"""AWS resource scanner for drift detection."""

from typing import Dict, List, Optional, Set
import boto3
from botocore.exceptions import ClientError

from strands_deploy.state.models import Resource, State
from strands_deploy.utils.logging import get_logger

logger = get_logger(__name__)


class ScannedState:
    """Represents the actual state of resources in AWS."""
    
    def __init__(self):
        """Initialize scanned state."""
        self.resources: Dict[str, Resource] = {}
        self.resource_arns: Set[str] = set()
    
    def add_resource(self, resource: Resource):
        """Add a scanned resource."""
        self.resources[resource.id] = resource
        if resource.physical_id:
            self.resource_arns.add(resource.physical_id)
    
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


class AWSScanner:
    """Scans AWS account for resources matching project tags."""
    
    def __init__(
        self,
        boto_session: boto3.Session,
        project_name: str,
        environment: str,
        region: str
    ):
        """Initialize AWS scanner.
        
        Args:
            boto_session: Boto3 session
            project_name: Project name to filter resources
            environment: Environment name to filter resources
            region: AWS region
        """
        self.session = boto_session
        self.project_name = project_name
        self.environment = environment
        self.region = region
        self.logger = get_logger(__name__)
        
        # Initialize AWS clients
        self.resource_groups_tagging = self.session.client(
            'resourcegroupstaggingapi',
            region_name=region
        )
    
    def scan_resources(self) -> ScannedState:
        """Scan AWS account for resources matching project tags.
        
        Returns:
            ScannedState containing all found resources
        """
        self.logger.info(
            f"Scanning AWS resources for project={self.project_name}, "
            f"environment={self.environment}"
        )
        
        scanned_state = ScannedState()
        
        try:
            # Use Resource Groups Tagging API to find all resources with our tags
            tag_filters = [
                {
                    'Key': 'strands:project',
                    'Values': [self.project_name]
                },
                {
                    'Key': 'strands:environment',
                    'Values': [self.environment]
                }
            ]
            
            paginator = self.resource_groups_tagging.get_paginator('get_resources')
            page_iterator = paginator.paginate(
                TagFilters=tag_filters,
                ResourcesPerPage=100
            )
            
            resource_count = 0
            for page in page_iterator:
                for resource_info in page.get('ResourceTagMappingList', []):
                    arn = resource_info['ResourceARN']
                    tags = {tag['Key']: tag['Value'] for tag in resource_info.get('Tags', [])}
                    
                    # Parse resource type from ARN
                    resource_type = self._parse_resource_type_from_arn(arn)
                    
                    # Create resource object
                    resource = Resource(
                        id=tags.get('Name', arn.split('/')[-1]),
                        type=resource_type,
                        physical_id=arn,
                        properties={},  # Would need service-specific API calls to get full properties
                        dependencies=[],
                        tags=tags
                    )
                    
                    scanned_state.add_resource(resource)
                    resource_count += 1
            
            self.logger.info(f"Scanned {resource_count} resources from AWS")
            
        except ClientError as e:
            self.logger.error(f"Error scanning AWS resources: {e}")
            raise
        
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
            Dictionary of resource properties or None if not found
        """
        try:
            # Route to appropriate service-specific method
            if resource_type == 'AWS::Lambda::Function':
                return self._get_lambda_details(physical_id)
            elif resource_type == 'AWS::IAM::Role':
                return self._get_iam_role_details(physical_id)
            elif resource_type == 'AWS::EC2::VPC':
                return self._get_vpc_details(physical_id)
            elif resource_type == 'AWS::EC2::SecurityGroup':
                return self._get_security_group_details(physical_id)
            elif resource_type == 'AWS::S3::Bucket':
                return self._get_s3_bucket_details(physical_id)
            elif resource_type == 'AWS::DynamoDB::Table':
                return self._get_dynamodb_table_details(physical_id)
            elif resource_type == 'AWS::SQS::Queue':
                return self._get_sqs_queue_details(physical_id)
            elif resource_type == 'AWS::SNS::Topic':
                return self._get_sns_topic_details(physical_id)
            else:
                self.logger.warning(f"Unsupported resource type for details: {resource_type}")
                return None
                
        except ClientError as e:
            self.logger.error(f"Error getting resource details: {e}")
            return None
    
    def _parse_resource_type_from_arn(self, arn: str) -> str:
        """Parse AWS resource type from ARN.
        
        Args:
            arn: AWS ARN
            
        Returns:
            CloudFormation resource type (e.g., AWS::Lambda::Function)
        """
        # ARN format: arn:aws:service:region:account:resource-type/resource-id
        parts = arn.split(':')
        if len(parts) < 6:
            return "AWS::Unknown::Resource"
        
        service = parts[2]
        
        # Map service to CloudFormation resource type
        service_mapping = {
            'lambda': 'AWS::Lambda::Function',
            'iam': 'AWS::IAM::Role',  # Simplified, could be Policy, User, etc.
            'ec2': 'AWS::EC2::Instance',  # Simplified, could be VPC, SecurityGroup, etc.
            's3': 'AWS::S3::Bucket',
            'dynamodb': 'AWS::DynamoDB::Table',
            'sqs': 'AWS::SQS::Queue',
            'sns': 'AWS::SNS::Topic',
            'apigateway': 'AWS::ApiGateway::RestApi',
            'apigatewayv2': 'AWS::ApiGatewayV2::Api',
        }
        
        # Try to be more specific based on ARN structure
        if service == 'ec2':
            if '/vpc/' in arn or ':vpc/' in arn:
                return 'AWS::EC2::VPC'
            elif '/security-group/' in arn or ':security-group/' in arn:
                return 'AWS::EC2::SecurityGroup'
            elif '/subnet/' in arn or ':subnet/' in arn:
                return 'AWS::EC2::Subnet'
        
        return service_mapping.get(service, f"AWS::{service.upper()}::Resource")
    
    def _get_lambda_details(self, function_arn: str) -> Dict:
        """Get Lambda function details."""
        lambda_client = self.session.client('lambda', region_name=self.region)
        function_name = function_arn.split(':')[-1]
        response = lambda_client.get_function(FunctionName=function_name)
        return response.get('Configuration', {})
    
    def _get_iam_role_details(self, role_arn: str) -> Dict:
        """Get IAM role details."""
        iam_client = self.session.client('iam')
        role_name = role_arn.split('/')[-1]
        response = iam_client.get_role(RoleName=role_name)
        return response.get('Role', {})
    
    def _get_vpc_details(self, vpc_id: str) -> Dict:
        """Get VPC details."""
        ec2_client = self.session.client('ec2', region_name=self.region)
        response = ec2_client.describe_vpcs(VpcIds=[vpc_id])
        vpcs = response.get('Vpcs', [])
        return vpcs[0] if vpcs else {}
    
    def _get_security_group_details(self, sg_id: str) -> Dict:
        """Get security group details."""
        ec2_client = self.session.client('ec2', region_name=self.region)
        response = ec2_client.describe_security_groups(GroupIds=[sg_id])
        sgs = response.get('SecurityGroups', [])
        return sgs[0] if sgs else {}
    
    def _get_s3_bucket_details(self, bucket_name: str) -> Dict:
        """Get S3 bucket details."""
        s3_client = self.session.client('s3', region_name=self.region)
        try:
            location = s3_client.get_bucket_location(Bucket=bucket_name)
            encryption = s3_client.get_bucket_encryption(Bucket=bucket_name)
            return {
                'BucketName': bucket_name,
                'Location': location.get('LocationConstraint'),
                'Encryption': encryption.get('ServerSideEncryptionConfiguration')
            }
        except ClientError:
            return {'BucketName': bucket_name}
    
    def _get_dynamodb_table_details(self, table_name: str) -> Dict:
        """Get DynamoDB table details."""
        dynamodb_client = self.session.client('dynamodb', region_name=self.region)
        response = dynamodb_client.describe_table(TableName=table_name)
        return response.get('Table', {})
    
    def _get_sqs_queue_details(self, queue_url: str) -> Dict:
        """Get SQS queue details."""
        sqs_client = self.session.client('sqs', region_name=self.region)
        response = sqs_client.get_queue_attributes(
            QueueUrl=queue_url,
            AttributeNames=['All']
        )
        return response.get('Attributes', {})
    
    def _get_sns_topic_details(self, topic_arn: str) -> Dict:
        """Get SNS topic details."""
        sns_client = self.session.client('sns', region_name=self.region)
        response = sns_client.get_topic_attributes(TopicArn=topic_arn)
        return response.get('Attributes', {})
