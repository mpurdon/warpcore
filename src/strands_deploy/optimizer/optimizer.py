"""Resource optimizer for shared infrastructure and cost reduction."""

import json
from typing import Dict, List, Optional, Set, Tuple, Any
from collections import defaultdict

from ..state.models import Resource, State
from ..config.models import AgentConfig
from ..provisioners.iam import IAMRoleProvisioner
from ..provisioners.security_group import SecurityGroupProvisioner


class ResourceOptimizer:
    """Optimizer for AWS resource sharing and consolidation.
    
    This class implements resource optimization strategies including:
    - Shared IAM execution roles for all agents
    - Security group consolidation for resources with identical requirements
    - Duplicate resource detection and elimination
    - Resource sharing across monorepo agents
    """

    def __init__(self):
        """Initialize the resource optimizer."""
        pass

    def optimize_iam_roles(
        self,
        agents: List[AgentConfig],
        agent_permissions: Dict[str, List[Dict[str, Any]]],
        vpc_enabled: bool = False
    ) -> Resource:
        """Create a shared execution role for all agents.
        
        This creates a single IAM role that can be used by all Lambda functions,
        reducing the number of IAM roles and simplifying management while
        maintaining least-privilege access.
        
        Args:
            agents: List of agent configurations
            agent_permissions: Dictionary mapping agent names to their permission requirements
            vpc_enabled: Whether VPC execution permissions are needed
            
        Returns:
            Resource representing the shared IAM execution role
        """
        # Collect all permissions from all agents
        all_permissions = []
        for agent in agents:
            agent_perms = agent_permissions.get(agent.name, [])
            all_permissions.extend(agent_perms)
        
        # Build shared execution role policy
        policy_document = IAMRoleProvisioner.build_shared_execution_role_policy(
            [all_permissions]
        )
        
        # Add VPC execution permissions if needed
        if vpc_enabled:
            policy_document = IAMRoleProvisioner.add_vpc_execution_permissions(
                policy_document
            )
        
        # Create shared role resource
        role_name = "strands-shared-execution"
        assume_role_policy = IAMRoleProvisioner.build_lambda_assume_role_policy()
        
        resource = Resource(
            id="iam-role-shared-execution",
            type="AWS::IAM::Role",
            physical_id=None,  # Will be set during provisioning
            properties={
                "RoleName": role_name,
                "AssumeRolePolicyDocument": assume_role_policy,
                "InlinePolicies": {
                    "SharedExecutionPolicy": policy_document
                },
                "Description": f"Shared execution role for {len(agents)} Strands agents",
                "MaxSessionDuration": 3600,
            },
            dependencies=[],
            tags={
                "strands:resource-type": "shared-iam-role",
                "strands:agent-count": str(len(agents)),
            }
        )
        
        return resource

    def optimize_security_groups(
        self,
        resources: List[Resource],
        vpc_id: Optional[str] = None
    ) -> Dict[str, Resource]:
        """Consolidate security groups for resources with identical requirements.
        
        This groups resources by their security requirements and creates
        shared security groups, reducing the total number of security groups
        and simplifying management.
        
        Args:
            resources: List of resources that need security groups
            vpc_id: VPC ID for the security groups
            
        Returns:
            Dictionary mapping security group signature to consolidated security group resource
        """
        # Group resources by security requirements
        groups = SecurityGroupProvisioner.consolidate_security_groups(resources)
        
        # Create consolidated security groups
        consolidated_sgs = {}
        
        for idx, (signature, grouped_resources) in enumerate(groups.items()):
            if not grouped_resources:
                continue
            
            # Use the first resource as template
            template = grouped_resources[0]
            ingress_rules = template.properties.get('SecurityGroupIngressRules', [])
            egress_rules = template.properties.get('SecurityGroupEgressRules', [])
            
            # Create a descriptive name based on the resources using this SG
            resource_types = set(r.type for r in grouped_resources)
            sg_name = f"strands-shared-sg-{idx}"
            
            # Build description
            description = f"Shared security group for {len(grouped_resources)} resources"
            if len(resource_types) == 1:
                resource_type = list(resource_types)[0].split("::")[-1]
                description = f"Shared security group for {resource_type} resources"
            
            # Create consolidated security group resource
            sg_resource = Resource(
                id=f"security-group-shared-{idx}",
                type="AWS::EC2::SecurityGroup",
                physical_id=None,  # Will be set during provisioning
                properties={
                    "GroupName": sg_name,
                    "Description": description,
                    "VpcId": vpc_id,
                    "IngressRules": ingress_rules,
                    "EgressRules": egress_rules,
                },
                dependencies=[],
                tags={
                    "strands:resource-type": "shared-security-group",
                    "strands:resource-count": str(len(grouped_resources)),
                }
            )
            
            consolidated_sgs[signature] = sg_resource
        
        return consolidated_sgs

    def detect_duplicates(self, state: State) -> List[Dict[str, Any]]:
        """Detect duplicate resources that can be consolidated.
        
        This analyzes the current state to find resources that are functionally
        identical and could be consolidated to reduce costs and complexity.
        
        Args:
            state: Current deployment state
            
        Returns:
            List of duplicate resource groups with consolidation recommendations
        """
        duplicates = []
        
        # Group resources by type
        resources_by_type: Dict[str, List[Tuple[str, Resource]]] = defaultdict(list)
        for stack_name, resource in state.all_resources():
            resources_by_type[resource.type].append((stack_name, resource))
        
        # Check each resource type for duplicates
        for resource_type, resources in resources_by_type.items():
            if len(resources) < 2:
                continue
            
            # Find duplicates based on resource type
            if resource_type == "AWS::IAM::Role":
                dups = self._find_duplicate_iam_roles(resources)
                duplicates.extend(dups)
            elif resource_type == "AWS::EC2::SecurityGroup":
                dups = self._find_duplicate_security_groups(resources)
                duplicates.extend(dups)
            elif resource_type == "AWS::EC2::VPC":
                dups = self._find_duplicate_vpcs(resources)
                duplicates.extend(dups)
        
        return duplicates

    def _find_duplicate_iam_roles(
        self,
        resources: List[Tuple[str, Resource]]
    ) -> List[Dict[str, Any]]:
        """Find duplicate IAM roles with similar policies.
        
        Args:
            resources: List of (stack_name, resource) tuples
            
        Returns:
            List of duplicate groups
        """
        duplicates = []
        
        # Group by policy similarity
        policy_groups: Dict[str, List[Tuple[str, Resource]]] = defaultdict(list)
        
        for stack_name, resource in resources:
            # Create a signature based on inline policies
            inline_policies = resource.properties.get('InlinePolicies', {})
            managed_policies = resource.properties.get('ManagedPolicyArns', [])
            
            # Normalize for comparison
            policy_sig = json.dumps({
                'inline': sorted([json.dumps(p, sort_keys=True) for p in inline_policies.values()]),
                'managed': sorted(managed_policies)
            }, sort_keys=True)
            
            policy_groups[policy_sig].append((stack_name, resource))
        
        # Find groups with multiple resources
        for policy_sig, group in policy_groups.items():
            if len(group) > 1:
                duplicates.append({
                    'type': 'IAM Role',
                    'count': len(group),
                    'resources': [
                        {
                            'stack': stack_name,
                            'id': resource.id,
                            'name': resource.properties.get('RoleName'),
                            'physical_id': resource.physical_id
                        }
                        for stack_name, resource in group
                    ],
                    'recommendation': 'Consider consolidating these IAM roles into a single shared execution role',
                    'potential_savings': 'Reduces IAM role count and simplifies permission management'
                })
        
        return duplicates

    def _find_duplicate_security_groups(
        self,
        resources: List[Tuple[str, Resource]]
    ) -> List[Dict[str, Any]]:
        """Find duplicate security groups with identical rules.
        
        Args:
            resources: List of (stack_name, resource) tuples
            
        Returns:
            List of duplicate groups
        """
        duplicates = []
        
        # Group by rules
        rule_groups: Dict[str, List[Tuple[str, Resource]]] = defaultdict(list)
        
        for stack_name, resource in resources:
            ingress_rules = resource.properties.get('IngressRules', [])
            egress_rules = resource.properties.get('EgressRules', [])
            
            # Create signature
            rule_sig = json.dumps({
                'ingress': sorted([str(r) for r in ingress_rules]),
                'egress': sorted([str(r) for r in egress_rules])
            }, sort_keys=True)
            
            rule_groups[rule_sig].append((stack_name, resource))
        
        # Find groups with multiple resources
        for rule_sig, group in rule_groups.items():
            if len(group) > 1:
                duplicates.append({
                    'type': 'Security Group',
                    'count': len(group),
                    'resources': [
                        {
                            'stack': stack_name,
                            'id': resource.id,
                            'name': resource.properties.get('GroupName'),
                            'physical_id': resource.physical_id
                        }
                        for stack_name, resource in group
                    ],
                    'recommendation': 'Consolidate these security groups into a single shared security group',
                    'potential_savings': 'Reduces security group count and simplifies network management'
                })
        
        return duplicates

    def _find_duplicate_vpcs(
        self,
        resources: List[Tuple[str, Resource]]
    ) -> List[Dict[str, Any]]:
        """Find duplicate VPCs that could be shared.
        
        Args:
            resources: List of (stack_name, resource) tuples
            
        Returns:
            List of duplicate groups
        """
        duplicates = []
        
        # If there are multiple VPCs, they could potentially be consolidated
        if len(resources) > 1:
            duplicates.append({
                'type': 'VPC',
                'count': len(resources),
                'resources': [
                    {
                        'stack': stack_name,
                        'id': resource.id,
                        'cidr': resource.properties.get('CidrBlock'),
                        'physical_id': resource.physical_id
                    }
                    for stack_name, resource in resources
                ],
                'recommendation': 'Consider using a single shared VPC for all agents to reduce costs',
                'potential_savings': 'Significant cost reduction by sharing NAT gateways and VPC endpoints'
            })
        
        return duplicates

    def calculate_optimization_savings(
        self,
        duplicates: List[Dict[str, Any]]
    ) -> Dict[str, Any]:
        """Calculate potential cost savings from optimization.
        
        Args:
            duplicates: List of duplicate resource groups
            
        Returns:
            Dictionary with savings estimates
        """
        savings = {
            'iam_roles': 0,
            'security_groups': 0,
            'vpcs': 0,
            'total_resources_eliminated': 0,
            'estimated_monthly_savings': 0.0
        }
        
        for dup_group in duplicates:
            resource_type = dup_group['type']
            count = dup_group['count']
            
            # Resources that can be eliminated (keep 1, eliminate the rest)
            eliminated = count - 1
            savings['total_resources_eliminated'] += eliminated
            
            if resource_type == 'IAM Role':
                savings['iam_roles'] += eliminated
                # IAM roles are free, but simplification has operational value
            elif resource_type == 'Security Group':
                savings['security_groups'] += eliminated
                # Security groups are free, but simplification has operational value
            elif resource_type == 'VPC':
                savings['vpcs'] += eliminated
                # VPC consolidation saves on NAT gateway costs (~$32/month per NAT gateway)
                # Assume 1 NAT gateway per VPC
                savings['estimated_monthly_savings'] += eliminated * 32.0
        
        return savings

    def identify_shared_infrastructure(
        self,
        agents: List[AgentConfig],
        state: State
    ) -> Dict[str, List[str]]:
        """Identify infrastructure that can be shared across agents in a monorepo.
        
        This analyzes the deployment to find resources that can be shared
        across multiple agents, such as VPCs, security groups, and IAM roles.
        
        Args:
            agents: List of agent configurations
            state: Current deployment state
            
        Returns:
            Dictionary mapping resource types to lists of shareable resource IDs
        """
        shareable = {
            'vpc': [],
            'security_groups': [],
            'iam_roles': [],
            'vpc_endpoints': [],
            'nat_gateways': []
        }
        
        # Find VPCs that can be shared
        for _, resource in state.all_resources():
            if resource.type == 'AWS::EC2::VPC':
                shareable['vpc'].append(resource.id)
            elif resource.type == 'AWS::EC2::SecurityGroup':
                # Security groups can be shared if they're not agent-specific
                if not resource.tags.get('strands:agent'):
                    shareable['security_groups'].append(resource.id)
            elif resource.type == 'AWS::IAM::Role':
                # Shared execution roles can be reused
                if 'shared' in resource.properties.get('RoleName', '').lower():
                    shareable['iam_roles'].append(resource.id)
            elif resource.type == 'AWS::EC2::VPCEndpoint':
                shareable['vpc_endpoints'].append(resource.id)
            elif resource.type == 'AWS::EC2::NatGateway':
                shareable['nat_gateways'].append(resource.id)
        
        return shareable

    def plan_resource_sharing(
        self,
        agents: List[AgentConfig],
        existing_state: Optional[State] = None
    ) -> Dict[str, Any]:
        """Plan resource sharing strategy for monorepo deployment.
        
        This creates a plan for which resources should be shared across agents
        and which should be agent-specific.
        
        Args:
            agents: List of agent configurations
            existing_state: Existing deployment state (if any)
            
        Returns:
            Resource sharing plan
        """
        plan = {
            'shared_resources': [],
            'agent_specific_resources': [],
            'reusable_resources': [],
            'optimization_opportunities': []
        }
        
        # Plan shared IAM role
        plan['shared_resources'].append({
            'type': 'IAM Role',
            'resource_id': 'iam-role-shared-execution',
            'name': 'strands-shared-execution',
            'used_by': [agent.name for agent in agents],
            'rationale': 'Single execution role for all Lambda functions reduces IAM complexity'
        })
        
        # Plan shared VPC (if needed)
        vpc_agents = [a for a in agents if a.tags.get('vpc-enabled') == 'true']
        if len(vpc_agents) > 0:
            plan['shared_resources'].append({
                'type': 'VPC',
                'resource_id': 'vpc-shared',
                'name': 'strands-shared-vpc',
                'used_by': [agent.name for agent in vpc_agents],
                'rationale': 'Shared VPC reduces costs by sharing NAT gateways and VPC endpoints'
            })
        
        # Check for reusable resources in existing state
        if existing_state:
            shareable = self.identify_shared_infrastructure(agents, existing_state)
            
            for resource_type, resource_ids in shareable.items():
                if resource_ids:
                    plan['reusable_resources'].append({
                        'type': resource_type,
                        'count': len(resource_ids),
                        'resource_ids': resource_ids,
                        'action': 'Reuse existing resources instead of creating new ones'
                    })
        
        # Identify agent-specific resources
        for agent in agents:
            plan['agent_specific_resources'].append({
                'agent': agent.name,
                'resources': [
                    'Lambda Function',
                    'CloudWatch Log Group',
                    'API Gateway Route (if applicable)'
                ]
            })
        
        # Add optimization opportunities
        if len(agents) > 3:
            plan['optimization_opportunities'].append({
                'priority': 'high',
                'title': 'High agent count detected',
                'description': f'With {len(agents)} agents, resource sharing becomes critical',
                'recommendation': 'Ensure all agents use shared IAM role and VPC to maximize savings'
            })
        
        return plan

    def apply_resource_sharing(
        self,
        resources: List[Resource],
        sharing_plan: Dict[str, Any]
    ) -> List[Resource]:
        """Apply resource sharing plan to a list of resources.
        
        This modifies resources to reference shared infrastructure instead
        of creating duplicate resources.
        
        Args:
            resources: List of resources to optimize
            sharing_plan: Resource sharing plan from plan_resource_sharing()
            
        Returns:
            Optimized list of resources with sharing applied
        """
        optimized = []
        shared_resource_map = {}
        
        # Build map of shared resources
        for shared_res in sharing_plan.get('shared_resources', []):
            resource_id = shared_res['resource_id']
            shared_resource_map[shared_res['type']] = resource_id
        
        # Process each resource
        for resource in resources:
            # Check if this resource type should be shared
            if resource.type == 'AWS::IAM::Role':
                # Check if this is an execution role that should be shared
                role_name = resource.properties.get('RoleName', '')
                if 'execution' in role_name.lower() or 'lambda' in role_name.lower():
                    # Skip this resource, use shared role instead
                    shared_role_id = shared_resource_map.get('IAM Role')
                    if shared_role_id:
                        # Update dependent resources to use shared role
                        for dep_resource in resources:
                            if resource.id in dep_resource.dependencies:
                                # Replace dependency with shared role
                                dep_resource.dependencies.remove(resource.id)
                                if shared_role_id not in dep_resource.dependencies:
                                    dep_resource.dependencies.append(shared_role_id)
                        continue
            
            elif resource.type == 'AWS::EC2::VPC':
                # Check if VPC should be shared
                shared_vpc_id = shared_resource_map.get('VPC')
                if shared_vpc_id and resource.id != shared_vpc_id:
                    # Skip duplicate VPC
                    continue
            
            # Keep this resource
            optimized.append(resource)
        
        return optimized

    def get_shared_resource_dependencies(
        self,
        agent_name: str,
        shared_resources: List[Resource]
    ) -> List[str]:
        """Get list of shared resource IDs that an agent depends on.
        
        Args:
            agent_name: Name of the agent
            shared_resources: List of shared resources
            
        Returns:
            List of resource IDs the agent should depend on
        """
        dependencies = []
        
        for resource in shared_resources:
            # Check if this shared resource is used by this agent
            used_by = resource.tags.get('strands:used-by', '').split(',')
            if agent_name in used_by or not resource.tags.get('strands:used-by'):
                # This is a globally shared resource or explicitly used by this agent
                dependencies.append(resource.id)
        
        return dependencies

    def generate_optimization_report(
        self,
        state: State,
        agents: List[AgentConfig]
    ) -> Dict[str, Any]:
        """Generate a comprehensive optimization report.
        
        Args:
            state: Current deployment state
            agents: List of agent configurations
            
        Returns:
            Optimization report with recommendations
        """
        # Detect duplicates
        duplicates = self.detect_duplicates(state)
        
        # Calculate savings
        savings = self.calculate_optimization_savings(duplicates)
        
        # Identify shared infrastructure
        shareable = self.identify_shared_infrastructure(agents, state)
        
        # Count current resources
        all_resources = state.all_resources()
        resource_counts = defaultdict(int)
        for _, resource in all_resources:
            resource_counts[resource.type] += 1
        
        # Generate recommendations
        recommendations = []
        
        # Check for IAM role optimization opportunity
        iam_role_count = resource_counts.get('AWS::IAM::Role', 0)
        if iam_role_count > 1:
            recommendations.append({
                'priority': 'high',
                'category': 'IAM Optimization',
                'title': 'Consolidate IAM execution roles',
                'description': f'You have {iam_role_count} IAM roles. Consider using a single shared execution role for all agents.',
                'impact': 'Simplifies permission management and reduces IAM complexity',
                'action': 'Use ResourceOptimizer.optimize_iam_roles() to create a shared role'
            })
        
        # Check for security group optimization
        sg_count = resource_counts.get('AWS::EC2::SecurityGroup', 0)
        if sg_count > len(agents):
            recommendations.append({
                'priority': 'medium',
                'category': 'Network Optimization',
                'title': 'Consolidate security groups',
                'description': f'You have {sg_count} security groups for {len(agents)} agents. Some may have identical rules.',
                'impact': 'Simplifies network management and reduces security group count',
                'action': 'Use ResourceOptimizer.optimize_security_groups() to consolidate'
            })
        
        # Check for VPC optimization
        vpc_count = resource_counts.get('AWS::EC2::VPC', 0)
        if vpc_count > 1:
            recommendations.append({
                'priority': 'high',
                'category': 'Cost Optimization',
                'title': 'Use a single shared VPC',
                'description': f'You have {vpc_count} VPCs. Using a single VPC can significantly reduce costs.',
                'impact': f'Estimated savings: ${vpc_count - 1} * $32/month = ${(vpc_count - 1) * 32}/month',
                'action': 'Configure a single shared VPC in your strands.yaml'
            })
        
        # Check for monorepo optimization opportunities
        if len(agents) > 1:
            shared_count = sum(len(ids) for ids in shareable.values())
            recommendations.append({
                'priority': 'medium',
                'category': 'Monorepo Optimization',
                'title': 'Maximize resource sharing across agents',
                'description': f'You have {len(agents)} agents with {shared_count} shareable resources.',
                'impact': 'Reduces costs and complexity by sharing infrastructure',
                'action': 'Use ResourceOptimizer.plan_resource_sharing() to create a sharing strategy'
            })
        
        return {
            'summary': {
                'total_resources': len(all_resources),
                'total_agents': len(agents),
                'duplicate_groups': len(duplicates),
                'resources_that_can_be_eliminated': savings['total_resources_eliminated'],
                'estimated_monthly_savings': savings['estimated_monthly_savings'],
                'shareable_resources': sum(len(ids) for ids in shareable.values())
            },
            'resource_counts': dict(resource_counts),
            'duplicates': duplicates,
            'savings': savings,
            'shareable_infrastructure': shareable,
            'recommendations': recommendations
        }
