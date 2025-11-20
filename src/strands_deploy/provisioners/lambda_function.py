"""Lambda function provisioner with code packaging and configuration."""

import os
import zipfile
import hashlib
import tempfile
from typing import Optional, Dict, Any
from botocore.exceptions import ClientError

from .base import BaseProvisioner, Resource, ProvisionPlan, ChangeType


class LambdaProvisioner(BaseProvisioner):
    """Provisioner for Lambda functions with code packaging."""

    def __init__(self, boto_session):
        """Initialize Lambda provisioner.
        
        Args:
            boto_session: Configured boto3 session
        """
        super().__init__(boto_session)
        self.lambda_client = boto_session.client('lambda')
        self.s3_client = boto_session.client('s3')

    def plan(self, desired: Resource, current: Optional[Resource]) -> ProvisionPlan:
        """Determine what changes are needed for the Lambda function.
        
        Args:
            desired: Desired Lambda function state
            current: Current Lambda function state (None if doesn't exist)
            
        Returns:
            ProvisionPlan with change type
        """
        if current is None:
            return ProvisionPlan(
                resource=desired,
                change_type=ChangeType.CREATE,
                current_state=None
            )
        
        if self._needs_update(desired, current):
            return ProvisionPlan(
                resource=desired,
                change_type=ChangeType.UPDATE,
                current_state=current
            )
        
        return ProvisionPlan(
            resource=desired,
            change_type=ChangeType.NO_CHANGE,
            current_state=current
        )

    def provision(self, plan: ProvisionPlan) -> Resource:
        """Execute the Lambda function provisioning plan.
        
        Args:
            plan: Provisioning plan to execute
            
        Returns:
            Resource with physical_id set to function ARN
        """
        if plan.change_type == ChangeType.CREATE:
            return self._create_function(plan.resource)
        elif plan.change_type == ChangeType.UPDATE:
            return self._update_function(plan.resource)
        else:
            return plan.resource

    def destroy(self, resource: Resource) -> None:
        """Destroy the Lambda function.
        
        Args:
            resource: Lambda function resource to destroy
        """
        function_name = resource.properties.get('FunctionName')
        if not function_name:
            return
        
        try:
            self.lambda_client.delete_function(FunctionName=function_name)
        except ClientError as e:
            if e.response['Error']['Code'] != 'ResourceNotFoundException':
                raise

    def get_current_state(self, resource_id: str) -> Optional[Resource]:
        """Fetch current Lambda function state from AWS.
        
        Args:
            resource_id: Logical resource ID
            
        Returns:
            Current resource state or None if doesn't exist
        """
        # Extract function name from resource_id
        function_name = resource_id.replace('lambda-', '')
        
        try:
            response = self.lambda_client.get_function(FunctionName=function_name)
            config = response['Configuration']
            
            # Get tags
            tags_response = self.lambda_client.list_tags(Resource=config['FunctionArn'])
            tags = tags_response.get('Tags', {})
            
            return Resource(
                id=resource_id,
                type='AWS::Lambda::Function',
                physical_id=config['FunctionArn'],
                properties={
                    'FunctionName': config['FunctionName'],
                    'Runtime': config['Runtime'],
                    'Role': config['Role'],
                    'Handler': config['Handler'],
                    'MemorySize': config['MemorySize'],
                    'Timeout': config['Timeout'],
                    'Environment': config.get('Environment', {}).get('Variables', {}),
                    'VpcConfig': config.get('VpcConfig'),
                    'DeadLetterConfig': config.get('DeadLetterConfig'),
                    'TracingConfig': config.get('TracingConfig'),
                    'ReservedConcurrentExecutions': config.get('ReservedConcurrentExecutions'),
                    'CodeSha256': config['CodeSha256'],
                },
                dependencies=[],
                tags=tags
            )
            
        except ClientError as e:
            if e.response['Error']['Code'] == 'ResourceNotFoundException':
                return None
            raise

    def _create_function(self, resource: Resource) -> Resource:
        """Create a new Lambda function.
        
        Args:
            resource: Resource definition
            
        Returns:
            Resource with physical_id set
        """
        function_name = resource.properties['FunctionName']
        runtime = resource.properties['Runtime']
        role = resource.properties['Role']
        handler = resource.properties['Handler']
        code_path = resource.properties['CodePath']
        
        # Package code
        code_zip = self._package_code(code_path)
        
        # Create function
        create_params = {
            'FunctionName': function_name,
            'Runtime': runtime,
            'Role': role,
            'Handler': handler,
            'Code': {'ZipFile': code_zip},
            'MemorySize': resource.properties.get('MemorySize', 512),
            'Timeout': resource.properties.get('Timeout', 30),
            'Publish': True,
        }
        
        # Add environment variables
        environment = resource.properties.get('Environment', {})
        if environment:
            create_params['Environment'] = {'Variables': environment}
        
        # Add VPC configuration
        vpc_config = resource.properties.get('VpcConfig')
        if vpc_config:
            create_params['VpcConfig'] = vpc_config
        
        # Add dead letter queue
        dlq_config = resource.properties.get('DeadLetterConfig')
        if dlq_config:
            create_params['DeadLetterConfig'] = dlq_config
        
        # Add tracing configuration
        tracing_config = resource.properties.get('TracingConfig', {'Mode': 'Active'})
        create_params['TracingConfig'] = tracing_config
        
        # Add reserved concurrent executions
        reserved_concurrency = resource.properties.get('ReservedConcurrentExecutions')
        if reserved_concurrency is not None:
            create_params['ReservedConcurrentExecutions'] = reserved_concurrency
        
        # Add tags
        if resource.tags:
            create_params['Tags'] = resource.tags
        
        response = self.lambda_client.create_function(**create_params)
        function_arn = response['FunctionArn']
        
        # Wait for function to be active
        waiter = self.lambda_client.get_waiter('function_active')
        waiter.wait(FunctionName=function_name)
        
        resource.physical_id = function_arn
        resource.properties['CodeSha256'] = response['CodeSha256']
        
        return resource

    def _update_function(self, resource: Resource) -> Resource:
        """Update an existing Lambda function.
        
        Args:
            resource: Resource definition with updates
            
        Returns:
            Updated resource
        """
        function_name = resource.properties['FunctionName']
        
        # Update function code if changed
        code_path = resource.properties.get('CodePath')
        if code_path:
            current_code_sha = resource.properties.get('CodeSha256')
            new_code_zip = self._package_code(code_path)
            new_code_sha = hashlib.sha256(new_code_zip).hexdigest()
            
            if current_code_sha != new_code_sha:
                self.lambda_client.update_function_code(
                    FunctionName=function_name,
                    ZipFile=new_code_zip,
                    Publish=True
                )
                
                # Wait for update to complete
                waiter = self.lambda_client.get_waiter('function_updated')
                waiter.wait(FunctionName=function_name)
                
                resource.properties['CodeSha256'] = new_code_sha
        
        # Update function configuration
        config_params = {
            'FunctionName': function_name,
        }
        
        config_changed = False
        
        if 'Runtime' in resource.properties:
            config_params['Runtime'] = resource.properties['Runtime']
            config_changed = True
        
        if 'Role' in resource.properties:
            config_params['Role'] = resource.properties['Role']
            config_changed = True
        
        if 'Handler' in resource.properties:
            config_params['Handler'] = resource.properties['Handler']
            config_changed = True
        
        if 'MemorySize' in resource.properties:
            config_params['MemorySize'] = resource.properties['MemorySize']
            config_changed = True
        
        if 'Timeout' in resource.properties:
            config_params['Timeout'] = resource.properties['Timeout']
            config_changed = True
        
        environment = resource.properties.get('Environment')
        if environment is not None:
            config_params['Environment'] = {'Variables': environment}
            config_changed = True
        
        vpc_config = resource.properties.get('VpcConfig')
        if vpc_config is not None:
            config_params['VpcConfig'] = vpc_config
            config_changed = True
        
        dlq_config = resource.properties.get('DeadLetterConfig')
        if dlq_config is not None:
            config_params['DeadLetterConfig'] = dlq_config
            config_changed = True
        
        tracing_config = resource.properties.get('TracingConfig')
        if tracing_config is not None:
            config_params['TracingConfig'] = tracing_config
            config_changed = True
        
        if config_changed:
            self.lambda_client.update_function_configuration(**config_params)
            
            # Wait for update to complete
            waiter = self.lambda_client.get_waiter('function_updated')
            waiter.wait(FunctionName=function_name)
        
        # Update reserved concurrent executions
        reserved_concurrency = resource.properties.get('ReservedConcurrentExecutions')
        if reserved_concurrency is not None:
            self.lambda_client.put_function_concurrency(
                FunctionName=function_name,
                ReservedConcurrentExecutions=reserved_concurrency
            )
        
        # Update tags
        if resource.tags:
            function_arn = resource.physical_id
            self.lambda_client.tag_resource(
                Resource=function_arn,
                Tags=resource.tags
            )
        
        return resource

    def _needs_update(self, desired: Resource, current: Resource) -> bool:
        """Check if Lambda function needs updates.
        
        Args:
            desired: Desired state
            current: Current state
            
        Returns:
            True if updates are needed
        """
        # Check configuration changes
        config_fields = [
            'Runtime', 'Role', 'Handler', 'MemorySize', 'Timeout',
            'Environment', 'VpcConfig', 'DeadLetterConfig', 'TracingConfig',
            'ReservedConcurrentExecutions'
        ]
        
        for field in config_fields:
            if field in desired.properties:
                if desired.properties[field] != current.properties.get(field):
                    return True
        
        # Check code changes
        if 'CodePath' in desired.properties:
            code_path = desired.properties['CodePath']
            new_code_zip = self._package_code(code_path)
            new_code_sha = hashlib.sha256(new_code_zip).hexdigest()
            current_code_sha = current.properties.get('CodeSha256', '')
            
            if new_code_sha != current_code_sha:
                return True
        
        # Check tags
        if desired.tags != current.tags:
            return True
        
        return False

    def _package_code(self, code_path: str) -> bytes:
        """Package Lambda function code into a zip file.
        
        Args:
            code_path: Path to the code directory or file
            
        Returns:
            Zip file contents as bytes
        """
        with tempfile.NamedTemporaryFile(suffix='.zip', delete=False) as tmp_file:
            zip_path = tmp_file.name
        
        try:
            with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as zipf:
                if os.path.isfile(code_path):
                    # Single file
                    zipf.write(code_path, os.path.basename(code_path))
                elif os.path.isdir(code_path):
                    # Directory - recursively add all files
                    for root, dirs, files in os.walk(code_path):
                        # Skip common directories
                        dirs[:] = [d for d in dirs if d not in [
                            '__pycache__', '.git', '.venv', 'venv', 'node_modules',
                            '.pytest_cache', '.mypy_cache', 'dist', 'build'
                        ]]
                        
                        for file in files:
                            # Skip common files
                            if file.endswith(('.pyc', '.pyo', '.DS_Store')):
                                continue
                            
                            file_path = os.path.join(root, file)
                            arcname = os.path.relpath(file_path, code_path)
                            zipf.write(file_path, arcname)
                else:
                    raise ValueError(f"Code path does not exist: {code_path}")
            
            # Read zip file contents
            with open(zip_path, 'rb') as f:
                zip_contents = f.read()
            
            return zip_contents
            
        finally:
            # Clean up temp file
            if os.path.exists(zip_path):
                os.unlink(zip_path)

    @staticmethod
    def build_vpc_config(subnet_ids: list[str], security_group_ids: list[str]) -> Dict[str, Any]:
        """Build VPC configuration for Lambda function.
        
        Args:
            subnet_ids: List of subnet IDs
            security_group_ids: List of security group IDs
            
        Returns:
            VPC configuration dictionary
        """
        return {
            'SubnetIds': subnet_ids,
            'SecurityGroupIds': security_group_ids
        }

    @staticmethod
    def build_dlq_config(target_arn: str) -> Dict[str, Any]:
        """Build dead letter queue configuration.
        
        Args:
            target_arn: ARN of SQS queue or SNS topic
            
        Returns:
            DLQ configuration dictionary
        """
        return {
            'TargetArn': target_arn
        }

    @staticmethod
    def build_tracing_config(mode: str = 'Active') -> Dict[str, Any]:
        """Build X-Ray tracing configuration.
        
        Args:
            mode: Tracing mode ('Active' or 'PassThrough')
            
        Returns:
            Tracing configuration dictionary
        """
        return {
            'Mode': mode
        }

    @staticmethod
    def calculate_memory_for_workload(workload_type: str) -> int:
        """Calculate recommended memory size for workload type.
        
        Args:
            workload_type: Type of workload ('light', 'medium', 'heavy', 'ml')
            
        Returns:
            Recommended memory size in MB
        """
        memory_recommendations = {
            'light': 512,      # Simple API handlers, data transformations
            'medium': 1024,    # Complex business logic, moderate data processing
            'heavy': 2048,     # Heavy data processing, large file operations
            'ml': 3008,        # Machine learning inference, large model loading
        }
        
        return memory_recommendations.get(workload_type, 512)

    @staticmethod
    def calculate_timeout_for_workload(workload_type: str) -> int:
        """Calculate recommended timeout for workload type.
        
        Args:
            workload_type: Type of workload ('light', 'medium', 'heavy', 'ml')
            
        Returns:
            Recommended timeout in seconds
        """
        timeout_recommendations = {
            'light': 30,       # Quick API responses
            'medium': 60,      # Moderate processing
            'heavy': 300,      # Heavy processing (5 minutes)
            'ml': 900,         # ML inference (15 minutes - max)
        }
        
        return timeout_recommendations.get(workload_type, 30)
