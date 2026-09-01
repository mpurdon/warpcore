"""Enumerate resources directly from each service's own API.

The Resource Groups Tagging API only returns resources that are - or once
were - tagged. A bucket nobody ever tagged is invisible to it. That is fine
for drift detection, which only cares about resources warpcore tagged itself,
but it makes it useless for answering "what is actually in this account".

So account-wide discovery walks each service's own list/describe API. It is
more calls and more code, but it is the only way to see everything.

Each enumerator is independent and failure-isolated: a service the caller has
no permission on contributes an error, not an exception.
"""

from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from typing import Callable, Dict, List, Optional, Sequence

import boto3
from botocore.exceptions import BotoCoreError, ClientError

from warpcore.state.models import Resource
from warpcore.utils.logging import get_logger

logger = get_logger(__name__)


@dataclass
class EnumerationError:
    """A service that could not be listed."""

    service: str
    message: str


class ServiceEnumerator:
    """Lists resources from each supported service's own API."""

    def __init__(self, boto_session: boto3.Session, region: str, account: str = ""):
        self.session = boto_session
        self.region = region
        self.account = account
        self.logger = get_logger(__name__)
        self.errors: List[EnumerationError] = []

    def supported_services(self) -> List[str]:
        return sorted(self._ENUMERATORS)

    def enumerate(
        self,
        services: Optional[Sequence[str]] = None,
        max_workers: int = 8,
    ) -> List[Resource]:
        """List resources across services, in parallel."""
        wanted = list(services) if services else self.supported_services()
        resources: List[Resource] = []

        with ThreadPoolExecutor(max_workers=max_workers) as executor:
            futures = {
                executor.submit(self._safe_enumerate, service): service
                for service in wanted
                if service in self._ENUMERATORS
            }
            for future in as_completed(futures):
                resources.extend(future.result())

        self.logger.info(
            f"Enumerated {len(resources)} resources across {len(wanted)} service(s)"
            + (f"; {len(self.errors)} service(s) failed" if self.errors else "")
        )
        return resources

    def _safe_enumerate(self, service: str) -> List[Resource]:
        """Run one service's enumerator, converting failures into errors."""
        try:
            return self._ENUMERATORS[service](self)
        except (ClientError, BotoCoreError) as e:
            self.errors.append(EnumerationError(service=service, message=str(e)))
            self.logger.debug(f"could not enumerate {service}: {e}")
            return []
        except Exception as e:  # noqa: BLE001 - one bad service must not stop discovery
            self.errors.append(EnumerationError(service=service, message=str(e)))
            self.logger.warning(f"unexpected error enumerating {service}: {e}")
            return []

    def _client(self, service: str, global_service: bool = False):
        region = None if global_service else self.region
        return self.session.client(service, region_name=region or self.region)

    def _paginate(self, client, operation: str, result_key: str, **kwargs):
        """Yield every item from a paginated operation, or fall back to one call."""
        if client.can_paginate(operation):
            paginator = client.get_paginator(operation)
            for page in paginator.paginate(**kwargs):
                yield from page.get(result_key, [])
        else:
            response = getattr(client, operation)(**kwargs)
            yield from response.get(result_key, [])

    # ------------------------------------------------------------- services

    def _enumerate_lambda(self) -> List[Resource]:
        client = self._client("lambda")
        return [
            Resource(
                id=fn["FunctionName"],
                type="AWS::Lambda::Function",
                physical_id=fn["FunctionArn"],
                properties={},
            )
            for fn in self._paginate(client, "list_functions", "Functions")
        ]

    def _enumerate_s3(self) -> List[Resource]:
        client = self._client("s3")
        buckets = client.list_buckets().get("Buckets", [])
        resources = []
        for bucket in buckets:
            name = bucket["Name"]
            # list_buckets is global; only keep buckets in the scanned region.
            try:
                location = client.get_bucket_location(Bucket=name).get("LocationConstraint")
                bucket_region = location or "us-east-1"
            except ClientError:
                continue
            if bucket_region != self.region:
                continue
            resources.append(Resource(
                id=name,
                type="AWS::S3::Bucket",
                physical_id=f"arn:aws:s3:::{name}",
                properties={},
            ))
        return resources

    def _enumerate_dynamodb(self) -> List[Resource]:
        client = self._client("dynamodb")
        return [
            Resource(
                id=name,
                type="AWS::DynamoDB::Table",
                physical_id=f"arn:aws:dynamodb:{self.region}:{self.account}:table/{name}",
                properties={},
            )
            for name in self._paginate(client, "list_tables", "TableNames")
        ]

    def _enumerate_sqs(self) -> List[Resource]:
        client = self._client("sqs")
        resources = []
        for url in self._paginate(client, "list_queues", "QueueUrls"):
            name = url.rsplit("/", 1)[-1]
            resources.append(Resource(
                id=name,
                type="AWS::SQS::Queue",
                physical_id=f"arn:aws:sqs:{self.region}:{self.account}:{name}",
                properties={},
            ))
        return resources

    def _enumerate_sns(self) -> List[Resource]:
        client = self._client("sns")
        return [
            Resource(
                id=topic["TopicArn"].rsplit(":", 1)[-1],
                type="AWS::SNS::Topic",
                physical_id=topic["TopicArn"],
                properties={},
            )
            for topic in self._paginate(client, "list_topics", "Topics")
        ]

    def _enumerate_iam(self) -> List[Resource]:
        client = self._client("iam", global_service=True)
        return [
            Resource(
                id=role["RoleName"],
                type="AWS::IAM::Role",
                physical_id=role["Arn"],
                properties={},
            )
            for role in self._paginate(client, "list_roles", "Roles")
            # Service-linked roles are AWS-managed and not adoptable.
            if not role["Path"].startswith("/aws-service-role/")
        ]

    def _enumerate_ec2(self) -> List[Resource]:
        client = self._client("ec2")
        resources: List[Resource] = []

        for vpc in self._paginate(client, "describe_vpcs", "Vpcs"):
            resources.append(Resource(
                id=vpc["VpcId"], type="AWS::EC2::VPC",
                physical_id=f"arn:aws:ec2:{self.region}:{self.account}:vpc/{vpc['VpcId']}",
                properties={},
            ))
        for subnet in self._paginate(client, "describe_subnets", "Subnets"):
            resources.append(Resource(
                id=subnet["SubnetId"], type="AWS::EC2::Subnet",
                physical_id=f"arn:aws:ec2:{self.region}:{self.account}:subnet/{subnet['SubnetId']}",
                properties={},
            ))
        for group in self._paginate(client, "describe_security_groups", "SecurityGroups"):
            resources.append(Resource(
                id=group["GroupId"], type="AWS::EC2::SecurityGroup",
                physical_id=(
                    f"arn:aws:ec2:{self.region}:{self.account}:"
                    f"security-group/{group['GroupId']}"
                ),
                properties={},
            ))
        return resources

    def _enumerate_logs(self) -> List[Resource]:
        client = self._client("logs")
        return [
            Resource(
                id=group["logGroupName"],
                type="AWS::Logs::LogGroup",
                physical_id=group.get("arn") or (
                    f"arn:aws:logs:{self.region}:{self.account}:"
                    f"log-group:{group['logGroupName']}"
                ),
                properties={},
            )
            for group in self._paginate(client, "describe_log_groups", "logGroups")
        ]

    def _enumerate_events(self) -> List[Resource]:
        client = self._client("events")
        return [
            Resource(
                id=rule["Name"],
                type="AWS::Events::Rule",
                physical_id=rule["Arn"],
                properties={},
            )
            for rule in self._paginate(client, "list_rules", "Rules")
        ]

    def _enumerate_secretsmanager(self) -> List[Resource]:
        client = self._client("secretsmanager")
        return [
            Resource(
                id=secret["Name"],
                type="AWS::SecretsManager::Secret",
                physical_id=secret["ARN"],
                properties={},
            )
            for secret in self._paginate(client, "list_secrets", "SecretList")
        ]

    def _enumerate_stepfunctions(self) -> List[Resource]:
        client = self._client("stepfunctions")
        return [
            Resource(
                id=machine["name"],
                type="AWS::StepFunctions::StateMachine",
                physical_id=machine["stateMachineArn"],
                properties={},
            )
            for machine in self._paginate(client, "list_state_machines", "stateMachines")
        ]

    def _enumerate_apigatewayv2(self) -> List[Resource]:
        client = self._client("apigatewayv2")
        return [
            Resource(
                id=api.get("Name") or api["ApiId"],
                type="AWS::ApiGatewayV2::Api",
                physical_id=(
                    f"arn:aws:apigateway:{self.region}::/apis/{api['ApiId']}"
                ),
                properties={},
            )
            for api in self._paginate(client, "get_apis", "Items")
        ]

    _ENUMERATORS: Dict[str, Callable[["ServiceEnumerator"], List[Resource]]] = {
        "lambda": _enumerate_lambda,
        "s3": _enumerate_s3,
        "dynamodb": _enumerate_dynamodb,
        "sqs": _enumerate_sqs,
        "sns": _enumerate_sns,
        "iam": _enumerate_iam,
        "ec2": _enumerate_ec2,
        "logs": _enumerate_logs,
        "events": _enumerate_events,
        "secretsmanager": _enumerate_secretsmanager,
        "stepfunctions": _enumerate_stepfunctions,
        "apigatewayv2": _enumerate_apigatewayv2,
    }
