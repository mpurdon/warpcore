"""Turn a scanned AWS account into a Visual Builder project.

This is the account-to-canvas path: the operator scanned an account in the
Explorer and wants to see it as a project. It differs from ConfigEmitter,
which writes the minimal warpcore.yaml the CLI deploys from, in three ways:

* Resource ``config`` uses the Visual Builder's own field names
  (``bucketName``, ``tableName``, ``visibilityTimeout``...), so every node
  opens in the configuration form with its real values filled in.
* Relationships are derived from hydrated properties - execution roles,
  environment variables that name another resource, event source mappings,
  rule targets, dead-letter queues, VPC attachments, state machine
  definitions - and emitted as connections keyed by ARN, so the canvas has
  edges rather than a row of unconnected boxes.
* Resources are selected with glob patterns (``AWS::Lambda::*``,
  ``name:orders-*``, ``tag:Project=shop``), the same semantics the app uses
  for its live preview.

Anything the canvas cannot show is counted per type and reported, never
silently dropped.
"""

from __future__ import annotations

import fnmatch
import json
import re
from dataclasses import dataclass, field
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

from warpcore.agentic.scanner import ScannedState
from warpcore.discovery.config_emitter import REDACTED, EmitNote, sanitize_agent_name, user_tags
from warpcore.state.models import Resource
from warpcore.utils.arn import parse_arn, service_identifier, sqs_url_to_arn
from warpcore.utils.logging import get_logger

logger = get_logger(__name__)

# AWS type -> Visual Builder node type. Lambda is decided per run (agent or
# plain lambda node) and handled separately.
CANVAS_TYPES: Dict[str, str] = {
    "AWS::S3::Bucket": "s3",
    "AWS::DynamoDB::Table": "dynamodb",
    "AWS::SQS::Queue": "sqs",
    "AWS::SNS::Topic": "sns",
    "AWS::Kinesis::Stream": "kinesis-stream",
    "AWS::KinesisFirehose::DeliveryStream": "kinesis-firehose",
    "AWS::Events::Rule": "eventbridge-rule",
    "AWS::Events::EventBus": "eventbridge",
    "AWS::Pipes::Pipe": "eventbridge-pipes",
    "AWS::ApiGateway::RestApi": "api-gateway",
    "AWS::ApiGatewayV2::Api": "api-gateway",
    "AWS::IAM::Role": "iam-role",
    "AWS::EC2::SecurityGroup": "security-group",
    "AWS::EC2::VPC": "vpc",
    "AWS::CloudWatch::Alarm": "cloudwatch-alarm",
    "AWS::CloudWatch::Dashboard": "cloudwatch-dashboard",
    "AWS::Logs::LogGroup": "log-group",
    "AWS::SecretsManager::Secret": "secrets-manager",
    "AWS::SSM::Parameter": "ssm-parameter",
    "AWS::StepFunctions::StateMachine": "step-functions",
    "AWS::ECR::Repository": "ecr",
    # Infrastructure drawn from an account. Mirrors discoveredTypes.ts.
    "AWS::EC2::Instance": "ec2-instance",
    "AWS::EC2::Subnet": "subnet",
    "AWS::EC2::InternetGateway": "internet-gateway",
    "AWS::EC2::NatGateway": "nat-gateway",
    "AWS::EC2::RouteTable": "route-table",
    "AWS::EC2::VPCEndpoint": "vpc-endpoint",
    "AWS::EC2::EIP": "elastic-ip",
    "AWS::EC2::Volume": "ebs-volume",
    "AWS::EC2::Snapshot": "ebs-snapshot",
    "AWS::ElasticLoadBalancingV2::LoadBalancer": "load-balancer",
    "AWS::ElasticLoadBalancing::LoadBalancer": "load-balancer",
    "AWS::CloudFront::Distribution": "cloudfront",
    "AWS::Cloudfront::Distribution": "cloudfront",
    "AWS::Route53::HostedZone": "route53-zone",
    "AWS::Route53::Hostedzone": "route53-zone",
    "AWS::KMS::Key": "kms-key",
    "AWS::ACM::Certificate": "acm-certificate",
    "AWS::Acm::Certificate": "acm-certificate",
    "AWS::IAM::InstanceProfile": "iam-instance-profile",
    "AWS::IAM::User": "iam-user",
    "AWS::IAM::Policy": "iam-policy",
    "AWS::RDS::DBInstance": "rds-instance",
    "AWS::RDS::DBCluster": "rds-cluster",
    "AWS::ECS::Cluster": "ecs-cluster",
    "AWS::ECS::Service": "ecs-service",
    "AWS::EKS::Cluster": "eks-cluster",
    "AWS::ElastiCache::CacheCluster": "elasticache-cluster",
    "AWS::Elasticache::Cluster": "elasticache-cluster",
}

# Anything else is still drawn, as a plain box carrying its AWS type.
GENERIC_TYPE = "aws-resource"

LAMBDA_TYPE = "AWS::Lambda::Function"

_ARN_RE = re.compile(r"arn:aws[a-z-]*:[a-z0-9-]+:[a-z0-9-]*:\d{0,12}:[^\s\"',]+")


# ------------------------------------------------------------------ selection

def _candidates(resource: Resource) -> Dict[str, List[str]]:
    """Strings a pattern can match, by field."""
    rtype = resource.type or ""
    short = rtype.replace("AWS::", "")
    region = (resource.metadata or {}).get("region") or ""
    return {
        "type": [rtype, short, CANVAS_TYPES.get(rtype, ""), "lambda" if rtype == LAMBDA_TYPE else ""],
        "name": [resource.id or ""],
        "arn": [resource.physical_id or ""],
        "region": [region],
        "tag": [f"{k}={v}" for k, v in (resource.tags or {}).items()],
    }


def pattern_matches(pattern: str, resource: Resource, fields: Optional[Dict[str, List[str]]] = None) -> bool:
    """Case-insensitive glob match of one pattern against one resource.

    A ``field:`` prefix (type, name, tag, region) restricts the match to that
    field; anything else is tried against every field. ``*`` matches all.
    Pass ``fields`` (from ``_candidates``) when matching many patterns
    against one resource, so they are built once.
    """
    p = pattern.strip()
    if not p:
        return False
    if p == "*":
        return True
    fields = fields if fields is not None else _candidates(resource)
    lowered = p.lower()
    for prefix in ("type:", "name:", "tag:", "region:"):
        if lowered.startswith(prefix):
            body = lowered[len(prefix):]
            return any(fnmatch.fnmatchcase(c.lower(), body) for c in fields[prefix[:-1]] if c)
    return any(
        fnmatch.fnmatchcase(c.lower(), lowered)
        for values in fields.values()
        for c in values
        if c
    )


def select_resources(
    resources: Iterable[Resource],
    include: Sequence[str],
    exclude: Sequence[str] = (),
) -> Tuple[List[Resource], List[Resource]]:
    """Split resources into (included, excluded).

    A resource is included when any include pattern matches and no exclude
    pattern does. No include patterns at all means everything.
    """
    include = [p for p in include if p.strip()] or ["*"]
    exclude = [p for p in exclude if p.strip()]
    kept: List[Resource] = []
    dropped: List[Resource] = []
    for resource in resources:
        fields = _candidates(resource)
        wanted = any(pattern_matches(p, resource, fields) for p in include)
        if wanted and any(pattern_matches(p, resource, fields) for p in exclude):
            wanted = False
        (kept if wanted else dropped).append(resource)
    return kept, dropped


# ------------------------------------------------------------------- emitter

@dataclass
class Connection:
    """A relationship between two emitted things, by ARN."""

    from_arn: str
    to_arn: str
    kind: str      # role | reference | access | event-source | event-target | dlq | vpc | logs | invokes | dns | origin
    detail: str = ""
    # For access edges: the role that grants it and a sample of the actions.
    via: str = ""
    actions: List[str] = field(default_factory=list)

    def as_dict(self) -> Dict[str, Any]:
        out: Dict[str, Any] = {"from_arn": self.from_arn, "to_arn": self.to_arn, "kind": self.kind, "detail": self.detail}
        if self.via:
            out["via"] = self.via
        if self.actions:
            out["actions"] = self.actions
        return out


@dataclass
class ProjectResult:
    """Everything the app needs to build a canvas."""

    payload: Dict[str, Any]
    notes: List[EmitNote] = field(default_factory=list)


def _region_of(resource: Resource) -> Optional[str]:
    return (resource.metadata or {}).get("region")


# ------------------------------------------------------------------- access
#
# IAM policy statements become read/write arrows. Verbs are classified by
# prefix, which is how IAM itself groups them; anything not clearly a read or
# a write (CreateGrant, PassRole) is treated as write, since it changes state.

_READ_PREFIXES = ("get", "list", "describe", "decrypt", "receive", "query", "scan", "batchget", "head",
                  "select", "read", "lookup", "view", "search", "filter", "check", "verify", "sign")

# Services whose resources get access edges; a statement about ec2:* says
# nothing about a queue. The ARN service prefix and the action prefix agree
# for all of these. "logs" is deliberately absent: writing your own logs is
# table stakes, and the standard execution roles grant it on `*`.
_ACCESS_SERVICES = frozenset({
    "s3", "dynamodb", "sqs", "sns", "secretsmanager", "ssm", "kms", "lambda", "states", "events",
    "kinesis", "firehose", "ecr", "rds", "elasticache",
})


def classify_action(action: str) -> Tuple[str, str]:
    """(read|write|admin, service) for one IAM action string.

    Anything not clearly a read is a write: it changes state.
    """
    action = (action or "").strip()
    if action == "*":
        return "admin", "*"
    service, _, verb = action.partition(":")
    service = service.lower()
    stem = verb.lower().rstrip("*")
    if not stem:
        return "admin", service
    return ("read" if stem.startswith(_READ_PREFIXES) else "write"), service


def _as_list(value: Any) -> List[Any]:
    if value is None:
        return []
    return value if isinstance(value, list) else [value]


def resource_pattern_matches(pattern: str, arn: str) -> bool:
    """Does a statement's Resource entry cover this ARN?

    ``arn:aws:s3:::bucket/*`` covers the bucket itself for drawing purposes:
    reading objects is reading the bucket.
    """
    pattern = (pattern or "").strip()
    if not pattern:
        return False
    if pattern == "*":
        return True
    if fnmatch.fnmatchcase(arn, pattern):
        return True
    if "/" in pattern:
        head = pattern.split("/", 1)[0]
        if head and "*" not in head and head == arn:
            return True
        if fnmatch.fnmatchcase(arn, head):
            return True
    return False


def _arn_service(arn: str) -> str:
    parsed = parse_arn(arn)
    return parsed.service if parsed else ""


def _summarise_access(classes: set) -> str:
    if "admin" in classes:
        return "admin"
    if "read" in classes and "write" in classes:
        return "read/write"
    return "read" if "read" in classes else "write"


# ------------------------------------------------------------------- health
#
# Green means something only if it is earned. A resource the scan merely
# found is "present"; it is healthy only when its own service reported a
# state that means running, and the reason is carried so the inspector can
# say where the colour came from.

def resource_health(aws_type: str, p: Dict[str, Any]) -> Dict[str, str]:
    def ok(reason: str) -> Dict[str, str]:
        return {"level": "ok", "reason": reason}

    def warn(reason: str) -> Dict[str, str]:
        return {"level": "warn", "reason": reason}

    def unknown(reason: str) -> Dict[str, str]:
        return {"level": "unknown", "reason": reason}

    if aws_type == "AWS::EC2::Instance":
        state = (p.get("State") or {}).get("Name")
        if state == "running":
            return ok("EC2 reports the instance running")
        return warn(f"EC2 reports the instance {state}") if state else unknown("instance state not read")
    if aws_type == LAMBDA_TYPE:
        state = p.get("State")
        update = p.get("LastUpdateStatus")
        if update == "Failed":
            return warn(f"last update failed: {p.get('LastUpdateStatusReason') or 'no reason given'}")
        if state == "Active":
            return ok("Lambda reports the function active")
        return warn(f"Lambda reports the function {state}") if state else unknown("function state not read")
    if aws_type == "AWS::RDS::DBInstance":
        status = p.get("DBInstanceStatus")
        return ok("RDS reports the instance available") if status == "available" else (warn(f"RDS reports {status}") if status else unknown("status not read"))
    if aws_type == "AWS::EC2::NatGateway":
        state = p.get("State")
        return ok("NAT gateway available") if state == "available" else (warn(f"NAT gateway {state}") if state else unknown("state not read"))
    if aws_type in ("AWS::ACM::Certificate", "AWS::Acm::Certificate"):
        status = p.get("Status")
        if status == "ISSUED":
            return ok("certificate issued and valid")
        return warn(f"certificate {status}") if status else unknown("status not read")
    if aws_type in ("AWS::CloudFront::Distribution", "AWS::Cloudfront::Distribution"):
        enabled = (p.get("DistributionConfig") or {}).get("Enabled")
        status = p.get("Status")
        if enabled is False:
            return warn("distribution disabled")
        return ok("distribution deployed and enabled") if status == "Deployed" else (warn(f"distribution {status}") if status else unknown("status not read"))
    if aws_type == "AWS::KMS::Key":
        state = p.get("KeyState")
        return ok("key enabled") if state == "Enabled" else (warn(f"key {state}") if state else unknown("state not read"))
    if aws_type in ("AWS::ElasticLoadBalancingV2::LoadBalancer", "AWS::ElasticLoadBalancing::LoadBalancer"):
        code = (p.get("State") or {}).get("Code")
        return ok("load balancer active") if code == "active" else (warn(f"load balancer {code}") if code else unknown("state not read"))
    if aws_type == "AWS::DynamoDB::Table":
        status = p.get("TableStatus")
        return ok("table active") if status == "ACTIVE" else (warn(f"table {status}") if status else unknown("status not read"))
    if aws_type == "AWS::StepFunctions::StateMachine":
        status = p.get("status")
        return ok("state machine active") if status == "ACTIVE" else (warn(f"state machine {status}") if status else unknown("status not read"))
    if aws_type == "AWS::Events::Rule":
        state = p.get("State")
        return ok("rule enabled") if state == "ENABLED" else (warn("rule disabled") if state else unknown("state not read"))
    return unknown("found in the account; this type reports no health")


class ProjectEmitter:
    """Builds the project payload from a scanned (and hydrated) account."""

    def __init__(
        self,
        scanned_state: ScannedState,
        project_name: str,
        environment: str,
        account: str,
        region: str,
        regions: Optional[Dict[str, int]] = None,
        lambda_as: str = "agent",
        include_env_values: bool = False,
    ):
        if lambda_as not in ("agent", "lambda"):
            raise ValueError("lambda_as must be 'agent' or 'lambda'")
        self.scanned_state = scanned_state
        self.project_name = project_name
        self.environment = environment
        self.account = account
        self.region = region
        self.regions = regions or {}
        self.lambda_as = lambda_as
        self.include_env_values = include_env_values

    # ------------------------------------------------------------- public

    def emit(self) -> ProjectResult:
        notes: List[EmitNote] = []
        resources = sorted(self.scanned_state.get_all_resources(), key=lambda r: (r.type, r.id))

        # Every ARN, id, name and URL that could identify an included resource,
        # so environment variables and definitions can be resolved to it.
        identifiers: Dict[str, str] = {}   # identifier -> arn
        for r in resources:
            arn = r.physical_id or r.id
            for ident in self._identifiers(r):
                identifiers.setdefault(ident, arn)

        agents: List[Dict[str, Any]] = []
        emitted: List[Dict[str, Any]] = []
        roles: Dict[str, Dict[str, Any]] = {}
        skipped: Dict[str, int] = {}
        connections: List[Connection] = []
        seen_agent_names: Dict[str, str] = {}

        seen_log_groups: set = set()
        for r in resources:
            arn = r.physical_id or r.id
            if r.type == "AWS::Logs::LogGroup":
                # Resource Explorer and the Logs API report the same group
                # under ARNs that differ only by a trailing ":*".
                key = service_identifier(arn)
                if key in seen_log_groups:
                    continue
                seen_log_groups.add(key)
            if r.type == LAMBDA_TYPE:
                item = self._emit_lambda(r, seen_agent_names, notes)
                if item is None:
                    skipped[r.type] = skipped.get(r.type, 0) + 1
                    continue
                (agents if self.lambda_as == "agent" else emitted).append(item)
                connections.extend(self._lambda_connections(r, arn, identifiers))
            elif r.type == "AWS::IAM::Role":
                # Collected now, emitted only if something included uses them:
                # an account's SSO and service roles are noise on a canvas.
                roles[arn] = self._emit_role(r)
            else:
                canvas_type = CANVAS_TYPES.get(r.type, GENERIC_TYPE)
                emitted.append(self._emit_resource(r, canvas_type))
                connections.extend(self._resource_connections(r, arn, identifiers))

        # Every included role is emitted (as a hidden node the Roles panel
        # lists); the ones something runs as also say what.
        runs_as: Dict[str, List[str]] = {}
        for c in connections:
            if c.kind == "role":
                runs_as.setdefault(c.to_arn, []).append(c.from_arn)
        for arn, role in roles.items():
            role["attached_to"] = sorted(runs_as.get(arn, []))
        used_roles = list(roles.values())

        # Only connections whose ends were both emitted.
        targets = {a["arn"]: a for a in agents}
        targets.update({e["arn"]: e for e in emitted})
        present = set(targets) | set(roles)
        connections = [c for c in connections if c.from_arn in present and c.to_arn in present]

        # Access arrows from what the roles are actually allowed to do.
        access = self._access_connections(roles, connections, targets, notes)
        if access:
            # A real grant beats an environment-variable guess about the same pair.
            granted = {(c.from_arn, c.to_arn) for c in access}
            connections = [c for c in connections
                           if not (c.kind == "reference" and c.detail.startswith("env ") and (c.from_arn, c.to_arn) in granted)]
            connections.extend(access)
        connections = list({(c.from_arn, c.to_arn, c.kind): c for c in connections}.values())

        # Sub-resources fold into their parent rather than getting a box.
        self._fold(emitted, targets)

        payload: Dict[str, Any] = {
            "account": self.account,
            "regions": self.regions,
            "project": {"name": self.project_name, "region": self.region},
            "environment": {"key": self.environment, "account": self.account, "region": self.region},
            "agents": agents,
            "resources": emitted,
            "roles": used_roles,
            "connections": [c.as_dict() for c in connections],
            "counts": {
                "included": len(resources),
                "shown": len(agents) + len(emitted) + len(used_roles),
                "skipped": sum(skipped.values()),
                "connections": len(connections),
            },
            "skipped": dict(sorted(skipped.items())),
            "notes": [{"level": n.level, "physical_id": n.physical_id, "message": n.message} for n in notes],
            "explorer": self.scanned_state.explorer_available,
            "errors": [
                {"physical_id": e.physical_id, "type": e.resource_type, "stage": e.stage, "message": e.message}
                for e in self.scanned_state.errors
            ],
        }
        return ProjectResult(payload=payload, notes=notes)

    # ------------------------------------------------------------- access

    def _access_connections(
        self,
        roles: Dict[str, Dict[str, Any]],
        connections: List[Connection],
        targets: Dict[str, Dict[str, Any]],
        notes: List[EmitNote],
    ) -> List[Connection]:
        """Read/write arrows from principals to resources, via role policies."""
        # Who runs as each role: functions and state machines directly,
        # instances through their instance profile.
        principals: Dict[str, set] = {}
        profile_roles: Dict[str, set] = {}
        for c in connections:
            if c.kind != "role":
                continue
            if c.detail == "profile role":
                profile_roles.setdefault(c.from_arn, set()).add(c.to_arn)
            else:
                principals.setdefault(c.to_arn, set()).add(c.from_arn)
        for c in connections:
            if c.kind == "role" and c.detail == "instance profile":
                for role_arn in profile_roles.get(c.to_arn, ()):
                    principals.setdefault(role_arn, set()).add(c.from_arn)

        # Resource and key policies grant to principals by ARN; fold them in
        # as if they were statements on that role.
        statements_by_role: Dict[str, List[Tuple[dict, str]]] = {}
        for role_arn, role in roles.items():
            for doc in role.get("policy_documents") or []:
                for stmt in _as_list((doc.get("document") or {}).get("Statement")):
                    if isinstance(stmt, dict):
                        statements_by_role.setdefault(role_arn, []).append((stmt, doc.get("name") or ""))
        for target_arn, item in targets.items():
            policy = item.get("resource_policy")
            if not isinstance(policy, dict):
                continue
            for stmt in _as_list(policy.get("Statement")):
                if not isinstance(stmt, dict):
                    continue
                principal = stmt.get("Principal")
                arns = _as_list(principal.get("AWS")) if isinstance(principal, dict) else []
                for arn in arns:
                    if arn in roles:
                        pinned = dict(stmt)
                        pinned["Resource"] = target_arn
                        statements_by_role.setdefault(arn, []).append((pinned, f"resource policy of {item.get('name')}"))

        # Targets that can receive access edges, by service, so a statement
        # about s3:GetObject is only tried against buckets.
        targets_by_service: Dict[str, List[str]] = {}
        for target_arn, item in targets.items():
            svc = _arn_service(target_arn)
            if svc in _ACCESS_SERVICES and item["type"] != "log-group":
                targets_by_service.setdefault(svc, []).append(target_arn)

        out: List[Connection] = []
        for role_arn, statements in statements_by_role.items():
            who = principals.get(role_arn)
            if not who:
                continue
            grants: Dict[str, Tuple[set, set, set]] = {}   # target -> (classes, actions, policy names)
            for stmt, policy_name in statements:
                if str(stmt.get("Effect", "Allow")).lower() != "allow":
                    continue
                if "NotAction" in stmt or "NotResource" in stmt:
                    continue
                actions = [str(a) for a in _as_list(stmt.get("Action"))]
                resources = [str(r) for r in _as_list(stmt.get("Resource"))]
                if not actions or not resources:
                    continue
                classified = [(action, *classify_action(action)) for action in actions]
                services = {svc for _, _, svc in classified}
                candidate_services = targets_by_service.keys() if "*" in services else services & targets_by_service.keys()
                for svc in candidate_services:
                    for target_arn in targets_by_service[svc]:
                        if not any(resource_pattern_matches(r, target_arn) for r in resources):
                            continue
                        for action, cls, action_svc in classified:
                            if action_svc not in ("*", svc):
                                continue
                            classes, seen_actions, names = grants.setdefault(target_arn, (set(), set(), set()))
                            classes.add(cls)
                            seen_actions.add(action)
                            names.add(policy_name)
            role_name = (roles[role_arn].get("config") or {}).get("roleName") or service_identifier(role_arn)
            for target_arn, (classes, seen_actions, names) in grants.items():
                for principal in who:
                    if principal == target_arn:
                        continue
                    out.append(Connection(
                        principal, target_arn, "access", _summarise_access(classes),
                        via=role_name, actions=sorted(seen_actions)[:8],
                    ))
        return out

    # ------------------------------------------------------------ folding

    def _fold(self, emitted: List[Dict[str, Any]], targets: Dict[str, Dict[str, Any]]) -> None:
        """Mark sub-resources that belong inside their parent's inspector."""
        # Anything a sub-resource might name its parent by: the logical name
        # and every AWS id the config carries (instanceId, volumeId...). A
        # volume with a Name tag is called by that name but referenced by
        # its vol- id, and both must resolve.
        by_id: Dict[str, str] = {}
        for arn, item in targets.items():
            by_id.setdefault(item["name"], arn)
            if item.get("aws_name"):
                by_id.setdefault(item["aws_name"], arn)
            for key, value in (item.get("config") or {}).items():
                if key.endswith("Id") and isinstance(value, str) and value:
                    by_id.setdefault(value, arn)
        # A log group named for the thing that writes it belongs to that thing.
        by_type_name: Dict[Tuple[str, str], str] = {}
        for arn, item in targets.items():
            by_type_name[(item["type"], item["name"])] = arn
            if item.get("aws_name"):
                by_type_name[(item["type"], item["aws_name"])] = arn
        nat_by_allocation: Dict[str, str] = {}
        for item in emitted:
            if item["type"] == "nat-gateway":
                for addr in (item.get("_props") or {}).get("NatGatewayAddresses") or []:
                    if addr.get("AllocationId"):
                        nat_by_allocation[addr["AllocationId"]] = item["arn"]
        for item in emitted:
            props = item.get("_props") or {}
            parent: Optional[str] = None
            if item["type"] == "ebs-volume":
                for att in props.get("Attachments") or []:
                    if att.get("InstanceId") in by_id:
                        parent = by_id[att["InstanceId"]]
            elif item["type"] == "ebs-snapshot":
                vol = props.get("VolumeId")
                parent = by_id.get(vol) if vol else None
            elif item["type"] == "elastic-ip":
                # Attached to an instance, or held by a NAT gateway: the
                # address is a property of that thing. Unattached, it stays
                # a chip of its own, and a finding.
                inst = props.get("InstanceId")
                parent = by_id.get(inst) if inst else None
                if not parent:
                    parent = nat_by_allocation.get(props.get("AllocationId") or "")
            elif item["type"] == "log-group":
                parent = self._log_group_owner(item["config"].get("logGroupPath") or item["name"], by_id, by_type_name)
            elif item["type"] == GENERIC_TYPE:
                aws_type = item["config"].get("awsType", "")
                if aws_type == "AWS::Lambda::Function/Version":
                    base = item["arn"].rsplit(":", 1)[0]
                    parent = base if base in targets else None
                elif aws_type in ("AWS::Ssm::ManagedInstance", "AWS::SSM::ManagedInstance"):
                    parent = by_id.get(item["name"])
            if parent and parent != item["arn"]:
                item["folded_into"] = parent
        for item in emitted:
            item.pop("_props", None)

    @staticmethod
    def _log_group_owner(path: str, by_id: Dict[str, str], by_type_name: Dict[Tuple[str, str], str]) -> Optional[str]:
        """The ARN of the resource a well-known log group path belongs to."""
        m = re.match(r"^/aws/lambda/(.+)$", path)
        if m:
            # Only a function may claim it: a log group left behind by a
            # deleted function must not fold into some other resource that
            # happens to share the name.
            return by_type_name.get(("agent", m.group(1))) or by_type_name.get(("lambda", m.group(1)))
        m = re.match(r"^/aws/rds/(?:instance|cluster)/([^/]+)/", path)
        if m:
            return by_type_name.get(("rds-instance", m.group(1))) or by_type_name.get(("rds-cluster", m.group(1)))
        m = re.match(r"^/aws/eks/([^/]+)/", path)
        if m:
            return by_type_name.get(("eks-cluster", m.group(1)))
        m = re.match(r"^/aws/ecs/containerinsights/([^/]+)/", path)
        if m:
            return by_type_name.get(("ecs-cluster", m.group(1)))
        m = re.match(r"^/aws/vendedlogs/states/(.+?)-Logs$", path) or re.match(r"^/aws/states/(.+?)-Logs$", path)
        if m:
            return by_type_name.get(("step-functions", m.group(1)))
        m = re.match(r"^API-Gateway-Execution-Logs_([^/]+)/", path) or re.match(r"^/aws/apigateway/([^/]+)", path)
        if m:
            return by_type_name.get(("api-gateway", m.group(1)))
        return None

    # ------------------------------------------------------------ lambdas

    def _emit_lambda(self, r: Resource, seen: Dict[str, str], notes: List[EmitNote]) -> Optional[Dict[str, Any]]:
        props = r.properties or {}
        arn = r.physical_id or r.id
        aws_name = props.get("FunctionName") or r.id

        env_vars = (props.get("Environment") or {}).get("Variables") or {}
        environment: Dict[str, str] = {}
        if env_vars:
            if self.include_env_values:
                environment = {k: str(v) for k, v in sorted(env_vars.items())}
                notes.append(EmitNote(
                    level="warning", physical_id=arn,
                    message=f"{len(env_vars)} environment variable value(s) copied verbatim from "
                            f"'{aws_name}'; check for credentials before committing",
                ))
            else:
                environment = {k: REDACTED for k in sorted(env_vars)}

        common = {
            "runtime": props.get("Runtime"),
            "handler": props.get("Handler"),
            "memory": int(props["MemorySize"]) if props.get("MemorySize") else None,
            "timeout": int(props["Timeout"]) if props.get("Timeout") else None,
            "description": props.get("Description") or None,
        }
        common = {k: v for k, v in common.items() if v is not None}
        role_arn = props.get("Role")

        health = resource_health(LAMBDA_TYPE, props)
        if self.lambda_as == "lambda":
            config: Dict[str, Any] = {"functionName": aws_name, **common}
            arch = (props.get("Architectures") or [None])[0]
            if arch:
                config["architecture"] = arch
            if environment:
                config["environment"] = environment
            return {
                "name": aws_name, "type": "lambda", "arn": arn, "region": _region_of(r),
                "config": config, "tags": user_tags(r), "role_arn": role_arn, "health": health,
            }

        name = sanitize_agent_name(aws_name)
        if name is None:
            notes.append(EmitNote(
                level="warning", physical_id=arn,
                message=f"Lambda name '{aws_name}' cannot be an agent name; skipped. "
                        f"Re-run with Lambda functions as plain nodes to include it",
            ))
            return None
        if name != aws_name:
            notes.append(EmitNote(
                level="warning", physical_id=arn,
                message=f"Lambda '{aws_name}' shown as agent '{name}' to satisfy the agent name "
                        f"schema; deploying would create a new function rather than update this one",
            ))
        if name in seen:
            suffix = 2
            while f"{name}-{suffix}" in seen:
                suffix += 1
            name = f"{name}-{suffix}"
        seen[name] = arn

        config = {"name": name, "path": f"./agents/{name}", **common}
        if environment:
            config["environment"] = environment
        return {
            "name": name, "type": "agent", "arn": arn, "region": _region_of(r),
            "config": config, "tags": user_tags(r), "role_arn": role_arn, "health": health,
            "aws_name": aws_name,
        }

    def _lambda_connections(self, r: Resource, arn: str, identifiers: Dict[str, str]) -> List[Connection]:
        props = r.properties or {}
        out: List[Connection] = []

        if props.get("Role"):
            out.append(Connection(arn, props["Role"], "role", "execution role"))

        # Environment variables that name another resource are how functions
        # are actually wired to their tables, queues and buckets.
        for key, value in ((props.get("Environment") or {}).get("Variables") or {}).items():
            target = self._resolve(str(value), identifiers)
            if target and target != arn:
                out.append(Connection(arn, target, "reference", f"env {key}"))

        dlq = (props.get("DeadLetterConfig") or {}).get("TargetArn")
        if dlq:
            out.append(Connection(arn, dlq, "dlq", "async invocation DLQ"))

        for mapping in props.get("EventSourceMappings") or []:
            source = mapping.get("EventSourceArn")
            if source:
                # DynamoDB stream ARNs carry a /stream/<ts> suffix; the table is the node.
                source = re.sub(r"/stream/.*$", "", source)
                out.append(Connection(source, arn, "event-source", "event source mapping"))

        vpc = props.get("VpcConfig") or {}
        if vpc.get("VpcId"):
            target = self._resolve(vpc["VpcId"], identifiers)
            if target:
                out.append(Connection(arn, target, "vpc", "attached to VPC"))
        for subnet in vpc.get("SubnetIds") or []:
            target = self._resolve(subnet, identifiers)
            if target:
                out.append(Connection(arn, target, "vpc", "in subnet"))
        if props.get("KMSKeyArn"):
            out.append(Connection(arn, props["KMSKeyArn"], "reference", "encrypted with"))
        for sg in vpc.get("SecurityGroupIds") or []:
            target = self._resolve(sg, identifiers)
            if target:
                out.append(Connection(arn, target, "vpc", "security group"))

        log_group = self._resolve(f"/aws/lambda/{props.get('FunctionName') or r.id}", identifiers)
        if log_group:
            out.append(Connection(arn, log_group, "logs", "function log group"))
        return out

    # ---------------------------------------------------------- resources

    def _emit_role(self, r: Resource) -> Dict[str, Any]:
        props = r.properties or {}
        managed = [p.get("PolicyArn") for p in props.get("AttachedPolicies") or [] if p.get("PolicyArn")]
        config: Dict[str, Any] = {"roleName": props.get("RoleName") or r.id}
        if props.get("Description"):
            config["description"] = props["Description"]
        if managed:
            config["managedPolicies"] = ", ".join(managed)
        return {
            "name": config["roleName"], "type": "iam-role", "arn": r.physical_id or r.id,
            "region": None, "config": config, "tags": user_tags(r),
            "inline_policies": props.get("InlinePolicyNames") or [],
            "policy_documents": [d for d in (props.get("PolicyDocuments") or []) if isinstance(d, dict)],
        }

    def _emit_resource(self, r: Resource, canvas_type: str) -> Dict[str, Any]:
        props = r.properties or {}
        item: Dict[str, Any] = {
            "name": r.id,
            "type": canvas_type,
            "arn": r.physical_id or r.id,
            "region": _region_of(r),
            "config": self._resource_config(r, canvas_type),
            "tags": user_tags(r),
            "health": resource_health(r.type, props),
            "_props": props,
        }
        policy = props.get("ResourcePolicy") or props.get("KeyPolicy")
        if isinstance(policy, dict):
            item["resource_policy"] = policy
        return item

    def _resource_config(self, r: Resource, canvas_type: str) -> Dict[str, Any]:
        """The Visual Builder's fields for one node, from hydrated properties.

        Narrow on purpose: these are the fields the configuration form
        shows. Everything else stays reachable in the Explorer.
        """
        p = r.properties or {}
        name = r.id
        tag_name = (r.tags or {}).get("Name")

        if canvas_type == "s3":
            cfg: Dict[str, Any] = {"bucketName": p.get("BucketName") or name}
            cfg["versioning"] = p.get("Versioning") == "Enabled"
            rules = (p.get("Encryption") or {}).get("Rules") or []
            algo = ((rules[0].get("ApplyServerSideEncryptionByDefault") or {}).get("SSEAlgorithm")
                    if rules else None)
            cfg["encryption"] = algo if algo in ("AES256", "aws:kms") else ("none" if p.get("Encryption") is None else "AES256")
            block = p.get("PublicAccessBlock") or {}
            if block:
                cfg["blockPublicAccess"] = all(block.get(k) for k in (
                    "BlockPublicAcls", "IgnorePublicAcls", "BlockPublicPolicy", "RestrictPublicBuckets"))
            return cfg

        if canvas_type == "dynamodb":
            cfg = {"tableName": p.get("TableName") or name}
            types = {a.get("AttributeName"): a.get("AttributeType") for a in p.get("AttributeDefinitions") or []}
            for key in p.get("KeySchema") or []:
                attr = key.get("AttributeName")
                if key.get("KeyType") == "HASH":
                    cfg["partitionKey"] = attr
                    cfg["partitionKeyType"] = types.get(attr, "S")
                elif key.get("KeyType") == "RANGE":
                    cfg["sortKey"] = attr
                    cfg["sortKeyType"] = types.get(attr, "S")
            mode = (p.get("BillingModeSummary") or {}).get("BillingMode")
            cfg["billingMode"] = mode or ("PROVISIONED" if (p.get("ProvisionedThroughput") or {}).get("ReadCapacityUnits") else "PAY_PER_REQUEST")
            return cfg

        if canvas_type == "sqs":
            cfg = {"queueName": name, "fifo": str(p.get("FifoQueue", "false")).lower() == "true"}
            if p.get("VisibilityTimeout"):
                cfg["visibilityTimeout"] = int(p["VisibilityTimeout"])
            if p.get("MessageRetentionPeriod"):
                cfg["messageRetention"] = max(1, round(int(p["MessageRetentionPeriod"]) / 86400))
            if p.get("DelaySeconds"):
                cfg["delaySeconds"] = int(p["DelaySeconds"])
            return cfg

        if canvas_type == "sns":
            cfg = {"topicName": name, "fifo": str(p.get("FifoTopic", "false")).lower() == "true"}
            if p.get("DisplayName"):
                cfg["displayName"] = p["DisplayName"]
            return cfg

        if canvas_type == "kinesis-stream":
            return {"streamName": name}

        if canvas_type == "kinesis-firehose":
            return {"deliveryStreamName": name}

        if canvas_type == "eventbridge-rule":
            cfg = {"ruleName": p.get("Name") or name, "state": p.get("State", "ENABLED") == "ENABLED"}
            if p.get("Description"):
                cfg["description"] = p["Description"]
            if p.get("ScheduleExpression"):
                cfg["ruleType"] = "schedule"
                cfg["schedule"] = p["ScheduleExpression"]
            elif p.get("EventPattern"):
                cfg["ruleType"] = "pattern"
                cfg["eventPattern"] = p["EventPattern"] if isinstance(p["EventPattern"], str) else json.dumps(p["EventPattern"])
            return cfg

        if canvas_type == "eventbridge":
            return {"busName": name}

        if canvas_type == "eventbridge-pipes":
            return {"pipeName": name}

        if canvas_type == "api-gateway":
            cfg = {"apiName": p.get("Name") or name}
            types = (p.get("EndpointConfiguration") or {}).get("Types") or []
            if types:
                cfg["endpointType"] = types[0]
            return cfg

        if canvas_type == "security-group":
            cfg = {"groupName": p.get("GroupName") or name, "groupId": p.get("GroupId") or name, "isDefault": p.get("GroupName") == "default"}
            if p.get("Description"):
                cfg["description"] = p["Description"]
            rules = []
            open_world = False
            for perm in p.get("IpPermissions") or []:
                proto = perm.get("IpProtocol", "-1")
                ports = "all" if proto == "-1" else (
                    str(perm.get("FromPort")) if perm.get("FromPort") == perm.get("ToPort")
                    else f"{perm.get('FromPort')}-{perm.get('ToPort')}")
                proto_label = "any" if proto == "-1" else proto
                sources = [r.get("CidrIp") for r in perm.get("IpRanges") or []]
                sources += [r.get("CidrIpv6") for r in perm.get("Ipv6Ranges") or []]
                sources += [f"sg {g.get('GroupId')}" for g in perm.get("UserIdGroupPairs") or []]
                sources += [f"prefix list {g.get('PrefixListId')}" for g in perm.get("PrefixListIds") or []]
                if any(src in ("0.0.0.0/0", "::/0") for src in sources):
                    open_world = True
                for src in sources or ["(none)"]:
                    rules.append(f"{proto_label} {ports} from {src}")
            cfg["inboundRules"] = rules
            cfg["openToWorld"] = open_world
            return cfg

        if canvas_type == "vpc":
            # The default VPC is AWS's, not the operator's: say so instead of
            # showing an id nobody chose. The id stays in the config.
            is_default = bool(p.get("IsDefault"))
            cfg = {"name": tag_name or ("Default VPC" if is_default else name), "vpcId": p.get("VpcId") or name, "isDefault": is_default}
            if p.get("CidrBlock"):
                cfg["cidrBlock"] = p["CidrBlock"]
            return cfg

        if canvas_type == "log-group":
            cfg = {"logGroupPath": p.get("logGroupName") or name}
            if p.get("retentionInDays"):
                cfg["retentionDays"] = p["retentionInDays"]
            if p.get("storedBytes") is not None:
                cfg["storedBytes"] = p["storedBytes"]
            return cfg

        if canvas_type == "secrets-manager":
            cfg = {"secretName": p.get("Name") or name}
            if p.get("Description"):
                cfg["description"] = p["Description"]
            return cfg

        if canvas_type == "ssm-parameter":
            cfg = {"parameterName": p.get("Name") or name}
            if p.get("Type"):
                cfg["type"] = p["Type"]
                cfg["secure"] = p["Type"] == "SecureString"
            if p.get("Tier"):
                cfg["tier"] = p["Tier"]
            if p.get("Description"):
                cfg["description"] = p["Description"]
            return cfg

        if canvas_type == "step-functions":
            cfg = {"stateMachineName": p.get("name") or name}
            if p.get("type"):
                cfg["type"] = p["type"]
            if p.get("description"):
                cfg["description"] = p["description"]
            return cfg

        if canvas_type == "cloudwatch-alarm":
            return {"alarmName": name}

        if canvas_type == "cloudwatch-dashboard":
            return {"name": name}

        if canvas_type == "ecr":
            return {"repositoryName": name}

        if canvas_type == "ec2-instance":
            cfg = {"name": tag_name or (p.get("InstanceId") or name), "instanceId": p.get("InstanceId") or name}
            for src, dst in (("InstanceType", "instanceType"), ("PrivateIpAddress", "privateIp"),
                             ("PublicIpAddress", "publicIp"), ("ImageId", "imageId")):
                if p.get(src):
                    cfg[dst] = p[src]
            if (p.get("State") or {}).get("Name"):
                cfg["state"] = p["State"]["Name"]
            if p.get("KeyName"):
                cfg["keyName"] = p["KeyName"]
            profile_arn = (p.get("IamInstanceProfile") or {}).get("Arn")
            if profile_arn:
                cfg["instanceProfile"] = profile_arn.rsplit("/", 1)[-1]
            if (p.get("MetadataOptions") or {}).get("HttpTokens"):
                cfg["imdsv2"] = p["MetadataOptions"]["HttpTokens"] == "required"
            return cfg

        if canvas_type == "subnet":
            is_default = bool(p.get("DefaultForAz"))
            cfg = {"name": tag_name or ("Default subnet" if is_default else name), "subnetId": p.get("SubnetId") or name, "isDefault": is_default}
            if p.get("CidrBlock"):
                cfg["cidrBlock"] = p["CidrBlock"]
            if p.get("AvailabilityZone"):
                cfg["availabilityZone"] = p["AvailabilityZone"]
            if "MapPublicIpOnLaunch" in p:
                cfg["public"] = bool(p["MapPublicIpOnLaunch"])
            return cfg

        if canvas_type == "internet-gateway":
            return {"name": tag_name or "Internet gateway", "gatewayId": p.get("InternetGatewayId") or name}

        if canvas_type == "nat-gateway":
            cfg = {"name": tag_name or "NAT gateway", "natGatewayId": p.get("NatGatewayId") or name}
            if p.get("State"):
                cfg["state"] = p["State"]
            ips = [a.get("PublicIp") for a in p.get("NatGatewayAddresses") or [] if a.get("PublicIp")]
            if ips:
                cfg["publicIp"] = ", ".join(ips)
            return cfg

        if canvas_type == "route-table":
            is_main = any(a.get("Main") for a in p.get("Associations") or [])
            cfg = {"name": tag_name or ("Main route table" if is_main else name), "routeTableId": p.get("RouteTableId") or name, "isMain": is_main}
            routes = []
            for route in p.get("Routes") or []:
                dest = route.get("DestinationCidrBlock") or route.get("DestinationPrefixListId") or "?"
                target = (route.get("GatewayId") or route.get("NatGatewayId") or route.get("VpcPeeringConnectionId")
                          or route.get("TransitGatewayId") or route.get("InstanceId") or route.get("NetworkInterfaceId") or "local")
                routes.append(f"{dest} -> {target}")
            if routes:
                cfg["routes"] = "\n".join(routes)
            return cfg

        if canvas_type == "vpc-endpoint":
            cfg = {"name": tag_name or name}
            if p.get("ServiceName"):
                cfg["serviceName"] = p["ServiceName"]
            if p.get("VpcEndpointType"):
                cfg["endpointType"] = p["VpcEndpointType"]
            return cfg

        if canvas_type == "elastic-ip":
            cfg = {"name": tag_name or name}
            if p.get("PublicIp"):
                cfg["publicIp"] = p["PublicIp"]
            return cfg

        if canvas_type == "load-balancer":
            cfg = {"name": p.get("LoadBalancerName") or name}
            for src, dst in (("Scheme", "scheme"), ("Type", "lbType"), ("DNSName", "dnsName")):
                if p.get(src):
                    cfg[dst] = p[src]
            listeners = [f"{l.get('Protocol') or ''} {l.get('Port') or ''}".strip() for l in p.get("Listeners") or []]
            if listeners:
                cfg["listeners"] = ", ".join(listeners)
            groups = p.get("TargetGroups") or []
            if groups:
                healthy = sum(1 for g in groups for t in g.get("Targets") or [] if t.get("State") == "healthy")
                total = sum(len(g.get("Targets") or []) for g in groups)
                cfg["targets"] = f"{healthy}/{total} healthy across {len(groups)} target group{'s' if len(groups) != 1 else ''}"
            return cfg

        if canvas_type == "ebs-volume":
            cfg = {"name": tag_name or name, "volumeId": p.get("VolumeId") or name}
            if p.get("Size"):
                cfg["size"] = p["Size"]
            if p.get("VolumeType"):
                cfg["volumeType"] = p["VolumeType"]
            if "Encrypted" in p:
                cfg["encrypted"] = bool(p["Encrypted"])
            return cfg

        if canvas_type == "ebs-snapshot":
            cfg = {"name": tag_name or name, "snapshotId": p.get("SnapshotId") or name}
            if p.get("StartTime"):
                cfg["taken"] = str(p["StartTime"])[:10]
            if p.get("VolumeSize"):
                cfg["size"] = p["VolumeSize"]
            if p.get("Description"):
                cfg["description"] = p["Description"]
            return cfg

        if canvas_type == "cloudfront":
            dist = p.get("DistributionConfig") or {}
            aliases = (dist.get("Aliases") or {}).get("Items") or []
            cfg = {"name": tag_name or (aliases[0] if aliases else None) or p.get("Id") or name, "distributionId": p.get("Id") or name}
            if p.get("DomainName"):
                cfg["domainName"] = p["DomainName"]
            if aliases:
                cfg["aliases"] = ", ".join(aliases)
            if "Enabled" in dist:
                cfg["enabled"] = bool(dist["Enabled"])
            if dist.get("Comment"):
                cfg["description"] = dist["Comment"]
            return cfg

        if canvas_type == "route53-zone":
            cfg = {"name": p.get("Name") or name}
            if p.get("ResourceRecordSetCount") is not None:
                cfg["recordCount"] = p["ResourceRecordSetCount"]
            if (p.get("Config") or {}).get("PrivateZone") is not None:
                cfg["privateZone"] = bool(p["Config"]["PrivateZone"])
            return cfg

        if canvas_type == "kms-key":
            cfg = {"name": tag_name or p.get("Description") or p.get("KeyId") or name}
            if p.get("KeyId"):
                cfg["keyId"] = p["KeyId"]
            if p.get("KeyState"):
                cfg["keyState"] = p["KeyState"]
            if p.get("Description"):
                cfg["description"] = p["Description"]
            return cfg

        if canvas_type == "acm-certificate":
            cfg = {"name": p.get("DomainName") or name}
            if p.get("Status"):
                cfg["status"] = p["Status"]
            if p.get("NotAfter"):
                cfg["notAfter"] = str(p["NotAfter"])[:10]
            alts = [a for a in p.get("SubjectAlternativeNames") or [] if a != p.get("DomainName")]
            if alts:
                cfg["alternativeNames"] = ", ".join(alts)
            return cfg

        if canvas_type == "iam-instance-profile":
            cfg = {"name": p.get("InstanceProfileName") or name}
            role_names = [role.get("RoleName") for role in p.get("Roles") or [] if role.get("RoleName")]
            if role_names:
                cfg["roles"] = ", ".join(role_names)
            return cfg

        if canvas_type == "rds-instance":
            cfg = {"name": p.get("DBInstanceIdentifier") or name}
            if p.get("Engine"):
                cfg["engine"] = f"{p['Engine']} {p.get('EngineVersion', '')}".strip()
            if p.get("DBInstanceClass"):
                cfg["instanceClass"] = p["DBInstanceClass"]
            if (p.get("Endpoint") or {}).get("Address"):
                cfg["endpoint"] = f"{p['Endpoint']['Address']}:{p['Endpoint'].get('Port', '')}".rstrip(":")
            if "MultiAZ" in p:
                cfg["multiAz"] = bool(p["MultiAZ"])
            return cfg

        if canvas_type == GENERIC_TYPE:
            cfg = {"name": tag_name or name, "awsType": r.type}
            if r.type == "AWS::EC2::KeyPair" and p.get("KeyName"):
                # Instances name their key pair, not its id.
                cfg["name"] = p["KeyName"]
                cfg["keyName"] = p["KeyName"]
                if p.get("KeyType"):
                    cfg["keyType"] = p["KeyType"]
            return cfg

        return {"name": tag_name or name}

    def _resource_connections(self, r: Resource, arn: str, identifiers: Dict[str, str]) -> List[Connection]:
        p = r.properties or {}
        out: List[Connection] = []

        # Encryption keys: every type that names one draws "encrypted with".
        kms = None
        if r.type == "AWS::S3::Bucket":
            rules = (p.get("Encryption") or {}).get("Rules") or []
            kms = (rules[0].get("ApplyServerSideEncryptionByDefault") or {}).get("KMSMasterKeyID") if rules else None
        elif r.type in ("AWS::SQS::Queue", "AWS::SNS::Topic"):
            kms = p.get("KmsMasterKeyId")
        elif r.type == "AWS::SecretsManager::Secret":
            kms = p.get("KmsKeyId")
        elif r.type == "AWS::DynamoDB::Table":
            kms = (p.get("SSEDescription") or {}).get("KMSMasterKeyArn")
        elif r.type == "AWS::Logs::LogGroup":
            kms = p.get("kmsKeyId")
        if kms:
            target = self._resolve(kms, identifiers)
            if target and target != arn:
                out.append(Connection(arn, target, "reference", "encrypted with"))

        if r.type == "AWS::Events::Rule":
            for target in p.get("Targets") or []:
                if target.get("Arn"):
                    out.append(Connection(arn, target["Arn"], "event-target", f"rule target {target.get('Id', '')}".strip()))

        elif r.type == "AWS::SQS::Queue":
            redrive = p.get("RedrivePolicy")
            if isinstance(redrive, str):
                try:
                    redrive = json.loads(redrive)
                except ValueError:
                    redrive = None
            if isinstance(redrive, dict) and redrive.get("deadLetterTargetArn"):
                out.append(Connection(arn, redrive["deadLetterTargetArn"], "dlq", "redrive policy"))

        elif r.type == "AWS::SNS::Topic":
            for sub in p.get("Subscriptions") or []:
                endpoint = sub.get("Endpoint") or ""
                target = self._resolve(endpoint, identifiers)
                if target:
                    out.append(Connection(arn, target, "event-target", f"{sub.get('Protocol', '')} subscription".strip()))

        elif r.type == "AWS::EC2::Instance":
            for key, kind, detail in (("SubnetId", "vpc", "in subnet"), ("VpcId", "vpc", "in VPC")):
                target = self._resolve(p.get(key) or "", identifiers)
                if target:
                    out.append(Connection(arn, target, kind, detail))
            for sg in p.get("SecurityGroups") or []:
                target = self._resolve(sg.get("GroupId") or "", identifiers)
                if target:
                    out.append(Connection(arn, target, "vpc", "security group"))
            profile = (p.get("IamInstanceProfile") or {}).get("Arn")
            if profile:
                out.append(Connection(arn, profile, "role", "instance profile"))
            key = self._resolve(p.get("KeyName") or "", identifiers)
            if key:
                out.append(Connection(arn, key, "reference", "key pair"))
            for mapping in p.get("BlockDeviceMappings") or []:
                vol = (mapping.get("Ebs") or {}).get("VolumeId")
                target = self._resolve(vol or "", identifiers)
                if target:
                    out.append(Connection(arn, target, "reference", f"volume {mapping.get('DeviceName', '')}".strip()))

        elif r.type in ("AWS::EC2::Subnet", "AWS::EC2::SecurityGroup", "AWS::EC2::VPCEndpoint", "AWS::EC2::NatGateway"):
            vpc = self._resolve(p.get("VpcId") or "", identifiers)
            if vpc:
                out.append(Connection(arn, vpc, "vpc", "in VPC"))
            if r.type == "AWS::EC2::NatGateway":
                subnet = self._resolve(p.get("SubnetId") or "", identifiers)
                if subnet:
                    out.append(Connection(arn, subnet, "vpc", "in subnet"))
            if r.type == "AWS::EC2::VPCEndpoint":
                # An interface endpoint has a foot in each subnet and a
                # security group; a gateway endpoint is a route. Neither is
                # containment, so the details stay clear of "in subnet".
                for subnet_id in p.get("SubnetIds") or []:
                    subnet = self._resolve(subnet_id, identifiers)
                    if subnet:
                        out.append(Connection(arn, subnet, "vpc", "interface in subnet"))
                for rt_id in p.get("RouteTableIds") or []:
                    rt = self._resolve(rt_id, identifiers)
                    if rt:
                        out.append(Connection(rt, arn, "vpc", "route to endpoint"))
                for group in p.get("Groups") or []:
                    sg = self._resolve(group.get("GroupId") or "", identifiers)
                    if sg:
                        out.append(Connection(arn, sg, "vpc", "security group"))
            if r.type == "AWS::EC2::SecurityGroup":
                # Rules that admit another group draw the trust between them.
                for perm in (p.get("IpPermissions") or []):
                    for pair in perm.get("UserIdGroupPairs") or []:
                        other = self._resolve(pair.get("GroupId") or "", identifiers)
                        if other and other != arn:
                            out.append(Connection(other, arn, "vpc", "allowed inbound"))

        elif r.type == "AWS::EC2::InternetGateway":
            for att in p.get("Attachments") or []:
                vpc = self._resolve(att.get("VpcId") or "", identifiers)
                if vpc:
                    out.append(Connection(arn, vpc, "vpc", "attached to VPC"))

        elif r.type == "AWS::EC2::RouteTable":
            vpc = self._resolve(p.get("VpcId") or "", identifiers)
            if vpc:
                out.append(Connection(arn, vpc, "vpc", "in VPC"))
            for assoc in p.get("Associations") or []:
                subnet = self._resolve(assoc.get("SubnetId") or "", identifiers)
                if subnet:
                    out.append(Connection(subnet, arn, "vpc", "routes via"))
            for route in p.get("Routes") or []:
                target = self._resolve(route.get("GatewayId") or route.get("NatGatewayId") or "", identifiers)
                if target:
                    out.append(Connection(arn, target, "vpc", f"route {route.get('DestinationCidrBlock', '')}".strip()))

        elif r.type == "AWS::EC2::Volume":
            for att in p.get("Attachments") or []:
                inst = self._resolve(att.get("InstanceId") or "", identifiers)
                if inst:
                    out.append(Connection(inst, arn, "reference", f"volume {att.get('Device', '')}".strip()))

        elif r.type == "AWS::EC2::Snapshot":
            vol = self._resolve(p.get("VolumeId") or "", identifiers)
            if vol:
                out.append(Connection(arn, vol, "reference", "snapshot of"))

        elif r.type in ("AWS::ElasticLoadBalancingV2::LoadBalancer", "AWS::ElasticLoadBalancing::LoadBalancer"):
            vpc = self._resolve(p.get("VpcId") or "", identifiers)
            if vpc:
                out.append(Connection(arn, vpc, "vpc", "in VPC"))
            for az in p.get("AvailabilityZones") or []:
                subnet = self._resolve(az.get("SubnetId") or "", identifiers)
                if subnet:
                    out.append(Connection(arn, subnet, "vpc", "in subnet"))
            for sg in p.get("SecurityGroups") or []:
                target = self._resolve(sg, identifiers)
                if target:
                    out.append(Connection(arn, target, "vpc", "security group"))
            # Traffic: each listener forwards to target groups, each target
            # group to instances, functions or addresses. The edge goes to
            # the target, labelled with the port and the group, so the path
            # a request takes is one line per hop.
            ports_by_group: Dict[str, List[str]] = {}
            for listener in p.get("Listeners") or []:
                label = f"{listener.get('Protocol') or ''} {listener.get('Port') or ''}".strip()
                for tg_arn in listener.get("TargetGroupArns") or []:
                    ports_by_group.setdefault(tg_arn, []).append(label)
            for tg in p.get("TargetGroups") or []:
                listens = ", ".join(ports_by_group.get(tg.get("TargetGroupArn") or "", [])) or "no listener"
                for target in tg.get("Targets") or []:
                    hit = self._resolve(target.get("Id") or "", identifiers)
                    if hit:
                        state = target.get("State")
                        detail = f"{listens} -> {tg.get('TargetGroupName') or 'target group'}"
                        if state and state != "healthy":
                            detail += f" ({state})"
                        out.append(Connection(arn, hit, "invokes", detail))

        elif r.type in ("AWS::CloudFront::Distribution", "AWS::Cloudfront::Distribution"):
            dist = p.get("DistributionConfig") or {}
            for origin in (dist.get("Origins") or {}).get("Items") or []:
                target = self._resolve(origin.get("DomainName") or "", identifiers)
                if target and target != arn:
                    out.append(Connection(arn, target, "origin", f"origin {origin.get('Id', '')}".strip()))
            cert = (dist.get("ViewerCertificate") or {}).get("ACMCertificateArn")
            if cert:
                out.append(Connection(arn, cert, "reference", "TLS certificate"))

        elif r.type in ("AWS::Route53::HostedZone", "AWS::Route53::Hostedzone"):
            for rec in p.get("Records") or []:
                candidates = [rec.get("Alias")] if rec.get("Alias") else (rec.get("Values") or [])
                for value in candidates:
                    target = self._resolve(str(value or "").rstrip("."), identifiers)
                    if target and target != arn:
                        out.append(Connection(arn, target, "dns", f"{rec.get('Type')} {str(rec.get('Name') or '').rstrip('.')}".strip()))

        elif r.type == "AWS::IAM::InstanceProfile":
            for role in p.get("Roles") or []:
                if role.get("Arn"):
                    out.append(Connection(arn, role["Arn"], "role", "profile role"))

        elif r.type == "AWS::RDS::DBInstance":
            for sn in (p.get("DBSubnetGroup") or {}).get("Subnets") or []:
                subnet = self._resolve(sn.get("SubnetIdentifier") or "", identifiers)
                if subnet:
                    out.append(Connection(arn, subnet, "vpc", "in subnet group"))
            for sg in p.get("VpcSecurityGroups") or []:
                target = self._resolve(sg.get("VpcSecurityGroupId") or "", identifiers)
                if target:
                    out.append(Connection(arn, target, "vpc", "security group"))
            vpc = self._resolve((p.get("DBSubnetGroup") or {}).get("VpcId") or "", identifiers)
            if vpc:
                out.append(Connection(arn, vpc, "vpc", "in VPC"))
            if p.get("KmsKeyId"):
                out.append(Connection(arn, p["KmsKeyId"], "reference", "encrypted with"))

        elif r.type == "AWS::StepFunctions::StateMachine":
            definition = p.get("definition") or ""
            if isinstance(definition, str):
                for found in set(_ARN_RE.findall(definition)):
                    target = self._resolve(found, identifiers)
                    if target and target != arn:
                        out.append(Connection(arn, target, "invokes", "referenced in definition"))
            if p.get("roleArn"):
                out.append(Connection(arn, p["roleArn"], "role", "execution role"))

        return out

    # ------------------------------------------------------------ helpers

    def _identifiers(self, r: Resource) -> List[str]:
        """Every string that could stand for this resource in another's config."""
        ids = [r.physical_id or "", r.id or ""]
        p = r.properties or {}
        # A resource is named by its own id, not by the ids of what contains
        # it: a subnet's VpcId must not make the subnet answer for the VPC.
        parent_keys = {
            "AWS::EC2::Subnet": {"VpcId"},
            "AWS::EC2::SecurityGroup": {"VpcId"},
            "AWS::EC2::NatGateway": {"VpcId", "SubnetId"},
            "AWS::EC2::RouteTable": {"VpcId"},
            "AWS::EC2::VPCEndpoint": {"VpcId"},
            "AWS::EC2::Instance": {"VpcId", "SubnetId", "KeyName"},
            "AWS::EC2::Snapshot": {"VolumeId"},
            "AWS::EC2::EIP": {"InstanceId"},
            "AWS::RDS::DBInstance": {"KmsKeyId"},
        }.get(r.type, set())
        p = {k: v for k, v in p.items() if k not in parent_keys}
        for key in ("FunctionName", "TableName", "BucketName", "QueueUrl", "QueueArn", "TopicArn",
                    "logGroupName", "Name", "stateMachineArn", "VpcId", "GroupId", "ARN",
                    "InstanceId", "SubnetId", "InternetGatewayId", "NatGatewayId", "RouteTableId",
                    "VpcEndpointId", "VolumeId", "SnapshotId", "AllocationId", "KeyId", "Arn",
                    "LoadBalancerArn", "CertificateArn", "DBInstanceArn", "Id", "KeyPairId", "KeyName",
                    # DNS names and addresses, so records and origins resolve.
                    "DomainName", "DNSName", "PublicDnsName", "PublicIpAddress", "PublicIp"):
            if p.get(key):
                ids.append(str(p[key]).rstrip(".").lower())
        if r.type == "AWS::SQS::Queue":
            # Queue URLs appear in environment variables far more than ARNs do.
            url = p.get("QueueUrl") or (r.physical_id if str(r.physical_id or "").startswith("https://") else "")
            if url:
                ids.append(url)
                from_url = sqs_url_to_arn(url)
                if from_url:
                    ids.append(from_url)
        return [i for i in ids if i]

    def _resolve(self, value: str, identifiers: Dict[str, str]) -> Optional[str]:
        """The ARN of the included resource this value names, if any."""
        if not value:
            return None
        if value in identifiers:
            return identifiers[value]
        # A value can be a URL or ARN with a trailing slash or stage suffix.
        stripped = value.rstrip("/")
        if stripped in identifiers:
            return identifiers[stripped]
        as_arn = sqs_url_to_arn(value)
        if as_arn and as_arn in identifiers:
            return identifiers[as_arn]
        # Hostnames: a record's target or a distribution's origin. S3 shows up
        # as bucket.s3(.region).amazonaws.com or a website endpoint.
        host = stripped.lower()
        if "://" in host:
            host = host.split("://", 1)[1].split("/", 1)[0]
        if host in identifiers:
            return identifiers[host]
        if ".s3-website" in host or ".s3." in host or host.endswith(".s3.amazonaws.com"):
            bucket = host.split(".s3", 1)[0]
            if bucket in identifiers:
                return identifiers[bucket]
        return None
