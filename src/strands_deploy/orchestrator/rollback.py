"""Rollback capability for failed deployments."""

from typing import Dict, List, Optional, Set
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum

from strands_deploy.state.models import Resource, State
from strands_deploy.orchestrator.executor import (
    DeploymentExecutor,
    DeploymentResult,
    ExecutionStatus,
    ResourceExecutionResult,
    ProgressCallback
)
from strands_deploy.orchestrator.planner import DeploymentPlanner, DestructionPlan
from strands_deploy.utils.logging import get_logger

logger = get_logger(__name__)


class RollbackStrategy(Enum):
    """Strategy for rollback."""
    AUTOMATIC = "automatic"  # Automatically rollback on failure
    MANUAL = "manual"  # Require manual rollback command
    NONE = "none"  # No rollback


@dataclass
class RollbackPlan:
    """Plan for rolling back a failed deployment."""
    
    resources_to_destroy: List[str]  # Resources created in failed deployment
    resources_to_restore: Dict[str, Resource]  # Resources to restore to previous state
    destruction_plan: Optional[DestructionPlan] = None
    created_at: datetime = field(default_factory=datetime.utcnow)
    
    def get_total_operations(self) -> int:
        """Get total number of rollback operations."""
        return len(self.resources_to_destroy) + len(self.resources_to_restore)


@dataclass
class RollbackResult:
    """Result of rollback execution."""
    
    status: ExecutionStatus
    destroyed_resources: List[str] = field(default_factory=list)
    restored_resources: List[str] = field(default_factory=list)
    failed_operations: Dict[str, str] = field(default_factory=dict)  # resource_id -> error
    start_time: Optional[datetime] = None
    end_time: Optional[datetime] = None
    duration: float = 0.0  # seconds
    
    def is_success(self) -> bool:
        """Check if rollback was successful."""
        return self.status == ExecutionStatus.SUCCESS
    
    def is_failed(self) -> bool:
        """Check if rollback failed."""
        return self.status == ExecutionStatus.FAILED


class RollbackManager:
    """Manages rollback operations for failed deployments."""
    
    def __init__(
        self,
        executor: DeploymentExecutor,
        planner: DeploymentPlanner
    ):
        """Initialize rollback manager.
        
        Args:
            executor: Deployment executor for executing rollback
            planner: Deployment planner for creating rollback plans
        """
        self.executor = executor
        self.planner = planner
        self.logger = get_logger(__name__)
    
    def create_rollback_plan(
        self,
        deployment_result: DeploymentResult,
        state_before: State,
        agent_filter: Optional[str] = None
    ) -> RollbackPlan:
        """Create a rollback plan from a failed deployment.
        
        Args:
            deployment_result: Result of the failed deployment
            state_before: State before the deployment started
            agent_filter: Optional agent filter for partial rollback
            
        Returns:
            RollbackPlan describing what needs to be rolled back
        """
        self.logger.info("Creating rollback plan...")
        
        resources_to_destroy = []
        resources_to_restore = {}
        
        # Collect all resources that were successfully created/updated
        for wave_result in deployment_result.wave_results:
            for resource_id, result in wave_result.resource_results.items():
                if result.is_success() and result.resource:
                    # Apply agent filter if specified
                    if agent_filter:
                        agent_tag = result.resource.tags.get('strands:agent')
                        if agent_tag != agent_filter:
                            continue
                    
                    # Check if this was a new resource (CREATE)
                    old_resource = state_before.get_resource(resource_id)
                    if old_resource is None:
                        # New resource - needs to be destroyed
                        resources_to_destroy.append(resource_id)
                    else:
                        # Updated resource - needs to be restored to previous state
                        resources_to_restore[resource_id] = old_resource
        
        # Create destruction plan for new resources
        destruction_plan = None
        if resources_to_destroy:
            # Get current state to build destruction plan
            current_state = self.executor.state_manager.load()
            
            # Filter state to only include resources to destroy
            filtered_state = State(
                version=current_state.version,
                environment=current_state.environment,
                region=current_state.region,
                account=current_state.account,
                project_name=current_state.project_name
            )
            
            for resource_id in resources_to_destroy:
                result = current_state.get_resource_with_stack(resource_id)
                if result:
                    stack_name, resource = result
                    filtered_state.add_resource(stack_name, resource)
            
            destruction_plan = self.planner.create_destruction_plan(
                current_state=filtered_state,
                agent_filter=agent_filter
            )
        
        plan = RollbackPlan(
            resources_to_destroy=resources_to_destroy,
            resources_to_restore=resources_to_restore,
            destruction_plan=destruction_plan
        )
        
        self.logger.info(
            f"Rollback plan created: {len(resources_to_destroy)} to destroy, "
            f"{len(resources_to_restore)} to restore"
        )
        
        return plan
    
    def execute_rollback(
        self,
        plan: RollbackPlan,
        progress_callback: Optional[ProgressCallback] = None
    ) -> RollbackResult:
        """Execute a rollback plan.
        
        Args:
            plan: Rollback plan to execute
            progress_callback: Optional progress callback
            
        Returns:
            RollbackResult with execution details
        """
        self.logger.info("Starting rollback execution...")
        
        start_time = datetime.utcnow()
        destroyed_resources = []
        restored_resources = []
        failed_operations = {}
        
        try:
            # Step 1: Destroy newly created resources
            if plan.destruction_plan:
                self.logger.info(
                    f"Destroying {len(plan.resources_to_destroy)} newly created resources..."
                )
                
                destruction_result = self.executor.execute_destruction(
                    plan=plan.destruction_plan,
                    progress_callback=progress_callback
                )
                
                # Track results
                for resource_id, result in destruction_result.resource_results.items():
                    if result.is_success():
                        destroyed_resources.append(resource_id)
                    else:
                        failed_operations[resource_id] = str(result.error)
            
            # Step 2: Restore updated resources to previous state
            if plan.resources_to_restore:
                self.logger.info(
                    f"Restoring {len(plan.resources_to_restore)} updated resources..."
                )
                
                for resource_id, old_resource in plan.resources_to_restore.items():
                    try:
                        if progress_callback:
                            progress_callback(resource_id, ExecutionStatus.IN_PROGRESS, None)
                        
                        # Get provisioner for resource type
                        provisioner = self.executor.provisioners.get(old_resource.type)
                        if not provisioner:
                            raise Exception(f"No provisioner for type: {old_resource.type}")
                        
                        # Convert to provisioner Resource format
                        from strands_deploy.provisioners.base import Resource as ProvisionerResource
                        prov_resource = ProvisionerResource(
                            id=old_resource.id,
                            type=old_resource.type,
                            physical_id=old_resource.physical_id,
                            properties=old_resource.properties,
                            dependencies=old_resource.dependencies,
                            tags=old_resource.tags
                        )
                        
                        # Create plan and provision
                        current_state = self.executor.state_manager.load()
                        current_resource = current_state.get_resource(resource_id)
                        
                        current_prov_resource = None
                        if current_resource:
                            current_prov_resource = ProvisionerResource(
                                id=current_resource.id,
                                type=current_resource.type,
                                physical_id=current_resource.physical_id,
                                properties=current_resource.properties,
                                dependencies=current_resource.dependencies,
                                tags=current_resource.tags
                            )
                        
                        plan = provisioner.plan(prov_resource, current_prov_resource)
                        result_resource = provisioner.provision(plan)
                        
                        # Update state
                        from strands_deploy.state.models import Resource as StateResource
                        state_resource = StateResource(
                            id=result_resource.id,
                            type=result_resource.type,
                            physical_id=result_resource.physical_id,
                            properties=result_resource.properties,
                            dependencies=result_resource.dependencies,
                            tags=result_resource.tags
                        )
                        
                        stack_name = old_resource.tags.get('strands:agent', 'shared-infrastructure')
                        self.executor.state_manager.add_resource(stack_name, state_resource)
                        self.executor.state_manager.save()
                        
                        restored_resources.append(resource_id)
                        
                        if progress_callback:
                            progress_callback(resource_id, ExecutionStatus.SUCCESS, None)
                        
                        self.logger.info(f"Restored resource: {resource_id}")
                    
                    except Exception as e:
                        error_msg = f"Failed to restore: {str(e)}"
                        failed_operations[resource_id] = error_msg
                        
                        if progress_callback:
                            progress_callback(resource_id, ExecutionStatus.FAILED, error_msg)
                        
                        self.logger.error(f"Failed to restore {resource_id}: {str(e)}")
            
            # Calculate result
            end_time = datetime.utcnow()
            duration = (end_time - start_time).total_seconds()
            
            if failed_operations:
                status = ExecutionStatus.FAILED
                self.logger.warning(
                    f"Rollback completed with failures: {len(failed_operations)} operations failed"
                )
            else:
                status = ExecutionStatus.SUCCESS
                self.logger.info(
                    f"Rollback completed successfully: {len(destroyed_resources)} destroyed, "
                    f"{len(restored_resources)} restored in {duration:.1f}s"
                )
            
            return RollbackResult(
                status=status,
                destroyed_resources=destroyed_resources,
                restored_resources=restored_resources,
                failed_operations=failed_operations,
                start_time=start_time,
                end_time=end_time,
                duration=duration
            )
        
        except Exception as e:
            end_time = datetime.utcnow()
            duration = (end_time - start_time).total_seconds()
            
            self.logger.error(f"Rollback execution failed: {str(e)}")
            
            return RollbackResult(
                status=ExecutionStatus.FAILED,
                destroyed_resources=destroyed_resources,
                restored_resources=restored_resources,
                failed_operations=failed_operations,
                start_time=start_time,
                end_time=end_time,
                duration=duration
            )
    
    def create_partial_rollback_plan(
        self,
        deployment_result: DeploymentResult,
        state_before: State,
        resource_ids: List[str]
    ) -> RollbackPlan:
        """Create a partial rollback plan for specific resources.
        
        Args:
            deployment_result: Result of the deployment
            state_before: State before the deployment
            resource_ids: Specific resource IDs to rollback
            
        Returns:
            RollbackPlan for the specified resources
        """
        self.logger.info(f"Creating partial rollback plan for {len(resource_ids)} resources...")
        
        resources_to_destroy = []
        resources_to_restore = {}
        
        resource_id_set = set(resource_ids)
        
        # Collect specified resources that were successfully created/updated
        for wave_result in deployment_result.wave_results:
            for resource_id, result in wave_result.resource_results.items():
                if resource_id not in resource_id_set:
                    continue
                
                if result.is_success() and result.resource:
                    # Check if this was a new resource (CREATE)
                    old_resource = state_before.get_resource(resource_id)
                    if old_resource is None:
                        # New resource - needs to be destroyed
                        resources_to_destroy.append(resource_id)
                    else:
                        # Updated resource - needs to be restored to previous state
                        resources_to_restore[resource_id] = old_resource
        
        # Create destruction plan for new resources
        destruction_plan = None
        if resources_to_destroy:
            current_state = self.executor.state_manager.load()
            
            filtered_state = State(
                version=current_state.version,
                environment=current_state.environment,
                region=current_state.region,
                account=current_state.account,
                project_name=current_state.project_name
            )
            
            for resource_id in resources_to_destroy:
                result = current_state.get_resource_with_stack(resource_id)
                if result:
                    stack_name, resource = result
                    filtered_state.add_resource(stack_name, resource)
            
            destruction_plan = self.planner.create_destruction_plan(
                current_state=filtered_state
            )
        
        plan = RollbackPlan(
            resources_to_destroy=resources_to_destroy,
            resources_to_restore=resources_to_restore,
            destruction_plan=destruction_plan
        )
        
        self.logger.info(
            f"Partial rollback plan created: {len(resources_to_destroy)} to destroy, "
            f"{len(resources_to_restore)} to restore"
        )
        
        return plan


class AutoRollbackExecutor:
    """Executor that automatically rolls back on deployment failure."""
    
    def __init__(
        self,
        executor: DeploymentExecutor,
        rollback_manager: RollbackManager
    ):
        """Initialize auto-rollback executor.
        
        Args:
            executor: Deployment executor
            rollback_manager: Rollback manager
        """
        self.executor = executor
        self.rollback_manager = rollback_manager
        self.logger = get_logger(__name__)
    
    def execute_with_auto_rollback(
        self,
        plan,
        state_before: State,
        parallel: bool = True,
        progress_callback: Optional[ProgressCallback] = None
    ) -> tuple[DeploymentResult, Optional[RollbackResult]]:
        """Execute deployment with automatic rollback on failure.
        
        Args:
            plan: Deployment plan
            state_before: State before deployment
            parallel: Whether to execute in parallel
            progress_callback: Optional progress callback
            
        Returns:
            Tuple of (DeploymentResult, RollbackResult or None)
        """
        self.logger.info("Executing deployment with auto-rollback enabled...")
        
        # Execute deployment
        deployment_result = self.executor.execute_deployment(
            plan=plan,
            parallel=parallel,
            progress_callback=progress_callback
        )
        
        # Check if rollback is needed
        if deployment_result.is_failed():
            self.logger.warning("Deployment failed, initiating automatic rollback...")
            
            # Create rollback plan
            rollback_plan = self.rollback_manager.create_rollback_plan(
                deployment_result=deployment_result,
                state_before=state_before
            )
            
            # Execute rollback
            rollback_result = self.rollback_manager.execute_rollback(
                plan=rollback_plan,
                progress_callback=progress_callback
            )
            
            if rollback_result.is_success():
                self.logger.info("Automatic rollback completed successfully")
            else:
                self.logger.error("Automatic rollback failed - manual intervention required")
            
            return deployment_result, rollback_result
        
        # Deployment succeeded, no rollback needed
        return deployment_result, None
