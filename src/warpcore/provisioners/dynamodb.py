"""DynamoDB table provisioner with encryption."""

from typing import Optional, List, Dict, Any
from botocore.exceptions import ClientError

from .base import BaseProvisioner, Resource, ProvisionPlan, ChangeType


class DynamoDBProvisioner(BaseProvisioner):
    """Provisioner for DynamoDB tables with encryption."""

    def __init__(self, boto_session):
        """Initialize DynamoDB provisioner.
        
        Args:
            boto_session: Configured boto3 session
        """
        super().__init__(boto_session)
        self.dynamodb_client = boto_session.client('dynamodb')

    def plan(self, desired: Resource, current: Optional[Resource]) -> ProvisionPlan:
        """Determine what changes are needed for the DynamoDB table.
        
        Args:
            desired: Desired DynamoDB table state
            current: Current DynamoDB table state (None if doesn't exist)
            
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
        """Execute the DynamoDB table provisioning plan.
        
        Args:
            plan: Provisioning plan to execute
            
        Returns:
            Resource with physical_id set to table ARN
        """
        if plan.change_type == ChangeType.CREATE:
            return self._create_table(plan.resource)
        elif plan.change_type == ChangeType.UPDATE:
            return self._update_table(plan.resource)
        else:
            return plan.resource

    def destroy(self, resource: Resource) -> None:
        """Destroy the DynamoDB table.
        
        Args:
            resource: DynamoDB table resource to destroy
        """
        table_name = resource.properties.get('TableName')
        if not table_name:
            return
        
        try:
            self.dynamodb_client.delete_table(TableName=table_name)
            
            # Wait for table to be deleted
            waiter = self.dynamodb_client.get_waiter('table_not_exists')
            waiter.wait(TableName=table_name)
            
        except ClientError as e:
            if e.response['Error']['Code'] != 'ResourceNotFoundException':
                raise

    def get_current_state(self, resource_id: str) -> Optional[Resource]:
        """Fetch current DynamoDB table state from AWS.
        
        Args:
            resource_id: Logical resource ID
            
        Returns:
            Current resource state or None if doesn't exist
        """
        table_name = resource_id.replace('dynamodb-', '')
        
        try:
            response = self.dynamodb_client.describe_table(TableName=table_name)
            table = response['Table']
            
            # Get tags
            tags_response = self.dynamodb_client.list_tags_of_resource(
                ResourceArn=table['TableArn']
            )
            tags = {tag['Key']: tag['Value'] for tag in tags_response.get('Tags', [])}
            
            return Resource(
                id=resource_id,
                type='AWS::DynamoDB::Table',
                physical_id=table['TableArn'],
                properties={
                    'TableName': table['TableName'],
                    'KeySchema': table['KeySchema'],
                    'AttributeDefinitions': table['AttributeDefinitions'],
                    'BillingMode': table.get('BillingModeSummary', {}).get('BillingMode', 'PROVISIONED'),
                    'ProvisionedThroughput': table.get('ProvisionedThroughput'),
                    'StreamSpecification': table.get('StreamSpecification'),
                    'SSEDescription': table.get('SSEDescription'),
                    'GlobalSecondaryIndexes': table.get('GlobalSecondaryIndexes', []),
                    'LocalSecondaryIndexes': table.get('LocalSecondaryIndexes', []),
                },
                dependencies=[],
                tags=tags
            )
            
        except ClientError as e:
            if e.response['Error']['Code'] == 'ResourceNotFoundException':
                return None
            raise

    def _create_table(self, resource: Resource) -> Resource:
        """Create a new DynamoDB table.
        
        Args:
            resource: Resource definition
            
        Returns:
            Resource with physical_id set
        """
        table_name = resource.properties['TableName']
        key_schema = resource.properties['KeySchema']
        attribute_definitions = resource.properties['AttributeDefinitions']
        
        # Create table
        create_params = {
            'TableName': table_name,
            'KeySchema': key_schema,
            'AttributeDefinitions': attribute_definitions,
        }
        
        # Add billing mode
        billing_mode = resource.properties.get('BillingMode', 'PAY_PER_REQUEST')
        create_params['BillingMode'] = billing_mode
        
        # Add provisioned throughput if using PROVISIONED mode
        if billing_mode == 'PROVISIONED':
            create_params['ProvisionedThroughput'] = resource.properties.get(
                'ProvisionedThroughput',
                {'ReadCapacityUnits': 5, 'WriteCapacityUnits': 5}
            )
        
        # Add stream specification
        stream_spec = resource.properties.get('StreamSpecification')
        if stream_spec:
            create_params['StreamSpecification'] = stream_spec
        
        # Add encryption (default to AWS owned key)
        sse_spec = resource.properties.get('SSESpecification', {
            'Enabled': True,
            'SSEType': 'KMS'
        })
        create_params['SSESpecification'] = sse_spec
        
        # Add global secondary indexes
        gsi = resource.properties.get('GlobalSecondaryIndexes')
        if gsi:
            create_params['GlobalSecondaryIndexes'] = gsi
        
        # Add local secondary indexes
        lsi = resource.properties.get('LocalSecondaryIndexes')
        if lsi:
            create_params['LocalSecondaryIndexes'] = lsi
        
        # Add tags
        if resource.tags:
            create_params['Tags'] = [
                {'Key': k, 'Value': v} for k, v in resource.tags.items()
            ]
        
        response = self.dynamodb_client.create_table(**create_params)
        table_arn = response['TableDescription']['TableArn']
        
        # Wait for table to be active
        waiter = self.dynamodb_client.get_waiter('table_exists')
        waiter.wait(TableName=table_name)
        
        resource.physical_id = table_arn
        return resource

    def _update_table(self, resource: Resource) -> Resource:
        """Update an existing DynamoDB table.
        
        Args:
            resource: Resource definition with updates
            
        Returns:
            Updated resource
        """
        table_name = resource.properties['TableName']
        
        # Update billing mode
        billing_mode = resource.properties.get('BillingMode')
        if billing_mode:
            update_params = {'TableName': table_name}
            
            if billing_mode == 'PROVISIONED':
                provisioned_throughput = resource.properties.get('ProvisionedThroughput')
                if provisioned_throughput:
                    update_params['ProvisionedThroughput'] = provisioned_throughput
            else:
                update_params['BillingMode'] = billing_mode
            
            self.dynamodb_client.update_table(**update_params)
            
            # Wait for update to complete
            waiter = self.dynamodb_client.get_waiter('table_exists')
            waiter.wait(TableName=table_name)
        
        # Update stream specification
        stream_spec = resource.properties.get('StreamSpecification')
        if stream_spec:
            self.dynamodb_client.update_table(
                TableName=table_name,
                StreamSpecification=stream_spec
            )
            
            waiter = self.dynamodb_client.get_waiter('table_exists')
            waiter.wait(TableName=table_name)
        
        # Update tags
        if resource.tags:
            table_arn = resource.physical_id
            self.dynamodb_client.tag_resource(
                ResourceArn=table_arn,
                Tags=[{'Key': k, 'Value': v} for k, v in resource.tags.items()]
            )
        
        return resource

    def _needs_update(self, desired: Resource, current: Resource) -> bool:
        """Check if DynamoDB table needs updates.
        
        Args:
            desired: Desired state
            current: Current state
            
        Returns:
            True if updates are needed
        """
        # Compare billing mode
        if desired.properties.get('BillingMode') != current.properties.get('BillingMode'):
            return True
        
        # Compare provisioned throughput
        if desired.properties.get('ProvisionedThroughput') != current.properties.get('ProvisionedThroughput'):
            return True
        
        # Compare stream specification
        if desired.properties.get('StreamSpecification') != current.properties.get('StreamSpecification'):
            return True
        
        # Compare tags
        if desired.tags != current.tags:
            return True
        
        return False

    @staticmethod
    def build_key_schema(
        partition_key: str,
        partition_key_type: str = 'S',
        sort_key: Optional[str] = None,
        sort_key_type: str = 'S'
    ) -> tuple[List[Dict[str, str]], List[Dict[str, str]]]:
        """Build key schema and attribute definitions.
        
        Args:
            partition_key: Partition key attribute name
            partition_key_type: Partition key type ('S', 'N', 'B')
            sort_key: Sort key attribute name (optional)
            sort_key_type: Sort key type ('S', 'N', 'B')
            
        Returns:
            Tuple of (KeySchema, AttributeDefinitions)
        """
        key_schema = [
            {'AttributeName': partition_key, 'KeyType': 'HASH'}
        ]
        
        attribute_definitions = [
            {'AttributeName': partition_key, 'AttributeType': partition_key_type}
        ]
        
        if sort_key:
            key_schema.append({'AttributeName': sort_key, 'KeyType': 'RANGE'})
            attribute_definitions.append({'AttributeName': sort_key, 'AttributeType': sort_key_type})
        
        return key_schema, attribute_definitions

    @staticmethod
    def build_stream_specification(stream_view_type: str = 'NEW_AND_OLD_IMAGES') -> Dict[str, Any]:
        """Build stream specification for DynamoDB Streams.
        
        Args:
            stream_view_type: Type of data to write to stream
                ('KEYS_ONLY', 'NEW_IMAGE', 'OLD_IMAGE', 'NEW_AND_OLD_IMAGES')
            
        Returns:
            Stream specification dictionary
        """
        return {
            'StreamEnabled': True,
            'StreamViewType': stream_view_type
        }

    @staticmethod
    def build_gsi(
        index_name: str,
        partition_key: str,
        partition_key_type: str = 'S',
        sort_key: Optional[str] = None,
        sort_key_type: str = 'S',
        projection_type: str = 'ALL'
    ) -> Dict[str, Any]:
        """Build global secondary index configuration.
        
        Args:
            index_name: Index name
            partition_key: Partition key attribute name
            partition_key_type: Partition key type
            sort_key: Sort key attribute name (optional)
            sort_key_type: Sort key type
            projection_type: Projection type ('ALL', 'KEYS_ONLY', 'INCLUDE')
            
        Returns:
            GSI configuration dictionary
        """
        key_schema = [
            {'AttributeName': partition_key, 'KeyType': 'HASH'}
        ]
        
        if sort_key:
            key_schema.append({'AttributeName': sort_key, 'KeyType': 'RANGE'})
        
        return {
            'IndexName': index_name,
            'KeySchema': key_schema,
            'Projection': {'ProjectionType': projection_type}
        }
