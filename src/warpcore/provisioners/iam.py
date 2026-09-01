"""IAM role provisioner with optimization for shared execution roles."""

import json
from typing import Optional, List, Dict, Any
from botocore.exceptions import ClientError

from .base import BaseProvisioner, Resource, ProvisionPlan, ChangeType


class IAMRoleProvisioner(BaseProvisioner):
    """Provisioner for IAM roles with least-privilege policy generation."""

    def __init__(self, boto_session):
        """Initialize IAM role provisioner.
        
        Args:
            boto_session: Configured boto3 session
        """
        super().__init__(boto_session)
        self.iam_client = boto_session.client('iam')

    def plan(self, desired: Resource, current: Optional[Resource]) -> ProvisionPlan:
        """Determine what changes are needed for the IAM role.
        
        Args:
            desired: Desired IAM role state
            current: Current IAM role state (None if doesn't exist)
            
        Returns:
            ProvisionPlan with change type
        """
        if current is None:
            return ProvisionPlan(
                resource=desired,
                change_type=ChangeType.CREATE,
                current_state=None
            )
        
        # Check if role needs updates
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
        """Execute the IAM role provisioning plan.
        
        Args:
            plan: Provisioning plan to execute
            
        Returns:
            Resource with physical_id set to role ARN
        """
        if plan.change_type == ChangeType.CREATE:
            return self._create_role(plan.resource)
        elif plan.change_type == ChangeType.UPDATE:
            return self._update_role(plan.resource)
        else:
            return plan.resource

    def destroy(self, resource: Resource) -> None:
        """Destroy the IAM role.
        
        Args:
            resource: IAM role resource to destroy
        """
        role_name = resource.properties.get('RoleName')
        if not role_name:
            return
        
        try:
            # Delete inline policies
            inline_policies = self.iam_client.list_role_policies(RoleName=role_name)
            for policy_name in inline_policies.get('PolicyNames', []):
                self.iam_client.delete_role_policy(
                    RoleName=role_name,
                    PolicyName=policy_name
                )
            
            # Detach managed policies
            attached_policies = self.iam_client.list_attached_role_policies(RoleName=role_name)
            for policy in attached_policies.get('AttachedPolicies', []):
                self.iam_client.detach_role_policy(
                    RoleName=role_name,
                    PolicyArn=policy['PolicyArn']
                )
            
            # Delete the role
            self.iam_client.delete_role(RoleName=role_name)
            
        except ClientError as e:
            if e.response['Error']['Code'] != 'NoSuchEntity':
                raise

    def get_current_state(self, resource_id: str) -> Optional[Resource]:
        """Fetch current IAM role state from AWS.
        
        Args:
            resource_id: Logical resource ID
            
        Returns:
            Current resource state or None if doesn't exist
        """
        # Extract role name from resource_id (format: iam-role-{name})
        role_name = resource_id.replace('iam-role-', '')
        
        try:
            response = self.iam_client.get_role(RoleName=role_name)
            role = response['Role']
            
            # Get inline policies
            inline_policies = self.iam_client.list_role_policies(RoleName=role_name)
            policy_documents = {}
            for policy_name in inline_policies.get('PolicyNames', []):
                policy_response = self.iam_client.get_role_policy(
                    RoleName=role_name,
                    PolicyName=policy_name
                )
                policy_documents[policy_name] = policy_response['PolicyDocument']
            
            # Get attached managed policies
            attached_policies = self.iam_client.list_attached_role_policies(RoleName=role_name)
            managed_policy_arns = [p['PolicyArn'] for p in attached_policies.get('AttachedPolicies', [])]
            
            # Get tags
            tags_response = self.iam_client.list_role_tags(RoleName=role_name)
            tags = {tag['Key']: tag['Value'] for tag in tags_response.get('Tags', [])}
            
            return Resource(
                id=resource_id,
                type='AWS::IAM::Role',
                physical_id=role['Arn'],
                properties={
                    'RoleName': role['RoleName'],
                    'AssumeRolePolicyDocument': role['AssumeRolePolicyDocument'],
                    'InlinePolicies': policy_documents,
                    'ManagedPolicyArns': managed_policy_arns,
                    'Description': role.get('Description', ''),
                    'MaxSessionDuration': role.get('MaxSessionDuration', 3600),
                },
                dependencies=[],
                tags=tags
            )
            
        except ClientError as e:
            if e.response['Error']['Code'] == 'NoSuchEntity':
                return None
            raise

    def _create_role(self, resource: Resource) -> Resource:
        """Create a new IAM role.
        
        Args:
            resource: Resource definition
            
        Returns:
            Resource with physical_id set
        """
        role_name = resource.properties['RoleName']
        assume_role_policy = resource.properties['AssumeRolePolicyDocument']
        
        # Convert assume role policy to JSON string if it's a dict
        if isinstance(assume_role_policy, dict):
            assume_role_policy = json.dumps(assume_role_policy)
        
        # Create role
        create_params = {
            'RoleName': role_name,
            'AssumeRolePolicyDocument': assume_role_policy,
        }
        
        if 'Description' in resource.properties:
            create_params['Description'] = resource.properties['Description']
        
        if 'MaxSessionDuration' in resource.properties:
            create_params['MaxSessionDuration'] = resource.properties['MaxSessionDuration']
        
        if resource.tags:
            create_params['Tags'] = [
                {'Key': k, 'Value': v} for k, v in resource.tags.items()
            ]
        
        response = self.iam_client.create_role(**create_params)
        role_arn = response['Role']['Arn']
        
        # Attach inline policies
        inline_policies = resource.properties.get('InlinePolicies', {})
        for policy_name, policy_document in inline_policies.items():
            if isinstance(policy_document, dict):
                policy_document = json.dumps(policy_document)
            
            self.iam_client.put_role_policy(
                RoleName=role_name,
                PolicyName=policy_name,
                PolicyDocument=policy_document
            )
        
        # Attach managed policies
        managed_policy_arns = resource.properties.get('ManagedPolicyArns', [])
        for policy_arn in managed_policy_arns:
            self.iam_client.attach_role_policy(
                RoleName=role_name,
                PolicyArn=policy_arn
            )
        
        # Update resource with physical ID
        resource.physical_id = role_arn
        
        return resource

    def _update_role(self, resource: Resource) -> Resource:
        """Update an existing IAM role.
        
        Args:
            resource: Resource definition with updates
            
        Returns:
            Updated resource
        """
        role_name = resource.properties['RoleName']
        
        # Update assume role policy if changed
        assume_role_policy = resource.properties.get('AssumeRolePolicyDocument')
        if assume_role_policy:
            if isinstance(assume_role_policy, dict):
                assume_role_policy = json.dumps(assume_role_policy)
            
            self.iam_client.update_assume_role_policy(
                RoleName=role_name,
                PolicyDocument=assume_role_policy
            )
        
        # Update description if provided
        if 'Description' in resource.properties:
            self.iam_client.update_role_description(
                RoleName=role_name,
                Description=resource.properties['Description']
            )
        
        # Update max session duration if provided
        if 'MaxSessionDuration' in resource.properties:
            self.iam_client.update_role(
                RoleName=role_name,
                MaxSessionDuration=resource.properties['MaxSessionDuration']
            )
        
        # Update inline policies
        inline_policies = resource.properties.get('InlinePolicies', {})
        
        # Get current inline policies
        current_policies = self.iam_client.list_role_policies(RoleName=role_name)
        current_policy_names = set(current_policies.get('PolicyNames', []))
        desired_policy_names = set(inline_policies.keys())
        
        # Delete removed policies
        for policy_name in current_policy_names - desired_policy_names:
            self.iam_client.delete_role_policy(
                RoleName=role_name,
                PolicyName=policy_name
            )
        
        # Add or update policies
        for policy_name, policy_document in inline_policies.items():
            if isinstance(policy_document, dict):
                policy_document = json.dumps(policy_document)
            
            self.iam_client.put_role_policy(
                RoleName=role_name,
                PolicyName=policy_name,
                PolicyDocument=policy_document
            )
        
        # Update managed policies
        managed_policy_arns = set(resource.properties.get('ManagedPolicyArns', []))
        
        # Get current managed policies
        current_managed = self.iam_client.list_attached_role_policies(RoleName=role_name)
        current_managed_arns = {p['PolicyArn'] for p in current_managed.get('AttachedPolicies', [])}
        
        # Detach removed policies
        for policy_arn in current_managed_arns - managed_policy_arns:
            self.iam_client.detach_role_policy(
                RoleName=role_name,
                PolicyArn=policy_arn
            )
        
        # Attach new policies
        for policy_arn in managed_policy_arns - current_managed_arns:
            self.iam_client.attach_role_policy(
                RoleName=role_name,
                PolicyArn=policy_arn
            )
        
        # Update tags
        if resource.tags:
            # Get current tags
            current_tags_response = self.iam_client.list_role_tags(RoleName=role_name)
            current_tags = {tag['Key'] for tag in current_tags_response.get('Tags', [])}
            desired_tags = set(resource.tags.keys())
            
            # Remove old tags
            tags_to_remove = current_tags - desired_tags
            if tags_to_remove:
                self.iam_client.untag_role(
                    RoleName=role_name,
                    TagKeys=list(tags_to_remove)
                )
            
            # Add/update tags
            if resource.tags:
                self.iam_client.tag_role(
                    RoleName=role_name,
                    Tags=[{'Key': k, 'Value': v} for k, v in resource.tags.items()]
                )
        
        return resource

    def _needs_update(self, desired: Resource, current: Resource) -> bool:
        """Check if role needs updates.
        
        Args:
            desired: Desired state
            current: Current state
            
        Returns:
            True if updates are needed
        """
        # Compare assume role policy
        desired_policy = desired.properties.get('AssumeRolePolicyDocument')
        current_policy = current.properties.get('AssumeRolePolicyDocument')
        if desired_policy != current_policy:
            return True
        
        # Compare inline policies
        desired_inline = desired.properties.get('InlinePolicies', {})
        current_inline = current.properties.get('InlinePolicies', {})
        if desired_inline != current_inline:
            return True
        
        # Compare managed policies
        desired_managed = set(desired.properties.get('ManagedPolicyArns', []))
        current_managed = set(current.properties.get('ManagedPolicyArns', []))
        if desired_managed != current_managed:
            return True
        
        # Compare tags
        if desired.tags != current.tags:
            return True
        
        return False

    @staticmethod
    def build_lambda_assume_role_policy() -> Dict[str, Any]:
        """Build standard assume role policy for Lambda functions.
        
        Returns:
            Assume role policy document
        """
        return {
            "Version": "2012-10-17",
            "Statement": [
                {
                    "Effect": "Allow",
                    "Principal": {
                        "Service": "lambda.amazonaws.com"
                    },
                    "Action": "sts:AssumeRole"
                }
            ]
        }

    @staticmethod
    def build_policy_from_permissions(permissions: List[Dict[str, Any]]) -> Dict[str, Any]:
        """Build IAM policy document from permission specifications.
        
        Args:
            permissions: List of permission specifications with format:
                {
                    'actions': ['s3:GetObject', 's3:PutObject'],
                    'resources': ['arn:aws:s3:::bucket-name/*'],
                    'conditions': {...}  # Optional
                }
        
        Returns:
            IAM policy document
        """
        statements = []
        
        for perm in permissions:
            statement = {
                "Effect": "Allow",
                "Action": perm['actions'],
                "Resource": perm['resources']
            }
            
            if 'conditions' in perm:
                statement['Condition'] = perm['conditions']
            
            statements.append(statement)
        
        return {
            "Version": "2012-10-17",
            "Statement": statements
        }

    @staticmethod
    def build_shared_execution_role_policy(agent_permissions: List[Dict[str, Any]]) -> Dict[str, Any]:
        """Build optimized policy for shared execution role across multiple agents.
        
        This creates a single policy that grants all permissions needed by all agents,
        following the principle of least privilege while optimizing for resource sharing.
        
        Args:
            agent_permissions: List of permission sets for each agent
        
        Returns:
            Combined IAM policy document
        """
        # Start with basic Lambda execution permissions
        statements = [
            {
                "Effect": "Allow",
                "Action": [
                    "logs:CreateLogGroup",
                    "logs:CreateLogStream",
                    "logs:PutLogEvents"
                ],
                "Resource": "arn:aws:logs:*:*:*"
            }
        ]
        
        # Add VPC execution permissions if needed
        # (will be added conditionally based on VPC configuration)
        
        # Consolidate agent-specific permissions
        # Group by resource to avoid duplicate statements
        resource_actions = {}
        
        for perm_set in agent_permissions:
            for perm in perm_set:
                actions = perm.get('actions', [])
                resources = perm.get('resources', [])
                conditions = perm.get('conditions')
                
                # Create a key for grouping
                resource_key = tuple(sorted(resources))
                condition_key = json.dumps(conditions, sort_keys=True) if conditions else None
                key = (resource_key, condition_key)
                
                if key not in resource_actions:
                    resource_actions[key] = set()
                
                resource_actions[key].update(actions)
        
        # Build statements from consolidated permissions
        for (resources, conditions_json), actions in resource_actions.items():
            statement = {
                "Effect": "Allow",
                "Action": sorted(list(actions)),
                "Resource": list(resources)
            }
            
            if conditions_json:
                statement['Condition'] = json.loads(conditions_json)
            
            statements.append(statement)
        
        return {
            "Version": "2012-10-17",
            "Statement": statements
        }

    @staticmethod
    def add_vpc_execution_permissions(policy_document: Dict[str, Any]) -> Dict[str, Any]:
        """Add VPC execution permissions to a policy document.
        
        Args:
            policy_document: Existing policy document
        
        Returns:
            Policy document with VPC permissions added
        """
        vpc_statement = {
            "Effect": "Allow",
            "Action": [
                "ec2:CreateNetworkInterface",
                "ec2:DescribeNetworkInterfaces",
                "ec2:DeleteNetworkInterface",
                "ec2:AssignPrivateIpAddresses",
                "ec2:UnassignPrivateIpAddresses"
            ],
            "Resource": "*"
        }
        
        policy_document['Statement'].append(vpc_statement)
        return policy_document
