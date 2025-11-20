"""Deployment planner for creating deployment and destruction plans."""

from typing import Dict, List, Optional, Set
from dataclasses import dataclass, field
from enum import Enum
from datetime import datetime

from strands_deploy.state.models import Resource, State
from strands_deploy.orchestrator.dependency_graph import DependencyGraph
from strands_deploy.provisioners.base import ChangeType
from strands_deploy.utils.logging import get_logger

logger = get_logger(__name__)


@dataclass
class ResourceChange:
    """Represents a change to a resource."""
    
    resource_id: str
    change_type: ChangeType
    current_resource: Optional[Resource] = None
    desired_resource: Optional[Resource] = None
    reason: Optional[str] = None


@dataclass
class DeploymentWave:
    """Represents a wave of resources that can be deployed in parallel."""
    
    wave_number: int
    resource_ids: List[str]
    changes: Dict[str, ResourceChange] = field(default_factory=dict)
    
    def add_change(self, change: ResourceChange) -> None:
        """Add a resource change to this wave."""
        self.changes[change.resource_id] = change
    
    def get_change(self, resource_id: str) -> Optional[ResourceChange]:
        """Get a resource change from this wave."""
        return self.changes.get(resource_id)
    
    def size(self) -> int:
        """Get the number of resources in this wave."""
        return len(self.resource_ids)


@dataclass
class DeploymentPlan:
    """Complete deployment plan with waves and changes."""
    
    waves: List[DeploymentWave]
    all_changes: Dict[str, ResourceChange] = field(default_factory=dict)
    dependency_graph: Optional[DependencyGraph] = None
    estimated_duration: int = 0  # seconds
    created_at: datetime = field(default_factory=datetime.utcnow)
    
    def get_total_resources(self) -> int:
        """Get total number of resources in the plan."""
        return len(self.all_changes)
    
    def get_changes_by_type(self, change_type: ChangeType) -> List[ResourceChange]:
        """Get all changes of a specific type."""
        return [
            change for change in self.all_changes.values()
            if change.change_type == change_type
        ]
    
    def has_changes(self) -> bool:
        """Check if the plan has any changes."""
        return len(self.all_changes) > 0
    
    def get_summary(self) -> Dict[str, int]:
        """Get a summary of changes by type."""
        summary = {
            'create': 0,
            'update': 0,
            'delete': 0,
            'no_change': 0
        }
        
        for change in self.all_changes.values():
            if change.change_type == ChangeType.CREATE:
                summary['create'] += 1
            elif change.change_type == ChangeType.UPDATE:
                summary['update'] += 1
            elif change.change_type == ChangeType.DELETE:
                summary['delete'] += 1
            elif change.change_type == ChangeType.NO_CHANGE:
                summary['no_change'] += 1
        
        return summary


@dataclass
class DestructionPlan:
    """Plan for destroying resources in reverse dependency order."""
    
    resource_ids: List[str]  # In destruction order
    resources: Dict[str, Resource] = field(default_factory=dict)
    dependency_graph: Optional[DependencyGraph] = None
    estimated_duration: int = 0  # seconds
    created_at: datetime = field(default_factory=datetime.utcnow)
    
    def get_total_resources(self) -> int:
        """Get total number of resources to destroy."""
        return len(self.resource_ids)


class DeploymentPlanner:
    """Creates deployment and destruction plans."""
    
    def __init__(self):
        """Initialize deployment planner."""
        self.logger = get_logger(__name__)
    
    def create_deployment_plan(
        self,
        desired_resources: Dict[str, Resource],
        current_state: State,
        agent_filter: Optional[str] = None
    ) -> DeploymentPlan:
        """Create a deployment plan by comparing desired and current state.
        
        Args:
            desired_resources: Dictionary of desired resources (resource_id -> Resource)
            current_state: Current deployment state
            agent_filter: Optional agent name to filter resources
            
        Returns:
            DeploymentPlan with waves and changes
        """
        self.logger.info("Creating deployment plan...")
        
        # Detect changes
        changes = self._detect_changes(desired_resources, current_state, agent_filter)
        
        if not changes:
            self.logger.info("No changes detected")
            return DeploymentPlan(waves=[], all_changes={})
        
        # Build dependency graph with resources that have changes
        graph = self._build_dependency_graph(desired_resources, changes)
        
        # Create deployment waves
        waves = self._create_deployment_waves(graph, changes)
        
        # Estimate duration
        estimated_duration = self._estimate_duration(waves)
        
        plan = DeploymentPlan(
            waves=waves,
            all_changes=changes,
            dependency_graph=graph,
            estimated_duration=estimated_duration
        )
        
        summary = plan.get_summary()
        self.logger.info(
            f"Deployment plan created: {summary['create']} create, "
            f"{summary['update']} update, {summary['delete']} delete, "
            f"{len(waves)} waves, estimated {estimated_duration}s"
        )
        
        return plan
    
    def create_destruction_plan(
        self,
        current_state: State,
        agent_filter: Optional[str] = None
    ) -> DestructionPlan:
        """Create a destruction plan for all resources in current state.
        
        Args:
            current_state: Current deployment state
            agent_filter: Optional agent name to filter resources
            
        Returns:
            DestructionPlan with resources in destruction order
        """
        self.logger.info("Creating destruction plan...")
        
        # Get all resources from state
        all_resources = {}
        for stack_name, resource in current_state.all_resources():
            # Apply agent filter if specified
            if agent_filter:
                # Check if resource belongs to the filtered agent
                agent_tag = resource.tags.get('strands:agent')
                if agent_tag != agent_filter:
                    continue
            
            all_resources[resource.id] = resource
        
        if not all_resources:
            self.logger.info("No resources to destroy")
            return DestructionPlan(resource_ids=[], resources={})
        
        # Build dependency graph
        graph = DependencyGraph()
        for resource in all_resources.values():
            graph.add_resource(resource)
        
        # Validate graph
        graph.validate()
        
        # Get destruction order (reverse of deployment order)
        destruction_order = graph.get_destruction_order()
        
        # Estimate duration
        estimated_duration = len(destruction_order) * 5  # Rough estimate: 5s per resource
        
        plan = DestructionPlan(
            resource_ids=destruction_order,
            resources=all_resources,
            dependency_graph=graph,
            estimated_duration=estimated_duration
        )
        
        self.logger.info(
            f"Destruction plan created: {len(destruction_order)} resources, "
            f"estimated {estimated_duration}s"
        )
        
        return plan
    
    def _detect_changes(
        self,
        desired_resources: Dict[str, Resource],
        current_state: State,
        agent_filter: Optional[str] = None
    ) -> Dict[str, ResourceChange]:
        """Detect changes between desired and current state.
        
        Args:
            desired_resources: Desired resources
            current_state: Current state
            agent_filter: Optional agent filter
            
        Returns:
            Dictionary of resource changes (resource_id -> ResourceChange)
        """
        changes = {}
        
        # Get all current resources
        current_resources = {}
        for stack_name, resource in current_state.all_resources():
            current_resources[resource.id] = resource
        
        # Check for creates and updates
        for resource_id, desired_resource in desired_resources.items():
            # Apply agent filter if specified
            if agent_filter:
                agent_tag = desired_resource.tags.get('strands:agent')
                if agent_tag != agent_filter:
                    continue
            
            current_resource = current_resources.get(resource_id)
            
            if current_resource is None:
                # Resource doesn't exist - CREATE
                changes[resource_id] = ResourceChange(
                    resource_id=resource_id,
                    change_type=ChangeType.CREATE,
                    current_resource=None,
                    desired_resource=desired_resource,
                    reason="Resource does not exist"
                )
            elif self._has_changed(current_resource, desired_resource):
                # Resource exists but has changed - UPDATE
                changes[resource_id] = ResourceChange(
                    resource_id=resource_id,
                    change_type=ChangeType.UPDATE,
                    current_resource=current_resource,
                    desired_resource=desired_resource,
                    reason="Resource configuration has changed"
                )
            else:
                # Resource exists and hasn't changed - NO_CHANGE
                changes[resource_id] = ResourceChange(
                    resource_id=resource_id,
                    change_type=ChangeType.NO_CHANGE,
                    current_resource=current_resource,
                    desired_resource=desired_resource,
                    reason="No changes detected"
                )
        
        # Check for deletes (resources in current state but not in desired)
        for resource_id, current_resource in current_resources.items():
            if resource_id not in desired_resources:
                # Apply agent filter if specified
                if agent_filter:
                    agent_tag = current_resource.tags.get('strands:agent')
                    if agent_tag != agent_filter:
                        continue
                
                # Resource exists in current state but not in desired - DELETE
                changes[resource_id] = ResourceChange(
                    resource_id=resource_id,
                    change_type=ChangeType.DELETE,
                    current_resource=current_resource,
                    desired_resource=None,
                    reason="Resource no longer in configuration"
                )
        
        return changes
    
    def _has_changed(self, current: Resource, desired: Resource) -> bool:
        """Check if a resource has changed.
        
        Args:
            current: Current resource state
            desired: Desired resource state
            
        Returns:
            True if resource has changed, False otherwise
        """
        # Compare resource type
        if current.type != desired.type:
            return True
        
        # Compare properties (excluding metadata and timestamps)
        if current.properties != desired.properties:
            return True
        
        # Compare dependencies
        if set(current.dependencies) != set(desired.dependencies):
            return True
        
        # Compare tags (excluding auto-generated tags like deployed-at)
        current_tags = {k: v for k, v in current.tags.items() if k != 'strands:deployed-at'}
        desired_tags = {k: v for k, v in desired.tags.items() if k != 'strands:deployed-at'}
        if current_tags != desired_tags:
            return True
        
        return False
    
    def _build_dependency_graph(
        self,
        desired_resources: Dict[str, Resource],
        changes: Dict[str, ResourceChange]
    ) -> DependencyGraph:
        """Build dependency graph for resources with changes.
        
        Args:
            desired_resources: All desired resources
            changes: Detected changes
            
        Returns:
            DependencyGraph
        """
        graph = DependencyGraph()
        
        # Add all resources that need to be deployed (CREATE or UPDATE)
        for resource_id, change in changes.items():
            if change.change_type in (ChangeType.CREATE, ChangeType.UPDATE):
                resource = desired_resources[resource_id]
                graph.add_resource(resource)
        
        # Validate graph
        graph.validate()
        
        return graph
    
    def _create_deployment_waves(
        self,
        graph: DependencyGraph,
        changes: Dict[str, ResourceChange]
    ) -> List[DeploymentWave]:
        """Create deployment waves from dependency graph.
        
        Args:
            graph: Dependency graph
            changes: Resource changes
            
        Returns:
            List of deployment waves
        """
        if graph.is_empty():
            return []
        
        # Get waves from graph
        wave_resource_ids = graph.get_deployment_waves()
        
        # Create DeploymentWave objects
        waves = []
        for wave_number, resource_ids in enumerate(wave_resource_ids, start=1):
            wave = DeploymentWave(
                wave_number=wave_number,
                resource_ids=resource_ids
            )
            
            # Add changes to wave
            for resource_id in resource_ids:
                if resource_id in changes:
                    wave.add_change(changes[resource_id])
            
            waves.append(wave)
        
        return waves
    
    def _estimate_duration(self, waves: List[DeploymentWave]) -> int:
        """Estimate deployment duration in seconds.
        
        Args:
            waves: Deployment waves
            
        Returns:
            Estimated duration in seconds
        """
        # Rough estimates per resource type (in seconds)
        DURATION_ESTIMATES = {
            'AWS::IAM::Role': 5,
            'AWS::Lambda::Function': 15,
            'AWS::ApiGatewayV2::Api': 10,
            'AWS::EC2::VPC': 10,
            'AWS::EC2::Subnet': 5,
            'AWS::EC2::SecurityGroup': 5,
            'AWS::S3::Bucket': 5,
            'AWS::DynamoDB::Table': 10,
            'AWS::SQS::Queue': 5,
            'AWS::SNS::Topic': 5,
            'default': 10
        }
        
        total_duration = 0
        
        for wave in waves:
            # Resources in a wave are deployed in parallel, so take the max duration
            wave_duration = 0
            for change in wave.changes.values():
                if change.change_type in (ChangeType.CREATE, ChangeType.UPDATE):
                    resource = change.desired_resource
                    if resource:
                        resource_type = resource.type
                        duration = DURATION_ESTIMATES.get(resource_type, DURATION_ESTIMATES['default'])
                        wave_duration = max(wave_duration, duration)
            
            total_duration += wave_duration
        
        return total_duration
