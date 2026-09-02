"""Turn a scanned AWS account into a warpcore.yaml.

The scanner produces resources keyed by ARN. This turns that into the config
schema warpcore deploys from, which means reconciling two mismatches:

* AWS names are freer than the config schema allows (``AgentConfig.name`` is
  ``^[a-z0-9-]+$`` starting with a letter, runtime must be python3.9-3.12).
* Lambda functions become ``agents``; everything else becomes ``resources``,
  which the parser tolerates as an extra key and the visual builder reads.

Anything that cannot be represented faithfully is reported as an EmitNote
rather than silently dropped or silently mangled.

Lambda environment variable VALUES are redacted by default. The output of this
module is a file people commit, and a live function's environment is exactly
where API tokens and connection strings live. Keys are kept so the shape of the
config is right; pass include_env_values=True to copy the real values.
"""

import re
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from warpcore.agentic.scanner import ScannedState
from warpcore.state.models import Resource
from warpcore.utils.logging import get_logger

logger = get_logger(__name__)

# Written in place of a real environment variable value. Deliberately not a
# plausible value: deploying this config unedited should fail loudly rather
# than quietly push a wrong secret.
REDACTED = "<redacted - see warpcore discover config --include-env-values>"

# Mirrors AgentConfig's validators in warpcore/config/models.py.
_AGENT_NAME_RE = re.compile(r"^[a-z][a-z0-9-]*$")
_SUPPORTED_RUNTIME_RE = re.compile(r"^python3\.(9|10|11|12)$")

# Resource types that map onto config `resources` entries, with the short type
# name the visual builder and templates use.
_RESOURCE_TYPE_NAMES = {
    "AWS::S3::Bucket": "s3",
    "AWS::DynamoDB::Table": "dynamodb",
    "AWS::SQS::Queue": "sqs",
    "AWS::SNS::Topic": "sns",
    "AWS::SecretsManager::Secret": "secrets-manager",
    "AWS::Events::Rule": "eventbridge-rule",
    "AWS::Logs::LogGroup": "log-group",
    "AWS::IAM::Role": "iam-role",
    "AWS::EC2::VPC": "vpc",
    "AWS::EC2::Subnet": "subnet",
    "AWS::EC2::SecurityGroup": "security-group",
    "AWS::StepFunctions::StateMachine": "step-function",
    "AWS::ApiGatewayV2::Api": "api-gateway",
    "AWS::ApiGateway::RestApi": "api-gateway",
}


@dataclass
class EmitNote:
    """Something the emitter could not represent exactly."""

    level: str           # "warning" | "info"
    physical_id: str
    message: str


@dataclass
class EmitResult:
    """A generated config plus everything the caller should know about it."""

    config: Dict[str, Any]
    notes: List[EmitNote] = field(default_factory=list)
    agent_count: int = 0
    resource_count: int = 0
    skipped_count: int = 0

    def warnings(self) -> List[EmitNote]:
        return [n for n in self.notes if n.level == "warning"]


def sanitize_agent_name(raw: str) -> Optional[str]:
    """Coerce an AWS Lambda function name into a valid agent name.

    Returns None when nothing valid can be salvaged (e.g. a purely numeric
    name), so the caller can report it rather than emit invalid config.
    """
    name = raw.lower()
    name = re.sub(r"[^a-z0-9-]+", "-", name)
    name = re.sub(r"-{2,}", "-", name).strip("-")
    # Must start with a letter.
    name = re.sub(r"^[0-9-]+", "", name)
    if not name or not _AGENT_NAME_RE.match(name):
        return None
    return name[:64]


class ConfigEmitter:
    """Builds a warpcore.yaml dict from a scanned account."""

    def __init__(
        self,
        scanned_state: ScannedState,
        project_name: str,
        environment: str,
        account: str,
        region: str,
        include_env_values: bool = False,
    ):
        self.scanned_state = scanned_state
        self.project_name = project_name
        self.environment = environment
        self.account = account
        self.region = region
        self.include_env_values = include_env_values

    def emit(self) -> EmitResult:
        """Generate the config."""
        result = EmitResult(config={})
        notes: List[EmitNote] = []

        agents: List[Dict[str, Any]] = []
        resources: List[Dict[str, Any]] = []
        seen_agent_names: Dict[str, str] = {}

        for resource in sorted(
            self.scanned_state.get_all_resources(), key=lambda r: (r.type, r.id)
        ):
            if resource.type == "AWS::Lambda::Function":
                agent = self._emit_agent(resource, seen_agent_names, notes)
                if agent:
                    agents.append(agent)
                else:
                    result.skipped_count += 1
            elif resource.type in _RESOURCE_TYPE_NAMES:
                resources.append(self._emit_resource(resource))
            else:
                notes.append(EmitNote(
                    level="info",
                    physical_id=resource.physical_id or resource.id,
                    message=f"{resource.type} has no config representation; "
                            f"recorded as a comment only",
                ))
                result.skipped_count += 1

        config: Dict[str, Any] = {
            "project": {
                "name": self.project_name,
                "region": self.region,
            },
            "agents": agents,
            "environments": {
                self.environment: {
                    "account": self.account,
                    "region": self.region,
                }
            },
        }

        if resources:
            config["resources"] = resources

        result.config = config
        result.notes = notes
        result.agent_count = len(agents)
        result.resource_count = len(resources)
        return result

    def _emit_agent(
        self,
        resource: Resource,
        seen: Dict[str, str],
        notes: List[EmitNote],
    ) -> Optional[Dict[str, Any]]:
        """Build one `agents:` entry from a discovered Lambda function."""
        props = resource.properties or {}
        physical = resource.physical_id or resource.id
        aws_name = props.get("FunctionName") or resource.id

        name = sanitize_agent_name(aws_name)
        if name is None:
            notes.append(EmitNote(
                level="warning",
                physical_id=physical,
                message=f"Lambda name '{aws_name}' cannot be expressed as an agent "
                        f"name (must match ^[a-z][a-z0-9-]*$); skipped",
            ))
            return None

        if name != aws_name:
            notes.append(EmitNote(
                level="warning",
                physical_id=physical,
                message=f"Lambda '{aws_name}' renamed to '{name}' to satisfy the "
                        f"agent name schema; deploying this config would create a "
                        f"NEW function rather than adopt the existing one",
            ))

        if name in seen:
            suffix = 2
            while f"{name}-{suffix}" in seen:
                suffix += 1
            deduped = f"{name}-{suffix}"
            notes.append(EmitNote(
                level="warning",
                physical_id=physical,
                message=f"agent name '{name}' already taken by {seen[name]}; "
                        f"emitted as '{deduped}'",
            ))
            name = deduped
        seen[name] = physical

        agent: Dict[str, Any] = {"name": name, "path": f"./agents/{name}"}

        runtime = props.get("Runtime")
        if runtime and _SUPPORTED_RUNTIME_RE.match(runtime):
            agent["runtime"] = runtime
        elif runtime:
            notes.append(EmitNote(
                level="warning",
                physical_id=physical,
                message=f"runtime '{runtime}' is not supported by the config schema "
                        f"(python3.9-3.12 only); emitted with the default runtime",
            ))

        if props.get("MemorySize"):
            agent["memory"] = int(props["MemorySize"])
        if props.get("Timeout"):
            agent["timeout"] = int(props["Timeout"])
        if props.get("Handler"):
            agent["handler"] = props["Handler"]

        env_vars = (props.get("Environment") or {}).get("Variables") or {}
        if env_vars:
            if self.include_env_values:
                agent["environment"] = {k: str(v) for k, v in sorted(env_vars.items())}
                notes.append(EmitNote(
                    level="warning",
                    physical_id=physical,
                    message=f"{len(env_vars)} environment variable VALUE(S) copied "
                            f"verbatim from the live function ({', '.join(sorted(env_vars))}). "
                            f"These may be live credentials - do not commit this file "
                            f"until you have checked",
                ))
            else:
                agent["environment"] = {k: REDACTED for k in sorted(env_vars)}
                notes.append(EmitNote(
                    level="info",
                    physical_id=physical,
                    message=f"{len(env_vars)} environment variable name(s) kept, values "
                            f"redacted ({', '.join(sorted(env_vars))}). Re-run with "
                            f"--include-env-values to copy the real values",
                ))

        user_tags = {k: v for k, v in (resource.tags or {}).items()
                     if not k.startswith("warpcore:") and k != "Name"}
        if user_tags:
            agent["tags"] = user_tags

        return agent

    def _emit_resource(self, resource: Resource) -> Dict[str, Any]:
        """Build one `resources:` entry from a discovered resource."""
        entry: Dict[str, Any] = {
            "name": resource.id,
            "type": _RESOURCE_TYPE_NAMES[resource.type],
            "arn": resource.physical_id,
        }

        config = self._resource_config(resource)
        if config:
            entry["config"] = config

        user_tags = {k: v for k, v in (resource.tags or {}).items()
                     if not k.startswith("warpcore:") and k != "Name"}
        if user_tags:
            entry["tags"] = user_tags

        return entry

    def _resource_config(self, resource: Resource) -> Dict[str, Any]:
        """Extract the handful of properties worth round-tripping per type.

        Deliberately narrow: dumping every describe_* field produces an
        unreadable config full of AWS-managed values that cannot be set.
        """
        props = resource.properties or {}

        if resource.type == "AWS::S3::Bucket":
            cfg: Dict[str, Any] = {"name": props.get("BucketName", resource.id)}
            if props.get("Versioning") == "Enabled":
                cfg["versioning"] = True
            if props.get("Encryption"):
                cfg["encryption"] = True
            return cfg

        if resource.type == "AWS::DynamoDB::Table":
            cfg = {"name": props.get("TableName", resource.id)}
            if props.get("BillingModeSummary", {}).get("BillingMode"):
                cfg["billing_mode"] = props["BillingModeSummary"]["BillingMode"]
            if props.get("KeySchema"):
                cfg["key_schema"] = props["KeySchema"]
            return cfg

        if resource.type == "AWS::SQS::Queue":
            cfg = {"name": resource.id}
            for src, dst in (
                ("VisibilityTimeout", "visibility_timeout"),
                ("MessageRetentionPeriod", "message_retention_period"),
            ):
                if props.get(src):
                    cfg[dst] = int(props[src])
            return cfg

        if resource.type == "AWS::Logs::LogGroup":
            cfg = {"name": props.get("logGroupName", resource.id)}
            if props.get("retentionInDays"):
                cfg["retention_days"] = props["retentionInDays"]
            return cfg

        if resource.type == "AWS::Events::Rule":
            cfg = {"name": props.get("Name", resource.id)}
            if props.get("ScheduleExpression"):
                cfg["schedule"] = props["ScheduleExpression"]
            if props.get("State"):
                cfg["enabled"] = props["State"] == "ENABLED"
            return cfg

        if resource.type == "AWS::EC2::VPC":
            return {"cidr": props.get("CidrBlock")} if props.get("CidrBlock") else {}

        if resource.type in ("AWS::SNS::Topic", "AWS::SecretsManager::Secret"):
            return {"name": resource.id}

        return {}
