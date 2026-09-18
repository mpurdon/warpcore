"""The config-to-resources compiler: what a project's canvas asks AWS for.

Everything in warpcore.yaml that describes infrastructure ends up here and
comes out as the Resource objects the provisioners understand, with the
property names each provisioner reads, the dependencies the planner orders
waves by, and references (refs.py) where a value is only known once a
dependency exists.

Two sources, one shape. A project the Visual Builder saved has a `canvas:`
block: nodes with a type, a config and edges between them. That is the
source of truth, because it is what the operator sees. A hand-written
project has `agents:`, `resources:` and `connections:`; those are lifted
into the same node-and-edge shape first, so there is one compiler.

What is compiled, and what is not:

- A discovered resource (a canvas node carrying an ARN from an account
  import) is observed, not desired. It is never created, updated or deleted
  by a deploy unless the operator has taken it over (`meta.managed: true`),
  in which case its config is compiled like a drawn one.
- A type with no provisioner is skipped and said so in the notes, never
  silently dropped. The same for a connection the provisioners cannot wire.
- A function with no code path gets a stub handler under `.warpcore/stubs/`
  so a system copied from the Holodeck can be stood up and then filled in;
  the plan says so per function.
"""

import json
import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from warpcore.config.parser import Config
from warpcore.orchestrator.refs import prop_ref, ref
from warpcore.state.models import Resource
from warpcore.utils.logging import get_logger

logger = get_logger(__name__)

# ------------------------------------------------------------------ shapes


@dataclass
class Node:
    """A resource as the canvas describes it."""

    id: str
    type: str
    label: str
    config: Dict[str, Any] = field(default_factory=dict)
    arn: Optional[str] = None
    parent: Optional[str] = None
    meta: Dict[str, Any] = field(default_factory=dict)

    @property
    def discovered(self) -> bool:
        return bool(self.arn) and not bool(self.meta.get("managed"))


@dataclass
class Edge:
    source: str
    target: str
    config: Dict[str, Any] = field(default_factory=dict)
    role_id: Optional[str] = None
    resource_based: bool = False
    dlq: bool = False
    meta: Dict[str, Any] = field(default_factory=dict)


@dataclass
class Compiled:
    resources: Dict[str, Resource]
    """What the plan says beyond the resources: stubs written, things left out and why."""
    notes: List[str] = field(default_factory=list)
    skipped: List[Dict[str, str]] = field(default_factory=list)


@dataclass
class Target:
    """Where the compile is going: names and ARNs need these."""

    project: str
    environment: str
    account: str
    region: str
    project_dir: Path
    # From the environment block the Visual Builder writes; defaults match
    # the builder's own (store/useStore.ts DEFAULT_ENVIRONMENT_CONFIGS).
    retention_days: int = 14
    xray: bool = False
    lambda_memory: int = 512
    lambda_timeout: int = 30
    s3_versioning: bool = False
    tags: Dict[str, str] = field(default_factory=dict)


# ------------------------------------------------------------- vocabulary

# Canvas type -> the AWS type the provisioner registry is keyed by.
PROVISIONED_TYPES: Dict[str, str] = {
    "agent": "AWS::Lambda::Function",
    "lambda": "AWS::Lambda::Function",
    "s3": "AWS::S3::Bucket",
    "dynamodb": "AWS::DynamoDB::Table",
    "sqs": "AWS::SQS::Queue",
    "sns": "AWS::SNS::Topic",
    "api-gateway": "AWS::ApiGatewayV2::Api",
    "log-group": "AWS::Logs::LogGroup",
    "iam-role": "AWS::IAM::Role",
    "vpc": "AWS::EC2::VPC",
    "security-group": "AWS::EC2::SecurityGroup",
    "cloudwatch-alarm": "AWS::CloudWatch::Alarm",
}

# Types the canvas draws that no provisioner builds yet. Named so the note
# can say what they are rather than "unknown".
KNOWN_UNPROVISIONED = {
    "eventbridge", "eventbridge-rule", "eventbridge-pipes", "step-functions", "bedrock", "kinesis-stream",
    "kinesis-firehose", "secrets-manager", "ssm-parameter", "ecr", "cloudwatch-dashboard", "api-route",
    "ec2-instance", "subnet", "internet-gateway", "nat-gateway", "route-table", "vpc-endpoint", "elastic-ip",
    "ebs-volume", "ebs-snapshot", "load-balancer", "cloudfront", "route53-zone", "kms-key", "acm-certificate",
    "iam-instance-profile", "iam-user", "iam-policy", "rds-instance", "rds-cluster", "ecs-cluster", "ecs-service",
    "eks-cluster", "elasticache-cluster", "cognito", "opensearch", "glue", "athena", "waf", "aws-resource",
}

# Layout containers: never resources.
CONTAINER_TYPES = {"application", "band", "enclosure"}

# The name field per type, as the canvas stores it (utils/nodeName.ts).
NAME_FIELDS: Dict[str, str] = {
    "s3": "bucketName", "dynamodb": "tableName", "sqs": "queueName", "sns": "topicName",
    "api-gateway": "apiName", "iam-role": "roleName", "security-group": "groupName", "vpc": "name",
    "log-group": "logGroupPath", "lambda": "functionName", "agent": "name", "cloudwatch-alarm": "alarmName",
}

# What a role may do to a target it is connected to (utils/rolePolicy.ts,
# targetResourcePermissions). Kept in step with the canvas by hand.
TARGET_ACTIONS: Dict[str, List[str]] = {
    "s3": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket"],
    "dynamodb": ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:Query", "dynamodb:Scan"],
    "sqs": ["sqs:SendMessage"],
    "sns": ["sns:Publish"],
    "eventbridge": ["events:PutEvents"],
    "log-group": ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"],
    "agent": ["lambda:InvokeFunction"],
    "lambda": ["lambda:InvokeFunction"],
    "secrets-manager": ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"],
    "ssm-parameter": ["ssm:GetParameter", "ssm:GetParameters", "ssm:GetParametersByPath"],
    "step-functions": ["states:StartExecution", "states:DescribeExecution", "states:StopExecution"],
    "bedrock": ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
    "cloudwatch-alarm": ["cloudwatch:DescribeAlarms", "cloudwatch:PutMetricAlarm", "cloudwatch:DeleteAlarms"],
    "kinesis-stream": ["kinesis:PutRecord", "kinesis:PutRecords", "kinesis:DescribeStream"],
    "kinesis-firehose": ["firehose:PutRecord", "firehose:PutRecordBatch", "firehose:DescribeDeliveryStream"],
    "ecr": ["ecr:GetDownloadUrlForLayer", "ecr:BatchGetImage", "ecr:BatchCheckLayerAvailability"],
    "cloudwatch-dashboard": ["cloudwatch:GetDashboard", "cloudwatch:PutDashboard", "cloudwatch:DeleteDashboards"],
}

# What a function needs to read from a source that triggers it.
SOURCE_ACTIONS: Dict[str, List[str]] = {
    "sqs": ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"],
    "dynamodb": ["dynamodb:GetRecords", "dynamodb:GetShardIterator", "dynamodb:DescribeStream", "dynamodb:ListStreams"],
    "kinesis-stream": ["kinesis:GetRecords", "kinesis:GetShardIterator", "kinesis:DescribeStream", "kinesis:DescribeStreamSummary", "kinesis:ListShards", "kinesis:ListStreams"],
}

# Pairs wired by a resource policy or a mapping rather than a role.
RESOURCE_BASED: set = {
    ("api-gateway", "agent"), ("api-gateway", "lambda"), ("api-gateway", "api-route"), ("api-route", "agent"),
    ("api-route", "lambda"), ("eventbridge-rule", "agent"), ("eventbridge-rule", "lambda"), ("sns", "agent"),
    ("sns", "lambda"), ("sns", "sqs"), ("s3", "agent"), ("s3", "lambda"),
}

# What the API Gateway provisioner can actually wire today.
SUPPORTED_RESOURCE_BASED = {("api-gateway", "agent"), ("api-gateway", "lambda"), ("api-gateway", "api-route"), ("api-route", "agent"), ("api-route", "lambda")}

COMPUTE = {"agent", "lambda"}

STUB_HANDLER = '''"""A stub handler warpcore wrote so this system could be stood up.

Replace it with the real handler; the deploy will pick up the change from
the code's hash.
"""

import json


def handler(event, context):
    return {
        "statusCode": 501,
        "headers": {"content-type": "application/json"},
        "body": json.dumps({"message": "%s is a warpcore stub; no handler has been written yet"}),
    }
'''


# ------------------------------------------------------------- lifting


def _slug(s: str, limit: int = 48) -> str:
    out = re.sub(r"[^a-z0-9]+", "-", str(s).lower()).strip("-")
    return out[:limit] or "resource"


def _aws_name(target: Target, node: Node) -> str:
    """The physical name: the config's name field when the operator set one,
    else project, environment and label, which keeps environments apart."""
    named = node.config.get(NAME_FIELDS.get(node.type, "name"))
    if isinstance(named, str) and named.strip():
        return named.strip()
    generic = node.config.get("name")
    if isinstance(generic, str) and generic.strip() and node.type not in ("agent",):
        return generic.strip()
    return f"{target.project}-{target.environment}-{_slug(node.label)}"


def lift(config: Config) -> Tuple[List[Node], List[Edge]]:
    """The canvas as nodes and edges; a hand-written project lifted into the same shape."""
    data = config.data or {}
    canvas = data.get("canvas") or {}
    raw_nodes = canvas.get("nodes") or []
    if raw_nodes:
        nodes = [
            Node(
                id=str(n["id"]), type=str(n.get("type") or ""), label=str(n.get("label") or n["id"]),
                config=dict(n.get("config") or {}), arn=n.get("arn") or None, parent=n.get("parent") or None,
                meta=dict(n.get("meta") or {}),
            )
            for n in raw_nodes if not n.get("hidden") or n.get("type") == "iam-role"
        ]
        edges = [
            Edge(
                source=str(e["source"]), target=str(e["target"]), config=dict(e.get("config") or {}),
                role_id=e.get("roleId") or None, resource_based=bool(e.get("isResourceBased")),
                dlq=bool((e.get("config") or {}).get("isDLQ") or e.get("isDLQ") or (e.get("data") or {}).get("isDLQ")),
                meta=dict(e.get("meta") or {}),
            )
            for e in canvas.get("edges") or []
        ]
        return nodes, edges

    # Hand-written: agents, resources and connections by name.
    nodes = []
    by_name: Dict[str, str] = {}
    for a in config.agents:
        node_id = f"agent-{_slug(a.name)}"
        nodes.append(Node(id=node_id, type="agent", label=a.name, config={
            "name": a.name, "path": a.path, "runtime": a.runtime, "memory": a.memory, "timeout": a.timeout,
            "handler": a.handler, "environment": dict(a.environment), "tags": dict(a.tags),
        }))
        by_name[a.name] = node_id
    for r in data.get("resources") or []:
        if not isinstance(r, dict) or not r.get("name") or not r.get("type"):
            continue
        node_id = f"{_slug(str(r['type']))}-{_slug(str(r['name']))}"
        cfg = dict(r.get("config") or {})
        cfg.setdefault(NAME_FIELDS.get(str(r["type"]), "name"), str(r["name"]))
        nodes.append(Node(id=node_id, type=str(r["type"]), label=str(r["name"]), config=cfg))
        by_name[str(r["name"])] = node_id
    edges = []
    for c in data.get("connections") or []:
        if not isinstance(c, dict):
            continue
        src, dst = by_name.get(str(c.get("from"))), by_name.get(str(c.get("to")))
        if src and dst:
            edges.append(Edge(source=src, target=dst, config=dict(c.get("config") or {}), role_id=by_name.get(str(c.get("role") or ""))))
    return nodes, edges


# ------------------------------------------------------------- compiling


def target_for(config: Config, environment: str, account: Optional[str] = None, region: Optional[str] = None) -> Target:
    env = config.get_environment(environment)
    block = (config.data.get("environments") or {}).get(environment) or {}
    logging_block = block.get("logging") or {}
    defaults = block.get("defaults") or {}
    return Target(
        project=config.project.name, environment=environment,
        account=account or env.account, region=region or env.region,
        project_dir=Path(config.config_path).resolve().parent,
        retention_days=int(logging_block.get("retention_days") or logging_block.get("default_retention_days") or 14),
        xray=bool(logging_block.get("xray", False)),
        lambda_memory=int(defaults.get("lambda_memory") or 512),
        lambda_timeout=int(defaults.get("lambda_timeout") or 30),
        s3_versioning=bool(defaults.get("s3_versioning", False)),
        tags={**(config.project.tags or {}), **(env.tags or {})},
    )


class Compiler:
    """Compiles one project for one target."""

    def __init__(self, config: Config, target: Target, write_stubs: bool = True, state: Optional[Any] = None):
        self.config = config
        self.target = target
        self.write_stubs = write_stubs
        self.notes: List[str] = []
        self.skipped: List[Dict[str, str]] = []
        # Adopted resources by ARN: a discovered node is owned only once its
        # state entry says it was taken over (discovery/takeover.py).
        self.taken: Dict[str, Resource] = {}
        if state is not None:
            for _stack, r in state.all_resources():
                if r.physical_id and (r.metadata or {}).get("adopted") and (r.metadata or {}).get("managed"):
                    self.taken[r.physical_id] = r

    # ----------------------------------------------------------- entry

    def compile(self, agent_filter: Optional[str] = None) -> Compiled:
        nodes, edges = lift(self.config)
        by_id = {n.id: n for n in nodes}
        resources: Dict[str, Resource] = {}

        # Which nodes the deploy owns.
        owned = [n for n in nodes if self._owned(n)]
        owned_ids = {n.id for n in owned}

        # Roles drawn on the canvas: an edge may name one; a function without one gets its own.
        role_nodes = {n.id: n for n in owned if n.type == "iam-role"}

        for n in owned:
            if n.type in COMPUTE and agent_filter and _agent_name(n) != agent_filter:
                continue
            if n.arn and n.arn in self.taken:
                taken = self._taken_over(n, self.taken[n.arn])
                if taken is not None:
                    resources[taken.id] = taken
                continue
            if n.type in COMPUTE:
                resources.update(self._function(n, edges, by_id, role_nodes, owned_ids))
            elif n.type == "s3":
                resources[n.id] = self._bucket(n)
            elif n.type == "dynamodb":
                resources[n.id] = self._table(n)
            elif n.type == "sqs":
                resources[n.id] = self._queue(n, edges, by_id, owned_ids)
            elif n.type == "sns":
                resources[n.id] = self._topic(n)
            elif n.type == "api-gateway":
                api = self._api(n, edges, by_id, owned_ids)
                if api:
                    resources[n.id] = api
            elif n.type == "log-group":
                resources[n.id] = self._log_group(n)
            elif n.type == "iam-role":
                resources[n.id] = self._role(n, [], name=_aws_name(self.target, n))
            elif n.type == "vpc":
                resources[n.id] = self._vpc(n)
            elif n.type == "security-group":
                resources[n.id] = self._security_group(n, by_id, owned_ids)
            elif n.type == "cloudwatch-alarm":
                alarm = self._alarm(n)
                if alarm:
                    resources[n.id] = alarm

        # The shared VPC block of a hand-written project, when no VPC is drawn.
        shared_vpc = self.config.shared.vpc if self.config.shared else None
        if shared_vpc and shared_vpc.enabled and not any(n.type == "vpc" for n in owned):
            node = Node(id="vpc-shared", type="vpc", label="vpc", config={"name": f"{self.target.project}-{self.target.environment}", "cidrBlock": shared_vpc.cidr or "10.0.0.0/16"})
            resources[node.id] = self._vpc(node)

        # Policy statements for roles named by edges, once every function is known.
        self._attach_edge_policies(resources, edges, by_id, role_nodes, owned_ids)

        # Every dependency must be a compiled resource; drop the rest with a note.
        for r in resources.values():
            missing = [d for d in r.dependencies if d not in resources]
            if missing:
                self.notes.append(f"{r.id} depends on {', '.join(missing)}, which the deploy does not own; the dependency is dropped")
                r.dependencies = [d for d in r.dependencies if d in resources]

        return Compiled(resources=resources, notes=self.notes, skipped=self.skipped)

    # --------------------------------------------------------- ownership

    def _owned(self, n: Node) -> bool:
        if n.type in CONTAINER_TYPES:
            return False
        if n.arn and n.arn in self.taken:
            return True  # taken over: compiled from its live shape, below
        if n.discovered:
            self.skipped.append({"id": n.id, "type": n.type, "reason": "discovered in the account; not managed by this project"})
            return False
        if n.arn and n.meta.get("managed"):
            # The canvas says taken over but the state does not know it yet.
            self.skipped.append({"id": n.id, "type": n.type, "reason": "marked as taken over on the canvas, but not in the deployment state; run `warpcore discover takeover`"})
            return False
        if n.type not in PROVISIONED_TYPES:
            what = "a type no provisioner builds yet" if n.type in KNOWN_UNPROVISIONED else f"an unknown type '{n.type}'"
            self.skipped.append({"id": n.id, "type": n.type, "reason": what})
            return False
        return True

    # --------------------------------------------------------- functions

    def _function(self, n: Node, edges: List[Edge], by_id: Dict[str, Node], role_nodes: Dict[str, Node], owned: set) -> Dict[str, Resource]:
        t = self.target
        cfg = n.config
        name = _aws_name(t, n)
        agent = _agent_name(n)
        tags = self._tags(agent, cfg.get("tags") or {})

        # The role: one named on an outgoing edge, else the function's own.
        named_role = next((e.role_id for e in edges if e.source == n.id and e.role_id in role_nodes), None)
        role_id = named_role or f"{n.id}-role"
        out: Dict[str, Resource] = {}

        # The log group: a drawn one wired to this function, else its own.
        log_id = next((e.target for e in edges if e.source == n.id and by_id.get(e.target) and by_id[e.target].type == "log-group" and e.target in owned), None)
        log_path = str(by_id[log_id].config.get("logGroupPath") or by_id[log_id].label) if log_id else f"/aws/lambda/{name}"
        if not named_role:
            out[role_id] = self._role(Node(id=role_id, type="iam-role", label=f"{n.label} role"), [], name=f"{name}-role"[:64], agent=agent, log_group=log_path)
        if not log_id:
            log_id = f"{n.id}-logs"
            out[log_id] = self._log_group(Node(id=log_id, type="log-group", label=log_path, config={"logGroupPath": log_path, "retentionDays": cfg.get("retentionDays")}), agent=agent)

        code_path = self._code_path(n, name)
        environment = {str(k): str(v) for k, v in (cfg.get("environment") or {}).items()}
        environment.update(self._links(n, edges, by_id, owned))

        props: Dict[str, Any] = {
            "FunctionName": name,
            "Runtime": cfg.get("runtime") or "python3.11",
            "Handler": cfg.get("handler") or "main.handler",
            "CodePath": code_path,
            "Role": ref(role_id),
            "MemorySize": int(cfg.get("memory") or t.lambda_memory),
            "Timeout": int(cfg.get("timeout") or t.lambda_timeout),
            "Environment": environment,
            "TracingConfig": {"Mode": "Active" if (cfg.get("xray") if cfg.get("xray") is not None else t.xray) else "PassThrough"},
        }
        dlq = next((e for e in edges if e.source == n.id and e.dlq and e.target in owned and by_id.get(e.target) and by_id[e.target].type == "sqs"), None)
        if dlq:
            props["DeadLetterConfig"] = {"TargetArn": prop_ref(dlq.target, "QueueArn")}
        deps = [role_id, log_id] + ([dlq.target] if dlq else [])
        out[n.id] = Resource(id=n.id, type="AWS::Lambda::Function", properties=props, dependencies=deps, tags=tags, metadata={"managed": True, "canvas": n.type})
        return out

    def _code_path(self, n: Node, name: str) -> str:
        cfg = n.config
        path = cfg.get("path")
        if isinstance(path, str) and path.strip():
            full = (self.target.project_dir / path).resolve() if not os.path.isabs(path) else Path(path)
            if full.exists():
                return str(full)
            self.notes.append(f"{n.label}: code path {path} does not exist; a stub handler is deployed instead")
        else:
            self.notes.append(f"{n.label}: no code path; a stub handler is deployed (edit .warpcore/stubs/{_slug(name)}/main.py or set path)")
        stub_dir = self.target.project_dir / ".warpcore" / "stubs" / _slug(name)
        if self.write_stubs:
            stub_dir.mkdir(parents=True, exist_ok=True)
            main = stub_dir / "main.py"
            if not main.exists():
                main.write_text(STUB_HANDLER % name)
        return str(stub_dir)

    def _links(self, n: Node, edges: List[Edge], by_id: Dict[str, Node], owned: set) -> Dict[str, str]:
        """Resource linking: every target this function reaches, by name, in its environment."""
        links: Dict[str, str] = {}
        for e in edges:
            if e.source != n.id or e.target not in owned:
                continue
            other = by_id.get(e.target)
            if not other or other.type not in PROVISIONED_TYPES or other.type in ("iam-role", "log-group", "vpc", "security-group", "cloudwatch-alarm"):
                continue
            key = "WARPCORE_" + re.sub(r"[^A-Z0-9]+", "_", other.label.upper()).strip("_")
            links[key] = _aws_name(self.target, other)
        return links

    # ------------------------------------------------------------- roles

    def _role(self, n: Node, statements: List[Dict[str, Any]], name: str, agent: Optional[str] = None,
              log_group: Optional[str] = None) -> Resource:
        t = self.target
        props: Dict[str, Any] = {
            "RoleName": name,
            "AssumeRolePolicyDocument": {
                "Version": "2012-10-17",
                "Statement": [{"Effect": "Allow", "Principal": {"Service": "lambda.amazonaws.com"}, "Action": "sts:AssumeRole"}],
            },
            "InlinePolicies": {},
            "ManagedPolicyArns": [],
        }
        if log_group:
            # Writing its own log group: the one thing every function needs,
            # scoped to that group rather than the account-wide managed policy.
            props["InlinePolicies"]["warpcore-logs"] = {"Version": "2012-10-17", "Statement": [{
                "Effect": "Allow",
                "Action": ["logs:CreateLogStream", "logs:PutLogEvents"],
                "Resource": [f"arn:aws:logs:{t.region}:{t.account}:log-group:{log_group}:*"],
            }]}
        if statements:
            props["InlinePolicies"]["warpcore-access"] = {"Version": "2012-10-17", "Statement": statements}
        return Resource(id=n.id, type="AWS::IAM::Role", properties=props, dependencies=[], tags=self._tags(agent, {}), metadata={"managed": True, "canvas": "iam-role"})

    def _attach_edge_policies(self, resources: Dict[str, Resource], edges: List[Edge], by_id: Dict[str, Node], role_nodes: Dict[str, Node], owned: set) -> None:
        """Connections become statements on the role of the function that holds them."""
        statements: Dict[str, List[Dict[str, Any]]] = {}
        for e in edges:
            src, dst = by_id.get(e.source), by_id.get(e.target)
            if not src or not dst or e.source not in owned:
                continue
            if e.dlq:
                continue  # the queue's redrive policy, not a permission
            pair = (src.type, dst.type)
            if pair in RESOURCE_BASED or e.resource_based:
                if pair not in SUPPORTED_RESOURCE_BASED and dst.type in COMPUTE:
                    self.notes.append(f"{src.label} -> {dst.label}: a {src.type} trigger is not wired by the deploy yet; connect it in the console or a later release")
                continue
            # Function -> target: the function's role may act on the target.
            if src.type in COMPUTE and dst.type in TARGET_ACTIONS:
                arns = self._target_arns(dst)
                if not arns:
                    continue
                role_id = next((x.role_id for x in edges if x.source == src.id and x.role_id in role_nodes), f"{src.id}-role")
                # ARNs come from names, so a policy never needs its target to exist first.
                statements.setdefault(role_id, []).append({"Effect": "Allow", "Action": self._filtered_actions(dst.type, e.config), "Resource": arns})
            # Source -> function: the function reads from what triggers it.
            elif dst.type in COMPUTE and src.type in SOURCE_ACTIONS:
                arns = self._target_arns(src, stream=src.type == "dynamodb")
                role_id = next((x.role_id for x in edges if x.source == dst.id and x.role_id in role_nodes), f"{dst.id}-role")
                statements.setdefault(role_id, []).append({"Effect": "Allow", "Action": SOURCE_ACTIONS[src.type], "Resource": arns})
                self.notes.append(f"{src.label} -> {dst.label}: the role may read the {src.type}; the event source mapping itself is not created by the deploy yet")
        for role_id, stmts in statements.items():
            role = resources.get(role_id)
            if role is None:
                continue
            role.properties["InlinePolicies"]["warpcore-access"] = {"Version": "2012-10-17", "Statement": stmts}

    def _filtered_actions(self, target_type: str, cfg: Dict[str, Any]) -> List[str]:
        """The canvas's read/write toggles narrow the default actions (rolePolicy.ts getFilteredActions)."""
        if target_type == "s3":
            acts = []
            if cfg.get("readAccess") is not False:
                acts += ["s3:GetObject", "s3:ListBucket"]
            if cfg.get("writeAccess") is not False:
                acts += ["s3:PutObject", "s3:DeleteObject"]
            return acts or TARGET_ACTIONS["s3"]
        if target_type == "dynamodb":
            acts = []
            if cfg.get("readAccess") is not False:
                acts += ["dynamodb:GetItem", "dynamodb:Query", "dynamodb:Scan"]
            if cfg.get("writeAccess") is not False:
                acts += ["dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem"]
            return acts or TARGET_ACTIONS["dynamodb"]
        if target_type == "sqs":
            acts = []
            if cfg.get("sendMessages") is not False:
                acts.append("sqs:SendMessage")
            if cfg.get("receiveMessages"):
                acts += ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"]
            return acts or ["sqs:SendMessage"]
        return list(TARGET_ACTIONS[target_type])

    def _target_arns(self, n: Node, stream: bool = False) -> List[str]:
        """The ARN a policy names, built from the name: it does not need the resource to exist."""
        t = self.target
        name = _aws_name(t, n)
        if n.arn and n.discovered:
            base = n.arn
            return [base, f"{base}/*"] if n.type == "s3" else [base]
        if n.type == "s3":
            return [f"arn:aws:s3:::{name}", f"arn:aws:s3:::{name}/*"]
        if n.type == "dynamodb":
            base = f"arn:aws:dynamodb:{t.region}:{t.account}:table/{name}"
            return [f"{base}/stream/*"] if stream else [base]
        if n.type == "sqs":
            return [f"arn:aws:sqs:{t.region}:{t.account}:{name}{'.fifo' if n.config.get('fifo') and not name.endswith('.fifo') else ''}"]
        if n.type == "sns":
            return [f"arn:aws:sns:{t.region}:{t.account}:{name}{'.fifo' if n.config.get('fifo') and not name.endswith('.fifo') else ''}"]
        if n.type in COMPUTE:
            return [f"arn:aws:lambda:{t.region}:{t.account}:function:{name}"]
        if n.type == "log-group":
            return [f"arn:aws:logs:{t.region}:{t.account}:log-group:{name}:*"]
        if n.type == "eventbridge":
            return [f"arn:aws:events:{t.region}:{t.account}:event-bus/{name}"]
        if n.type == "secrets-manager":
            return [f"arn:aws:secretsmanager:{t.region}:{t.account}:secret:{name}*"]
        if n.type == "ssm-parameter":
            return [f"arn:aws:ssm:{t.region}:{t.account}:parameter/{name.lstrip('/')}"]
        if n.type == "step-functions":
            return [f"arn:aws:states:{t.region}:{t.account}:stateMachine:{name}"]
        if n.type == "bedrock":
            return [f"arn:aws:bedrock:{t.region}::foundation-model/{name}"]
        if n.type == "kinesis-stream":
            return [f"arn:aws:kinesis:{t.region}:{t.account}:stream/{name}"]
        if n.type == "kinesis-firehose":
            return [f"arn:aws:firehose:{t.region}:{t.account}:deliverystream/{name}"]
        if n.type == "ecr":
            return [f"arn:aws:ecr:{t.region}:{t.account}:repository/{name}"]
        if n.type == "cloudwatch-alarm":
            return [f"arn:aws:cloudwatch:{t.region}:{t.account}:alarm:{name}"]
        if n.type == "cloudwatch-dashboard":
            return [f"arn:aws:cloudwatch::{t.account}:dashboard/{name}"]
        return []

    # --------------------------------------------------------- storage

    def _bucket(self, n: Node) -> Resource:
        cfg = n.config
        versioning = cfg.get("versioning")
        props = {
            "BucketName": _aws_name(self.target, n),
            "VersioningStatus": "Enabled" if (versioning if versioning is not None else self.target.s3_versioning) else "Disabled",
            "EncryptionConfiguration": {"Rules": [{"ApplyServerSideEncryptionByDefault": {"SSEAlgorithm": "AES256"}}]},
        }
        return self._resource(n, "AWS::S3::Bucket", props)

    def _table(self, n: Node) -> Resource:
        cfg = n.config
        pk = str(cfg.get("partitionKey") or "pk")
        sk = cfg.get("sortKey")
        attrs = [{"AttributeName": pk, "AttributeType": _attr_type(cfg.get("partitionKeyType"))}]
        keys = [{"AttributeName": pk, "KeyType": "HASH"}]
        if isinstance(sk, str) and sk.strip():
            attrs.append({"AttributeName": sk.strip(), "AttributeType": _attr_type(cfg.get("sortKeyType"))})
            keys.append({"AttributeName": sk.strip(), "KeyType": "RANGE"})
        props: Dict[str, Any] = {
            "TableName": _aws_name(self.target, n),
            "KeySchema": keys,
            "AttributeDefinitions": attrs,
            "BillingMode": "PROVISIONED" if str(cfg.get("billingMode") or "").upper().startswith("PROV") else "PAY_PER_REQUEST",
        }
        if props["BillingMode"] == "PROVISIONED":
            props["ProvisionedThroughput"] = {"ReadCapacityUnits": int(cfg.get("readCapacity") or 5), "WriteCapacityUnits": int(cfg.get("writeCapacity") or 5)}
        if cfg.get("stream") or cfg.get("streamEnabled"):
            props["StreamSpecification"] = {"StreamEnabled": True, "StreamViewType": str(cfg.get("streamViewType") or "NEW_AND_OLD_IMAGES")}
        return self._resource(n, "AWS::DynamoDB::Table", props)

    def _queue(self, n: Node, edges: List[Edge], by_id: Dict[str, Node], owned: set) -> Resource:
        cfg = n.config
        name = _aws_name(self.target, n)
        fifo = bool(cfg.get("fifo"))
        if fifo and not name.endswith(".fifo"):
            name += ".fifo"
        props: Dict[str, Any] = {"QueueName": name}
        if fifo:
            props["FifoQueue"] = True
            if cfg.get("contentBasedDeduplication", True):
                props["ContentBasedDeduplication"] = True
        for src, dst in (("visibilityTimeout", "VisibilityTimeout"), ("messageRetentionPeriod", "MessageRetentionPeriod"),
                         ("delaySeconds", "DelaySeconds"), ("receiveWaitTime", "ReceiveMessageWaitTimeSeconds")):
            if cfg.get(src) is not None:
                props[dst] = int(cfg[src])
        deps: List[str] = []
        dlq = next((e for e in edges if e.source == n.id and e.dlq and e.target in owned and by_id.get(e.target) and by_id[e.target].type == "sqs"), None)
        if dlq:
            props["RedrivePolicy"] = {"deadLetterTargetArn": prop_ref(dlq.target, "QueueArn"), "maxReceiveCount": int(dlq.config.get("maxRetries") or cfg.get("maxRetries") or 3)}
            deps.append(dlq.target)
        return self._resource(n, "AWS::SQS::Queue", props, deps)

    def _topic(self, n: Node) -> Resource:
        cfg = n.config
        name = _aws_name(self.target, n)
        fifo = bool(cfg.get("fifo"))
        if fifo and not name.endswith(".fifo"):
            name += ".fifo"
        props: Dict[str, Any] = {"TopicName": name}
        if fifo:
            props["FifoTopic"] = True
            props["ContentBasedDeduplication"] = True
        if cfg.get("displayName"):
            props["DisplayName"] = str(cfg["displayName"])
        return self._resource(n, "AWS::SNS::Topic", props)

    # ------------------------------------------------------------- edge

    def _api(self, n: Node, edges: List[Edge], by_id: Dict[str, Node], owned: set) -> Optional[Resource]:
        cfg = n.config
        routes: List[Dict[str, Any]] = []
        deps: List[str] = []
        # Routes: api-gateway -> function directly (config.method/path on the
        # edge), or api-gateway -> api-route -> function.
        for e in edges:
            if e.source != n.id:
                continue
            dst = by_id.get(e.target)
            if not dst:
                continue
            if dst.type in COMPUTE and e.target in owned:
                routes.append(self._route(e.config.get("method"), e.config.get("path"), e.target))
                deps.append(e.target)
            elif dst.type == "api-route":
                for e2 in edges:
                    fn = by_id.get(e2.target)
                    if e2.source == dst.id and fn and fn.type in COMPUTE and e2.target in owned:
                        routes.append(self._route(dst.config.get("method"), dst.config.get("path"), e2.target))
                        deps.append(e2.target)
        if not routes:
            self.notes.append(f"{n.label}: an API with no route to a function is not created; connect it to a function first")
            self.skipped.append({"id": n.id, "type": n.type, "reason": "no route to a function"})
            return None
        props: Dict[str, Any] = {"Name": _aws_name(self.target, n), "Routes": routes, "StageName": "$default"}
        if cfg.get("cors", True):
            props["CorsConfiguration"] = {"AllowOrigins": ["*"], "AllowMethods": ["*"], "AllowHeaders": ["*"]}
        return self._resource(n, "AWS::ApiGatewayV2::Api", props, sorted(set(deps)))

    @staticmethod
    def _route(method: Any, path: Any, function_id: str) -> Dict[str, Any]:
        m = str(method or "ANY").upper()
        p = str(path or "/")
        if not p.startswith("/"):
            p = "/" + p
        return {"RouteKey": f"{m} {p}", "IntegrationType": "AWS_PROXY", "IntegrationUri": ref(function_id), "TimeoutInMillis": 30000}

    # ----------------------------------------------------- observability

    def _log_group(self, n: Node, agent: Optional[str] = None) -> Resource:
        cfg = n.config
        retention = cfg.get("retentionDays")
        props = {
            "ResourceType": "LogGroup",
            "LogGroupName": str(cfg.get("logGroupPath") or cfg.get("name") or n.label),
            "RetentionInDays": int(retention) if retention else self.target.retention_days,
        }
        return self._resource(n, "AWS::Logs::LogGroup", props, agent=agent)

    def _alarm(self, n: Node) -> Optional[Resource]:
        cfg = n.config
        required = ("metricName", "namespace", "threshold")
        if not all(cfg.get(k) for k in required):
            self.notes.append(f"{n.label}: an alarm needs metricName, namespace and threshold; left out")
            self.skipped.append({"id": n.id, "type": n.type, "reason": "missing metric, namespace or threshold"})
            return None
        props = {
            "ResourceType": "Alarm",
            "AlarmName": _aws_name(self.target, n),
            "MetricName": str(cfg["metricName"]),
            "Namespace": str(cfg["namespace"]),
            "Threshold": float(cfg["threshold"]),
            "ComparisonOperator": str(cfg.get("comparisonOperator") or "GreaterThanThreshold"),
            "EvaluationPeriods": int(cfg.get("evaluationPeriods") or 1),
            "Period": int(cfg.get("period") or 300),
            "Statistic": str(cfg.get("statistic") or "Average"),
        }
        return self._resource(n, "AWS::CloudWatch::Alarm", props)

    # ------------------------------------------------------------ network

    def _vpc(self, n: Node) -> Resource:
        cfg = n.config
        return self._resource(n, "AWS::EC2::VPC", {"CidrBlock": str(cfg.get("cidrBlock") or cfg.get("cidr") or "10.0.0.0/16")})

    def _security_group(self, n: Node, by_id: Dict[str, Node], owned: set) -> Resource:
        cfg = n.config
        props: Dict[str, Any] = {"GroupName": _aws_name(self.target, n), "Description": str(cfg.get("description") or f"{n.label} (warpcore)")}
        deps: List[str] = []
        vpc = by_id.get(n.parent or "")
        if vpc and vpc.type == "vpc":
            if vpc.id in owned:
                props["VpcId"] = ref(vpc.id)
                deps.append(vpc.id)
            elif vpc.arn:
                props["VpcId"] = vpc.config.get("vpcId") or vpc.arn.rsplit("/", 1)[-1]
        rules = cfg.get("inboundRules") or cfg.get("ingressRules") or []
        if isinstance(rules, list) and rules and isinstance(rules[0], dict):
            props["IngressRules"] = rules
        return self._resource(n, "AWS::EC2::SecurityGroup", props, deps)

    # --------------------------------------------------------- taken over

    # Config keys the operator may change on a taken-over resource, and the
    # provisioner property each sets. Everything else keeps its live value.
    EDITABLE: Dict[str, Dict[str, str]] = {
        "AWS::Lambda::Function": {"runtime": "Runtime", "handler": "Handler", "memory": "MemorySize", "timeout": "Timeout"},
        "AWS::SQS::Queue": {"visibilityTimeout": "VisibilityTimeout", "delaySeconds": "DelaySeconds"},
        "AWS::SNS::Topic": {"displayName": "DisplayName"},
        "AWS::Logs::LogGroup": {"retentionDays": "RetentionInDays"},
        "AWS::S3::Bucket": {},
        "AWS::DynamoDB::Table": {},
        "AWS::IAM::Role": {},
        "AWS::EC2::VPC": {},
        "AWS::EC2::SecurityGroup": {},
    }

    def _taken_over(self, n: Node, existing: Resource) -> Optional[Resource]:
        """A resource warpcore now owns but did not create: its live shape,
        with the canvas's edits on top. Keeps the state's id, so the plan
        compares it with the entry the take-over rewrote."""
        editable = self.EDITABLE.get(existing.type)
        if editable is None:
            self.skipped.append({"id": n.id, "type": n.type, "reason": f"taken over, but no provisioner manages {existing.type}"})
            return None
        props = dict(existing.properties)
        for key, prop in editable.items():
            value = n.config.get(key)
            if value is None or value == "":
                continue
            props[prop] = int(value) if prop in ("MemorySize", "Timeout", "VisibilityTimeout", "DelaySeconds", "RetentionInDays") else value
        if existing.type == "AWS::Lambda::Function":
            env = n.config.get("environment")
            if isinstance(env, dict) and env and not any(str(v) == "<redacted>" for v in env.values()):
                props["Environment"] = {str(k): str(v) for k, v in env.items()}
            path = n.config.get("path")
            if isinstance(path, str) and path.strip():
                full = (self.target.project_dir / path).resolve() if not os.path.isabs(path) else Path(path)
                if full.exists():
                    props["CodePath"] = str(full)
                else:
                    self.notes.append(f"{n.label}: code path {path} does not exist; the deployed code is kept")
            props.pop("CodeSha256", None) if "CodePath" in props else None
        if existing.type == "AWS::S3::Bucket" and n.config.get("versioning") is not None:
            props["VersioningStatus"] = "Enabled" if n.config.get("versioning") else "Disabled"
        # Its tags stay as they are: a take-over is a change of record, not
        # a change in AWS, and the first plan after one must propose nothing.
        tags = {**existing.tags, **{str(k): str(v) for k, v in (n.config.get("tags") or {}).items()}}
        return Resource(id=existing.id, type=existing.type, physical_id=existing.physical_id, properties=props,
                        dependencies=[], tags=tags, metadata={**(existing.metadata or {}), "managed": True, "canvas": n.type})

    # ------------------------------------------------------------ helpers

    def _resource(self, n: Node, aws_type: str, props: Dict[str, Any], deps: Optional[List[str]] = None, agent: Optional[str] = None) -> Resource:
        return Resource(id=n.id, type=aws_type, properties=props, dependencies=list(deps or []), tags=self._tags(agent, n.config.get("tags") or {}), metadata={"managed": True, "canvas": n.type})

    def _tags(self, agent: Optional[str], own: Dict[str, Any]) -> Dict[str, str]:
        t = self.target
        tags = {
            "warpcore:project": t.project,
            "warpcore:environment": t.environment,
            "warpcore:managed-by": "warpcore",
            **{str(k): str(v) for k, v in t.tags.items()},
            **{str(k): str(v) for k, v in (own or {}).items() if isinstance(own, dict)},
        }
        if agent:
            tags["warpcore:agent"] = agent
        return tags


def _agent_name(n: Node) -> str:
    return str(n.config.get("name") or n.config.get("functionName") or _slug(n.label))


def _attr_type(raw: Any) -> str:
    v = str(raw or "S").upper()
    if v.startswith("N"):
        return "N"
    if v.startswith("B"):
        return "B"
    return "S"


def compile_project(config: Config, environment: str, account: Optional[str] = None, region: Optional[str] = None,
                    agent_filter: Optional[str] = None, write_stubs: bool = True, state: Optional[Any] = None) -> Compiled:
    """The desired resources of a project for one environment. `state` is
    the deployment state, so taken-over resources compile from their live shape."""
    target = target_for(config, environment, account, region)
    return Compiler(config, target, write_stubs=write_stubs, state=state).compile(agent_filter=agent_filter)
