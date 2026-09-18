"""Taking over a resource that something else deployed.

An adopted resource is observed: it is in the state so a plan knows it
exists, but a deploy never touches it and a destroy never removes it. Taking
it over makes it warpcore's: from then on its config on the canvas is what
the deploy enforces, and removing it from the canvas removes it from AWS.

Two things make that safe. First, the state entry is rewritten in the
provisioner's own property names, from the hydrated description the scan
took, so the first plan after a take-over is a no-op rather than a rewrite
of everything. Second, the resource keeps its bindings: an existing function
keeps its role and its code; the compiler does not invent a new role or a
stub for something that already runs.

Take-over never calls AWS and never edits the other framework's state. It
says what that framework needs told (release_steps), and leaves that to the
operator, because `terraform state rm` and its cousins are the kind of
command a person should run on purpose.
"""

import json
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from warpcore.state.manager import StateManager
from warpcore.state.models import Resource
from warpcore.utils.logging import get_logger

logger = get_logger(__name__)

# ------------------------------------------------------------ normalising


def _json(value: Any) -> Any:
    if isinstance(value, str):
        try:
            return json.loads(value)
        except ValueError:
            return value
    return value


def normalise(aws_type: str, props: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """The hydrated description of a resource, in its provisioner's property
    names. None for a type no provisioner manages."""
    p = props or {}
    if aws_type == "AWS::Lambda::Function":
        out: Dict[str, Any] = {
            "FunctionName": p.get("FunctionName"),
            "Runtime": p.get("Runtime"),
            "Role": p.get("Role"),
            "Handler": p.get("Handler"),
            "MemorySize": p.get("MemorySize"),
            "Timeout": p.get("Timeout"),
            "Environment": dict((p.get("Environment") or {}).get("Variables") or {}),
            "TracingConfig": p.get("TracingConfig") or {"Mode": "PassThrough"},
        }
        if p.get("VpcConfig") and (p["VpcConfig"].get("SubnetIds") or p["VpcConfig"].get("SecurityGroupIds")):
            out["VpcConfig"] = {"SubnetIds": list(p["VpcConfig"].get("SubnetIds") or []), "SecurityGroupIds": list(p["VpcConfig"].get("SecurityGroupIds") or [])}
        if p.get("DeadLetterConfig"):
            out["DeadLetterConfig"] = dict(p["DeadLetterConfig"])
        if p.get("CodeSha256"):
            out["CodeSha256"] = p["CodeSha256"]
        return {k: v for k, v in out.items() if v is not None}
    if aws_type == "AWS::IAM::Role":
        inline: Dict[str, Any] = {}
        for doc in p.get("PolicyDocuments") or []:
            if isinstance(doc, dict) and doc.get("source") == "inline" and doc.get("name"):
                inline[doc["name"]] = doc.get("document") or {}
        return {
            "RoleName": p.get("RoleName"),
            "AssumeRolePolicyDocument": _json(p.get("AssumeRolePolicyDocument")) or {},
            "InlinePolicies": inline,
            "ManagedPolicyArns": sorted(a.get("PolicyArn") for a in (p.get("AttachedPolicies") or []) if a.get("PolicyArn")),
            **({"Description": p["Description"]} if p.get("Description") else {}),
        }
    if aws_type == "AWS::S3::Bucket":
        enc = p.get("Encryption")
        return {
            "BucketName": p.get("BucketName"),
            "VersioningStatus": p.get("Versioning") or "Disabled",
            **({"EncryptionConfiguration": enc} if enc else {}),
        }
    if aws_type == "AWS::DynamoDB::Table":
        out = {
            "TableName": p.get("TableName"),
            "KeySchema": [{"AttributeName": k.get("AttributeName"), "KeyType": k.get("KeyType")} for k in p.get("KeySchema") or []],
            "AttributeDefinitions": [{"AttributeName": a.get("AttributeName"), "AttributeType": a.get("AttributeType")} for a in p.get("AttributeDefinitions") or []],
            "BillingMode": (p.get("BillingModeSummary") or {}).get("BillingMode")
            or ("PROVISIONED" if (p.get("ProvisionedThroughput") or {}).get("ReadCapacityUnits") else "PAY_PER_REQUEST"),
        }
        if out["BillingMode"] == "PROVISIONED":
            t = p.get("ProvisionedThroughput") or {}
            out["ProvisionedThroughput"] = {"ReadCapacityUnits": t.get("ReadCapacityUnits"), "WriteCapacityUnits": t.get("WriteCapacityUnits")}
        if (p.get("StreamSpecification") or {}).get("StreamEnabled"):
            out["StreamSpecification"] = {"StreamEnabled": True, "StreamViewType": p["StreamSpecification"].get("StreamViewType")}
        return out
    if aws_type == "AWS::SQS::Queue":
        arn = p.get("QueueArn") or ""
        out = {"QueueName": arn.rsplit(":", 1)[-1] if arn else None}
        for src, dst in (("VisibilityTimeout", "VisibilityTimeout"), ("MessageRetentionPeriod", "MessageRetentionPeriod"),
                         ("MaximumMessageSize", "MaximumMessageSize"), ("DelaySeconds", "DelaySeconds"),
                         ("ReceiveMessageWaitTimeSeconds", "ReceiveMessageWaitTimeSeconds")):
            if p.get(src) is not None:
                out[dst] = int(p[src])
        if str(p.get("FifoQueue", "false")).lower() == "true":
            out["FifoQueue"] = True
            if str(p.get("ContentBasedDeduplication", "false")).lower() == "true":
                out["ContentBasedDeduplication"] = True
        if p.get("RedrivePolicy"):
            out["RedrivePolicy"] = _json(p["RedrivePolicy"])
        if p.get("KmsMasterKeyId"):
            out["KmsMasterKeyId"] = p["KmsMasterKeyId"]
        if arn:
            out["QueueArn"] = arn
        return out
    if aws_type == "AWS::SNS::Topic":
        arn = p.get("TopicArn") or ""
        out = {"TopicName": arn.rsplit(":", 1)[-1] if arn else None}
        if p.get("DisplayName"):
            out["DisplayName"] = p["DisplayName"]
        if str(p.get("FifoTopic", "false")).lower() == "true":
            out["FifoTopic"] = True
        if p.get("KmsMasterKeyId"):
            out["KmsMasterKeyId"] = p["KmsMasterKeyId"]
        return out
    if aws_type == "AWS::Logs::LogGroup":
        return {
            "ResourceType": "LogGroup",
            "LogGroupName": p.get("logGroupName"),
            **({"RetentionInDays": p["retentionInDays"]} if p.get("retentionInDays") else {}),
        }
    if aws_type == "AWS::EC2::VPC":
        return {"CidrBlock": p.get("CidrBlock")}
    if aws_type == "AWS::EC2::SecurityGroup":
        return {
            "GroupName": p.get("GroupName"),
            "Description": p.get("Description"),
            "VpcId": p.get("VpcId"),
            "IngressRules": list(p.get("IpPermissions") or []),
            "EgressRules": list(p.get("IpPermissionsEgress") or []),
        }
    return None


# The AWS types a take-over can hand to a provisioner.
TAKEOVER_TYPES = {
    "AWS::Lambda::Function", "AWS::IAM::Role", "AWS::S3::Bucket", "AWS::DynamoDB::Table", "AWS::SQS::Queue",
    "AWS::SNS::Topic", "AWS::Logs::LogGroup", "AWS::EC2::VPC", "AWS::EC2::SecurityGroup",
}


# --------------------------------------------------------------- take-over


@dataclass
class TakeoverItem:
    resource_id: str
    resource_type: str
    physical_id: Optional[str]
    action: str          # "taken" | "already" | "unsupported" | "not-found" | "not-adopted"
    detail: str = ""
    provenance: Dict[str, Any] = field(default_factory=dict)


@dataclass
class TakeoverResult:
    items: List[TakeoverItem] = field(default_factory=list)
    release: List[str] = field(default_factory=list)

    def taken(self) -> List[TakeoverItem]:
        return [i for i in self.items if i.action == "taken"]

    def to_dict(self) -> Dict[str, Any]:
        return {
            "items": [i.__dict__ for i in self.items],
            "release": self.release,
            "taken": len(self.taken()),
        }


def _match(resource: Resource, wanted: str) -> bool:
    return wanted == resource.id or wanted == resource.physical_id or (
        resource.physical_id is not None and resource.physical_id.endswith("/" + wanted)
    ) or (resource.physical_id is not None and resource.physical_id.endswith(":" + wanted))


def take_over(state_manager: StateManager, wanted: List[str], dry_run: bool = False) -> TakeoverResult:
    """Mark adopted resources as managed and rewrite them in provisioner terms.

    `wanted` are logical ids, ARNs, or the tail of an ARN (a function name,
    a table name). Nothing is written when `dry_run`.
    """
    state = state_manager.load()
    result = TakeoverResult()
    seen = set()
    for want in wanted:
        hits = [(stack, r) for stack, r in state.all_resources() if _match(r, want)]
        if not hits:
            result.items.append(TakeoverItem(want, "", None, "not-found", "no such resource in the state; adopt it first"))
            continue
        for stack, r in hits:
            if r.id in seen:
                continue
            seen.add(r.id)
            meta = r.metadata or {}
            provenance = meta.get("provenance") or {}
            if meta.get("managed"):
                result.items.append(TakeoverItem(r.id, r.type, r.physical_id, "already", "already managed by this project", provenance))
                continue
            if not meta.get("adopted"):
                result.items.append(TakeoverItem(r.id, r.type, r.physical_id, "not-adopted", "created by warpcore; nothing to take over", provenance))
                continue
            if r.type not in TAKEOVER_TYPES:
                result.items.append(TakeoverItem(r.id, r.type, r.physical_id, "unsupported", f"no provisioner manages {r.type}; it stays observed", provenance))
                continue
            normalised = normalise(r.type, r.properties)
            if not normalised:
                result.items.append(TakeoverItem(r.id, r.type, r.physical_id, "unsupported", "could not read its configuration into provisioner terms", provenance))
                continue
            if not dry_run:
                r.properties = normalised
                r.metadata = {**meta, "managed": True, "taken_over_from": provenance.get("manager") or "account"}
            result.items.append(TakeoverItem(r.id, r.type, r.physical_id, "taken", "", provenance))
    if not dry_run and result.taken():
        state_manager.save(state)
    result.release = release_steps([i.provenance for i in result.taken()])
    return result


# ------------------------------------------------------------ releasing


def release_steps(provenances: List[Dict[str, Any]]) -> List[str]:
    """What the previous manager has to be told, grouped, so two tools do not
    fight over one resource. Text for a person; never executed here."""
    by_manager: Dict[str, List[Dict[str, Any]]] = {}
    for p in provenances:
        if p and p.get("manager"):
            by_manager.setdefault(p["manager"], []).append(p)
    steps: List[str] = []
    for manager, items in by_manager.items():
        if manager in ("terraform", "opentofu"):
            tool = "tofu" if manager == "opentofu" else "terraform"
            addresses = sorted({i["address"] for i in items if i.get("address")})
            if addresses:
                steps.append(f"In the {tool} project, forget these without destroying them (the resources stay in AWS):\n"
                             + "\n".join(f"  {tool} state rm '{a}'" for a in addresses)
                             + f"\n  then remove their blocks from the configuration (or keep a `removed {{}}` block with `lifecycle {{ destroy = false }}`) and run `{tool} plan` to confirm it proposes nothing.")
            else:
                steps.append(f"In the {tool} project, run `{tool} state rm <address>` for each taken-over resource, remove its block, and confirm `{tool} plan` proposes nothing.")
        elif manager == "sst-v3":
            apps = sorted({(i.get("app") or "?", i.get("stage") or "?") for i in items})
            urns = sorted({i["urn"] for i in items if i.get("urn")})
            where = ", ".join(f"{a}/{s}" for a, s in apps)
            text = f"In the SST app ({where}), remove the components from sst.config.ts so `sst deploy` would not recreate them, then drop them from SST's state without deleting them"
            if urns:
                text += ":\n" + "\n".join(f"  sst state remove '{u}' --stage <stage>" for u in urns)
            steps.append(text + "\n  Check with `sst diff` that SST proposes no change to them. Do not run `sst remove`: that deletes the resources.")
        elif manager in ("sst-v2", "cdk", "sam", "serverless", "cloudformation", "amplify", "copilot"):
            stacks = sorted({i["stack"] for i in items if i.get("stack")})
            logical = sorted({f"{i.get('stack')}: {i.get('logical_id')}" for i in items if i.get("logical_id")})
            text = (f"These are in CloudFormation stack{'s' if len(stacks) != 1 else ''} {', '.join(stacks) or '?'}. "
                    "Set DeletionPolicy: Retain (and UpdateReplacePolicy: Retain) on each logical resource, deploy that, then remove the "
                    "resource from the template and deploy again; CloudFormation drops it from the stack and leaves it in AWS.")
            if logical:
                text += "\n  Logical ids:\n" + "\n".join(f"    {l}" for l in logical)
            if manager == "cdk":
                text += "\n  In CDK: `resource.applyRemovalPolicy(RemovalPolicy.RETAIN)`, `cdk deploy`, delete the construct, `cdk deploy`."
            if manager == "serverless":
                text += "\n  In Serverless Framework: add `DeletionPolicy: Retain` under `resources:` for the resource, deploy, remove it, deploy."
            steps.append(text)
        elif manager == "pulumi":
            urns = sorted({i["urn"] for i in items if i.get("urn")})
            text = "In the Pulumi project, remove the resources from the program, then drop them from state without deleting them"
            if urns:
                text += ":\n" + "\n".join(f"  pulumi state delete '{u}'" for u in urns)
            steps.append(text + "\n  and confirm `pulumi preview` proposes nothing.")
        else:
            steps.append(f"Managed by {manager}: stop that tool from managing these before deploying with warpcore, or both will fight over them.")
    return steps
