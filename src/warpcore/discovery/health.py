"""What the account says about the canvas right now: health, and drift.

Two questions, one round of describes. Health: is each resource running,
available, active, as the service reports it, in the import's own terms
(project_emitter.resource_health). Drift: does each resource the state
knows still exist, and does its live shape still match what the state
recorded, property by property, in its provisioner's terms
(takeover.normalise) so a managed and an adopted entry compare the same way.

Describes are batched where the API allows (instances, NAT gateways) and
run in a pool otherwise. Nothing here writes to AWS.
"""

from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Optional, Tuple

import boto3
from botocore.exceptions import ClientError

from warpcore.agentic.scanner import AWSScanner
from warpcore.discovery.project_emitter import resource_health
from warpcore.discovery.takeover import normalise
from warpcore.state.models import Resource, State
from warpcore.utils.arn import resource_type_from_arn, service_identifier
from warpcore.utils.boto import discovery_client
from warpcore.utils.logging import get_logger

logger = get_logger(__name__)

# Types whose health the service reports; others come back "unknown".
HEALTH_TYPES = {
    "AWS::EC2::Instance", "AWS::Lambda::Function", "AWS::RDS::DBInstance", "AWS::EC2::NatGateway", "AWS::ACM::Certificate",
    "AWS::CloudFront::Distribution", "AWS::KMS::Key", "AWS::ElasticLoadBalancingV2::LoadBalancer", "AWS::DynamoDB::Table",
    "AWS::StepFunctions::StateMachine", "AWS::Events::Rule",
}

CANVAS_TO_AWS = {
    "ec2-instance": "AWS::EC2::Instance", "lambda": "AWS::Lambda::Function", "agent": "AWS::Lambda::Function",
    "rds-instance": "AWS::RDS::DBInstance", "nat-gateway": "AWS::EC2::NatGateway", "acm-certificate": "AWS::ACM::Certificate",
    "cloudfront": "AWS::CloudFront::Distribution", "kms-key": "AWS::KMS::Key", "load-balancer": "AWS::ElasticLoadBalancingV2::LoadBalancer",
    "dynamodb": "AWS::DynamoDB::Table", "step-functions": "AWS::StepFunctions::StateMachine", "eventbridge-rule": "AWS::Events::Rule",
    "s3": "AWS::S3::Bucket", "sqs": "AWS::SQS::Queue", "sns": "AWS::SNS::Topic", "iam-role": "AWS::IAM::Role",
    "log-group": "AWS::Logs::LogGroup", "vpc": "AWS::EC2::VPC", "security-group": "AWS::EC2::SecurityGroup",
}


@dataclass
class Live:
    """One resource as it is right now, or the fact that it is gone."""

    arn: str
    aws_type: str
    properties: Dict[str, Any] = field(default_factory=dict)
    missing: bool = False
    error: Optional[str] = None


def describe_live(session: boto3.Session, region: str, wanted: Iterable[Tuple[str, str]], parallelism: int = 8) -> Dict[str, Live]:
    """(arn, aws type) -> Live, batched where the API allows."""
    wanted = list(dict.fromkeys(wanted))
    out: Dict[str, Live] = {}
    by_region: Dict[str, List[Tuple[str, str]]] = {}
    for arn, aws_type in wanted:
        r = arn.split(":")[3] if arn.count(":") >= 5 and arn.split(":")[3] else region
        by_region.setdefault(r, []).append((arn, aws_type))

    for r, items in by_region.items():
        scanner = AWSScanner(boto_session=session, project_name="health", environment="live", region=r)
        instances = [(a, t) for a, t in items if t == "AWS::EC2::Instance"]
        nats = [(a, t) for a, t in items if t == "AWS::EC2::NatGateway"]
        rest = [(a, t) for a, t in items if t not in ("AWS::EC2::Instance", "AWS::EC2::NatGateway")]
        if instances:
            out.update(_describe_instances(session, r, instances))
        if nats:
            out.update(_describe_nat_gateways(session, r, nats))

        def one(item: Tuple[str, str]) -> Live:
            arn, aws_type = item
            try:
                props = scanner.get_resource_details(aws_type, service_identifier(arn))
                if props is None:
                    return Live(arn, aws_type, error="no reader for this type")
                if props == {}:
                    return Live(arn, aws_type, missing=True)
                return Live(arn, aws_type, properties=props)
            except ClientError as e:
                code = e.response.get("Error", {}).get("Code", "")
                if code in ("ResourceNotFoundException", "NoSuchEntity", "NoSuchBucket", "NotFound", "404", "InvalidParameterValue",
                            "QueueDoesNotExist", "AWS.SimpleQueueService.NonExistentQueue", "InvalidGroup.NotFound", "InvalidVpcID.NotFound"):
                    return Live(arn, aws_type, missing=True)
                return Live(arn, aws_type, error=str(e))
            except Exception as e:  # noqa: BLE001 - one resource's failure is a note
                return Live(arn, aws_type, error=str(e))

        with ThreadPoolExecutor(max_workers=max(1, parallelism)) as pool:
            for live in pool.map(one, rest):
                out[live.arn] = live
    return out


def _describe_instances(session, region, items) -> Dict[str, Live]:
    ec2 = discovery_client(session, "ec2", region)
    ids = {service_identifier(a): a for a, _ in items}
    out = {arn: Live(arn, "AWS::EC2::Instance", missing=True) for arn in ids.values()}
    id_list = list(ids)
    for i in range(0, len(id_list), 100):
        chunk = id_list[i:i + 100]
        try:
            resp = ec2.describe_instances(InstanceIds=chunk)
        except ClientError as e:
            if "InvalidInstanceID" in e.response.get("Error", {}).get("Code", ""):
                # One bad id fails the batch: fall back to one at a time.
                for iid in chunk:
                    try:
                        resp1 = ec2.describe_instances(InstanceIds=[iid])
                        for res in resp1.get("Reservations", []):
                            for inst in res.get("Instances", []):
                                out[ids[iid]] = Live(ids[iid], "AWS::EC2::Instance", properties=inst)
                    except ClientError:
                        pass
                continue
            for iid in chunk:
                out[ids[iid]] = Live(ids[iid], "AWS::EC2::Instance", error=str(e))
            continue
        for res in resp.get("Reservations", []):
            for inst in res.get("Instances", []):
                iid = inst.get("InstanceId")
                if iid in ids:
                    if (inst.get("State") or {}).get("Name") == "terminated":
                        out[ids[iid]] = Live(ids[iid], "AWS::EC2::Instance", properties=inst, missing=True)
                    else:
                        out[ids[iid]] = Live(ids[iid], "AWS::EC2::Instance", properties=inst)
    return out


def _describe_nat_gateways(session, region, items) -> Dict[str, Live]:
    ec2 = discovery_client(session, "ec2", region)
    ids = {service_identifier(a): a for a, _ in items}
    out = {arn: Live(arn, "AWS::EC2::NatGateway", missing=True) for arn in ids.values()}
    try:
        resp = ec2.describe_nat_gateways(NatGatewayIds=list(ids))
    except ClientError as e:
        for arn in ids.values():
            out[arn] = Live(arn, "AWS::EC2::NatGateway", error=str(e))
        return out
    for nat in resp.get("NatGateways", []):
        nid = nat.get("NatGatewayId")
        if nid in ids:
            out[ids[nid]] = Live(ids[nid], "AWS::EC2::NatGateway", properties=nat, missing=nat.get("State") == "deleted")
    return out


# ----------------------------------------------------------------- health


def canvas_health(session: boto3.Session, region: str, nodes: List[Dict[str, Any]], state: Optional[State] = None,
                  parallelism: int = 8) -> Dict[str, Any]:
    """Per ARN: level, reason, missing, and when warpcore last deployed it."""
    wanted: List[Tuple[str, str]] = []
    for n in nodes:
        arn = n.get("arn")
        if not arn or n.get("hidden"):
            continue
        aws_type = CANVAS_TO_AWS.get(n.get("type") or "") or resource_type_from_arn(arn)
        if aws_type in HEALTH_TYPES:
            wanted.append((arn, aws_type))
    live = describe_live(session, region, wanted, parallelism=parallelism)
    deployed_at: Dict[str, str] = {}
    if state is not None:
        for _stack, r in state.all_resources():
            if r.physical_id and (r.tags or {}).get("warpcore:deployed-at"):
                deployed_at[r.physical_id] = r.tags["warpcore:deployed-at"]
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    out: Dict[str, Any] = {}
    for arn, l in live.items():
        if l.error:
            entry = {"level": "unknown", "reason": f"could not be read: {l.error}"}
        elif l.missing:
            entry = {"level": "warn", "reason": "no longer exists in the account", "missing": True}
        else:
            entry = dict(resource_health(l.aws_type, l.properties))
        entry["checked_at"] = now
        if arn in deployed_at:
            entry["deployed_at"] = deployed_at[arn]
        out[arn] = entry
    return {"checked_at": now, "resources": out}


# ------------------------------------------------------------------ drift

# Properties the record and the live shape are compared on, per type. What
# the provisioner sets, in its names; volatile or recorded-after fields left out.
COMPARED: Dict[str, List[str]] = {
    "AWS::Lambda::Function": ["Runtime", "Handler", "MemorySize", "Timeout", "Environment", "Role", "TracingConfig", "CodeSha256"],
    "AWS::IAM::Role": ["AssumeRolePolicyDocument", "InlinePolicies", "ManagedPolicyArns"],
    "AWS::S3::Bucket": ["VersioningStatus", "EncryptionConfiguration"],
    "AWS::DynamoDB::Table": ["KeySchema", "AttributeDefinitions", "BillingMode", "ProvisionedThroughput", "StreamSpecification"],
    "AWS::SQS::Queue": ["VisibilityTimeout", "MessageRetentionPeriod", "DelaySeconds", "ReceiveMessageWaitTimeSeconds", "RedrivePolicy", "FifoQueue"],
    "AWS::SNS::Topic": ["DisplayName", "FifoTopic", "KmsMasterKeyId"],
    "AWS::Logs::LogGroup": ["RetentionInDays"],
    "AWS::EC2::VPC": ["CidrBlock"],
    "AWS::EC2::SecurityGroup": ["IngressRules", "EgressRules"],
}


@dataclass
class DriftItem:
    resource_id: str
    resource_type: str
    physical_id: str
    kind: str                       # missing | modified | ok | unchecked
    differences: List[Dict[str, Any]] = field(default_factory=list)
    managed: bool = False
    note: str = ""

    def to_dict(self) -> Dict[str, Any]:
        return self.__dict__


def _canon(v: Any) -> Any:
    """Compare structures order-insensitively where order carries no meaning."""
    if isinstance(v, dict):
        return {k: _canon(x) for k, x in sorted(v.items())}
    if isinstance(v, list):
        items = [_canon(x) for x in v]
        try:
            return sorted(items, key=lambda x: repr(x))
        except TypeError:
            return items
    return v


def drift_report(session: boto3.Session, region: str, state: State, parallelism: int = 8) -> Dict[str, Any]:
    """Every state entry with a physical id, against the account."""
    entries = [(stack, r) for stack, r in state.all_resources() if r.physical_id]
    live = describe_live(session, region, [(r.physical_id, r.type) for _s, r in entries], parallelism=parallelism)
    items: List[DriftItem] = []
    for _stack, r in entries:
        meta = r.metadata or {}
        managed = bool(meta.get("managed")) or not meta.get("adopted")
        l = live.get(r.physical_id)
        if l is None or l.error:
            items.append(DriftItem(r.id, r.type, r.physical_id, "unchecked", managed=managed, note=(l.error or "") if l else "not described"))
            continue
        if l.missing:
            items.append(DriftItem(r.id, r.type, r.physical_id, "missing", managed=managed, note="no longer exists in the account"))
            continue
        keys = COMPARED.get(r.type)
        if not keys:
            items.append(DriftItem(r.id, r.type, r.physical_id, "unchecked", managed=managed, note="no comparison rule for this type"))
            continue
        now = normalise(r.type, l.properties) or {}
        # The record: provisioner terms for a managed entry, normalised
        # hydrated terms for an adopted one that was never taken over.
        was = r.properties if managed else (normalise(r.type, r.properties) or {})
        diffs = []
        for key in keys:
            a, b = was.get(key), now.get(key)
            if a is None:
                continue  # the record never set it; whatever AWS defaulted is not drift
            if key == "Environment" and isinstance(a, dict) and any(str(v) == "<redacted>" for v in a.values()):
                continue
            if _canon(a) != _canon(b):
                diffs.append({"key": key, "recorded": a, "live": b})
        items.append(DriftItem(r.id, r.type, r.physical_id, "modified" if diffs else "ok", differences=diffs, managed=managed))
    counts = {k: sum(1 for i in items if i.kind == k) for k in ("ok", "modified", "missing", "unchecked")}
    return {"checked_at": datetime.now(timezone.utc).isoformat(timespec="seconds"), "counts": counts, "items": [i.to_dict() for i in items]}
