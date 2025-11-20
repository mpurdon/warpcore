"""Retention and cleanup policies for deployment history."""

from datetime import datetime, timedelta
from typing import Dict, List, Optional
from dataclasses import dataclass

from botocore.exceptions import ClientError

from strands_deploy.history.models import DeploymentMetadata, DeploymentStatus
from strands_deploy.utils.logging import get_logger

logger = get_logger(__name__)


@dataclass
class RetentionPolicy:
    """Retention policy configuration."""

    # Keep last N successful deployments regardless of age
    keep_last_successful: int = 10

    # Keep all failed deployments for X days
    keep_failed_days: int = 90

    # Keep all deployments for X days
    keep_all_days: int = 30

    # Keep deployments with specific tags indefinitely
    keep_tags: Dict[str, str] = None

    # Transition to cheaper storage after X days
    transition_to_ia_days: int = 30
    transition_to_glacier_days: int = 90

    # Delete deployments older than X days (0 = never delete)
    delete_after_days: int = 365

    def __post_init__(self):
        if self.keep_tags is None:
            self.keep_tags = {}


class RetentionManager:
    """Manages retention and cleanup of deployment history."""

    def __init__(self, s3_client, bucket_name: str, project_name: str, environment: str):
        """
        Initialize retention manager.

        Args:
            s3_client: Boto3 S3 client
            bucket_name: S3 bucket name
            project_name: Project name
            environment: Environment name
        """
        self.s3 = s3_client
        self.bucket_name = bucket_name
        self.project_name = project_name
        self.environment = environment
        self.logger = get_logger(__name__)

    def apply_retention_policy(
        self, policy: RetentionPolicy, deployments: List[DeploymentMetadata], dry_run: bool = False
    ) -> Dict[str, List[str]]:
        """
        Apply retention policy to deployments.

        Args:
            policy: Retention policy to apply
            deployments: List of deployment metadata
            dry_run: If True, only report what would be deleted

        Returns:
            Dictionary with 'kept' and 'deleted' deployment IDs
        """
        self.logger.info(
            f"Applying retention policy (dry_run={dry_run}) to {len(deployments)} deployments"
        )

        now = datetime.utcnow()
        kept = []
        deleted = []

        # Sort deployments by start time (newest first)
        sorted_deployments = sorted(deployments, key=lambda d: d.start_time, reverse=True)

        # Separate successful and failed deployments
        successful = [d for d in sorted_deployments if d.status == DeploymentStatus.SUCCESS]
        failed = [d for d in sorted_deployments if d.status == DeploymentStatus.FAILED]

        # Keep last N successful deployments
        keep_successful_ids = {d.deployment_id for d in successful[: policy.keep_last_successful]}

        for deployment in sorted_deployments:
            should_keep = False
            reason = ""

            # Check if in keep_last_successful
            if deployment.deployment_id in keep_successful_ids:
                should_keep = True
                reason = "last_successful"

            # Check if failed and within keep_failed_days
            elif deployment.status == DeploymentStatus.FAILED:
                age_days = (now - deployment.start_time).days
                if age_days <= policy.keep_failed_days:
                    should_keep = True
                    reason = "failed_recent"

            # Check if within keep_all_days
            else:
                age_days = (now - deployment.start_time).days
                if age_days <= policy.keep_all_days:
                    should_keep = True
                    reason = "recent"

            # Check if has keep tags
            if not should_keep and policy.keep_tags:
                for tag_key, tag_value in policy.keep_tags.items():
                    if deployment.tags.get(tag_key) == tag_value:
                        should_keep = True
                        reason = f"tag_{tag_key}"
                        break

            # Check if older than delete_after_days
            if policy.delete_after_days > 0:
                age_days = (now - deployment.start_time).days
                if age_days > policy.delete_after_days and not should_keep:
                    should_keep = False
                    reason = "expired"

            if should_keep:
                kept.append(deployment.deployment_id)
                self.logger.debug(
                    f"Keeping deployment {deployment.deployment_id} (reason: {reason})"
                )
            else:
                deleted.append(deployment.deployment_id)
                self.logger.info(
                    f"{'Would delete' if dry_run else 'Deleting'} deployment {deployment.deployment_id}"
                )

                if not dry_run:
                    self._delete_deployment(deployment.deployment_id)

        self.logger.info(
            f"Retention policy applied: {len(kept)} kept, {len(deleted)} {'would be ' if dry_run else ''}deleted"
        )

        return {"kept": kept, "deleted": deleted}

    def setup_lifecycle_rules(self, policy: RetentionPolicy) -> None:
        """
        Set up S3 lifecycle rules for automatic transitions and expiration.

        Args:
            policy: Retention policy
        """
        self.logger.info("Setting up S3 lifecycle rules")

        try:
            prefix = f"{self.project_name}/{self.environment}/deployments/"

            rules = []

            # Rule for transitioning to Infrequent Access
            if policy.transition_to_ia_days > 0:
                rules.append(
                    {
                        "Id": f"transition-ia-{self.environment}",
                        "Status": "Enabled",
                        "Prefix": prefix,
                        "Transitions": [
                            {
                                "Days": policy.transition_to_ia_days,
                                "StorageClass": "STANDARD_IA",
                            }
                        ],
                    }
                )

            # Rule for transitioning to Glacier
            if policy.transition_to_glacier_days > 0:
                rules.append(
                    {
                        "Id": f"transition-glacier-{self.environment}",
                        "Status": "Enabled",
                        "Prefix": prefix,
                        "Transitions": [
                            {
                                "Days": policy.transition_to_glacier_days,
                                "StorageClass": "GLACIER",
                            }
                        ],
                    }
                )

            # Rule for expiration
            if policy.delete_after_days > 0:
                rules.append(
                    {
                        "Id": f"expiration-{self.environment}",
                        "Status": "Enabled",
                        "Prefix": prefix,
                        "Expiration": {"Days": policy.delete_after_days},
                    }
                )

            if rules:
                self.s3.put_bucket_lifecycle_configuration(
                    Bucket=self.bucket_name, LifecycleConfiguration={"Rules": rules}
                )
                self.logger.info(f"Created {len(rules)} lifecycle rules")
            else:
                self.logger.info("No lifecycle rules to create")

        except ClientError as e:
            self.logger.error(f"Failed to set up lifecycle rules: {str(e)}")
            raise

    def cleanup_old_deployments(self, days: int, dry_run: bool = False) -> List[str]:
        """
        Delete deployments older than specified days.

        Args:
            days: Delete deployments older than this many days
            dry_run: If True, only report what would be deleted

        Returns:
            List of deleted deployment IDs
        """
        self.logger.info(
            f"Cleaning up deployments older than {days} days (dry_run={dry_run})"
        )

        cutoff_date = datetime.utcnow() - timedelta(days=days)
        deleted = []

        try:
            prefix = f"{self.project_name}/{self.environment}/deployments/"
            response = self.s3.list_objects_v2(
                Bucket=self.bucket_name, Prefix=prefix, Delimiter="/"
            )

            for common_prefix in response.get("CommonPrefixes", []):
                deployment_prefix = common_prefix["Prefix"]
                deployment_id = deployment_prefix.rstrip("/").split("/")[-1]

                # Try to parse timestamp from deployment ID
                try:
                    # Format: 2025-11-20T10-30-00-123456Z-abc123
                    timestamp_str = deployment_id.split("Z-")[0] + "Z"
                    timestamp_str = timestamp_str.replace("-", ":", 2)  # Fix time part
                    deployment_time = datetime.fromisoformat(timestamp_str.replace("Z", ""))

                    if deployment_time < cutoff_date:
                        self.logger.info(
                            f"{'Would delete' if dry_run else 'Deleting'} old deployment: {deployment_id}"
                        )
                        deleted.append(deployment_id)

                        if not dry_run:
                            self._delete_deployment(deployment_id)

                except (ValueError, IndexError) as e:
                    self.logger.warning(
                        f"Could not parse timestamp from deployment ID {deployment_id}: {str(e)}"
                    )
                    continue

            self.logger.info(
                f"Cleanup complete: {len(deleted)} deployments {'would be ' if dry_run else ''}deleted"
            )
            return deleted

        except ClientError as e:
            self.logger.error(f"Failed to cleanup old deployments: {str(e)}")
            raise

    def _delete_deployment(self, deployment_id: str) -> None:
        """
        Delete all objects for a deployment.

        Args:
            deployment_id: Deployment ID to delete
        """
        try:
            prefix = f"{self.project_name}/{self.environment}/deployments/{deployment_id}/"

            # List all objects with this prefix
            paginator = self.s3.get_paginator("list_objects_v2")
            pages = paginator.paginate(Bucket=self.bucket_name, Prefix=prefix)

            objects_to_delete = []
            for page in pages:
                for obj in page.get("Contents", []):
                    objects_to_delete.append({"Key": obj["Key"]})

            # Delete objects in batches of 1000 (S3 limit)
            if objects_to_delete:
                for i in range(0, len(objects_to_delete), 1000):
                    batch = objects_to_delete[i : i + 1000]
                    self.s3.delete_objects(
                        Bucket=self.bucket_name, Delete={"Objects": batch, "Quiet": True}
                    )

                self.logger.debug(
                    f"Deleted {len(objects_to_delete)} objects for deployment {deployment_id}"
                )

        except ClientError as e:
            self.logger.error(f"Failed to delete deployment {deployment_id}: {str(e)}")
            raise

    def get_storage_metrics(self) -> Dict[str, any]:
        """
        Get storage metrics for deployment history.

        Returns:
            Dictionary with storage metrics
        """
        try:
            prefix = f"{self.project_name}/{self.environment}/deployments/"

            total_size = 0
            total_objects = 0
            deployments_count = 0

            # List all objects
            paginator = self.s3.get_paginator("list_objects_v2")
            pages = paginator.paginate(Bucket=self.bucket_name, Prefix=prefix)

            deployment_ids = set()
            for page in pages:
                for obj in page.get("Contents", []):
                    total_size += obj["Size"]
                    total_objects += 1

                    # Extract deployment ID
                    parts = obj["Key"].split("/")
                    if len(parts) >= 4:
                        deployment_ids.add(parts[3])

            deployments_count = len(deployment_ids)

            return {
                "total_size_bytes": total_size,
                "total_size_mb": round(total_size / (1024 * 1024), 2),
                "total_objects": total_objects,
                "deployments_count": deployments_count,
                "avg_size_per_deployment_mb": (
                    round(total_size / (1024 * 1024) / deployments_count, 2)
                    if deployments_count > 0
                    else 0
                ),
            }

        except ClientError as e:
            self.logger.error(f"Failed to get storage metrics: {str(e)}")
            raise
