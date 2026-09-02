"""AWS resource scanner for drift detection and account discovery.

Two scopes are supported:

* ``ScanScope.PROJECT`` - only resources carrying this project's warpcore tags,
  read from the Resource Groups Tagging API. This is what drift detection
  uses; it must not see unrelated resources.
* ``ScanScope.ACCOUNT`` - everything the caller's credentials can enumerate,
  used to reverse-engineer an account that warpcore did not deploy.

Account scope does NOT use the tagging API to find resources, because that API
only returns resources that are or once were tagged - a bucket nobody ever
tagged is invisible to it. Instead it walks each service's own list API and
then overlays tags from the tagging API. Getting this wrong makes discovery
quietly incomplete rather than visibly broken, which is worse.

Hydration (fetching each resource's real configuration) is opt-in because it
costs one API call per resource.
"""

from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from enum import Enum
from typing import Dict, List, Optional, Sequence, Set

import boto3
from botocore.exceptions import ClientError

from warpcore.state.models import Resource
from warpcore.utils.arn import logical_id_from_arn, resource_type_from_arn, service_identifier
from warpcore.utils.boto import discovery_client
from warpcore.utils.progress import PHASE, REGION_PLAN, plan_for
from warpcore.utils.logging import get_logger

logger = get_logger(__name__)


class ScanScope(Enum):
    """How wide to cast the net when scanning."""

    PROJECT = "project"
    ACCOUNT = "account"


@dataclass
class ScanError:
    """A resource that was found but could not be fully read."""

    physical_id: str
    resource_type: str
    stage: str
    message: str


class ScannedState:
    """Represents the actual state of resources in AWS."""

    def __init__(self):
        """Initialize scanned state."""
        self.resources: Dict[str, Resource] = {}
        self.resource_arns: Set[str] = set()
        self.errors: List[ScanError] = []
        self.unhydrated: Dict[str, int] = {}
        self.truncated: bool = False
        # Whether AWS Resource Explorer contributed. Without it, coverage is
        # limited to the services warpcore enumerates by hand.
        self.explorer_available: bool = False

    def add_resource(self, resource: Resource):
        """Add a scanned resource.

        Keyed on physical id, not logical id. Naming a role after the function
        it serves is the most common convention in AWS - `gitf-wake` the role
        and `gitf-wake` the Lambda - and keying on the logical id made the
        second one silently overwrite the first, dropping it from the
        inventory with no error.
        """
        self.resources[self._key(resource)] = resource
        if resource.physical_id:
            self.resource_arns.add(resource.physical_id)

    @staticmethod
    def _key(resource: Resource) -> str:
        """Unique key for a scanned resource."""
        return resource.physical_id or f"{resource.type}/{resource.id}"

    def add_error(self, error: ScanError) -> None:
        """Record a resource that could not be read."""
        self.errors.append(error)

    def has_resource(self, physical_id: str) -> bool:
        """Check if a resource exists by physical ID."""
        return physical_id in self.resource_arns

    def get_resource_by_physical_id(self, physical_id: str) -> Optional[Resource]:
        """Get resource by physical ID."""
        for resource in self.resources.values():
            if resource.physical_id == physical_id:
                return resource
        return None

    def get_all_resources(self) -> List[Resource]:
        """Get all scanned resources."""
        return list(self.resources.values())

    def count_by_type(self) -> Dict[str, int]:
        """Count scanned resources grouped by resource type."""
        counts: Dict[str, int] = {}
        for resource in self.resources.values():
            counts[resource.type] = counts.get(resource.type, 0) + 1
        return dict(sorted(counts.items(), key=lambda kv: (-kv[1], kv[0])))


class AWSScanner:
    """Scans an AWS account for resources."""

    def __init__(
        self,
        boto_session: boto3.Session,
        project_name: str,
        environment: str,
        region: str,
        account: Optional[str] = None
    ):
        """Initialize AWS scanner.

        Args:
            boto_session: Boto3 session
            project_name: Project name to filter resources
            environment: Environment name to filter resources
            region: AWS region
            account: AWS account id. Looked up via STS when omitted; only
                needed to synthesise ARNs during account-wide enumeration.
        """
        self.session = boto_session
        self.project_name = project_name
        self.environment = environment
        self.region = region
        self._account = account
        self.logger = get_logger(__name__)

        # Initialize AWS clients
        self.resource_groups_tagging = discovery_client(
            self.session, 'resourcegroupstaggingapi', region
        )

    @property
    def account(self) -> str:
        """AWS account id, resolved lazily and cached."""
        if self._account is None:
            try:
                self._account = discovery_client(
                    self.session, "sts", self.region
                ).get_caller_identity()["Account"]
            except Exception as e:  # noqa: BLE001 - only affects synthesised ARNs
                self.logger.warning(f"Could not resolve account id: {e}")
                self._account = ""
        return self._account

    def scan_resources(
        self,
        scope: ScanScope = ScanScope.PROJECT,
        hydrate: bool = False,
        resource_types: Optional[Sequence[str]] = None,
        max_resources: Optional[int] = None,
        max_workers: int = 8,
        progress=None,
    ) -> ScannedState:
        """Scan AWS for resources.

        Args:
            scope: PROJECT restricts to this project's warpcore tags; ACCOUNT
                enumerates everything the credentials can see.
            hydrate: Fetch each resource's real configuration. Costs one API
                call per resource, so it is off by default.
            resource_types: Optional CloudFormation-style type allowlist
                (e.g. ``["AWS::Lambda::Function"]``) applied after ARN parsing.
            max_resources: Stop after this many resources. Guards against
                walking an enormous account by accident.
            max_workers: Parallelism for hydration.

        Returns:
            ScannedState containing all found resources
        """
        if scope is ScanScope.PROJECT:
            self.logger.info(
                f"Scanning AWS resources for project={self.project_name}, "
                f"environment={self.environment}"
            )
        else:
            self.logger.info(
                f"Scanning all resources in region={self.region} (account-wide scope)"
            )

        scanned_state = ScannedState()
        wanted_types = set(resource_types) if resource_types else None

        if scope is ScanScope.PROJECT:
            self._scan_by_tags(scanned_state, wanted_types, max_resources)
        else:
            self._scan_by_enumeration(
                scanned_state, wanted_types, max_resources, progress=progress
            )

        self.logger.info(f"Scanned {len(scanned_state.resources)} resources from AWS")

        if hydrate:
            if progress is not None:
                progress.emit(
                    PHASE, phase="hydrate", status="running",
                    total=len(scanned_state.resources),
                )
            self.hydrate(scanned_state, max_workers=max_workers)
            if progress is not None:
                progress.emit(
                    PHASE, phase="hydrate", status="done",
                    found=len(scanned_state.resources) - len(scanned_state.unhydrated),
                )

        return scanned_state

    def _scan_by_tags(
        self,
        scanned_state: ScannedState,
        wanted_types: Optional[Set[str]],
        max_resources: Optional[int],
    ) -> None:
        """Find resources via the tagging API, filtered to this project."""
        tag_filters = [
            {'Key': 'warpcore:project', 'Values': [self.project_name]},
            {'Key': 'warpcore:environment', 'Values': [self.environment]},
        ]

        try:
            paginator = self.resource_groups_tagging.get_paginator('get_resources')
            for page in paginator.paginate(TagFilters=tag_filters, ResourcesPerPage=100):
                for resource_info in page.get('ResourceTagMappingList', []):
                    arn = resource_info['ResourceARN']
                    tags = {t['Key']: t['Value'] for t in resource_info.get('Tags', [])}

                    resource_type = resource_type_from_arn(arn)
                    if wanted_types and resource_type not in wanted_types:
                        continue

                    scanned_state.add_resource(Resource(
                        id=tags.get('Name') or logical_id_from_arn(arn),
                        type=resource_type,
                        physical_id=arn,
                        properties={},
                        dependencies=[],
                        tags=tags,
                    ))

                    if max_resources and len(scanned_state.resources) >= max_resources:
                        scanned_state.truncated = True
                        self.logger.warning(
                            f"Stopped scanning at max_resources={max_resources}; "
                            f"results are incomplete"
                        )
                        return
        except ClientError as e:
            self.logger.error(f"Error scanning AWS resources: {e}")
            raise

    def _scan_by_enumeration(
        self,
        scanned_state: ScannedState,
        wanted_types: Optional[Set[str]],
        max_resources: Optional[int],
        progress=None,
    ) -> None:
        """Find every resource in the region, from every source available.

        Resource Explorer, when the account has it enabled, is the most complete
        source: an AWS-maintained index of nearly every type. The per-service
        enumerators always run too - they are the fallback when Resource
        Explorer is absent, and they use warpcore's canonical type names. The
        two are merged by ARN, and each resource records which sources saw it.
        """
        from warpcore.discovery.enumerator import ServiceEnumerator
        from warpcore.discovery.resource_explorer import ResourceExplorerSource

        by_arn: Dict[str, Resource] = {}

        def merge(resource: Resource, source: str) -> None:
            key = resource.physical_id or f"{resource.type}/{resource.id}"
            existing = by_arn.get(key)
            if existing is None:
                resource.metadata = {**(resource.metadata or {}), "sources": [source]}
                by_arn[key] = resource
                return
            # Keep the first record but fold in anything the second knows.
            existing.tags = {**(resource.tags or {}), **(existing.tags or {})}
            sources = existing.metadata.setdefault("sources", [])
            if source not in sources:
                sources.append(source)
            for k, v in (resource.metadata or {}).items():
                existing.metadata.setdefault(k, v)

        enumerator_preview = ServiceEnumerator(
            boto_session=self.session, region=self.region, account=""
        )
        if progress is not None:
            progress.emit(
                REGION_PLAN,
                phases=plan_for(enumerator_preview.supported_services(), hydrate=False),
                services=enumerator_preview.supported_services(),
            )
            progress.emit(PHASE, phase="resource-explorer", status="running")

        explorer = ResourceExplorerSource(self.session)
        availability = explorer.availability(self.region)
        scanned_state.explorer_available = availability.available
        if availability.available:
            try:
                for resource in explorer.search(self.region):
                    merge(resource, "resource-explorer")
            except Exception as e:  # noqa: BLE001 - fall through to enumerators
                scanned_state.add_error(ScanError(
                    physical_id="(resource-explorer)",
                    resource_type="resource-explorer-2",
                    stage="enumerate",
                    message=str(e),
                ))
        else:
            self.logger.info(
                f"Resource Explorer not available in {self.region} "
                f"({availability.reason}); using service enumerators only"
            )
        if progress is not None:
            progress.emit(
                PHASE, phase="resource-explorer",
                status="done" if availability.available else "skipped",
                found=len(by_arn), reason=availability.reason,
            )

        enumerator = ServiceEnumerator(
            boto_session=self.session, region=self.region, account=self.account
        )
        # Enumerators use warpcore's canonical types, so let them win on a
        # collision by inserting them over the explorer's record.
        for resource in enumerator.enumerate(progress=progress):
            key = resource.physical_id or f"{resource.type}/{resource.id}"
            if key in by_arn:
                existing = by_arn[key]
                resource.tags = {**(existing.tags or {}), **(resource.tags or {})}
                resource.metadata = {**(existing.metadata or {}), **(resource.metadata or {})}
                sources = resource.metadata.setdefault("sources", [])
                if "service-api" not in sources:
                    sources.append("service-api")
                by_arn[key] = resource
            else:
                merge(resource, "service-api")

        for error in enumerator.errors:
            scanned_state.add_error(ScanError(
                physical_id=f"(service: {error.service})",
                resource_type=error.service,
                stage="enumerate",
                message=error.message,
            ))

        if progress is not None:
            progress.emit(PHASE, phase="tags", status="running")
        tags_by_arn = self._tags_by_arn()
        if progress is not None:
            progress.emit(PHASE, phase="tags", status="done", found=len(tags_by_arn))

        for resource in by_arn.values():
            if wanted_types and resource.type not in wanted_types:
                continue
            if resource.physical_id in tags_by_arn:
                resource.tags = {**tags_by_arn[resource.physical_id], **(resource.tags or {})}
            if resource.tags.get("Name"):
                resource.id = resource.tags["Name"]
            scanned_state.add_resource(resource)

            if max_resources and len(scanned_state.resources) >= max_resources:
                scanned_state.truncated = True
                self.logger.warning(
                    f"Stopped scanning at max_resources={max_resources}; "
                    f"results are incomplete"
                )
                return

    def _tags_by_arn(self) -> Dict[str, Dict[str, str]]:
        """Tags for every tagged resource in the region, keyed by ARN.

        Used to decorate enumerated resources. Failure is non-fatal: an
        inventory without tags is still an inventory.
        """
        tags: Dict[str, Dict[str, str]] = {}
        try:
            paginator = self.resource_groups_tagging.get_paginator('get_resources')
            for page in paginator.paginate(ResourcesPerPage=100):
                for entry in page.get('ResourceTagMappingList', []):
                    tags[entry['ResourceARN']] = {
                        t['Key']: t['Value'] for t in entry.get('Tags', [])
                    }
        except ClientError as e:
            self.logger.warning(f"Could not read tags: {e}")
        return tags

    def hydrate(self, scanned_state: ScannedState, max_workers: int = 8) -> ScannedState:
        """Fill in each resource's ``properties`` from its owning service.

        The tagging API returns only ARNs and tags. Without this step every
        scanned resource has empty properties, which makes drift detection
        blind to configuration changes and makes config emission useless.

        Failures are recorded on the ScannedState rather than raised: a single
        resource the caller lacks read permission on should not abort an
        otherwise useful inventory.
        """
        resources = [r for r in scanned_state.resources.values() if r.physical_id]
        if not resources:
            return scanned_state

        self.logger.info(f"Hydrating {len(resources)} resources ({max_workers} workers)...")

        def _fetch(resource: Resource):
            return resource, self.get_resource_details(resource.type, resource.physical_id)

        hydrated = 0
        with ThreadPoolExecutor(max_workers=max_workers) as executor:
            futures = {executor.submit(_fetch, r): r for r in resources}
            for future in as_completed(futures):
                resource = futures[future]
                try:
                    _, details = future.result()
                except Exception as e:  # noqa: BLE001 - recorded, not raised
                    scanned_state.add_error(ScanError(
                        physical_id=resource.physical_id or resource.id,
                        resource_type=resource.type,
                        stage="hydrate",
                        message=str(e),
                    ))
                    continue

                if details is None:
                    # No reader for this type: a coverage gap, not a failure.
                    # Counting these separately keeps real errors - permission
                    # denials, malformed ids - visible instead of buried.
                    scanned_state.unhydrated[resource.type] = (
                        scanned_state.unhydrated.get(resource.type, 0) + 1
                    )
                    continue

                resource.properties = _json_safe(details)
                hydrated += 1

        skipped = sum(scanned_state.unhydrated.values())
        self.logger.info(
            f"Hydrated {hydrated}/{len(resources)} resources "
            f"({len(scanned_state.errors)} could not be read, "
            f"{skipped} have no reader)"
        )
        return scanned_state

    def get_resource_details(
        self,
        resource_type: str,
        physical_id: str
    ) -> Optional[Dict]:
        """Get detailed properties for a specific resource.

        Args:
            resource_type: AWS resource type
            physical_id: Physical resource ID/ARN

        Returns:
            Dictionary of resource properties or None if unsupported
        """
        reader = self._DETAIL_READERS.get(resource_type)
        if reader is None:
            self.logger.debug(f"No detail reader for resource type: {resource_type}")
            return None

        # Each service wants its own identifier shape, not the raw ARN.
        identifier = service_identifier(physical_id)

        try:
            return reader(self, identifier)
        except ClientError as e:
            self.logger.warning(f"Error reading {resource_type} {identifier}: {e}")
            raise

    def _get_lambda_details(self, function_name: str) -> Dict:
        """Get Lambda function details."""
        lambda_client = discovery_client(self.session, 'lambda', self.region)
        response = lambda_client.get_function(FunctionName=function_name)
        details = dict(response.get('Configuration', {}))
        # Layers/env come back nested; keep them, drop the presigned code URL
        # which is a short-lived credential and must not land in a config file.
        details.pop('Code', None)
        return details

    def _get_iam_role_details(self, role_name: str) -> Dict:
        """Get IAM role details, including attached and inline policies."""
        iam_client = discovery_client(self.session, 'iam')
        details = dict(iam_client.get_role(RoleName=role_name).get('Role', {}))

        attached = iam_client.list_attached_role_policies(RoleName=role_name)
        details['AttachedPolicies'] = attached.get('AttachedPolicies', [])

        inline = iam_client.list_role_policies(RoleName=role_name)
        details['InlinePolicyNames'] = inline.get('PolicyNames', [])
        return details

    def _get_vpc_details(self, vpc_id: str) -> Dict:
        """Get VPC details."""
        ec2_client = discovery_client(self.session, 'ec2', self.region)
        response = ec2_client.describe_vpcs(VpcIds=[vpc_id])
        vpcs = response.get('Vpcs', [])
        return vpcs[0] if vpcs else {}

    def _get_subnet_details(self, subnet_id: str) -> Dict:
        """Get subnet details."""
        ec2_client = discovery_client(self.session, 'ec2', self.region)
        response = ec2_client.describe_subnets(SubnetIds=[subnet_id])
        subnets = response.get('Subnets', [])
        return subnets[0] if subnets else {}

    def _get_security_group_details(self, sg_id: str) -> Dict:
        """Get security group details."""
        ec2_client = discovery_client(self.session, 'ec2', self.region)
        response = ec2_client.describe_security_groups(GroupIds=[sg_id])
        sgs = response.get('SecurityGroups', [])
        return sgs[0] if sgs else {}

    def _get_instance_details(self, instance_id: str) -> Dict:
        """Get EC2 instance details."""
        ec2_client = discovery_client(self.session, 'ec2', self.region)
        response = ec2_client.describe_instances(InstanceIds=[instance_id])
        for reservation in response.get('Reservations', []):
            for instance in reservation.get('Instances', []):
                return instance
        return {}

    def _get_nat_gateway_details(self, nat_gateway_id: str) -> Dict:
        """Get NAT gateway details."""
        ec2_client = discovery_client(self.session, 'ec2', self.region)
        response = ec2_client.describe_nat_gateways(NatGatewayIds=[nat_gateway_id])
        gateways = response.get('NatGateways', [])
        return gateways[0] if gateways else {}

    def _get_volume_details(self, volume_id: str) -> Dict:
        """Get EBS volume details."""
        ec2_client = discovery_client(self.session, 'ec2', self.region)
        response = ec2_client.describe_volumes(VolumeIds=[volume_id])
        volumes = response.get('Volumes', [])
        return volumes[0] if volumes else {}

    def _get_route_table_details(self, route_table_id: str) -> Dict:
        """Get route table details."""
        ec2_client = discovery_client(self.session, 'ec2', self.region)
        response = ec2_client.describe_route_tables(RouteTableIds=[route_table_id])
        tables = response.get('RouteTables', [])
        return tables[0] if tables else {}

    def _get_vpc_endpoint_details(self, endpoint_id: str) -> Dict:
        """Get VPC endpoint details."""
        ec2_client = discovery_client(self.session, 'ec2', self.region)
        response = ec2_client.describe_vpc_endpoints(VpcEndpointIds=[endpoint_id])
        endpoints = response.get('VpcEndpoints', [])
        return endpoints[0] if endpoints else {}

    def _get_s3_bucket_details(self, bucket_name: str) -> Dict:
        """Get S3 bucket details.

        Each sub-call is individually optional: a bucket with no encryption
        configuration raises rather than returning an empty result.
        """
        s3_client = discovery_client(self.session, 's3', self.region)
        details: Dict = {'BucketName': bucket_name}

        def _try(key: str, fn):
            try:
                details[key] = fn()
            except ClientError:
                details[key] = None

        _try('Location', lambda: s3_client.get_bucket_location(
            Bucket=bucket_name).get('LocationConstraint'))
        _try('Encryption', lambda: s3_client.get_bucket_encryption(
            Bucket=bucket_name).get('ServerSideEncryptionConfiguration'))
        _try('Versioning', lambda: s3_client.get_bucket_versioning(
            Bucket=bucket_name).get('Status'))
        _try('PublicAccessBlock', lambda: s3_client.get_public_access_block(
            Bucket=bucket_name).get('PublicAccessBlockConfiguration'))
        return details

    def _get_dynamodb_table_details(self, table_name: str) -> Dict:
        """Get DynamoDB table details."""
        dynamodb_client = discovery_client(self.session, 'dynamodb', self.region)
        response = dynamodb_client.describe_table(TableName=table_name)
        return response.get('Table', {})

    def _get_sqs_queue_details(self, queue_url: str) -> Dict:
        """Get SQS queue details."""
        sqs_client = discovery_client(self.session, 'sqs', self.region)
        response = sqs_client.get_queue_attributes(
            QueueUrl=queue_url,
            AttributeNames=['All']
        )
        return response.get('Attributes', {})

    def _get_sns_topic_details(self, topic_arn: str) -> Dict:
        """Get SNS topic details."""
        sns_client = discovery_client(self.session, 'sns', self.region)
        response = sns_client.get_topic_attributes(TopicArn=topic_arn)
        return response.get('Attributes', {})

    def _get_log_group_details(self, log_group_name: str) -> Dict:
        """Get CloudWatch log group details."""
        logs_client = discovery_client(self.session, 'logs', self.region)
        response = logs_client.describe_log_groups(logGroupNamePrefix=log_group_name)
        for group in response.get('logGroups', []):
            if group.get('logGroupName') == log_group_name:
                return group
        return {}

    def _get_events_rule_details(self, rule_name: str) -> Dict:
        """Get EventBridge rule details, including its targets."""
        events_client = discovery_client(self.session, 'events', self.region)
        details = dict(events_client.describe_rule(Name=rule_name))
        details.pop('ResponseMetadata', None)
        targets = events_client.list_targets_by_rule(Rule=rule_name)
        details['Targets'] = targets.get('Targets', [])
        return details

    def _get_secret_details(self, secret_arn: str) -> Dict:
        """Get Secrets Manager secret metadata.

        Deliberately uses describe_secret, never get_secret_value - warpcore
        must never read a secret's plaintext into state or a config file.
        """
        secrets_client = discovery_client(self.session, 'secretsmanager', self.region)
        details = dict(secrets_client.describe_secret(SecretId=secret_arn))
        details.pop('ResponseMetadata', None)
        return details

    def _get_state_machine_details(self, state_machine_arn: str) -> Dict:
        """Get Step Functions state machine details."""
        sfn_client = discovery_client(self.session, 'stepfunctions', self.region)
        details = dict(sfn_client.describe_state_machine(stateMachineArn=state_machine_arn))
        details.pop('ResponseMetadata', None)
        return details

    # Dispatch table, consulted by get_resource_details. Adding a service means
    # adding a reader and one row here.
    _DETAIL_READERS = {
        'AWS::Lambda::Function': _get_lambda_details,
        'AWS::IAM::Role': _get_iam_role_details,
        'AWS::EC2::VPC': _get_vpc_details,
        'AWS::EC2::Subnet': _get_subnet_details,
        'AWS::EC2::SecurityGroup': _get_security_group_details,
        'AWS::EC2::Instance': _get_instance_details,
        'AWS::EC2::NatGateway': _get_nat_gateway_details,
        'AWS::EC2::Volume': _get_volume_details,
        'AWS::EC2::RouteTable': _get_route_table_details,
        'AWS::EC2::VPCEndpoint': _get_vpc_endpoint_details,
        'AWS::S3::Bucket': _get_s3_bucket_details,
        'AWS::DynamoDB::Table': _get_dynamodb_table_details,
        'AWS::SQS::Queue': _get_sqs_queue_details,
        'AWS::SNS::Topic': _get_sns_topic_details,
        'AWS::Logs::LogGroup': _get_log_group_details,
        'AWS::Events::Rule': _get_events_rule_details,
        'AWS::SecretsManager::Secret': _get_secret_details,
        'AWS::StepFunctions::StateMachine': _get_state_machine_details,
    }

    def supported_detail_types(self) -> List[str]:
        """Resource types this scanner can hydrate."""
        return sorted(self._DETAIL_READERS)


def _json_safe(value):
    """Coerce boto3 responses into JSON-serialisable values.

    boto3 returns datetimes and, for some services, Decimal - both of which
    break json.dump when the scan result is written to a state file.
    """
    from datetime import date, datetime
    from decimal import Decimal

    if isinstance(value, dict):
        return {k: _json_safe(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_safe(v) for v in value]
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    return value
