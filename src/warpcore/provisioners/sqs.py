"""SQS queue provisioner."""

from typing import Optional, Dict, Any
from botocore.exceptions import ClientError

from .base import BaseProvisioner, Resource, ProvisionPlan, ChangeType


class SQSProvisioner(BaseProvisioner):
    """Provisioner for SQS queues."""

    def __init__(self, boto_session):
        """Initialize SQS provisioner.
        
        Args:
            boto_session: Configured boto3 session
        """
        super().__init__(boto_session)
        self.sqs_client = boto_session.client('sqs')

    def plan(self, desired: Resource, current: Optional[Resource]) -> ProvisionPlan:
        """Determine what changes are needed for the SQS queue.
        
        Args:
            desired: Desired SQS queue state
            current: Current SQS queue state (None if doesn't exist)
            
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
        """Execute the SQS queue provisioning plan.
        
        Args:
            plan: Provisioning plan to execute
            
        Returns:
            Resource with physical_id set to queue URL
        """
        if plan.change_type == ChangeType.CREATE:
            return self._create_queue(plan.resource)
        elif plan.change_type == ChangeType.UPDATE:
            return self._update_queue(plan.resource)
        else:
            return plan.resource

    def destroy(self, resource: Resource) -> None:
        """Destroy the SQS queue.
        
        Args:
            resource: SQS queue resource to destroy
        """
        queue_url = resource.physical_id
        if not queue_url:
            return
        
        try:
            self.sqs_client.delete_queue(QueueUrl=queue_url)
        except ClientError as e:
            if e.response['Error']['Code'] != 'AWS.SimpleQueueService.NonExistentQueue':
                raise

    def get_current_state(self, resource_id: str) -> Optional[Resource]:
        """Fetch current SQS queue state from AWS.
        
        Args:
            resource_id: Logical resource ID
            
        Returns:
            Current resource state or None if doesn't exist
        """
        queue_name = resource_id.replace('sqs-', '')
        
        try:
            # Get queue URL
            response = self.sqs_client.get_queue_url(QueueName=queue_name)
            queue_url = response['QueueUrl']
            
            # Get queue attributes
            attrs_response = self.sqs_client.get_queue_attributes(
                QueueUrl=queue_url,
                AttributeNames=['All']
            )
            attributes = attrs_response['Attributes']
            
            # Get tags
            tags_response = self.sqs_client.list_queue_tags(QueueUrl=queue_url)
            tags = tags_response.get('Tags', {})
            
            return Resource(
                id=resource_id,
                type='AWS::SQS::Queue',
                physical_id=queue_url,
                properties={
                    'QueueName': queue_name,
                    'QueueArn': attributes.get('QueueArn'),
                    'VisibilityTimeout': int(attributes.get('VisibilityTimeout', 30)),
                    'MessageRetentionPeriod': int(attributes.get('MessageRetentionPeriod', 345600)),
                    'MaximumMessageSize': int(attributes.get('MaximumMessageSize', 262144)),
                    'DelaySeconds': int(attributes.get('DelaySeconds', 0)),
                    'ReceiveMessageWaitTimeSeconds': int(attributes.get('ReceiveMessageWaitTimeSeconds', 0)),
                    'FifoQueue': attributes.get('FifoQueue', 'false') == 'true',
                    'ContentBasedDeduplication': attributes.get('ContentBasedDeduplication', 'false') == 'true',
                    'RedrivePolicy': attributes.get('RedrivePolicy'),
                    'KmsMasterKeyId': attributes.get('KmsMasterKeyId'),
                },
                dependencies=[],
                tags=tags
            )
            
        except ClientError as e:
            if e.response['Error']['Code'] == 'AWS.SimpleQueueService.NonExistentQueue':
                return None
            raise

    def _create_queue(self, resource: Resource) -> Resource:
        """Create a new SQS queue.
        
        Args:
            resource: Resource definition
            
        Returns:
            Resource with physical_id set
        """
        queue_name = resource.properties['QueueName']
        
        # Build attributes
        attributes = {}
        
        if 'VisibilityTimeout' in resource.properties:
            attributes['VisibilityTimeout'] = str(resource.properties['VisibilityTimeout'])
        
        if 'MessageRetentionPeriod' in resource.properties:
            attributes['MessageRetentionPeriod'] = str(resource.properties['MessageRetentionPeriod'])
        
        if 'MaximumMessageSize' in resource.properties:
            attributes['MaximumMessageSize'] = str(resource.properties['MaximumMessageSize'])
        
        if 'DelaySeconds' in resource.properties:
            attributes['DelaySeconds'] = str(resource.properties['DelaySeconds'])
        
        if 'ReceiveMessageWaitTimeSeconds' in resource.properties:
            attributes['ReceiveMessageWaitTimeSeconds'] = str(resource.properties['ReceiveMessageWaitTimeSeconds'])
        
        if resource.properties.get('FifoQueue'):
            attributes['FifoQueue'] = 'true'
        
        if resource.properties.get('ContentBasedDeduplication'):
            attributes['ContentBasedDeduplication'] = 'true'
        
        if 'RedrivePolicy' in resource.properties:
            attributes['RedrivePolicy'] = resource.properties['RedrivePolicy']
        
        if 'KmsMasterKeyId' in resource.properties:
            attributes['KmsMasterKeyId'] = resource.properties['KmsMasterKeyId']
        
        # Create queue
        create_params = {
            'QueueName': queue_name,
            'Attributes': attributes
        }
        
        if resource.tags:
            create_params['tags'] = resource.tags
        
        response = self.sqs_client.create_queue(**create_params)
        queue_url = response['QueueUrl']
        
        # Get queue ARN
        attrs_response = self.sqs_client.get_queue_attributes(
            QueueUrl=queue_url,
            AttributeNames=['QueueArn']
        )
        queue_arn = attrs_response['Attributes']['QueueArn']
        
        resource.physical_id = queue_url
        resource.properties['QueueArn'] = queue_arn
        
        return resource

    def _update_queue(self, resource: Resource) -> Resource:
        """Update an existing SQS queue.
        
        Args:
            resource: Resource definition with updates
            
        Returns:
            Updated resource
        """
        queue_url = resource.physical_id
        
        # Build attributes to update
        attributes = {}
        
        if 'VisibilityTimeout' in resource.properties:
            attributes['VisibilityTimeout'] = str(resource.properties['VisibilityTimeout'])
        
        if 'MessageRetentionPeriod' in resource.properties:
            attributes['MessageRetentionPeriod'] = str(resource.properties['MessageRetentionPeriod'])
        
        if 'MaximumMessageSize' in resource.properties:
            attributes['MaximumMessageSize'] = str(resource.properties['MaximumMessageSize'])
        
        if 'DelaySeconds' in resource.properties:
            attributes['DelaySeconds'] = str(resource.properties['DelaySeconds'])
        
        if 'ReceiveMessageWaitTimeSeconds' in resource.properties:
            attributes['ReceiveMessageWaitTimeSeconds'] = str(resource.properties['ReceiveMessageWaitTimeSeconds'])
        
        if 'RedrivePolicy' in resource.properties:
            attributes['RedrivePolicy'] = resource.properties['RedrivePolicy']
        
        if 'KmsMasterKeyId' in resource.properties:
            attributes['KmsMasterKeyId'] = resource.properties['KmsMasterKeyId']
        
        # Update queue attributes
        if attributes:
            self.sqs_client.set_queue_attributes(
                QueueUrl=queue_url,
                Attributes=attributes
            )
        
        # Update tags
        if resource.tags:
            # Remove old tags
            self.sqs_client.untag_queue(
                QueueUrl=queue_url,
                TagKeys=list(resource.tags.keys())
            )
            
            # Add new tags
            self.sqs_client.tag_queue(
                QueueUrl=queue_url,
                Tags=resource.tags
            )
        
        return resource

    def _needs_update(self, desired: Resource, current: Resource) -> bool:
        """Check if SQS queue needs updates.
        
        Args:
            desired: Desired state
            current: Current state
            
        Returns:
            True if updates are needed
        """
        # Compare attributes
        attributes = [
            'VisibilityTimeout', 'MessageRetentionPeriod', 'MaximumMessageSize',
            'DelaySeconds', 'ReceiveMessageWaitTimeSeconds', 'RedrivePolicy',
            'KmsMasterKeyId'
        ]
        
        for attr in attributes:
            if attr in desired.properties:
                if desired.properties[attr] != current.properties.get(attr):
                    return True
        
        # Compare tags
        if desired.tags != current.tags:
            return True
        
        return False

    @staticmethod
    def build_redrive_policy(dlq_arn: str, max_receive_count: int = 3) -> str:
        """Build redrive policy for dead letter queue.
        
        Args:
            dlq_arn: Dead letter queue ARN
            max_receive_count: Maximum number of receives before moving to DLQ
            
        Returns:
            Redrive policy as JSON string
        """
        import json
        return json.dumps({
            'deadLetterTargetArn': dlq_arn,
            'maxReceiveCount': max_receive_count
        })

    @staticmethod
    def build_fifo_queue_name(base_name: str) -> str:
        """Build FIFO queue name with .fifo suffix.
        
        Args:
            base_name: Base queue name
            
        Returns:
            Queue name with .fifo suffix
        """
        if not base_name.endswith('.fifo'):
            return f"{base_name}.fifo"
        return base_name
