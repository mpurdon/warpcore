"""AWS connectivity validation for local development mode."""

import boto3
from typing import Dict, List, Optional, Tuple
from botocore.exceptions import ClientError, NoCredentialsError, PartialCredentialsError

from ..state.models import State, Resource
from ..utils.logging import get_logger

logger = get_logger(__name__)


class ConnectivityError(Exception):
    """Exception raised when connectivity validation fails."""

    pass


class AWSConnectivityValidator:
    """Validates connectivity to deployed AWS resources."""

    def __init__(self, state: State, aws_profile: Optional[str] = None):
        """
        Initialize connectivity validator.

        Args:
            state: Deployment state containing resource information
            aws_profile: Optional AWS profile to use
        """
        self.state = state
        self.aws_profile = aws_profile
        self._session: Optional[boto3.Session] = None

    @property
    def session(self) -> boto3.Session:
        """Get or create boto3 session."""
        if self._session is None:
            if self.aws_profile:
                self._session = boto3.Session(
                    profile_name=self.aws_profile,
                    region_name=self.state.region
                )
            else:
                self._session = boto3.Session(region_name=self.state.region)
        return self._session

    def validate_credentials(self) -> Tuple[bool, Optional[str]]:
        """
        Validate AWS credentials are configured and valid.

        Returns:
            Tuple of (is_valid, error_message)
        """
        try:
            sts_client = self.session.client('sts')
            identity = sts_client.get_caller_identity()

            account_id = identity['Account']
            arn = identity['Arn']

            # Verify account matches state
            if account_id != self.state.account:
                return False, (
                    f"AWS account mismatch: credentials are for account {account_id}, "
                    f"but state is for account {self.state.account}"
                )

            logger.info(f"AWS credentials validated: {arn}")
            return True, None

        except NoCredentialsError:
            return False, "No AWS credentials found. Please configure credentials."
        except PartialCredentialsError:
            return False, "Incomplete AWS credentials. Please check your configuration."
        except ClientError as e:
            return False, f"Failed to validate credentials: {e}"
        except Exception as e:
            return False, f"Unexpected error validating credentials: {e}"

    def validate_resource_connectivity(self, resource: Resource) -> Tuple[bool, Optional[str]]:
        """
        Validate connectivity to a specific AWS resource.

        Args:
            resource: Resource to validate

        Returns:
            Tuple of (is_accessible, error_message)
        """
        if not resource.physical_id:
            return False, "Resource has no physical ID (not deployed?)"

        try:
            if resource.type == 'AWS::DynamoDB::Table':
                return self._validate_dynamodb_table(resource)
            elif resource.type == 'AWS::S3::Bucket':
                return self._validate_s3_bucket(resource)
            elif resource.type == 'AWS::SQS::Queue':
                return self._validate_sqs_queue(resource)
            elif resource.type == 'AWS::SNS::Topic':
                return self._validate_sns_topic(resource)
            elif resource.type == 'AWS::Lambda::Function':
                return self._validate_lambda_function(resource)
            elif resource.type == 'AWS::ApiGatewayV2::Api':
                return self._validate_api_gateway(resource)
            else:
                # For unknown resource types, just return success
                logger.debug(f"Skipping connectivity check for resource type: {resource.type}")
                return True, None

        except Exception as e:
            return False, f"Error validating resource: {e}"

    def _validate_dynamodb_table(self, resource: Resource) -> Tuple[bool, Optional[str]]:
        """Validate DynamoDB table connectivity."""
        try:
            dynamodb = self.session.client('dynamodb')
            table_name = resource.properties.get('TableName')

            if not table_name:
                return False, "Table name not found in resource properties"

            response = dynamodb.describe_table(TableName=table_name)
            status = response['Table']['TableStatus']

            if status != 'ACTIVE':
                return False, f"Table is not active (status: {status})"

            logger.debug(f"DynamoDB table '{table_name}' is accessible")
            return True, None

        except ClientError as e:
            error_code = e.response['Error']['Code']
            if error_code == 'ResourceNotFoundException':
                return False, f"Table not found: {resource.properties.get('TableName')}"
            elif error_code == 'AccessDeniedException':
                return False, "Access denied to DynamoDB table"
            else:
                return False, f"DynamoDB error: {e}"

    def _validate_s3_bucket(self, resource: Resource) -> Tuple[bool, Optional[str]]:
        """Validate S3 bucket connectivity."""
        try:
            s3 = self.session.client('s3')
            bucket_name = resource.properties.get('BucketName')

            if not bucket_name:
                return False, "Bucket name not found in resource properties"

            # Try to get bucket location (lightweight operation)
            s3.head_bucket(Bucket=bucket_name)

            logger.debug(f"S3 bucket '{bucket_name}' is accessible")
            return True, None

        except ClientError as e:
            error_code = e.response['Error']['Code']
            if error_code == '404':
                return False, f"Bucket not found: {resource.properties.get('BucketName')}"
            elif error_code == '403':
                return False, "Access denied to S3 bucket"
            else:
                return False, f"S3 error: {e}"

    def _validate_sqs_queue(self, resource: Resource) -> Tuple[bool, Optional[str]]:
        """Validate SQS queue connectivity."""
        try:
            sqs = self.session.client('sqs')
            queue_url = resource.properties.get('QueueUrl')

            if not queue_url:
                return False, "Queue URL not found in resource properties"

            # Get queue attributes (lightweight operation)
            sqs.get_queue_attributes(
                QueueUrl=queue_url,
                AttributeNames=['QueueArn']
            )

            logger.debug(f"SQS queue '{queue_url}' is accessible")
            return True, None

        except ClientError as e:
            error_code = e.response['Error']['Code']
            if error_code == 'AWS.SimpleQueueService.NonExistentQueue':
                return False, f"Queue not found: {resource.properties.get('QueueUrl')}"
            elif error_code == 'AccessDenied':
                return False, "Access denied to SQS queue"
            else:
                return False, f"SQS error: {e}"

    def _validate_sns_topic(self, resource: Resource) -> Tuple[bool, Optional[str]]:
        """Validate SNS topic connectivity."""
        try:
            sns = self.session.client('sns')
            topic_arn = resource.physical_id

            # Get topic attributes (lightweight operation)
            sns.get_topic_attributes(TopicArn=topic_arn)

            logger.debug(f"SNS topic '{topic_arn}' is accessible")
            return True, None

        except ClientError as e:
            error_code = e.response['Error']['Code']
            if error_code == 'NotFound':
                return False, f"Topic not found: {topic_arn}"
            elif error_code == 'AuthorizationError':
                return False, "Access denied to SNS topic"
            else:
                return False, f"SNS error: {e}"

    def _validate_lambda_function(self, resource: Resource) -> Tuple[bool, Optional[str]]:
        """Validate Lambda function connectivity."""
        try:
            lambda_client = self.session.client('lambda')
            function_name = resource.properties.get('FunctionName')

            if not function_name:
                return False, "Function name not found in resource properties"

            # Get function configuration (lightweight operation)
            response = lambda_client.get_function_configuration(FunctionName=function_name)
            state = response.get('State')

            if state != 'Active':
                return False, f"Function is not active (state: {state})"

            logger.debug(f"Lambda function '{function_name}' is accessible")
            return True, None

        except ClientError as e:
            error_code = e.response['Error']['Code']
            if error_code == 'ResourceNotFoundException':
                return False, f"Function not found: {resource.properties.get('FunctionName')}"
            elif error_code == 'AccessDeniedException':
                return False, "Access denied to Lambda function"
            else:
                return False, f"Lambda error: {e}"

    def _validate_api_gateway(self, resource: Resource) -> Tuple[bool, Optional[str]]:
        """Validate API Gateway connectivity."""
        try:
            apigw = self.session.client('apigatewayv2')
            api_id = resource.properties.get('ApiId')

            if not api_id:
                return False, "API ID not found in resource properties"

            # Get API details
            apigw.get_api(ApiId=api_id)

            logger.debug(f"API Gateway '{api_id}' is accessible")
            return True, None

        except ClientError as e:
            error_code = e.response['Error']['Code']
            if error_code == 'NotFoundException':
                return False, f"API not found: {resource.properties.get('ApiId')}"
            elif error_code == 'AccessDeniedException':
                return False, "Access denied to API Gateway"
            else:
                return False, f"API Gateway error: {e}"

    def validate_all_resources(self, agent_name: Optional[str] = None) -> Dict[str, Tuple[bool, Optional[str]]]:
        """
        Validate connectivity to all resources (or resources for a specific agent).

        Args:
            agent_name: Optional agent name to filter resources

        Returns:
            Dictionary mapping resource IDs to (is_accessible, error_message) tuples
        """
        results = {}

        # Get resources to validate
        if agent_name:
            stack = self.state.get_stack(agent_name)
            if stack:
                resources = [(agent_name, r) for r in stack.list_resources()]
            else:
                logger.warning(f"No stack found for agent: {agent_name}")
                resources = []
        else:
            resources = self.state.all_resources()

        # Validate each resource
        for stack_name, resource in resources:
            logger.debug(f"Validating resource: {resource.id} ({resource.type})")
            is_accessible, error = self.validate_resource_connectivity(resource)
            results[resource.id] = (is_accessible, error)

            if not is_accessible:
                logger.warning(f"Resource {resource.id} is not accessible: {error}")

        return results

    def validate_for_agent(self, agent_name: str) -> Tuple[bool, List[str]]:
        """
        Validate connectivity for all resources needed by an agent.

        Args:
            agent_name: Agent name

        Returns:
            Tuple of (all_accessible, list_of_errors)
        """
        # First validate credentials
        creds_valid, creds_error = self.validate_credentials()
        if not creds_valid:
            return False, [f"Credentials error: {creds_error}"]

        # Validate agent resources
        results = self.validate_all_resources(agent_name=agent_name)

        # Also validate shared infrastructure
        shared_results = {}
        shared_stack = self.state.get_stack('shared-infrastructure')
        if shared_stack:
            for resource in shared_stack.list_resources():
                is_accessible, error = self.validate_resource_connectivity(resource)
                shared_results[resource.id] = (is_accessible, error)

        # Combine results
        all_results = {**results, **shared_results}

        # Collect errors
        errors = []
        for resource_id, (is_accessible, error) in all_results.items():
            if not is_accessible:
                errors.append(f"{resource_id}: {error}")

        all_accessible = len(errors) == 0
        return all_accessible, errors

    def get_connectivity_report(self, agent_name: Optional[str] = None) -> Dict[str, any]:
        """
        Generate a comprehensive connectivity report.

        Args:
            agent_name: Optional agent name to filter resources

        Returns:
            Dictionary with connectivity report
        """
        # Validate credentials
        creds_valid, creds_error = self.validate_credentials()

        # Validate resources
        resource_results = self.validate_all_resources(agent_name=agent_name)

        # Count accessible/inaccessible
        accessible_count = sum(1 for is_accessible, _ in resource_results.values() if is_accessible)
        total_count = len(resource_results)

        # Build report
        report = {
            'credentials': {
                'valid': creds_valid,
                'error': creds_error,
            },
            'resources': {
                'total': total_count,
                'accessible': accessible_count,
                'inaccessible': total_count - accessible_count,
                'details': {
                    resource_id: {
                        'accessible': is_accessible,
                        'error': error,
                    }
                    for resource_id, (is_accessible, error) in resource_results.items()
                }
            },
            'overall_status': creds_valid and accessible_count == total_count,
        }

        return report
