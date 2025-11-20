"""VPC provisioner with IPAM support and production-ready networking."""

import time
from typing import Optional, List, Dict, Any
from botocore.exceptions import ClientError

from .base import BaseProvisioner, Resource, ProvisionPlan, ChangeType


class VPCProvisioner(BaseProvisioner):
    """Provisioner for VPC with public/private subnets, NAT gateways, and VPC endpoints."""

    def __init__(self, boto_session):
        """Initialize VPC provisioner.
        
        Args:
            boto_session: Configured boto3 session
        """
        super().__init__(boto_session)
        self.ec2_client = boto_session.client('ec2')

    def plan(self, desired: Resource, current: Optional[Resource]) -> ProvisionPlan:
        """Determine what changes are needed for the VPC.
        
        Args:
            desired: Desired VPC state
            current: Current VPC state (None if doesn't exist)
            
        Returns:
            ProvisionPlan with change type
        """
        if current is None:
            return ProvisionPlan(
                resource=desired,
                change_type=ChangeType.CREATE,
                current_state=None
            )
        
        # VPCs typically don't support in-place updates for major changes
        # Most changes require recreation
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
        """Execute the VPC provisioning plan.
        
        Args:
            plan: Provisioning plan to execute
            
        Returns:
            Resource with physical_id set to VPC ID
        """
        if plan.change_type == ChangeType.CREATE:
            return self._create_vpc(plan.resource)
        elif plan.change_type == ChangeType.UPDATE:
            return self._update_vpc(plan.resource)
        else:
            return plan.resource

    def destroy(self, resource: Resource) -> None:
        """Destroy the VPC and all associated resources.
        
        Args:
            resource: VPC resource to destroy
        """
        vpc_id = resource.physical_id
        if not vpc_id:
            return
        
        try:
            # Delete NAT gateways first
            nat_gateway_ids = resource.properties.get('NatGatewayIds', [])
            for nat_id in nat_gateway_ids:
                try:
                    self.ec2_client.delete_nat_gateway(NatGatewayId=nat_id)
                except ClientError:
                    pass
            
            # Wait for NAT gateways to be deleted
            if nat_gateway_ids:
                time.sleep(30)  # NAT gateways take time to delete
            
            # Release Elastic IPs
            eip_allocation_ids = resource.properties.get('EipAllocationIds', [])
            for allocation_id in eip_allocation_ids:
                try:
                    self.ec2_client.release_address(AllocationId=allocation_id)
                except ClientError:
                    pass
            
            # Delete subnets
            subnet_ids = resource.properties.get('SubnetIds', [])
            for subnet_id in subnet_ids:
                try:
                    self.ec2_client.delete_subnet(SubnetId=subnet_id)
                except ClientError:
                    pass
            
            # Delete route tables (except main)
            route_table_ids = resource.properties.get('RouteTableIds', [])
            for rt_id in route_table_ids:
                try:
                    self.ec2_client.delete_route_table(RouteTableId=rt_id)
                except ClientError:
                    pass
            
            # Detach and delete internet gateway
            igw_id = resource.properties.get('InternetGatewayId')
            if igw_id:
                try:
                    self.ec2_client.detach_internet_gateway(
                        InternetGatewayId=igw_id,
                        VpcId=vpc_id
                    )
                    self.ec2_client.delete_internet_gateway(InternetGatewayId=igw_id)
                except ClientError:
                    pass
            
            # Delete VPC endpoints
            vpc_endpoint_ids = resource.properties.get('VpcEndpointIds', [])
            for endpoint_id in vpc_endpoint_ids:
                try:
                    self.ec2_client.delete_vpc_endpoints(VpcEndpointIds=[endpoint_id])
                except ClientError:
                    pass
            
            # Release IPAM allocation if applicable
            ipam_pool_id = resource.properties.get('IpamPoolId')
            cidr_block = resource.properties.get('CidrBlock')
            if ipam_pool_id and cidr_block:
                try:
                    self.ec2_client.release_ipam_pool_allocation(
                        IpamPoolId=ipam_pool_id,
                        Cidr=cidr_block
                    )
                except ClientError:
                    pass
            
            # Finally, delete the VPC
            self.ec2_client.delete_vpc(VpcId=vpc_id)
            
        except ClientError as e:
            if e.response['Error']['Code'] != 'InvalidVpcID.NotFound':
                raise

    def get_current_state(self, resource_id: str) -> Optional[Resource]:
        """Fetch current VPC state from AWS.
        
        Args:
            resource_id: Logical resource ID
            
        Returns:
            Current resource state or None if doesn't exist
        """
        # Try to find VPC by tag
        try:
            response = self.ec2_client.describe_vpcs(
                Filters=[
                    {'Name': 'tag:strands:resource-id', 'Values': [resource_id]}
                ]
            )
            
            if not response['Vpcs']:
                return None
            
            vpc = response['Vpcs'][0]
            vpc_id = vpc['VpcId']
            
            # Get tags
            tags = {tag['Key']: tag['Value'] for tag in vpc.get('Tags', [])}
            
            # Get subnets
            subnets_response = self.ec2_client.describe_subnets(
                Filters=[{'Name': 'vpc-id', 'Values': [vpc_id]}]
            )
            subnet_ids = [s['SubnetId'] for s in subnets_response['Subnets']]
            
            # Get internet gateway
            igw_response = self.ec2_client.describe_internet_gateways(
                Filters=[{'Name': 'attachment.vpc-id', 'Values': [vpc_id]}]
            )
            igw_id = igw_response['InternetGateways'][0]['InternetGatewayId'] if igw_response['InternetGateways'] else None
            
            # Get NAT gateways
            nat_response = self.ec2_client.describe_nat_gateways(
                Filters=[{'Name': 'vpc-id', 'Values': [vpc_id]}]
            )
            nat_gateway_ids = [n['NatGatewayId'] for n in nat_response['NatGateways'] if n['State'] != 'deleted']
            
            # Get route tables
            rt_response = self.ec2_client.describe_route_tables(
                Filters=[{'Name': 'vpc-id', 'Values': [vpc_id]}]
            )
            route_table_ids = [rt['RouteTableId'] for rt in rt_response['RouteTables']]
            
            # Get VPC endpoints
            endpoints_response = self.ec2_client.describe_vpc_endpoints(
                Filters=[{'Name': 'vpc-id', 'Values': [vpc_id]}]
            )
            vpc_endpoint_ids = [e['VpcEndpointId'] for e in endpoints_response['VpcEndpoints']]
            
            return Resource(
                id=resource_id,
                type='AWS::EC2::VPC',
                physical_id=vpc_id,
                properties={
                    'CidrBlock': vpc['CidrBlock'],
                    'SubnetIds': subnet_ids,
                    'InternetGatewayId': igw_id,
                    'NatGatewayIds': nat_gateway_ids,
                    'RouteTableIds': route_table_ids,
                    'VpcEndpointIds': vpc_endpoint_ids,
                },
                dependencies=[],
                tags=tags
            )
            
        except (ClientError, IndexError):
            return None

    def _create_vpc(self, resource: Resource) -> Resource:
        """Create a new VPC with complete networking setup.
        
        Args:
            resource: Resource definition
            
        Returns:
            Resource with physical_id and properties set
        """
        # Allocate CIDR from IPAM if configured
        cidr_block = self._allocate_cidr(resource)
        
        # Create VPC
        vpc_response = self.ec2_client.create_vpc(
            CidrBlock=cidr_block,
            TagSpecifications=[
                {
                    'ResourceType': 'vpc',
                    'Tags': [
                        {'Key': k, 'Value': v} for k, v in resource.tags.items()
                    ] + [
                        {'Key': 'strands:resource-id', 'Value': resource.id}
                    ]
                }
            ]
        )
        vpc_id = vpc_response['Vpc']['VpcId']
        
        # Enable DNS hostnames and DNS support
        self.ec2_client.modify_vpc_attribute(
            VpcId=vpc_id,
            EnableDnsHostnames={'Value': True}
        )
        self.ec2_client.modify_vpc_attribute(
            VpcId=vpc_id,
            EnableDnsSupport={'Value': True}
        )
        
        # Wait for VPC to be available
        waiter = self.ec2_client.get_waiter('vpc_available')
        waiter.wait(VpcIds=[vpc_id])
        
        # Create subnets
        subnet_config = resource.properties.get('Subnets', self._default_subnet_config(cidr_block))
        subnet_ids = self._create_subnets(vpc_id, subnet_config, resource.tags)
        
        # Create and attach internet gateway
        igw_id = self._create_internet_gateway(vpc_id, resource.tags)
        
        # Create NAT gateways for private subnets
        nat_gateway_ids, eip_allocation_ids = self._create_nat_gateways(
            vpc_id, subnet_ids, subnet_config, resource.tags
        )
        
        # Create route tables
        route_table_ids = self._create_route_tables(
            vpc_id, subnet_ids, subnet_config, igw_id, nat_gateway_ids, resource.tags
        )
        
        # Create VPC endpoints if configured
        vpc_endpoint_ids = self._create_vpc_endpoints(
            vpc_id, route_table_ids, resource.properties.get('VpcEndpoints', []), resource.tags
        )
        
        # Update resource with all created resources
        resource.physical_id = vpc_id
        resource.properties.update({
            'CidrBlock': cidr_block,
            'SubnetIds': subnet_ids,
            'InternetGatewayId': igw_id,
            'NatGatewayIds': nat_gateway_ids,
            'EipAllocationIds': eip_allocation_ids,
            'RouteTableIds': route_table_ids,
            'VpcEndpointIds': vpc_endpoint_ids,
        })
        
        # Store IPAM info if used
        ipam_config = resource.properties.get('Ipam', {})
        if ipam_config.get('enabled'):
            resource.properties['IpamPoolId'] = ipam_config['pool_id']
        
        return resource

    def _update_vpc(self, resource: Resource) -> Resource:
        """Update an existing VPC (limited updates supported).
        
        Args:
            resource: Resource definition with updates
            
        Returns:
            Updated resource
        """
        vpc_id = resource.physical_id
        
        # Update tags
        if resource.tags:
            self.ec2_client.create_tags(
                Resources=[vpc_id],
                Tags=[{'Key': k, 'Value': v} for k, v in resource.tags.items()]
            )
        
        # Note: Most VPC changes require recreation
        # This method handles minor updates like tags
        
        return resource

    def _needs_update(self, desired: Resource, current: Resource) -> bool:
        """Check if VPC needs updates.
        
        Args:
            desired: Desired state
            current: Current state
            
        Returns:
            True if updates are needed
        """
        # Compare tags
        if desired.tags != current.tags:
            return True
        
        return False

    def _allocate_cidr(self, resource: Resource) -> str:
        """Allocate CIDR block from IPAM or use specified CIDR.
        
        Args:
            resource: Resource definition
            
        Returns:
            CIDR block string
        """
        ipam_config = resource.properties.get('Ipam', {})
        
        if ipam_config.get('enabled'):
            # Allocate from IPAM pool
            pool_id = ipam_config['pool_id']
            netmask_length = ipam_config['netmask_length']
            
            response = self.ec2_client.allocate_ipam_pool_cidr(
                IpamPoolId=pool_id,
                NetmaskLength=netmask_length,
                Description=f"VPC for {resource.id}"
            )
            
            return response['IpamPoolAllocation']['Cidr']
        else:
            # Use specified CIDR
            return resource.properties.get('CidrBlock', '10.0.0.0/16')

    def _default_subnet_config(self, vpc_cidr: str) -> List[Dict[str, Any]]:
        """Generate default subnet configuration.
        
        Args:
            vpc_cidr: VPC CIDR block
            
        Returns:
            List of subnet configurations
        """
        # Parse VPC CIDR to calculate subnet CIDRs
        # For simplicity, create 2 public and 2 private subnets
        base_ip = vpc_cidr.split('/')[0]
        octets = base_ip.split('.')
        
        return [
            {
                'name': 'public-1',
                'cidr': f"{octets[0]}.{octets[1]}.0.0/24",
                'availability_zone': 'a',
                'type': 'public'
            },
            {
                'name': 'public-2',
                'cidr': f"{octets[0]}.{octets[1]}.1.0/24",
                'availability_zone': 'b',
                'type': 'public'
            },
            {
                'name': 'private-1',
                'cidr': f"{octets[0]}.{octets[1]}.10.0/24",
                'availability_zone': 'a',
                'type': 'private'
            },
            {
                'name': 'private-2',
                'cidr': f"{octets[0]}.{octets[1]}.11.0/24",
                'availability_zone': 'b',
                'type': 'private'
            },
        ]

    def _create_subnets(
        self, vpc_id: str, subnet_configs: List[Dict[str, Any]], tags: Dict[str, str]
    ) -> List[str]:
        """Create subnets in the VPC.
        
        Args:
            vpc_id: VPC ID
            subnet_configs: List of subnet configurations
            tags: Tags to apply
            
        Returns:
            List of subnet IDs
        """
        subnet_ids = []
        region = self.session.region_name
        
        for config in subnet_configs:
            az = f"{region}{config['availability_zone']}"
            
            response = self.ec2_client.create_subnet(
                VpcId=vpc_id,
                CidrBlock=config['cidr'],
                AvailabilityZone=az,
                TagSpecifications=[
                    {
                        'ResourceType': 'subnet',
                        'Tags': [
                            {'Key': k, 'Value': v} for k, v in tags.items()
                        ] + [
                            {'Key': 'Name', 'Value': config['name']},
                            {'Key': 'strands:subnet-type', 'Value': config['type']}
                        ]
                    }
                ]
            )
            
            subnet_id = response['Subnet']['SubnetId']
            subnet_ids.append(subnet_id)
            
            # Enable auto-assign public IP for public subnets
            if config['type'] == 'public':
                self.ec2_client.modify_subnet_attribute(
                    SubnetId=subnet_id,
                    MapPublicIpOnLaunch={'Value': True}
                )
        
        return subnet_ids

    def _create_internet_gateway(self, vpc_id: str, tags: Dict[str, str]) -> str:
        """Create and attach internet gateway.
        
        Args:
            vpc_id: VPC ID
            tags: Tags to apply
            
        Returns:
            Internet gateway ID
        """
        response = self.ec2_client.create_internet_gateway(
            TagSpecifications=[
                {
                    'ResourceType': 'internet-gateway',
                    'Tags': [{'Key': k, 'Value': v} for k, v in tags.items()]
                }
            ]
        )
        
        igw_id = response['InternetGateway']['InternetGatewayId']
        
        # Attach to VPC
        self.ec2_client.attach_internet_gateway(
            InternetGatewayId=igw_id,
            VpcId=vpc_id
        )
        
        return igw_id

    def _create_nat_gateways(
        self,
        vpc_id: str,
        subnet_ids: List[str],
        subnet_configs: List[Dict[str, Any]],
        tags: Dict[str, str]
    ) -> tuple[List[str], List[str]]:
        """Create NAT gateways in public subnets.
        
        Args:
            vpc_id: VPC ID
            subnet_ids: List of all subnet IDs
            subnet_configs: Subnet configurations
            tags: Tags to apply
            
        Returns:
            Tuple of (NAT gateway IDs, EIP allocation IDs)
        """
        nat_gateway_ids = []
        eip_allocation_ids = []
        
        # Create one NAT gateway per public subnet
        for i, config in enumerate(subnet_configs):
            if config['type'] == 'public':
                # Allocate Elastic IP
                eip_response = self.ec2_client.allocate_address(
                    Domain='vpc',
                    TagSpecifications=[
                        {
                            'ResourceType': 'elastic-ip',
                            'Tags': [
                                {'Key': k, 'Value': v} for k, v in tags.items()
                            ] + [
                                {'Key': 'Name', 'Value': f"nat-{config['name']}"}
                            ]
                        }
                    ]
                )
                
                allocation_id = eip_response['AllocationId']
                eip_allocation_ids.append(allocation_id)
                
                # Create NAT gateway
                nat_response = self.ec2_client.create_nat_gateway(
                    SubnetId=subnet_ids[i],
                    AllocationId=allocation_id,
                    TagSpecifications=[
                        {
                            'ResourceType': 'natgateway',
                            'Tags': [
                                {'Key': k, 'Value': v} for k, v in tags.items()
                            ] + [
                                {'Key': 'Name', 'Value': f"nat-{config['name']}"}
                            ]
                        }
                    ]
                )
                
                nat_gateway_ids.append(nat_response['NatGateway']['NatGatewayId'])
        
        # Wait for NAT gateways to be available
        if nat_gateway_ids:
            waiter = self.ec2_client.get_waiter('nat_gateway_available')
            waiter.wait(NatGatewayIds=nat_gateway_ids)
        
        return nat_gateway_ids, eip_allocation_ids

    def _create_route_tables(
        self,
        vpc_id: str,
        subnet_ids: List[str],
        subnet_configs: List[Dict[str, Any]],
        igw_id: str,
        nat_gateway_ids: List[str],
        tags: Dict[str, str]
    ) -> List[str]:
        """Create route tables and associate with subnets.
        
        Args:
            vpc_id: VPC ID
            subnet_ids: List of subnet IDs
            subnet_configs: Subnet configurations
            igw_id: Internet gateway ID
            nat_gateway_ids: NAT gateway IDs
            tags: Tags to apply
            
        Returns:
            List of route table IDs
        """
        route_table_ids = []
        nat_index = 0
        
        for i, config in enumerate(subnet_configs):
            # Create route table
            rt_response = self.ec2_client.create_route_table(
                VpcId=vpc_id,
                TagSpecifications=[
                    {
                        'ResourceType': 'route-table',
                        'Tags': [
                            {'Key': k, 'Value': v} for k, v in tags.items()
                        ] + [
                            {'Key': 'Name', 'Value': f"rt-{config['name']}"}
                        ]
                    }
                ]
            )
            
            rt_id = rt_response['RouteTable']['RouteTableId']
            route_table_ids.append(rt_id)
            
            # Add routes
            if config['type'] == 'public':
                # Route to internet gateway
                self.ec2_client.create_route(
                    RouteTableId=rt_id,
                    DestinationCidrBlock='0.0.0.0/0',
                    GatewayId=igw_id
                )
            else:
                # Route to NAT gateway
                if nat_index < len(nat_gateway_ids):
                    self.ec2_client.create_route(
                        RouteTableId=rt_id,
                        DestinationCidrBlock='0.0.0.0/0',
                        NatGatewayId=nat_gateway_ids[nat_index]
                    )
                    nat_index = (nat_index + 1) % len(nat_gateway_ids)
            
            # Associate with subnet
            self.ec2_client.associate_route_table(
                RouteTableId=rt_id,
                SubnetId=subnet_ids[i]
            )
        
        return route_table_ids

    def _create_vpc_endpoints(
        self,
        vpc_id: str,
        route_table_ids: List[str],
        endpoint_configs: List[str],
        tags: Dict[str, str]
    ) -> List[str]:
        """Create VPC endpoints for AWS services.
        
        Args:
            vpc_id: VPC ID
            route_table_ids: Route table IDs
            endpoint_configs: List of service names (e.g., ['s3', 'dynamodb'])
            tags: Tags to apply
            
        Returns:
            List of VPC endpoint IDs
        """
        endpoint_ids = []
        region = self.session.region_name
        
        for service_name in endpoint_configs:
            service_full_name = f"com.amazonaws.{region}.{service_name}"
            
            try:
                response = self.ec2_client.create_vpc_endpoint(
                    VpcId=vpc_id,
                    ServiceName=service_full_name,
                    RouteTableIds=route_table_ids,
                    TagSpecifications=[
                        {
                            'ResourceType': 'vpc-endpoint',
                            'Tags': [
                                {'Key': k, 'Value': v} for k, v in tags.items()
                            ] + [
                                {'Key': 'Name', 'Value': f"vpce-{service_name}"}
                            ]
                        }
                    ]
                )
                
                endpoint_ids.append(response['VpcEndpoint']['VpcEndpointId'])
            except ClientError:
                # Some services may not support VPC endpoints in all regions
                pass
        
        return endpoint_ids
