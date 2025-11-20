"""Deployment history manager with S3 storage."""

import json
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional
import yaml

from botocore.exceptions import ClientError

from strands_deploy.history.models import (
    DeploymentMetadata,
    DeploymentRecord,
    DeploymentStatus,
    LogEntry,
    APICall,
    ResourceChange,
    DeploymentDiff,
)
from strands_deploy.history.cost_estimator import CostEstimator
from strands_deploy.history.comparison import DeploymentComparator, compare_deployments
from strands_deploy.state.models import State
from strands_deploy.config.models import Config
from strands_deploy.utils.logging import get_logger
from strands_deploy.utils.errors import DeploymentError

logger = get_logger(__name__)


class HistoryError(Exception):
    """Base exception for history management errors."""

    pass


class DeploymentHistoryManager:
    """Manages deployment history with S3 storage."""

    def __init__(
        self,
        s3_client,
        bucket_name: str,
        project_name: str,
        environment: str,
        region: str,
        account: str,
    ):
        """
        Initialize deployment history manager.

        Args:
            s3_client: Boto3 S3 client
            bucket_name: S3 bucket name for history storage
            project_name: Project name
            environment: Environment name
            region: AWS region
            account: AWS account ID
        """
        self.s3 = s3_client
        self.bucket_name = bucket_name
        self.project_name = project_name
        self.environment = environment
        self.region = region
        self.account = account
        self.logger = get_logger(__name__)
        self.cost_estimator = CostEstimator()
        self.comparator = DeploymentComparator()

    def ensure_bucket_exists(self) -> None:
        """Ensure the S3 bucket exists, create if not."""
        try:
            self.s3.head_bucket(Bucket=self.bucket_name)
            self.logger.debug(f"History bucket exists: {self.bucket_name}")
        except ClientError as e:
            error_code = e.response.get("Error", {}).get("Code")
            if error_code == "404":
                # Bucket doesn't exist, create it
                self.logger.info(f"Creating history bucket: {self.bucket_name}")
                try:
                    if self.region == "us-east-1":
                        self.s3.create_bucket(Bucket=self.bucket_name)
                    else:
                        self.s3.create_bucket(
                            Bucket=self.bucket_name,
                            CreateBucketConfiguration={"LocationConstraint": self.region},
                        )

                    # Enable versioning
                    self.s3.put_bucket_versioning(
                        Bucket=self.bucket_name,
                        VersioningConfiguration={"Status": "Enabled"},
                    )

                    # Enable encryption
                    self.s3.put_bucket_encryption(
                        Bucket=self.bucket_name,
                        ServerSideEncryptionConfiguration={
                            "Rules": [
                                {
                                    "ApplyServerSideEncryptionByDefault": {
                                        "SSEAlgorithm": "AES256"
                                    }
                                }
                            ]
                        },
                    )

                    self.logger.info(f"Created history bucket: {self.bucket_name}")
                except ClientError as create_error:
                    raise HistoryError(
                        f"Failed to create history bucket: {str(create_error)}"
                    )
            else:
                raise HistoryError(f"Failed to access history bucket: {str(e)}")

    def create_deployment_record(
        self, config: Config, state_before: Optional[State], deployed_by: str, version: str
    ) -> str:
        """
        Create new deployment record and return deployment ID.

        Args:
            config: Configuration used for deployment
            state_before: State before deployment (None for initial deployment)
            deployed_by: IAM user/role ARN
            version: Deployment system version

        Returns:
            Deployment ID
        """
        # Generate unique deployment ID
        timestamp = datetime.utcnow().isoformat().replace(":", "-").replace(".", "-")
        short_id = uuid.uuid4().hex[:6]
        deployment_id = f"{timestamp}Z-{short_id}"

        self.logger.info(f"Creating deployment record: {deployment_id}")

        try:
            # Ensure bucket exists
            self.ensure_bucket_exists()

            prefix = self._get_deployment_prefix(deployment_id)

            # Upload configuration
            config_yaml = yaml.dump(config.to_dict(), default_flow_style=False, sort_keys=False)
            self.s3.put_object(
                Bucket=self.bucket_name, Key=f"{prefix}/config.yaml", Body=config_yaml
            )

            # Upload state before deployment
            if state_before:
                self.s3.put_object(
                    Bucket=self.bucket_name,
                    Key=f"{prefix}/state-before.json",
                    Body=json.dumps(state_before.to_dict(), indent=2),
                )

            # Create initial metadata
            metadata = DeploymentMetadata(
                deployment_id=deployment_id,
                project_name=self.project_name,
                environment=self.environment,
                start_time=datetime.utcnow(),
                status=DeploymentStatus.IN_PROGRESS,
                deployed_by=deployed_by,
                version=version,
            )

            self.s3.put_object(
                Bucket=self.bucket_name,
                Key=f"{prefix}/metadata.json",
                Body=json.dumps(metadata.to_dict(), indent=2),
            )

            self.logger.info(f"Created deployment record: {deployment_id}")
            return deployment_id

        except ClientError as e:
            raise HistoryError(f"Failed to create deployment record: {str(e)}")

    def finalize_deployment_record(
        self,
        deployment_id: str,
        state_after: State,
        status: DeploymentStatus,
        changes: Dict[str, List[str]],
        execution_log: List[LogEntry],
        resource_logs: Dict[str, str],
        api_calls: List[APICall],
        estimated_cost: Optional[float] = None,
        error_message: Optional[str] = None,
    ) -> None:
        """
        Finalize deployment record with results and logs.

        Args:
            deployment_id: Deployment ID
            state_after: State after deployment
            status: Final deployment status
            changes: Resource changes (created, updated, deleted)
            execution_log: Structured execution logs
            resource_logs: Per-resource logs
            api_calls: AWS API calls made
            estimated_cost: Estimated monthly cost (auto-calculated if None)
            error_message: Error message if failed
        """
        self.logger.info(f"Finalizing deployment record: {deployment_id}")

        try:
            prefix = self._get_deployment_prefix(deployment_id)

            # Upload state after deployment
            self.s3.put_object(
                Bucket=self.bucket_name,
                Key=f"{prefix}/state-after.json",
                Body=json.dumps(state_after.to_dict(), indent=2),
            )

            # Upload execution logs (structured JSONL)
            execution_log_jsonl = "\n".join(
                json.dumps(
                    {
                        "timestamp": entry.timestamp.isoformat(),
                        "level": entry.level.value,
                        "message": entry.message,
                        "resource_id": entry.resource_id,
                        "context": entry.context,
                    }
                )
                for entry in execution_log
            )
            self.s3.put_object(
                Bucket=self.bucket_name,
                Key=f"{prefix}/execution-log.jsonl",
                Body=execution_log_jsonl,
            )

            # Upload per-resource logs
            for resource_id, logs in resource_logs.items():
                # Sanitize resource ID for use in S3 key
                safe_resource_id = resource_id.replace("/", "_").replace(":", "_")
                self.s3.put_object(
                    Bucket=self.bucket_name,
                    Key=f"{prefix}/logs/{safe_resource_id}.log",
                    Body=logs,
                )

            # Upload API calls
            api_calls_json = json.dumps(
                [
                    {
                        "service": call.service,
                        "operation": call.operation,
                        "resource_id": call.resource_id,
                        "start_time": call.start_time.isoformat(),
                        "duration": call.duration,
                        "status_code": call.status_code,
                        "request": call.request,
                        "response": call.response,
                        "error": call.error,
                    }
                    for call in api_calls
                ],
                indent=2,
            )
            self.s3.put_object(
                Bucket=self.bucket_name, Key=f"{prefix}/api-calls.json", Body=api_calls_json
            )

            # Calculate cost if not provided
            if estimated_cost is None:
                estimated_cost = self.cost_estimator.estimate_deployment_cost(state_after)

            # Upload cost breakdown
            cost_breakdown = self.cost_estimator.get_cost_breakdown(state_after)
            self.s3.put_object(
                Bucket=self.bucket_name,
                Key=f"{prefix}/cost-breakdown.json",
                Body=json.dumps(cost_breakdown, indent=2),
            )

            # Update metadata with final information
            metadata_response = self.s3.get_object(
                Bucket=self.bucket_name, Key=f"{prefix}/metadata.json"
            )
            metadata_dict = json.loads(metadata_response["Body"].read())
            metadata = DeploymentMetadata.from_dict(metadata_dict)

            metadata.end_time = datetime.utcnow()
            metadata.duration = (metadata.end_time - metadata.start_time).total_seconds()
            metadata.status = status
            metadata.changes = changes
            metadata.resource_count = len(state_after.all_resources())
            metadata.estimated_cost = estimated_cost
            metadata.error_message = error_message

            self.s3.put_object(
                Bucket=self.bucket_name,
                Key=f"{prefix}/metadata.json",
                Body=json.dumps(metadata.to_dict(), indent=2),
            )

            # Upload detailed resource changes
            self._upload_resource_changes(prefix, changes, state_after)

            # Update current config and state
            self._update_current(state_after)

            self.logger.info(f"Finalized deployment record: {deployment_id}")

        except ClientError as e:
            raise HistoryError(f"Failed to finalize deployment record: {str(e)}")

    def list_deployments(self, limit: int = 50) -> List[DeploymentMetadata]:
        """
        List recent deployments.

        Args:
            limit: Maximum number of deployments to return

        Returns:
            List of deployment metadata, sorted by start time (newest first)
        """
        self.logger.debug(f"Listing deployments (limit={limit})")

        try:
            prefix = f"{self.project_name}/{self.environment}/deployments/"
            response = self.s3.list_objects_v2(
                Bucket=self.bucket_name, Prefix=prefix, Delimiter="/"
            )

            deployments = []
            for common_prefix in response.get("CommonPrefixes", []):
                deployment_prefix = common_prefix["Prefix"]
                try:
                    metadata = self._load_metadata(deployment_prefix)
                    deployments.append(metadata)
                except Exception as e:
                    self.logger.warning(
                        f"Failed to load metadata for {deployment_prefix}: {str(e)}"
                    )
                    continue

            # Sort by start time (newest first)
            deployments.sort(key=lambda d: d.start_time, reverse=True)

            return deployments[:limit]

        except ClientError as e:
            raise HistoryError(f"Failed to list deployments: {str(e)}")

    def get_deployment(self, deployment_id: str) -> DeploymentRecord:
        """
        Get complete deployment record.

        Args:
            deployment_id: Deployment ID

        Returns:
            Complete deployment record

        Raises:
            HistoryError: If deployment not found or cannot be loaded
        """
        self.logger.debug(f"Getting deployment record: {deployment_id}")

        try:
            prefix = self._get_deployment_prefix(deployment_id)

            # Load all components
            metadata = self._load_metadata(prefix)
            config = self._load_config(prefix)
            state_before = self._load_state(f"{prefix}/state-before.json")
            state_after = self._load_state(f"{prefix}/state-after.json")
            execution_log = self._load_execution_log(prefix)
            resource_logs = self._load_resource_logs(prefix)
            api_calls = self._load_api_calls(prefix)

            return DeploymentRecord(
                metadata=metadata,
                config=config,
                state_before=state_before,
                state_after=state_after,
                execution_log=execution_log,
                resource_logs=resource_logs,
                api_calls=api_calls,
            )

        except ClientError as e:
            if e.response.get("Error", {}).get("Code") == "NoSuchKey":
                raise HistoryError(f"Deployment not found: {deployment_id}")
            raise HistoryError(f"Failed to get deployment record: {str(e)}")

    def get_current_state(self) -> Optional[Dict[str, Any]]:
        """
        Get current state from history.

        Returns:
            Current state dictionary or None if not found
        """
        try:
            current_prefix = f"{self.project_name}/{self.environment}/current"
            response = self.s3.get_object(
                Bucket=self.bucket_name, Key=f"{current_prefix}/state.json"
            )
            return json.loads(response["Body"].read())
        except ClientError as e:
            if e.response.get("Error", {}).get("Code") == "NoSuchKey":
                return None
            raise HistoryError(f"Failed to get current state: {str(e)}")

    def compare_deployments(self, deployment_id_1: str, deployment_id_2: str) -> DeploymentDiff:
        """
        Compare two deployments.

        Args:
            deployment_id_1: First deployment ID
            deployment_id_2: Second deployment ID

        Returns:
            DeploymentDiff with all differences

        Raises:
            HistoryError: If deployments cannot be compared
        """
        self.logger.info(f"Comparing deployments: {deployment_id_1} vs {deployment_id_2}")

        try:
            # Load both deployment records
            record1 = self.get_deployment(deployment_id_1)
            record2 = self.get_deployment(deployment_id_2)

            # Compare configurations
            config_diff = self.comparator.compare_configs(record1.config, record2.config)

            # Compare states
            state_diff = self.comparator.compare_states(
                record1.state_after or {}, record2.state_after or {}
            )

            # Calculate duration and cost differences
            duration_diff = record2.metadata.duration - record1.metadata.duration
            cost_diff = record2.metadata.estimated_cost - record1.metadata.estimated_cost

            return DeploymentDiff(
                deployment_id_1=deployment_id_1,
                deployment_id_2=deployment_id_2,
                config_diff=config_diff,
                state_diff=state_diff,
                duration_diff=duration_diff,
                cost_diff=cost_diff,
            )

        except Exception as e:
            raise HistoryError(f"Failed to compare deployments: {str(e)}")

    def get_deployment_timeline(self, limit: int = 10) -> List[Dict[str, Any]]:
        """
        Get deployment timeline with key metrics.

        Args:
            limit: Maximum number of deployments to include

        Returns:
            List of deployment timeline entries
        """
        deployments = self.list_deployments(limit=limit)

        timeline = []
        for deployment in deployments:
            timeline.append(
                {
                    "deployment_id": deployment.deployment_id,
                    "timestamp": deployment.start_time.isoformat(),
                    "duration": deployment.duration,
                    "status": deployment.status.value,
                    "resource_count": deployment.resource_count,
                    "estimated_cost": deployment.estimated_cost,
                    "changes": deployment.changes,
                }
            )

        return timeline

    def _get_deployment_prefix(self, deployment_id: str) -> str:
        """Get S3 prefix for deployment."""
        return f"{self.project_name}/{self.environment}/deployments/{deployment_id}"

    def _update_current(self, state: State) -> None:
        """
        Update current state in S3.

        Args:
            state: Current state
        """
        try:
            current_prefix = f"{self.project_name}/{self.environment}/current"

            self.s3.put_object(
                Bucket=self.bucket_name,
                Key=f"{current_prefix}/state.json",
                Body=json.dumps(state.to_dict(), indent=2),
            )

            self.logger.debug("Updated current state in history")

        except ClientError as e:
            self.logger.warning(f"Failed to update current state: {str(e)}")

    def _load_metadata(self, prefix: str) -> DeploymentMetadata:
        """Load deployment metadata from S3."""
        response = self.s3.get_object(Bucket=self.bucket_name, Key=f"{prefix}metadata.json")
        data = json.loads(response["Body"].read())
        return DeploymentMetadata.from_dict(data)

    def _load_config(self, prefix: str) -> Dict[str, Any]:
        """Load configuration from S3."""
        response = self.s3.get_object(Bucket=self.bucket_name, Key=f"{prefix}/config.yaml")
        return yaml.safe_load(response["Body"].read())

    def _load_state(self, key: str) -> Optional[Dict[str, Any]]:
        """Load state from S3."""
        try:
            response = self.s3.get_object(Bucket=self.bucket_name, Key=key)
            return json.loads(response["Body"].read())
        except ClientError as e:
            if e.response.get("Error", {}).get("Code") == "NoSuchKey":
                return None
            raise

    def _load_execution_log(self, prefix: str) -> List[LogEntry]:
        """Load execution log from S3."""
        try:
            response = self.s3.get_object(
                Bucket=self.bucket_name, Key=f"{prefix}/execution-log.jsonl"
            )
            log_entries = []
            for line in response["Body"].read().decode("utf-8").splitlines():
                if line.strip():
                    data = json.loads(line)
                    log_entries.append(
                        LogEntry(
                            timestamp=datetime.fromisoformat(data["timestamp"]),
                            level=data["level"],
                            message=data["message"],
                            resource_id=data.get("resource_id"),
                            context=data.get("context", {}),
                        )
                    )
            return log_entries
        except ClientError as e:
            if e.response.get("Error", {}).get("Code") == "NoSuchKey":
                return []
            raise

    def _load_resource_logs(self, prefix: str) -> Dict[str, str]:
        """Load per-resource logs from S3."""
        try:
            resource_logs = {}
            response = self.s3.list_objects_v2(
                Bucket=self.bucket_name, Prefix=f"{prefix}/logs/"
            )

            for obj in response.get("Contents", []):
                key = obj["Key"]
                resource_id = key.split("/")[-1].replace(".log", "")
                log_response = self.s3.get_object(Bucket=self.bucket_name, Key=key)
                resource_logs[resource_id] = log_response["Body"].read().decode("utf-8")

            return resource_logs
        except ClientError as e:
            if e.response.get("Error", {}).get("Code") == "NoSuchKey":
                return {}
            raise

    def _load_api_calls(self, prefix: str) -> List[APICall]:
        """Load API calls from S3."""
        try:
            response = self.s3.get_object(
                Bucket=self.bucket_name, Key=f"{prefix}/api-calls.json"
            )
            data = json.loads(response["Body"].read())
            return [
                APICall(
                    service=call["service"],
                    operation=call["operation"],
                    resource_id=call.get("resource_id"),
                    start_time=datetime.fromisoformat(call["start_time"]),
                    duration=call["duration"],
                    status_code=call["status_code"],
                    request=call.get("request"),
                    response=call.get("response"),
                    error=call.get("error"),
                )
                for call in data
            ]
        except ClientError as e:
            if e.response.get("Error", {}).get("Code") == "NoSuchKey":
                return []
            raise

    def _upload_resource_changes(
        self, prefix: str, changes: Dict[str, List[str]], state: State
    ) -> None:
        """Upload detailed resource changes."""
        detailed_changes = []

        for change_type, resource_ids in changes.items():
            for resource_id in resource_ids:
                resource = state.get_resource(resource_id)
                if resource:
                    detailed_changes.append(
                        {
                            "resource_id": resource_id,
                            "change_type": change_type,
                            "resource_type": resource.type,
                            "physical_id": resource.physical_id,
                            "tags": resource.tags,
                        }
                    )

        self.s3.put_object(
            Bucket=self.bucket_name,
            Key=f"{prefix}/resource-changes.json",
            Body=json.dumps(detailed_changes, indent=2),
        )
