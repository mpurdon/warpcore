"""S3 bucket provisioner with encryption at rest."""

from typing import Optional, Dict, Any
from botocore.exceptions import ClientError

from .base import BaseProvisioner, Resource, ProvisionPlan, ChangeType


class S3Provisioner(BaseProvisioner):
    """Provisioner for S3 buckets with encryption."""

    def __init__(self, boto_session):
        """Initialize S3 provisioner.
        
        Args:
            boto_session: Configured boto3 session
        """
        super().__init__(boto_session)
        self.s3_client = boto_session.client('s3')

    def plan(self, desired: Resource, current: Optional[Resource]) -> ProvisionPlan:
        """Determine what changes are needed for the S3 bucket.
        
        Args:
            desired: Desired S3 bucket state
            current: Current S3 bucket state (None if doesn't exist)
            
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
        """Execute the S3 bucket provisioning plan.
        
        Args:
            plan: Provisioning plan to execute
            
        Returns:
            Resource with physical_id set to bucket name
        """
        if plan.change_type == ChangeType.CREATE:
            return self._create_bucket(plan.resource)
        elif plan.change_type == ChangeType.UPDATE:
            return self._update_bucket(plan.resource)
        else:
            return plan.resource

    def destroy(self, resource: Resource) -> None:
        """Destroy the S3 bucket.
        
        Args:
            resource: S3 bucket resource to destroy
        """
        bucket_name = resource.physical_id
        if not bucket_name:
            return
        
        try:
            # Delete all objects first
            paginator = self.s3_client.get_paginator('list_object_versions')
            for page in paginator.paginate(Bucket=bucket_name):
                # Delete versions
                versions = page.get('Versions', [])
                if versions:
                    objects = [{'Key': v['Key'], 'VersionId': v['VersionId']} for v in versions]
                    self.s3_client.delete_objects(
                        Bucket=bucket_name,
                        Delete={'Objects': objects}
                    )
                
                # Delete delete markers
                delete_markers = page.get('DeleteMarkers', [])
                if delete_markers:
                    objects = [{'Key': d['Key'], 'VersionId': d['VersionId']} for d in delete_markers]
                    self.s3_client.delete_objects(
                        Bucket=bucket_name,
                        Delete={'Objects': objects}
                    )
            
            # Delete the bucket
            self.s3_client.delete_bucket(Bucket=bucket_name)
            
        except ClientError as e:
            if e.response['Error']['Code'] != 'NoSuchBucket':
                raise

    def get_current_state(self, resource_id: str) -> Optional[Resource]:
        """Fetch current S3 bucket state from AWS.
        
        Args:
            resource_id: Logical resource ID
            
        Returns:
            Current resource state or None if doesn't exist
        """
        bucket_name = resource_id.replace('s3-', '')
        
        try:
            # Check if bucket exists
            self.s3_client.head_bucket(Bucket=bucket_name)
            
            # Get bucket encryption
            try:
                encryption_response = self.s3_client.get_bucket_encryption(Bucket=bucket_name)
                encryption_config = encryption_response.get('ServerSideEncryptionConfiguration')
            except ClientError:
                encryption_config = None
            
            # Get bucket versioning
            try:
                versioning_response = self.s3_client.get_bucket_versioning(Bucket=bucket_name)
                versioning_status = versioning_response.get('Status', 'Disabled')
            except ClientError:
                versioning_status = 'Disabled'
            
            # Get tags
            try:
                tags_response = self.s3_client.get_bucket_tagging(Bucket=bucket_name)
                tags = {tag['Key']: tag['Value'] for tag in tags_response.get('TagSet', [])}
            except ClientError:
                tags = {}
            
            return Resource(
                id=resource_id,
                type='AWS::S3::Bucket',
                physical_id=bucket_name,
                properties={
                    'BucketName': bucket_name,
                    'EncryptionConfiguration': encryption_config,
                    'VersioningStatus': versioning_status,
                },
                dependencies=[],
                tags=tags
            )
            
        except ClientError as e:
            if e.response['Error']['Code'] in ['NoSuchBucket', '404']:
                return None
            raise

    def _create_bucket(self, resource: Resource) -> Resource:
        """Create a new S3 bucket.
        
        Args:
            resource: Resource definition
            
        Returns:
            Resource with physical_id set
        """
        bucket_name = resource.properties['BucketName']
        region = self.session.region_name
        
        # Create bucket
        create_params = {'Bucket': bucket_name}
        
        # Add location constraint for non-us-east-1 regions
        if region != 'us-east-1':
            create_params['CreateBucketConfiguration'] = {
                'LocationConstraint': region
            }
        
        self.s3_client.create_bucket(**create_params)
        
        # Enable encryption (default to AES256)
        encryption_config = resource.properties.get('EncryptionConfiguration', {
            'Rules': [
                {
                    'ApplyServerSideEncryptionByDefault': {
                        'SSEAlgorithm': 'AES256'
                    },
                    'BucketKeyEnabled': True
                }
            ]
        })
        
        self.s3_client.put_bucket_encryption(
            Bucket=bucket_name,
            ServerSideEncryptionConfiguration=encryption_config
        )
        
        # Enable versioning if specified
        versioning_status = resource.properties.get('VersioningStatus', 'Disabled')
        if versioning_status == 'Enabled':
            self.s3_client.put_bucket_versioning(
                Bucket=bucket_name,
                VersioningConfiguration={'Status': 'Enabled'}
            )
        
        # Block public access by default
        self.s3_client.put_public_access_block(
            Bucket=bucket_name,
            PublicAccessBlockConfiguration={
                'BlockPublicAcls': True,
                'IgnorePublicAcls': True,
                'BlockPublicPolicy': True,
                'RestrictPublicBuckets': True
            }
        )
        
        # Add tags
        if resource.tags:
            self.s3_client.put_bucket_tagging(
                Bucket=bucket_name,
                Tagging={
                    'TagSet': [
                        {'Key': k, 'Value': v} for k, v in resource.tags.items()
                    ]
                }
            )
        
        resource.physical_id = bucket_name
        return resource

    def _update_bucket(self, resource: Resource) -> Resource:
        """Update an existing S3 bucket.
        
        Args:
            resource: Resource definition with updates
            
        Returns:
            Updated resource
        """
        bucket_name = resource.physical_id
        
        # Update encryption
        encryption_config = resource.properties.get('EncryptionConfiguration')
        if encryption_config:
            self.s3_client.put_bucket_encryption(
                Bucket=bucket_name,
                ServerSideEncryptionConfiguration=encryption_config
            )
        
        # Update versioning
        versioning_status = resource.properties.get('VersioningStatus')
        if versioning_status:
            self.s3_client.put_bucket_versioning(
                Bucket=bucket_name,
                VersioningConfiguration={'Status': versioning_status}
            )
        
        # Update tags
        if resource.tags:
            self.s3_client.put_bucket_tagging(
                Bucket=bucket_name,
                Tagging={
                    'TagSet': [
                        {'Key': k, 'Value': v} for k, v in resource.tags.items()
                    ]
                }
            )
        
        return resource

    def _needs_update(self, desired: Resource, current: Resource) -> bool:
        """Check if S3 bucket needs updates.
        
        Args:
            desired: Desired state
            current: Current state
            
        Returns:
            True if updates are needed
        """
        # Compare encryption
        if desired.properties.get('EncryptionConfiguration') != current.properties.get('EncryptionConfiguration'):
            return True
        
        # Compare versioning
        if desired.properties.get('VersioningStatus') != current.properties.get('VersioningStatus'):
            return True
        
        # Compare tags
        if desired.tags != current.tags:
            return True
        
        return False

    @staticmethod
    def build_encryption_config(algorithm: str = 'AES256', kms_key_id: Optional[str] = None) -> Dict[str, Any]:
        """Build encryption configuration for S3 bucket.
        
        Args:
            algorithm: Encryption algorithm ('AES256' or 'aws:kms')
            kms_key_id: KMS key ID (required if algorithm is 'aws:kms')
            
        Returns:
            Encryption configuration dictionary
        """
        config = {
            'Rules': [
                {
                    'ApplyServerSideEncryptionByDefault': {
                        'SSEAlgorithm': algorithm
                    },
                    'BucketKeyEnabled': True
                }
            ]
        }
        
        if algorithm == 'aws:kms' and kms_key_id:
            config['Rules'][0]['ApplyServerSideEncryptionByDefault']['KMSMasterKeyID'] = kms_key_id
        
        return config
