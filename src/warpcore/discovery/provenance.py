"""Who deployed a resource.

An account is rarely one tool's. Terraform made the VPC, SST the app in it,
someone clicked the bastion together in the console. Before warpcore takes
anything over it has to know which is which, because each manager has to be
told differently to let go (takeover.release_steps), and because a resource
nobody manages is a finding of its own.

Three sources, cheapest first:

- Tags. SST, Amplify, Copilot and Chalice tag what they make; CloudFormation
  tags every stack resource with its stack and logical id.
- The stack. A CloudFormation stack says what built it: a CDKMetadata
  resource, a SAM transform, Serverless's deployment bucket, SST v2's tags.
  One describe per stack, cached.
- State files. Terraform, Pulumi and SST v3 keep state the account cannot
  see; given the file (or SST's bootstrap bucket), the physical ids in it
  map resources to their addresses.

Nothing here changes anything. The result is a small dict on each resource:

    {"manager": "terraform", "address": "module.net.aws_vpc.main", "evidence": "..."}
"""

import json
import re
from typing import Any, Dict, Iterable, List, Optional, Tuple

import boto3
from botocore.exceptions import ClientError

from warpcore.state.models import Resource
from warpcore.utils.boto import discovery_client
from warpcore.utils.logging import get_logger

logger = get_logger(__name__)

Provenance = Dict[str, Any]

SAM_TRANSFORM = "AWS::Serverless-2016-10-31"
SERVERLESS_DESCRIPTION = "The AWS CloudFormation template for this Serverless application"


# ------------------------------------------------------------------- tags


def from_tags(tags: Dict[str, str]) -> Optional[Provenance]:
    """What the tags alone say. CloudFormation-tagged resources come back as
    'cloudformation' with the stack; classify_stack refines that."""
    t = tags or {}
    if t.get("sst:app") and not t.get("aws:cloudformation:stack-name"):
        return {"manager": "sst-v3", "app": t["sst:app"], "stage": t.get("sst:stage"), "evidence": "tags sst:app and sst:stage with no CloudFormation stack"}
    if t.get("copilot-application"):
        return {"manager": "copilot", "app": t["copilot-application"], "stage": t.get("copilot-environment"),
                "stack": t.get("aws:cloudformation:stack-name"), "logical_id": t.get("aws:cloudformation:logical-id"), "evidence": "tag copilot-application"}
    if t.get("created-by") == "amplify" or any(k.startswith("amplify:") for k in t):
        return {"manager": "amplify", "stack": t.get("aws:cloudformation:stack-name"), "logical_id": t.get("aws:cloudformation:logical-id"),
                "stage": t.get("amplify:deployment-type"), "evidence": "tag created-by=amplify"}
    if t.get("aws-chalice"):
        m = re.search(r"stage=([^:]+):app=(.+)$", t["aws-chalice"])
        return {"manager": "chalice", "app": m.group(2) if m else None, "stage": m.group(1) if m else None, "evidence": "tag aws-chalice"}
    if t.get("aws:cloudformation:stack-name"):
        base = {"manager": "cloudformation", "stack": t["aws:cloudformation:stack-name"], "logical_id": t.get("aws:cloudformation:logical-id"),
                "evidence": "tag aws:cloudformation:stack-name"}
        if t.get("sst:app"):
            base.update({"manager": "sst-v2", "app": t["sst:app"], "stage": t.get("sst:stage"), "evidence": "tags sst:app on a CloudFormation stack resource"})
        return base
    if t.get("warpcore:managed-by") == "warpcore":
        return {"manager": "warpcore", "app": t.get("warpcore:project"), "stage": t.get("warpcore:environment"), "evidence": "tag warpcore:managed-by"}
    return None


# ----------------------------------------------------------------- stacks


class StackClassifier:
    """What built a CloudFormation stack, one describe per stack."""

    def __init__(self, session: boto3.Session, region: str):
        self.session = session
        self.region = region
        self._cache: Dict[str, Tuple[str, str]] = {}

    def classify(self, stack_name: str) -> Tuple[str, str]:
        """(manager, evidence) for a stack; ('cloudformation', ...) when nothing more specific shows."""
        if stack_name in self._cache:
            return self._cache[stack_name]
        result = self._classify(stack_name)
        self._cache[stack_name] = result
        return result

    def _classify(self, stack_name: str) -> Tuple[str, str]:
        cfn = discovery_client(self.session, "cloudformation", self.region)
        tags: Dict[str, str] = {}
        description = ""
        try:
            stacks = cfn.describe_stacks(StackName=stack_name).get("Stacks", [])
            if stacks:
                tags = {t["Key"]: t["Value"] for t in stacks[0].get("Tags", [])}
                description = stacks[0].get("Description") or ""
        except ClientError as e:
            logger.info("describe_stacks(%s) failed: %s", stack_name, e)
            return "cloudformation", "in a CloudFormation stack that could not be described"
        if tags.get("sst:app"):
            return "sst-v2", f"stack {stack_name} tagged sst:app"
        if tags.get("copilot-application"):
            return "copilot", f"stack {stack_name} tagged copilot-application"
        if tags.get("created-by") == "amplify" or stack_name.startswith("amplify-"):
            return "amplify", f"stack {stack_name} is an Amplify stack"
        if tags.get("ZappaProject"):
            return "zappa", f"stack {stack_name} tagged ZappaProject"
        transforms: List[str] = []
        types: List[str] = []
        try:
            summary = cfn.get_template_summary(StackName=stack_name)
            transforms = list(summary.get("DeclaredTransforms") or [])
            types = list(summary.get("ResourceTypes") or [])
        except ClientError as e:
            logger.info("get_template_summary(%s) failed: %s", stack_name, e)
        if "AWS::CDK::Metadata" in types:
            return "cdk", f"stack {stack_name} carries the CDKMetadata resource"
        if any(t == SAM_TRANSFORM for t in transforms):
            return "sam", f"stack {stack_name} declares the {SAM_TRANSFORM} transform"
        if SERVERLESS_DESCRIPTION.lower() in description.lower():
            return "serverless", f"stack {stack_name} is a Serverless Framework template"
        # The template itself, when the summary did not settle it.
        try:
            body = cfn.get_template(StackName=stack_name).get("TemplateBody")
            template = json.loads(body) if isinstance(body, str) else (body or {})
        except (ClientError, ValueError):
            template = {}
        if isinstance(template, dict):
            res = template.get("Resources") or {}
            declared = template.get("Transform")
            declared = [declared] if isinstance(declared, str) else list(declared or [])
            if any(isinstance(v, dict) and v.get("Type") == "AWS::CDK::Metadata" for v in res.values()) or "CDKMetadata" in res:
                return "cdk", f"stack {stack_name} carries the CDKMetadata resource"
            if SAM_TRANSFORM in declared:
                return "sam", f"stack {stack_name} declares the {SAM_TRANSFORM} transform"
            if "ServerlessDeploymentBucket" in res or SERVERLESS_DESCRIPTION.lower() in str(template.get("Description", "")).lower():
                return "serverless", f"stack {stack_name} is a Serverless Framework template"
        return "cloudformation", f"in CloudFormation stack {stack_name}"


# ----------------------------------------------------------------- states


def terraform_index(state: Dict[str, Any]) -> Dict[str, Provenance]:
    """physical id (arn or id) -> provenance, from a Terraform/OpenTofu state (v4)."""
    out: Dict[str, Provenance] = {}
    tool = "opentofu" if "opentofu" in str(state.get("terraform_version", "")).lower() else "terraform"
    for r in state.get("resources") or []:
        if r.get("mode") != "managed":
            continue
        base = f"{r.get('module') + '.' if r.get('module') else ''}{r.get('type')}.{r.get('name')}"
        for inst in r.get("instances") or []:
            key = inst.get("index_key")
            address = base if key is None else (f'{base}["{key}"]' if isinstance(key, str) else f"{base}[{key}]")
            attrs = inst.get("attributes") or {}
            prov = {"manager": tool, "address": address, "type": r.get("type"), "evidence": f"{tool} state: {address}"}
            for ident in (attrs.get("arn"), attrs.get("id"), (inst.get("identity") or {}).get("arn"), (inst.get("identity") or {}).get("id")):
                if isinstance(ident, str) and ident:
                    out.setdefault(ident, prov)
            # Buckets are keyed by name in state but by ARN on the canvas.
            if r.get("type") == "aws_s3_bucket" and attrs.get("bucket"):
                out.setdefault(f"arn:aws:s3:::{attrs['bucket']}", prov)
            if r.get("type") == "aws_sqs_queue" and attrs.get("arn"):
                out.setdefault(attrs["arn"], prov)
    return out


def pulumi_index(checkpoint: Dict[str, Any], manager: str = "pulumi", app: Optional[str] = None, stage: Optional[str] = None) -> Dict[str, Provenance]:
    """physical id -> provenance, from a Pulumi checkpoint or `pulumi stack export`."""
    latest = (checkpoint.get("checkpoint") or {}).get("latest") or checkpoint.get("deployment") or checkpoint
    out: Dict[str, Provenance] = {}
    for r in latest.get("resources") or []:
        if not r.get("custom") and r.get("custom") is not None:
            continue
        urn = r.get("urn") or ""
        name = urn.rsplit("::", 1)[-1] if urn else None
        prov = {"manager": manager, "urn": urn, "name": name, "type": r.get("type"), "evidence": f"{manager} state: {urn}"}
        if app:
            prov["app"] = app
        if stage:
            prov["stage"] = stage
        outputs = r.get("outputs") or {}
        for ident in (outputs.get("arn"), r.get("id"), outputs.get("id")):
            if isinstance(ident, str) and ident:
                out.setdefault(ident, prov)
        if r.get("type") == "aws:s3/bucket:Bucket" or r.get("type") == "aws:s3/bucketV2:BucketV2":
            b = outputs.get("bucket") or r.get("id")
            if b:
                out.setdefault(f"arn:aws:s3:::{b}", prov)
    return out


def read_state_file(session: Optional[boto3.Session], location: str) -> Dict[str, Any]:
    """A local path or s3://bucket/key, as JSON."""
    if location.startswith("s3://"):
        if session is None:
            raise ValueError("an AWS session is needed to read s3:// state")
        bucket, _, key = location[5:].partition("/")
        body = session.client("s3").get_object(Bucket=bucket, Key=key)["Body"].read()
        if key.endswith(".gz"):
            import gzip
            body = gzip.decompress(body)
        return json.loads(body.decode("utf-8"))
    with open(location, "r", encoding="utf-8") as fh:
        return json.load(fh)


def sst_v3_index(session: boto3.Session, region: str, apps: Iterable[Tuple[str, str]]) -> Tuple[Dict[str, Provenance], List[str]]:
    """The SST v3 state of each (app, stage): the bootstrap parameter names
    the state bucket; the checkpoint sits at app/<app>/<stage>.json."""
    notes: List[str] = []
    out: Dict[str, Provenance] = {}
    try:
        param = discovery_client(session, "ssm", region).get_parameter(Name="/sst/bootstrap")["Parameter"]["Value"]
        bucket = json.loads(param).get("state")
    except (ClientError, ValueError, KeyError) as e:
        notes.append(f"SST bootstrap parameter /sst/bootstrap could not be read in {region}: {e}")
        return out, notes
    if not bucket:
        notes.append("SST bootstrap parameter has no state bucket")
        return out, notes
    s3 = discovery_client(session, "s3", region)
    for app, stage in sorted(set(apps)):
        key = f"app/{app}/{stage}.json"
        try:
            body = s3.get_object(Bucket=bucket, Key=key)["Body"].read()
            out.update(pulumi_index(json.loads(body.decode("utf-8")), manager="sst-v3", app=app, stage=stage))
        except (ClientError, ValueError) as e:
            notes.append(f"SST state s3://{bucket}/{key} could not be read: {e}")
    return out, notes


# ------------------------------------------------------------------ attach


def _identifiers(r: Resource) -> List[str]:
    ids = [r.physical_id or "", r.id or ""]
    p = r.properties or {}
    for key in ("FunctionArn", "TableArn", "QueueArn", "TopicArn", "QueueUrl", "Arn", "arn", "VpcId", "SubnetId", "GroupId",
                "InstanceId", "BucketName", "RoleName", "logGroupName", "NatGatewayId", "RouteTableId", "InternetGatewayId"):
        v = p.get(key)
        if isinstance(v, str) and v:
            ids.append(v)
    return [i for i in ids if i]


def attach_provenance(
    resources: List[Resource],
    classifier: Optional[StackClassifier] = None,
    indexes: Optional[List[Dict[str, Provenance]]] = None,
) -> Dict[str, int]:
    """Write metadata['provenance'] on each resource. Returns manager -> count.
    State-file indexes win over tags; tags over nothing."""
    counts: Dict[str, int] = {}
    for r in resources:
        prov: Optional[Provenance] = None
        for index in indexes or []:
            for ident in _identifiers(r):
                if ident in index:
                    prov = dict(index[ident])
                    break
            if prov:
                break
        if prov is None:
            prov = from_tags(r.tags or {})
            if prov and prov.get("manager") == "cloudformation" and classifier is not None:
                manager, evidence = classifier.classify(prov["stack"])
                prov["manager"], prov["evidence"] = manager, evidence
                if manager == "sst-v2":
                    prov.setdefault("app", (r.tags or {}).get("sst:app"))
                    prov.setdefault("stage", (r.tags or {}).get("sst:stage"))
        if prov is None:
            continue
        r.metadata = {**(r.metadata or {}), "provenance": prov}
        counts[prov["manager"]] = counts.get(prov["manager"], 0) + 1
    return counts


def sst_apps(resources: Iterable[Resource]) -> List[Tuple[str, str]]:
    """The SST v3 (app, stage) pairs the tags name."""
    pairs = set()
    for r in resources:
        t = r.tags or {}
        if t.get("sst:app") and t.get("sst:stage") and not t.get("aws:cloudformation:stack-name"):
            pairs.add((t["sst:app"], t["sst:stage"]))
    return sorted(pairs)
