"""Tag management for AWS resources."""

import os
from datetime import datetime
from typing import Dict, Optional, List
from strands_deploy.config.models import AgentConfig, ProjectConfig
from strands_deploy.utils.logging import get_logger

logger = get_logger(__name__)

# Version of the deployment system
VERSION = "1.0.0"


class DeploymentContext:
    """Context information for a deployment."""

    def __init__(
        self,
        project_name: str,
        environment: str,
        iam_identity: str,
        agent_name: Optional[str] = None,
    ):
        """Initialize deployment context.

        Args:
            project_name: Name of the project
            environment: Environment name (dev, staging, prod)
            iam_identity: IAM user/role performing the deployment
            agent_name: Optional agent name for agent-specific resources
        """
        self.project_name = project_name
        self.environment = environment
        self.iam_identity = iam_identity
        self.agent_name = agent_name


class TagManager:
    """Manages resource tagging with automatic tag generation and inheritance."""

    def __init__(self, project_config: ProjectConfig):
        """Initialize tag manager.

        Args:
            project_config: Project configuration containing project-level tags
        """
        self.project_config = project_config
        logger.info(f"Initialized TagManager for project: {project_config.name}")

    def generate_tags(
        self,
        context: DeploymentContext,
        agent_config: Optional[AgentConfig] = None,
        resource_tags: Optional[Dict[str, str]] = None,
    ) -> Dict[str, str]:
        """Generate complete tag set for a resource with inheritance.

        Tag inheritance order (later overrides earlier):
        1. System tags (strands:*)
        2. Project-level tags
        3. Agent-level tags (if applicable)
        4. Resource-specific tags

        Args:
            context: Deployment context with environment and identity info
            agent_config: Optional agent configuration for agent-specific resources
            resource_tags: Optional resource-specific tags

        Returns:
            Complete dictionary of tags to apply to the resource
        """
        tags = {}

        # 1. System tags (always present)
        system_tags = self._generate_system_tags(context)
        tags.update(system_tags)

        # 2. Project-level tags
        tags.update(self.project_config.tags)

        # 3. Agent-level tags (if applicable)
        if agent_config:
            tags.update(agent_config.tags)

        # 4. Resource-specific tags
        if resource_tags:
            tags.update(resource_tags)

        logger.debug(
            f"Generated {len(tags)} tags for resource in "
            f"project={context.project_name}, env={context.environment}"
        )

        return tags

    def _generate_system_tags(self, context: DeploymentContext) -> Dict[str, str]:
        """Generate system tags (strands:* namespace).

        Args:
            context: Deployment context

        Returns:
            Dictionary of system tags
        """
        tags = {
            "strands:project": context.project_name,
            "strands:environment": context.environment,
            "strands:managed-by": "strands-deployment-system",
            "strands:version": VERSION,
            "strands:deployed-at": datetime.utcnow().isoformat() + "Z",
            "strands:deployed-by": context.iam_identity,
        }

        # Add agent tag if applicable
        if context.agent_name:
            tags["strands:agent"] = context.agent_name

        return tags

    def apply_tags(self, resource_arn: str, tags: Dict[str, str], boto_session) -> bool:
        """Apply tags to an AWS resource using the resource tagging API.

        Args:
            resource_arn: ARN of the resource to tag
            tags: Dictionary of tags to apply
            boto_session: Boto3 session for AWS API calls

        Returns:
            True if tags were applied successfully, False otherwise
        """
        try:
            # Convert tags to AWS format
            tag_list = [{"Key": key, "Value": value} for key, value in tags.items()]

            # Use Resource Groups Tagging API for universal tagging
            tagging_client = boto_session.client("resourcegroupstaggingapi")

            tagging_client.tag_resources(ResourceARNList=[resource_arn], Tags=tags)

            logger.info(f"Applied {len(tags)} tags to resource: {resource_arn}")
            return True

        except Exception as e:
            logger.error(f"Failed to apply tags to {resource_arn}: {e}")
            return False

    def apply_tags_service_specific(
        self, resource_id: str, tags: Dict[str, str], service: str, boto_session
    ) -> bool:
        """Apply tags using service-specific tagging APIs.

        Some AWS services require service-specific tagging methods.

        Args:
            resource_id: Resource identifier (ARN, ID, or name)
            tags: Dictionary of tags to apply
            service: AWS service name (e.g., 'lambda', 'ec2', 's3')
            boto_session: Boto3 session for AWS API calls

        Returns:
            True if tags were applied successfully, False otherwise
        """
        try:
            tag_list = [{"Key": key, "Value": value} for key, value in tags.items()]

            if service == "lambda":
                client = boto_session.client("lambda")
                client.tag_resource(Resource=resource_id, Tags=tags)

            elif service == "ec2":
                client = boto_session.client("ec2")
                client.create_tags(Resources=[resource_id], Tags=tag_list)

            elif service == "s3":
                client = boto_session.client("s3")
                # S3 uses bucket name, not ARN
                bucket_name = resource_id.split(":")[-1] if ":" in resource_id else resource_id
                client.put_bucket_tagging(
                    Bucket=bucket_name, Tagging={"TagSet": tag_list}
                )

            elif service == "dynamodb":
                client = boto_session.client("dynamodb")
                client.tag_resource(ResourceArn=resource_id, Tags=tag_list)

            elif service == "sqs":
                client = boto_session.client("sqs")
                # SQS uses queue URL
                client.tag_queue(QueueUrl=resource_id, Tags=tags)

            elif service == "sns":
                client = boto_session.client("sns")
                client.tag_resource(ResourceArn=resource_id, Tags=tag_list)

            elif service == "iam":
                client = boto_session.client("iam")
                # IAM requires resource name, not ARN
                resource_name = resource_id.split("/")[-1]
                client.tag_role(RoleName=resource_name, Tags=tag_list)

            elif service == "apigateway":
                client = boto_session.client("apigatewayv2")
                # Extract API ID from ARN
                api_id = resource_id.split("/")[-1]
                client.tag_resource(ResourceArn=resource_id, Tags=tags)

            else:
                logger.warning(f"Unknown service for tagging: {service}, using generic API")
                return self.apply_tags(resource_id, tags, boto_session)

            logger.info(f"Applied {len(tags)} tags to {service} resource: {resource_id}")
            return True

        except Exception as e:
            logger.error(f"Failed to apply tags to {service} resource {resource_id}: {e}")
            return False

    def get_cost_allocation_tags(self) -> List[str]:
        """Get list of tag keys to activate for cost allocation.

        Returns:
            List of tag keys that should be activated in AWS Cost Explorer
        """
        return [
            "strands:project",
            "strands:environment",
            "strands:agent",
            "team",
            "cost-center",
            "owner",
        ]

    def validate_tags(self, tags: Dict[str, str]) -> List[str]:
        """Validate tags against AWS requirements.

        Args:
            tags: Dictionary of tags to validate

        Returns:
            List of validation error messages (empty if valid)
        """
        errors = []

        for key, value in tags.items():
            # Validate key
            if not key:
                errors.append("Tag key cannot be empty")
            elif len(key) > 128:
                errors.append(f"Tag key exceeds 128 characters: {key}")
            elif key.startswith("aws:"):
                errors.append(f"Tag key cannot start with 'aws:' (reserved): {key}")

            # Validate value
            if not isinstance(value, str):
                errors.append(f"Tag value must be a string for key '{key}': {value}")
            elif len(value) > 256:
                errors.append(f"Tag value exceeds 256 characters for key '{key}'")

        # Check total number of tags (AWS limit is 50 per resource)
        if len(tags) > 50:
            errors.append(f"Too many tags: {len(tags)} (AWS limit is 50 per resource)")

        return errors
