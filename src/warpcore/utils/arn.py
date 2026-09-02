"""ARN parsing and resource-type inference.

The scanner receives ARNs from the Resource Groups Tagging API, but every
service-level describe call wants a different identifier: Lambda wants a
function name, S3 a bucket name, SQS a queue URL, DynamoDB a table name.
This module turns an ARN into both a CloudFormation-style type and the
identifier that service's API actually expects.
"""

from dataclasses import dataclass
from typing import Dict, Optional, Tuple


@dataclass(frozen=True)
class Arn:
    """A parsed AWS ARN.

    ARN grammar is ``arn:partition:service:region:account-id:resource`` where
    the trailing resource part is one of ``id``, ``type/id`` or ``type:id``.
    """

    partition: str
    service: str
    region: str
    account: str
    resource_type: Optional[str]
    resource_id: str
    raw: str

    @property
    def is_arn(self) -> bool:
        return self.raw.startswith("arn:")


def parse_arn(arn: str) -> Optional[Arn]:
    """Parse an ARN string.

    Returns None when the value is not an ARN (some AWS APIs hand back bare
    names or queue URLs), so callers can fall back to treating it as an id.
    """
    if not arn or not arn.startswith("arn:"):
        return None

    # Only split the first 5 colons: the resource part may contain colons of
    # its own (e.g. Lambda versioned ARNs, SNS subscription ARNs).
    parts = arn.split(":", 5)
    if len(parts) < 6:
        return None

    _, partition, service, region, account, resource = parts

    resource_type: Optional[str] = None
    resource_id = resource

    # Split on whichever separator appears first. CloudWatch Logs ARNs are
    # `log-group:/aws/lambda/fn` - checking "/" first would yield a resource
    # type of "log-group:" and break every lookup keyed on it.
    slash = resource.find("/")
    colon = resource.find(":")
    candidates = [i for i in (slash, colon) if i != -1]
    if candidates:
        split_at = min(candidates)
        resource_type = resource[:split_at]
        resource_id = resource[split_at + 1:]

    return Arn(
        partition=partition,
        service=service,
        region=region,
        account=account,
        resource_type=resource_type,
        resource_id=resource_id,
        raw=arn,
    )


# (service, resource_type) -> CloudFormation type. resource_type of None means
# the service only has one interesting resource shape.
_TYPE_MAP: Dict[Tuple[str, Optional[str]], str] = {
    ("lambda", "function"): "AWS::Lambda::Function",
    ("lambda", "layer"): "AWS::Lambda::LayerVersion",
    ("iam", "role"): "AWS::IAM::Role",
    ("iam", "policy"): "AWS::IAM::ManagedPolicy",
    ("iam", "user"): "AWS::IAM::User",
    ("iam", "group"): "AWS::IAM::Group",
    ("iam", "instance-profile"): "AWS::IAM::InstanceProfile",
    ("ec2", "vpc"): "AWS::EC2::VPC",
    ("ec2", "security-group"): "AWS::EC2::SecurityGroup",
    ("ec2", "subnet"): "AWS::EC2::Subnet",
    ("ec2", "route-table"): "AWS::EC2::RouteTable",
    ("ec2", "internet-gateway"): "AWS::EC2::InternetGateway",
    ("ec2", "natgateway"): "AWS::EC2::NatGateway",
    ("ec2", "instance"): "AWS::EC2::Instance",
    ("ec2", "network-interface"): "AWS::EC2::NetworkInterface",
    ("ec2", "volume"): "AWS::EC2::Volume",
    ("s3", None): "AWS::S3::Bucket",
    ("dynamodb", "table"): "AWS::DynamoDB::Table",
    ("sqs", None): "AWS::SQS::Queue",
    ("sns", None): "AWS::SNS::Topic",
    ("events", "rule"): "AWS::Events::Rule",
    ("events", "event-bus"): "AWS::Events::EventBus",
    ("logs", "log-group"): "AWS::Logs::LogGroup",
    ("secretsmanager", "secret"): "AWS::SecretsManager::Secret",
    ("ssm", "parameter"): "AWS::SSM::Parameter",
    ("apigateway", "restapis"): "AWS::ApiGateway::RestApi",
    # execute-api ARNs identify a deployed API by id, with no resource-type
    # segment: arn:aws:execute-api:region:account:api-id/stage/METHOD/path
    ("execute-api", None): "AWS::ApiGateway::RestApi",
    ("apigateway", "apis"): "AWS::ApiGatewayV2::Api",
    ("states", "stateMachine"): "AWS::StepFunctions::StateMachine",
    ("kms", "key"): "AWS::KMS::Key",
    ("cloudwatch", "alarm"): "AWS::CloudWatch::Alarm",
    ("elasticloadbalancing", "loadbalancer"): "AWS::ElasticLoadBalancingV2::LoadBalancer",
    ("rds", "db"): "AWS::RDS::DBInstance",
    ("rds", "cluster"): "AWS::RDS::DBCluster",
    ("ecs", "cluster"): "AWS::ECS::Cluster",
    ("ecs", "service"): "AWS::ECS::Service",
    ("bedrock", "agent"): "AWS::Bedrock::Agent",
    ("bedrock", "knowledge-base"): "AWS::Bedrock::KnowledgeBase",
}

# Fallback when the service is known but the resource type is not in the map.
_SERVICE_DEFAULT: Dict[str, str] = {
    "lambda": "AWS::Lambda::Function",
    "s3": "AWS::S3::Bucket",
    "sqs": "AWS::SQS::Queue",
    "sns": "AWS::SNS::Topic",
    "dynamodb": "AWS::DynamoDB::Table",
    "iam": "AWS::IAM::Role",
    "execute-api": "AWS::ApiGateway::RestApi",
}


def resource_type_from_arn(arn: str) -> str:
    """Infer a CloudFormation-style resource type from an ARN.

    Falls back to ``AWS::<Service>::Resource`` for services we do not model,
    which keeps unknown resources visible in an inventory rather than dropping
    them.
    """
    parsed = parse_arn(arn)
    if parsed is None:
        return "AWS::Unknown::Resource"

    mapped = _TYPE_MAP.get((parsed.service, parsed.resource_type))
    if mapped:
        return mapped

    mapped = _TYPE_MAP.get((parsed.service, None))
    if mapped:
        return mapped

    mapped = _SERVICE_DEFAULT.get(parsed.service)
    if mapped:
        return mapped

    service = parsed.service.replace("-", " ").title().replace(" ", "")
    if parsed.resource_type:
        kind = parsed.resource_type.replace("-", " ").title().replace(" ", "")
        return f"AWS::{service}::{kind}"
    return f"AWS::{service}::Resource"


def service_identifier(arn: str) -> str:
    """Return the identifier the owning service's own API expects.

    The tagging API always hands back an ARN, but ``describe_table`` wants a
    bare table name and ``get_queue_attributes`` wants a queue URL. Passing the
    ARN straight through - as the scanner used to - makes those calls fail.
    """
    parsed = parse_arn(arn)
    if parsed is None:
        return arn

    service = parsed.service

    if service == "iam":
        # IAM ARNs embed the role's path: role/aws-reserved/sso.amazonaws.com/NAME.
        # GetRole(RoleName=) rejects slashes outright, so only the last segment
        # is the name.
        return parsed.resource_id.rsplit("/", 1)[-1]

    if service == "logs":
        # CloudWatch Logs ARNs carry a trailing ":*" stream wildcard
        # (log-group:/aws/lambda/fn:*) which is not part of the group name.
        return parsed.resource_id[:-2] if parsed.resource_id.endswith(":*") \
            else parsed.resource_id

    if service == "sqs":
        # SQS ARNs are arn:aws:sqs:region:account:queue-name; the API wants
        # the https URL form.
        return f"https://sqs.{parsed.region}.amazonaws.com/{parsed.account}/{parsed.resource_id}"

    if service in ("sns", "states", "secretsmanager", "kms"):
        # These APIs take the ARN itself.
        return parsed.raw

    if service == "lambda":
        # Strip a trailing :version or :alias qualifier.
        return parsed.resource_id.split(":")[0]

    return parsed.resource_id


def logical_id_from_arn(arn: str) -> str:
    """Derive a stable, readable logical id from an ARN."""
    parsed = parse_arn(arn)
    if parsed is None:
        return arn
    return parsed.resource_id.split("/")[-1].split(":")[0] or parsed.raw
