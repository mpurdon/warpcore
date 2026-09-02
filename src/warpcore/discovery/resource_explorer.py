"""Discovery via AWS Resource Explorer.

Resource Explorer is an account-wide index of (nearly) every resource type
AWS has, kept current by AWS itself. When it is enabled it is a far better
answer to "what is in this account" than walking service APIs one at a time:
one paginated call returns hundreds of types, including ones warpcore has
never heard of, with tags attached.

It is opt-in per account, so it cannot be the only source. ServiceEnumerator
remains the fallback, and the two are merged by ARN so a resource found by
both is reported once.

A LOCAL index answers for its own region plus global resources. Only an
AGGREGATOR index answers for every region, so callers wanting the whole
account search each region they care about.
"""

from dataclasses import dataclass
from typing import Dict, List, Optional

import boto3
from botocore.exceptions import BotoCoreError, ClientError

from warpcore.state.models import Resource
from warpcore.utils.arn import logical_id_from_arn
from warpcore.utils.boto import discovery_client
from warpcore.utils.logging import get_logger

logger = get_logger(__name__)

# Resource Explorer names types as `service:type`. Map the ones warpcore models
# onto its CloudFormation-style names so results from both sources agree; the
# rest get a readable generated name via _generic_type().
_TYPE_MAP: Dict[str, str] = {
    "ec2:instance": "AWS::EC2::Instance",
    "ec2:vpc": "AWS::EC2::VPC",
    "ec2:subnet": "AWS::EC2::Subnet",
    "ec2:security-group": "AWS::EC2::SecurityGroup",
    "ec2:security-group-rule": "AWS::EC2::SecurityGroupRule",
    "ec2:route-table": "AWS::EC2::RouteTable",
    "ec2:internet-gateway": "AWS::EC2::InternetGateway",
    "ec2:natgateway": "AWS::EC2::NatGateway",
    "ec2:volume": "AWS::EC2::Volume",
    "ec2:snapshot": "AWS::EC2::Snapshot",
    "ec2:network-interface": "AWS::EC2::NetworkInterface",
    "ec2:network-acl": "AWS::EC2::NetworkAcl",
    "ec2:elastic-ip": "AWS::EC2::EIP",
    "ec2:vpc-endpoint": "AWS::EC2::VPCEndpoint",
    "ec2:key-pair": "AWS::EC2::KeyPair",
    "ec2:dhcp-options": "AWS::EC2::DHCPOptions",
    "lambda:function": "AWS::Lambda::Function",
    "lambda:layer": "AWS::Lambda::LayerVersion",
    "iam:role": "AWS::IAM::Role",
    "iam:policy": "AWS::IAM::ManagedPolicy",
    "iam:user": "AWS::IAM::User",
    "iam:group": "AWS::IAM::Group",
    "iam:saml-provider": "AWS::IAM::SAMLProvider",
    "iam:instance-profile": "AWS::IAM::InstanceProfile",
    "s3:bucket": "AWS::S3::Bucket",
    "dynamodb:table": "AWS::DynamoDB::Table",
    "sqs:queue": "AWS::SQS::Queue",
    "sns:topic": "AWS::SNS::Topic",
    "events:rule": "AWS::Events::Rule",
    "events:event-bus": "AWS::Events::EventBus",
    "logs:log-group": "AWS::Logs::LogGroup",
    "secretsmanager:secret": "AWS::SecretsManager::Secret",
    "ssm:parameter": "AWS::SSM::Parameter",
    "states:stateMachine": "AWS::StepFunctions::StateMachine",
    "apigateway:restapis": "AWS::ApiGateway::RestApi",
    "apigateway:apis": "AWS::ApiGatewayV2::Api",
    "kms:key": "AWS::KMS::Key",
    "cloudformation:stack": "AWS::CloudFormation::Stack",
    "cloudwatch:alarm": "AWS::CloudWatch::Alarm",
    "rds:db": "AWS::RDS::DBInstance",
    "rds:cluster": "AWS::RDS::DBCluster",
    "ecs:cluster": "AWS::ECS::Cluster",
    "ecs:service": "AWS::ECS::Service",
    "eks:cluster": "AWS::EKS::Cluster",
    "ecr:repository": "AWS::ECR::Repository",
    "elasticloadbalancing:loadbalancer": "AWS::ElasticLoadBalancingV2::LoadBalancer",
    "glue:database": "AWS::Glue::Database",
    "glue:job": "AWS::Glue::Job",
    "glue:crawler": "AWS::Glue::Crawler",
    "athena:workgroup": "AWS::Athena::WorkGroup",
    "athena:datacatalog": "AWS::Athena::DataCatalog",
    "kinesis:stream": "AWS::Kinesis::Stream",
    "redshift:cluster": "AWS::Redshift::Cluster",
    "backup:backup-vault": "AWS::Backup::BackupVault",
    "guardduty:detector": "AWS::GuardDuty::Detector",
    "config:config-rule": "AWS::Config::ConfigRule",
    "bedrock:agent": "AWS::Bedrock::Agent",
}


def _generic_type(resource_type: str) -> str:
    """Readable CloudFormation-style name for a type warpcore does not model."""
    service, _, kind = resource_type.partition(":")
    svc = service.replace("-", " ").title().replace(" ", "")
    typ = kind.replace("-", " ").replace("_", " ").title().replace(" ", "") or "Resource"
    return f"AWS::{svc}::{typ}"


def map_type(resource_type: str) -> str:
    """Resource Explorer `service:type` to warpcore's resource type name."""
    return _TYPE_MAP.get(resource_type) or _generic_type(resource_type)


@dataclass
class ExplorerAvailability:
    """Whether Resource Explorer can be queried in a region."""

    region: str
    available: bool
    reason: str = ""


class ResourceExplorerSource:
    """Reads resources from an AWS Resource Explorer index."""

    def __init__(self, boto_session: boto3.Session):
        self.session = boto_session
        self.logger = get_logger(__name__)

    def availability(self, region: str) -> ExplorerAvailability:
        """Check whether a search will work in this region.

        Search needs a view in the region; a view needs an index. Both are
        opt-in, so absence is the normal case for many accounts.
        """
        client = discovery_client(self.session, "resource-explorer-2", region)
        try:
            views = client.list_views().get("Views", [])
        except (ClientError, BotoCoreError) as e:
            code = getattr(e, "response", {}).get("Error", {}).get("Code", type(e).__name__)
            return ExplorerAvailability(region, False, f"{code}")
        if not views:
            return ExplorerAvailability(region, False, "no Resource Explorer view in region")
        return ExplorerAvailability(region, True)

    def search(
        self,
        region: str,
        query: str = "",
        max_resources: Optional[int] = None,
    ) -> List[Resource]:
        """Return every indexed resource visible from this region's view."""
        client = discovery_client(self.session, "resource-explorer-2", region)
        resources: List[Resource] = []

        try:
            paginator = client.get_paginator("search")
            for page in paginator.paginate(QueryString=query):
                for item in page.get("Resources", []):
                    resources.append(self._to_resource(item))
                    if max_resources and len(resources) >= max_resources:
                        return resources
        except (ClientError, BotoCoreError) as e:
            self.logger.warning(f"Resource Explorer search failed in {region}: {e}")
            raise

        self.logger.info(
            f"Resource Explorer returned {len(resources)} resources from {region}"
        )
        return resources

    @staticmethod
    def _to_resource(item: Dict) -> Resource:
        """Convert a Resource Explorer search hit into a warpcore Resource."""
        arn = item["Arn"]
        tags: Dict[str, str] = {}
        for prop in item.get("Properties", []) or []:
            if prop.get("Name") == "tags":
                for tag in prop.get("Data", []) or []:
                    if "Key" in tag:
                        tags[tag["Key"]] = tag.get("Value", "")

        return Resource(
            id=tags.get("Name") or logical_id_from_arn(arn),
            type=map_type(item.get("ResourceType", "")),
            physical_id=arn,
            properties={},
            dependencies=[],
            tags=tags,
            metadata={
                "source": "resource-explorer",
                "region": item.get("Region", ""),
                "explorer_type": item.get("ResourceType", ""),
                "last_reported_at": str(item.get("LastReportedAt", "")),
            },
        )
