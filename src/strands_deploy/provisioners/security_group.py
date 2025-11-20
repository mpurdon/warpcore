"""Security group provisioner with optimization and consolidation."""

from typing import Optional, List, Dict, Any
from botocore.exceptions import ClientError

from .base import BaseProvisioner, Resource, ProvisionPlan, ChangeType


class SecurityGroupProvisioner(BaseProvisioner):
    """Provisioner for security groups with rule optimization."""

    def __init__(self, boto_session):
        """Initialize security group provisioner.
        
        Args:
            boto_session: Configured boto3 session
        """
        super().__init__(boto_session)
        self.ec2_client = boto_session.client('ec2')

    def plan(self, desired: Resource, current: Optional[Resource]) -> ProvisionPlan:
        """Determine what changes are needed for the security group.
        
        Args:
            desired: Desired security group state
            current: Current security group state (None if doesn't exist)
            
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
        """Execute the security group provisioning plan.
        
        Args:
            plan: Provisioning plan to execute
            
        Returns:
            Resource with physical_id set to security group ID
        """
        if plan.change_type == ChangeType.CREATE:
            return self._create_security_group(plan.resource)
        elif plan.change_type == ChangeType.UPDATE:
            return self._update_security_group(plan.resource)
        else:
            return plan.resource

    def destroy(self, resource: Resource) -> None:
        """Destroy the security group.
        
        Args:
            resource: Security group resource to destroy
        """
        sg_id = resource.physical_id
        if not sg_id:
            return
        
        try:
            self.ec2_client.delete_security_group(GroupId=sg_id)
        except ClientError as e:
            if e.response['Error']['Code'] != 'InvalidGroup.NotFound':
                raise

    def get_current_state(self, resource_id: str) -> Optional[Resource]:
        """Fetch current security group state from AWS.
        
        Args:
            resource_id: Logical resource ID
            
        Returns:
            Current resource state or None if doesn't exist
        """
        try:
            response = self.ec2_client.describe_security_groups(
                Filters=[
                    {'Name': 'tag:strands:resource-id', 'Values': [resource_id]}
                ]
            )
            
            if not response['SecurityGroups']:
                return None
            
            sg = response['SecurityGroups'][0]
            
            # Get tags
            tags = {tag['Key']: tag['Value'] for tag in sg.get('Tags', [])}
            
            return Resource(
                id=resource_id,
                type='AWS::EC2::SecurityGroup',
                physical_id=sg['GroupId'],
                properties={
                    'GroupName': sg['GroupName'],
                    'Description': sg['Description'],
                    'VpcId': sg.get('VpcId'),
                    'IngressRules': sg.get('IpPermissions', []),
                    'EgressRules': sg.get('IpPermissionsEgress', []),
                },
                dependencies=[],
                tags=tags
            )
            
        except (ClientError, IndexError):
            return None

    def _create_security_group(self, resource: Resource) -> Resource:
        """Create a new security group.
        
        Args:
            resource: Resource definition
            
        Returns:
            Resource with physical_id set
        """
        group_name = resource.properties['GroupName']
        description = resource.properties.get('Description', f'Security group for {resource.id}')
        vpc_id = resource.properties.get('VpcId')
        
        # Validate rules before creation
        ingress_rules = resource.properties.get('IngressRules', [])
        self._validate_rules(ingress_rules, 'ingress')
        
        # Create security group
        create_params = {
            'GroupName': group_name,
            'Description': description,
        }
        
        if vpc_id:
            create_params['VpcId'] = vpc_id
        
        if resource.tags:
            create_params['TagSpecifications'] = [
                {
                    'ResourceType': 'security-group',
                    'Tags': [
                        {'Key': k, 'Value': v} for k, v in resource.tags.items()
                    ] + [
                        {'Key': 'strands:resource-id', 'Value': resource.id}
                    ]
                }
            ]
        
        response = self.ec2_client.create_security_group(**create_params)
        sg_id = response['GroupId']
        
        # Add ingress rules
        if ingress_rules:
            self.ec2_client.authorize_security_group_ingress(
                GroupId=sg_id,
                IpPermissions=ingress_rules
            )
        
        # Add egress rules (if specified, otherwise AWS creates default allow all)
        egress_rules = resource.properties.get('EgressRules')
        if egress_rules is not None:
            # Remove default egress rule
            try:
                self.ec2_client.revoke_security_group_egress(
                    GroupId=sg_id,
                    IpPermissions=[
                        {
                            'IpProtocol': '-1',
                            'IpRanges': [{'CidrIp': '0.0.0.0/0'}]
                        }
                    ]
                )
            except ClientError:
                pass
            
            # Add custom egress rules
            if egress_rules:
                self.ec2_client.authorize_security_group_egress(
                    GroupId=sg_id,
                    IpPermissions=egress_rules
                )
        
        resource.physical_id = sg_id
        return resource

    def _update_security_group(self, resource: Resource) -> Resource:
        """Update an existing security group.
        
        Args:
            resource: Resource definition with updates
            
        Returns:
            Updated resource
        """
        sg_id = resource.physical_id
        
        # Get current rules
        current_sg = self.ec2_client.describe_security_groups(GroupIds=[sg_id])['SecurityGroups'][0]
        current_ingress = current_sg.get('IpPermissions', [])
        current_egress = current_sg.get('IpPermissionsEgress', [])
        
        # Update ingress rules
        desired_ingress = resource.properties.get('IngressRules', [])
        self._validate_rules(desired_ingress, 'ingress')
        self._update_rules(sg_id, current_ingress, desired_ingress, 'ingress')
        
        # Update egress rules
        desired_egress = resource.properties.get('EgressRules')
        if desired_egress is not None:
            self._update_rules(sg_id, current_egress, desired_egress, 'egress')
        
        # Update tags
        if resource.tags:
            self.ec2_client.create_tags(
                Resources=[sg_id],
                Tags=[{'Key': k, 'Value': v} for k, v in resource.tags.items()]
            )
        
        return resource

    def _update_rules(
        self,
        sg_id: str,
        current_rules: List[Dict[str, Any]],
        desired_rules: List[Dict[str, Any]],
        rule_type: str
    ) -> None:
        """Update security group rules.
        
        Args:
            sg_id: Security group ID
            current_rules: Current rules
            desired_rules: Desired rules
            rule_type: 'ingress' or 'egress'
        """
        # Normalize rules for comparison
        current_normalized = [self._normalize_rule(r) for r in current_rules]
        desired_normalized = [self._normalize_rule(r) for r in desired_rules]
        
        # Find rules to add and remove
        rules_to_add = [r for r in desired_rules if self._normalize_rule(r) not in current_normalized]
        rules_to_remove = [r for r in current_rules if self._normalize_rule(r) not in desired_normalized]
        
        # Remove old rules
        if rules_to_remove:
            if rule_type == 'ingress':
                self.ec2_client.revoke_security_group_ingress(
                    GroupId=sg_id,
                    IpPermissions=rules_to_remove
                )
            else:
                self.ec2_client.revoke_security_group_egress(
                    GroupId=sg_id,
                    IpPermissions=rules_to_remove
                )
        
        # Add new rules
        if rules_to_add:
            if rule_type == 'ingress':
                self.ec2_client.authorize_security_group_ingress(
                    GroupId=sg_id,
                    IpPermissions=rules_to_add
                )
            else:
                self.ec2_client.authorize_security_group_egress(
                    GroupId=sg_id,
                    IpPermissions=rules_to_add
                )

    def _needs_update(self, desired: Resource, current: Resource) -> bool:
        """Check if security group needs updates.
        
        Args:
            desired: Desired state
            current: Current state
            
        Returns:
            True if updates are needed
        """
        # Compare ingress rules
        desired_ingress = [self._normalize_rule(r) for r in desired.properties.get('IngressRules', [])]
        current_ingress = [self._normalize_rule(r) for r in current.properties.get('IngressRules', [])]
        if set(map(str, desired_ingress)) != set(map(str, current_ingress)):
            return True
        
        # Compare egress rules
        desired_egress = desired.properties.get('EgressRules')
        if desired_egress is not None:
            desired_egress_normalized = [self._normalize_rule(r) for r in desired_egress]
            current_egress_normalized = [self._normalize_rule(r) for r in current.properties.get('EgressRules', [])]
            if set(map(str, desired_egress_normalized)) != set(map(str, current_egress_normalized)):
                return True
        
        # Compare tags
        if desired.tags != current.tags:
            return True
        
        return False

    def _normalize_rule(self, rule: Dict[str, Any]) -> str:
        """Normalize a security group rule for comparison.
        
        Args:
            rule: Security group rule
            
        Returns:
            Normalized string representation
        """
        # Create a consistent string representation
        protocol = rule.get('IpProtocol', '-1')
        from_port = rule.get('FromPort', 0)
        to_port = rule.get('ToPort', 0)
        
        sources = []
        for ip_range in rule.get('IpRanges', []):
            sources.append(f"cidr:{ip_range.get('CidrIp', '')}")
        for ipv6_range in rule.get('Ipv6Ranges', []):
            sources.append(f"cidr6:{ipv6_range.get('CidrIpv6', '')}")
        for sg_ref in rule.get('UserIdGroupPairs', []):
            sources.append(f"sg:{sg_ref.get('GroupId', '')}")
        
        sources.sort()
        return f"{protocol}:{from_port}:{to_port}:{','.join(sources)}"

    def _validate_rules(self, rules: List[Dict[str, Any]], rule_type: str) -> None:
        """Validate security group rules for security best practices.
        
        Args:
            rules: List of security group rules
            rule_type: 'ingress' or 'egress'
            
        Raises:
            ValueError: If rules violate security best practices
        """
        sensitive_ports = {
            22: 'SSH',
            3389: 'RDP',
            3306: 'MySQL',
            5432: 'PostgreSQL',
            6379: 'Redis',
            27017: 'MongoDB',
        }
        
        for rule in rules:
            # Check for overly permissive rules
            ip_ranges = rule.get('IpRanges', [])
            for ip_range in ip_ranges:
                cidr = ip_range.get('CidrIp', '')
                
                if cidr == '0.0.0.0/0' and rule_type == 'ingress':
                    from_port = rule.get('FromPort')
                    to_port = rule.get('ToPort')
                    
                    # Allow 0.0.0.0/0 for HTTP/HTTPS
                    if from_port in [80, 443] and to_port in [80, 443]:
                        continue
                    
                    # Check for sensitive ports
                    if from_port in sensitive_ports or to_port in sensitive_ports:
                        port_name = sensitive_ports.get(from_port) or sensitive_ports.get(to_port)
                        raise ValueError(
                            f"Security group rule allows unrestricted access (0.0.0.0/0) "
                            f"to sensitive port {from_port}-{to_port} ({port_name}). "
                            f"This violates security best practices."
                        )

    @staticmethod
    def consolidate_security_groups(
        resources: List[Resource]
    ) -> Dict[str, List[Resource]]:
        """Consolidate resources with identical security requirements.
        
        This groups resources that have the same security group rules,
        allowing them to share a single security group.
        
        Args:
            resources: List of resources that need security groups
            
        Returns:
            Dictionary mapping security group signature to list of resources
        """
        groups = {}
        
        for resource in resources:
            # Create a signature based on security requirements
            ingress_rules = resource.properties.get('SecurityGroupIngressRules', [])
            egress_rules = resource.properties.get('SecurityGroupEgressRules', [])
            
            # Sort rules for consistent signature
            ingress_sig = str(sorted([str(r) for r in ingress_rules]))
            egress_sig = str(sorted([str(r) for r in egress_rules]))
            signature = f"{ingress_sig}|{egress_sig}"
            
            if signature not in groups:
                groups[signature] = []
            
            groups[signature].append(resource)
        
        return groups

    @staticmethod
    def build_rule_from_port(
        port: int,
        protocol: str = 'tcp',
        source_cidr: Optional[str] = None,
        source_sg_id: Optional[str] = None,
        description: Optional[str] = None
    ) -> Dict[str, Any]:
        """Build a security group rule for a specific port.
        
        Args:
            port: Port number
            protocol: Protocol (tcp, udp, icmp, or -1 for all)
            source_cidr: Source CIDR block (e.g., '0.0.0.0/0')
            source_sg_id: Source security group ID
            description: Rule description
            
        Returns:
            Security group rule dictionary
        """
        rule = {
            'IpProtocol': protocol,
            'FromPort': port,
            'ToPort': port,
        }
        
        if source_cidr:
            rule['IpRanges'] = [{'CidrIp': source_cidr}]
            if description:
                rule['IpRanges'][0]['Description'] = description
        
        if source_sg_id:
            rule['UserIdGroupPairs'] = [{'GroupId': source_sg_id}]
            if description:
                rule['UserIdGroupPairs'][0]['Description'] = description
        
        return rule

    @staticmethod
    def build_rule_from_port_range(
        from_port: int,
        to_port: int,
        protocol: str = 'tcp',
        source_cidr: Optional[str] = None,
        source_sg_id: Optional[str] = None,
        description: Optional[str] = None
    ) -> Dict[str, Any]:
        """Build a security group rule for a port range.
        
        Args:
            from_port: Starting port number
            to_port: Ending port number
            protocol: Protocol (tcp, udp, icmp, or -1 for all)
            source_cidr: Source CIDR block
            source_sg_id: Source security group ID
            description: Rule description
            
        Returns:
            Security group rule dictionary
        """
        rule = {
            'IpProtocol': protocol,
            'FromPort': from_port,
            'ToPort': to_port,
        }
        
        if source_cidr:
            rule['IpRanges'] = [{'CidrIp': source_cidr}]
            if description:
                rule['IpRanges'][0]['Description'] = description
        
        if source_sg_id:
            rule['UserIdGroupPairs'] = [{'GroupId': source_sg_id}]
            if description:
                rule['UserIdGroupPairs'][0]['Description'] = description
        
        return rule

    @staticmethod
    def build_https_rule(source_cidr: str = '0.0.0.0/0') -> Dict[str, Any]:
        """Build a standard HTTPS ingress rule.
        
        Args:
            source_cidr: Source CIDR block
            
        Returns:
            Security group rule for HTTPS
        """
        return SecurityGroupProvisioner.build_rule_from_port(
            port=443,
            protocol='tcp',
            source_cidr=source_cidr,
            description='HTTPS access'
        )

    @staticmethod
    def build_http_rule(source_cidr: str = '0.0.0.0/0') -> Dict[str, Any]:
        """Build a standard HTTP ingress rule.
        
        Args:
            source_cidr: Source CIDR block
            
        Returns:
            Security group rule for HTTP
        """
        return SecurityGroupProvisioner.build_rule_from_port(
            port=80,
            protocol='tcp',
            source_cidr=source_cidr,
            description='HTTP access'
        )

    @staticmethod
    def build_internal_rule(source_sg_id: str, port: int, protocol: str = 'tcp') -> Dict[str, Any]:
        """Build a rule for internal communication between resources.
        
        Args:
            source_sg_id: Source security group ID
            port: Port number
            protocol: Protocol
            
        Returns:
            Security group rule for internal communication
        """
        return SecurityGroupProvisioner.build_rule_from_port(
            port=port,
            protocol=protocol,
            source_sg_id=source_sg_id,
            description='Internal communication'
        )
