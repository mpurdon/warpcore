"""SNS topic provisioner."""

from typing import Optional, Dict, Any
from botocore.exceptions import ClientError

from .base import BaseProvisioner, Resource, ProvisionPlan, ChangeType


class SNSProvisioner(BaseProvisioner):
    """Provisioner for SNS topics."""

    def __init__(self, boto_session):
        """Initialize SNS provisioner.
        
        Args:
            boto_session: Configured boto3 session
        """
        super().__init__(boto_session)
        self.sns_client = boto_session.client('sns')

    def plan(self, desired: Resource, current: Optional[Resource]) -> ProvisionPlan:
        """Determine what changes are needed for the SNS topic.
        
        Args:
            desired: Desired SNS topic state
            current: Current SNS topic state (None if doesn't exist)
            
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
        """Execute the SNS topic provisioning plan.
        
        Args:
            plan: Provisioning plan to execute
            
        Returns:
            Resource with physical_id set to topic ARN
        """
        if plan.change_type == ChangeType.CREATE:
            return self._create_topic(plan.resource)
        elif plan.change_type == ChangeType.UPDATE:
            return self._update_topic(plan.resource)
        else:
            return plan.resource

    def destroy(self, resource: Resource) -> None:
        """Destroy the SNS topic.
        
        Args:
            resource: SNS topic resource to destroy
        """
        topic_arn = resource.physical_id
        if not topic_arn:
            return
        
        try:
            self.sns_client.delete_topic(TopicArn=topic_arn)
        except ClientError as e:
            if e.response['Error']['Code'] != 'NotFound':
                raise

    def get_current_state(self, resource_id: str) -> Optional[Resource]:
        """Fetch current SNS topic state from AWS.
        
        Args:
            resource_id: Logical resource ID
            
        Returns:
            Current resource state or None if doesn't exist
        """
        # Find topic by tag
        try:
            # List all topics
            paginator = self.sns_client.get_paginator('list_topics')
            
            for page in paginator.paginate():
                for topic in page['Topics']:
                    topic_arn = topic['TopicArn']
                    
                    # Get topic attributes
                    attrs_response = self.sns_client.get_topic_attributes(TopicArn=topic_arn)
                    attributes = attrs_response['Attributes']
                    
                    # Get tags
                    tags_response = self.sns_client.list_tags_for_resource(ResourceArn=topic_arn)
                    tags = {tag['Key']: tag['Value'] for tag in tags_response.get('Tags', [])}
                    
                    # Check if this is our topic
                    if tags.get('strands:resource-id') == resource_id:
                        return Resource(
                            id=resource_id,
                            type='AWS::SNS::Topic',
                            physical_id=topic_arn,
                            properties={
                                'TopicName': attributes.get('TopicName'),
                                'DisplayName': attributes.get('DisplayName'),
                                'FifoTopic': attributes.get('FifoTopic', 'false') == 'true',
                                'ContentBasedDeduplication': attributes.get('ContentBasedDeduplication', 'false') == 'true',
                                'KmsMasterKeyId': attributes.get('KmsMasterKeyId'),
                            },
                            dependencies=[],
                            tags=tags
                        )
            
            return None
            
        except ClientError:
            return None

    def _create_topic(self, resource: Resource) -> Resource:
        """Create a new SNS topic.
        
        Args:
            resource: Resource definition
            
        Returns:
            Resource with physical_id set
        """
        topic_name = resource.properties['TopicName']
        
        # Build attributes
        attributes = {}
        
        if 'DisplayName' in resource.properties:
            attributes['DisplayName'] = resource.properties['DisplayName']
        
        if resource.properties.get('FifoTopic'):
            attributes['FifoTopic'] = 'true'
        
        if resource.properties.get('ContentBasedDeduplication'):
            attributes['ContentBasedDeduplication'] = 'true'
        
        if 'KmsMasterKeyId' in resource.properties:
            attributes['KmsMasterKeyId'] = resource.properties['KmsMasterKeyId']
        
        # Create topic
        create_params = {
            'Name': topic_name,
            'Attributes': attributes
        }
        
        if resource.tags:
            create_params['Tags'] = [
                {'Key': k, 'Value': v} for k, v in resource.tags.items()
            ] + [
                {'Key': 'strands:resource-id', 'Value': resource.id}
            ]
        
        response = self.sns_client.create_topic(**create_params)
        topic_arn = response['TopicArn']
        
        resource.physical_id = topic_arn
        return resource

    def _update_topic(self, resource: Resource) -> Resource:
        """Update an existing SNS topic.
        
        Args:
            resource: Resource definition with updates
            
        Returns:
            Updated resource
        """
        topic_arn = resource.physical_id
        
        # Update attributes
        if 'DisplayName' in resource.properties:
            self.sns_client.set_topic_attributes(
                TopicArn=topic_arn,
                AttributeName='DisplayName',
                AttributeValue=resource.properties['DisplayName']
            )
        
        if 'KmsMasterKeyId' in resource.properties:
            self.sns_client.set_topic_attributes(
                TopicArn=topic_arn,
                AttributeName='KmsMasterKeyId',
                AttributeValue=resource.properties['KmsMasterKeyId']
            )
        
        # Update tags
        if resource.tags:
            self.sns_client.tag_resource(
                ResourceArn=topic_arn,
                Tags=[{'Key': k, 'Value': v} for k, v in resource.tags.items()]
            )
        
        return resource

    def _needs_update(self, desired: Resource, current: Resource) -> bool:
        """Check if SNS topic needs updates.
        
        Args:
            desired: Desired state
            current: Current state
            
        Returns:
            True if updates are needed
        """
        # Compare attributes
        if desired.properties.get('DisplayName') != current.properties.get('DisplayName'):
            return True
        
        if desired.properties.get('KmsMasterKeyId') != current.properties.get('KmsMasterKeyId'):
            return True
        
        # Compare tags
        if desired.tags != current.tags:
            return True
        
        return False

    @staticmethod
    def build_fifo_topic_name(base_name: str) -> str:
        """Build FIFO topic name with .fifo suffix.
        
        Args:
            base_name: Base topic name
            
        Returns:
            Topic name with .fifo suffix
        """
        if not base_name.endswith('.fifo'):
            return f"{base_name}.fifo"
        return base_name

    def create_subscription(
        self,
        topic_arn: str,
        protocol: str,
        endpoint: str,
        attributes: Optional[Dict[str, str]] = None
    ) -> str:
        """Create a subscription to the topic.
        
        Args:
            topic_arn: Topic ARN
            protocol: Protocol (email, sms, sqs, lambda, http, https, etc.)
            endpoint: Endpoint (email address, phone number, queue ARN, function ARN, URL)
            attributes: Optional subscription attributes
            
        Returns:
            Subscription ARN
        """
        subscribe_params = {
            'TopicArn': topic_arn,
            'Protocol': protocol,
            'Endpoint': endpoint,
            'ReturnSubscriptionArn': True
        }
        
        if attributes:
            subscribe_params['Attributes'] = attributes
        
        response = self.sns_client.subscribe(**subscribe_params)
        return response['SubscriptionArn']

    @staticmethod
    def build_filter_policy(filters: Dict[str, Any]) -> str:
        """Build filter policy for subscription.
        
        Args:
            filters: Filter conditions
            
        Returns:
            Filter policy as JSON string
        """
        import json
        return json.dumps(filters)
