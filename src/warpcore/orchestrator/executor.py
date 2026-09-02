"""Deployment executor with parallel execution and progress tracking."""

from typing import Dict, List, Optional, Callable
from dataclasses import dataclass, field
from datetime import datetime
from concurrent.futures import ThreadPoolExecutor, as_completed
from contextlib import contextmanager, nullcontext
from enum import Enum

from warpcore.orchestrator.planner import DeploymentPlan, DestructionPlan, ResourceChange
from warpcore.provisioners.base import BaseProvisioner, ChangeType
from warpcore.state.models import Resource
from warpcore.state.manager import StateManager
from warpcore.state.checkpoint import CheckpointManager
from warpcore.audit.models import AuditOperation
from warpcore.audit.recorder import AuditRecorder
from warpcore.utils.logging import get_logger
from warpcore.utils.errors import DeploymentError, ProvisioningError, ErrorContext

logger = get_logger(__name__)


class ExecutionStatus(Enum):
    """Status of execution."""
    PENDING = "pending"
    IN_PROGRESS = "in_progress"
    SUCCESS = "success"
    FAILED = "failed"
    SKIPPED = "skipped"


@dataclass
class ResourceExecutionResult:
    """Result of executing a single resource."""
    
    resource_id: str
    status: ExecutionStatus
    resource: Optional[Resource] = None
    error: Optional[DeploymentError] = None
    start_time: Optional[datetime] = None
    end_time: Optional[datetime] = None
    duration: float = 0.0  # seconds
    
    def is_success(self) -> bool:
        """Check if execution was successful."""
        return self.status == ExecutionStatus.SUCCESS
    
    def is_failed(self) -> bool:
        """Check if execution failed."""
        return self.status == ExecutionStatus.FAILED


@dataclass
class WaveExecutionResult:
    """Result of executing a deployment wave."""
    
    wave_number: int
    resource_results: Dict[str, ResourceExecutionResult] = field(default_factory=dict)
    start_time: Optional[datetime] = None
    end_time: Optional[datetime] = None
    duration: float = 0.0  # seconds
    
    def get_success_count(self) -> int:
        """Get number of successful resources."""
        return sum(1 for r in self.resource_results.values() if r.is_success())
    
    def get_failed_count(self) -> int:
        """Get number of failed resources."""
        return sum(1 for r in self.resource_results.values() if r.is_failed())
    
    def has_failures(self) -> bool:
        """Check if wave has any failures."""
        return self.get_failed_count() > 0


@dataclass
class DeploymentResult:
    """Complete deployment execution result."""
    
    status: ExecutionStatus
    wave_results: List[WaveExecutionResult] = field(default_factory=list)
    start_time: Optional[datetime] = None
    end_time: Optional[datetime] = None
    duration: float = 0.0  # seconds
    total_resources: int = 0
    successful_resources: int = 0
    failed_resources: int = 0
    skipped_resources: int = 0
    error: Optional[DeploymentError] = None
    
    def is_success(self) -> bool:
        """Check if deployment was successful."""
        return self.status == ExecutionStatus.SUCCESS
    
    def is_failed(self) -> bool:
        """Check if deployment failed."""
        return self.status == ExecutionStatus.FAILED
    
    def get_failed_resource_ids(self) -> List[str]:
        """Get list of failed resource IDs."""
        failed = []
        for wave_result in self.wave_results:
            for resource_id, result in wave_result.resource_results.items():
                if result.is_failed():
                    failed.append(resource_id)
        return failed


@dataclass
class DestructionResult:
    """Result of destruction execution."""
    
    status: ExecutionStatus
    resource_results: Dict[str, ResourceExecutionResult] = field(default_factory=dict)
    start_time: Optional[datetime] = None
    end_time: Optional[datetime] = None
    duration: float = 0.0  # seconds
    total_resources: int = 0
    successful_resources: int = 0
    failed_resources: int = 0
    error: Optional[DeploymentError] = None
    
    def is_success(self) -> bool:
        """Check if destruction was successful."""
        return self.status == ExecutionStatus.SUCCESS
    
    def is_failed(self) -> bool:
        """Check if destruction failed."""
        return self.status == ExecutionStatus.FAILED


# Type alias for progress callback
ProgressCallback = Callable[[str, ExecutionStatus, Optional[str]], None]


class DeploymentExecutor:
    """Executes deployment and destruction plans with parallelization."""
    
    def __init__(
        self,
        provisioners: Dict[str, BaseProvisioner],
        state_manager: StateManager,
        checkpoint_manager: Optional[CheckpointManager] = None,
        max_workers: int = 10,
        audit_recorder: Optional[AuditRecorder] = None
    ):
        """Initialize deployment executor.
        
        Args:
            provisioners: Dictionary of provisioners by resource type
            state_manager: State manager for updating state
            checkpoint_manager: Optional checkpoint manager for recovery
            max_workers: Maximum number of parallel workers
            audit_recorder: Optional audit recorder. When supplied, every
                provision and destroy is written to the append-only audit
                trail with before/after snapshots so it can be undone.
        """
        self.provisioners = provisioners
        self.state_manager = state_manager
        self.checkpoint_manager = checkpoint_manager
        self.max_workers = max_workers
        self.audit_recorder = audit_recorder
        self.logger = get_logger(__name__)
    
    # Maps a planned change onto the audit operation that records it.
    _AUDIT_OPERATIONS = {
        ChangeType.CREATE: AuditOperation.CREATE,
        ChangeType.UPDATE: AuditOperation.UPDATE,
        ChangeType.DELETE: AuditOperation.DELETE,
    }

    @contextmanager
    def _audit_context(
        self,
        operation: Optional[AuditOperation],
        resource_id: str,
        resource_type: str,
        stack: str,
        before: Optional[Resource]
    ):
        """Record an operation to the audit trail, if auditing is enabled.

        Yields the mutable OperationRecord, or None when there is no recorder,
        so call sites read the same either way.
        """
        if self.audit_recorder is None or operation is None:
            with nullcontext(None) as record:
                yield record
            return

        with self.audit_recorder.operation(
            operation=operation,
            resource_id=resource_id,
            resource_type=resource_type,
            stack=stack,
            before=before,
        ) as record:
            yield record

    @staticmethod
    def _stack_for(resource: Resource) -> str:
        """Stack a resource is filed under, matching _update_state."""
        return (resource.tags or {}).get('warpcore:agent', 'shared-infrastructure')

    def execute_deployment(
        self,
        plan: DeploymentPlan,
        parallel: bool = True,
        progress_callback: Optional[ProgressCallback] = None
    ) -> DeploymentResult:
        """Execute a deployment plan.
        
        Args:
            plan: Deployment plan to execute
            parallel: Whether to execute waves in parallel
            progress_callback: Optional callback for progress updates
            
        Returns:
            DeploymentResult with execution details
        """
        self.logger.info(f"Starting deployment execution (parallel={parallel})...")
        
        start_time = datetime.utcnow()
        wave_results = []
        
        try:
            # Execute each wave
            for wave in plan.waves:
                self.logger.info(f"Executing wave {wave.wave_number} ({wave.size()} resources)...")
                
                wave_result = self._execute_wave(
                    wave=wave,
                    parallel=parallel,
                    progress_callback=progress_callback
                )
                wave_results.append(wave_result)
                
                # Check for failures
                if wave_result.has_failures():
                    self.logger.error(
                        f"Wave {wave.wave_number} completed with {wave_result.get_failed_count()} failures"
                    )
                    # Stop execution on wave failure
                    break
                
                self.logger.info(
                    f"Wave {wave.wave_number} completed successfully in {wave_result.duration:.1f}s"
                )
            
            # Calculate totals
            end_time = datetime.utcnow()
            duration = (end_time - start_time).total_seconds()
            
            total_resources = 0
            successful_resources = 0
            failed_resources = 0
            
            for wave_result in wave_results:
                total_resources += len(wave_result.resource_results)
                successful_resources += wave_result.get_success_count()
                failed_resources += wave_result.get_failed_count()
            
            # Determine overall status
            if failed_resources > 0:
                status = ExecutionStatus.FAILED
                self.logger.error(
                    f"Deployment failed: {failed_resources}/{total_resources} resources failed"
                )
            else:
                status = ExecutionStatus.SUCCESS
                self.logger.info(
                    f"Deployment completed successfully: {successful_resources} resources in {duration:.1f}s"
                )
            
            return DeploymentResult(
                status=status,
                wave_results=wave_results,
                start_time=start_time,
                end_time=end_time,
                duration=duration,
                total_resources=total_resources,
                successful_resources=successful_resources,
                failed_resources=failed_resources
            )
        
        except Exception as e:
            end_time = datetime.utcnow()
            duration = (end_time - start_time).total_seconds()
            
            error = DeploymentError(
                message=f"Deployment execution failed: {str(e)}",
                cause=e
            )
            
            self.logger.error(f"Deployment execution failed: {str(e)}")
            
            return DeploymentResult(
                status=ExecutionStatus.FAILED,
                wave_results=wave_results,
                start_time=start_time,
                end_time=end_time,
                duration=duration,
                error=error
            )
    
    def execute_destruction(
        self,
        plan: DestructionPlan,
        progress_callback: Optional[ProgressCallback] = None
    ) -> DestructionResult:
        """Execute a destruction plan.
        
        Args:
            plan: Destruction plan to execute
            progress_callback: Optional callback for progress updates
            
        Returns:
            DestructionResult with execution details
        """
        self.logger.info(f"Starting destruction of {plan.get_total_resources()} resources...")
        
        start_time = datetime.utcnow()
        resource_results = {}
        
        try:
            # Execute destruction sequentially in reverse dependency order
            for resource_id in plan.resource_ids:
                resource = plan.resources.get(resource_id)
                if not resource:
                    continue
                
                self.logger.info(f"Destroying resource: {resource_id}")
                
                if progress_callback:
                    progress_callback(resource_id, ExecutionStatus.IN_PROGRESS, None)
                
                result = self._destroy_resource(resource)
                resource_results[resource_id] = result
                
                if progress_callback:
                    progress_callback(
                        resource_id,
                        result.status,
                        str(result.error) if result.error else None
                    )
                
                # Update state after successful destruction
                if result.is_success():
                    self._remove_from_state(resource)
                
                # Continue even if destruction fails (best effort)
                if result.is_failed():
                    self.logger.warning(
                        f"Failed to destroy resource {resource_id}: {result.error}"
                    )
            
            # Calculate totals
            end_time = datetime.utcnow()
            duration = (end_time - start_time).total_seconds()
            
            successful_resources = sum(1 for r in resource_results.values() if r.is_success())
            failed_resources = sum(1 for r in resource_results.values() if r.is_failed())
            
            # Determine overall status
            if failed_resources > 0:
                status = ExecutionStatus.FAILED
                self.logger.warning(
                    f"Destruction completed with failures: {failed_resources}/{len(resource_results)} failed"
                )
            else:
                status = ExecutionStatus.SUCCESS
                self.logger.info(
                    f"Destruction completed successfully: {successful_resources} resources in {duration:.1f}s"
                )
            
            return DestructionResult(
                status=status,
                resource_results=resource_results,
                start_time=start_time,
                end_time=end_time,
                duration=duration,
                total_resources=len(resource_results),
                successful_resources=successful_resources,
                failed_resources=failed_resources
            )
        
        except Exception as e:
            end_time = datetime.utcnow()
            duration = (end_time - start_time).total_seconds()
            
            error = DeploymentError(
                message=f"Destruction execution failed: {str(e)}",
                cause=e
            )
            
            self.logger.error(f"Destruction execution failed: {str(e)}")
            
            return DestructionResult(
                status=ExecutionStatus.FAILED,
                resource_results=resource_results,
                start_time=start_time,
                end_time=end_time,
                duration=duration,
                error=error
            )
    
    def _execute_wave(
        self,
        wave,
        parallel: bool,
        progress_callback: Optional[ProgressCallback]
    ) -> WaveExecutionResult:
        """Execute a single deployment wave.
        
        Args:
            wave: Deployment wave to execute
            parallel: Whether to execute resources in parallel
            progress_callback: Optional progress callback
            
        Returns:
            WaveExecutionResult
        """
        start_time = datetime.utcnow()
        resource_results = {}
        
        if parallel and len(wave.resource_ids) > 1:
            # Execute in parallel
            resource_results = self._execute_wave_parallel(wave, progress_callback)
        else:
            # Execute sequentially
            resource_results = self._execute_wave_sequential(wave, progress_callback)
        
        end_time = datetime.utcnow()
        duration = (end_time - start_time).total_seconds()
        
        return WaveExecutionResult(
            wave_number=wave.wave_number,
            resource_results=resource_results,
            start_time=start_time,
            end_time=end_time,
            duration=duration
        )
    
    def _execute_wave_parallel(
        self,
        wave,
        progress_callback: Optional[ProgressCallback]
    ) -> Dict[str, ResourceExecutionResult]:
        """Execute wave resources in parallel.
        
        Args:
            wave: Deployment wave
            progress_callback: Optional progress callback
            
        Returns:
            Dictionary of resource results
        """
        resource_results = {}
        
        with ThreadPoolExecutor(max_workers=self.max_workers) as executor:
            # Submit all resources for execution
            future_to_resource = {}
            for resource_id in wave.resource_ids:
                change = wave.get_change(resource_id)
                if change and change.change_type != ChangeType.NO_CHANGE:
                    future = executor.submit(self._provision_resource, change)
                    future_to_resource[future] = resource_id
            
            # Collect results as they complete
            for future in as_completed(future_to_resource):
                resource_id = future_to_resource[future]
                try:
                    result = future.result()
                    resource_results[resource_id] = result
                    
                    if progress_callback:
                        progress_callback(
                            resource_id,
                            result.status,
                            str(result.error) if result.error else None
                        )
                    
                    # Update state after successful provisioning
                    if result.is_success() and result.resource:
                        self._update_state(result.resource)
                    
                except Exception as e:
                    self.logger.error(f"Unexpected error provisioning {resource_id}: {str(e)}")
                    result = ResourceExecutionResult(
                        resource_id=resource_id,
                        status=ExecutionStatus.FAILED,
                        error=DeploymentError(
                            message=f"Unexpected error: {str(e)}",
                            cause=e
                        )
                    )
                    resource_results[resource_id] = result
        
        return resource_results
    
    def _execute_wave_sequential(
        self,
        wave,
        progress_callback: Optional[ProgressCallback]
    ) -> Dict[str, ResourceExecutionResult]:
        """Execute wave resources sequentially.
        
        Args:
            wave: Deployment wave
            progress_callback: Optional progress callback
            
        Returns:
            Dictionary of resource results
        """
        resource_results = {}
        
        for resource_id in wave.resource_ids:
            change = wave.get_change(resource_id)
            if change and change.change_type != ChangeType.NO_CHANGE:
                if progress_callback:
                    progress_callback(resource_id, ExecutionStatus.IN_PROGRESS, None)
                
                result = self._provision_resource(change)
                resource_results[resource_id] = result
                
                if progress_callback:
                    progress_callback(
                        resource_id,
                        result.status,
                        str(result.error) if result.error else None
                    )
                
                # Update state after successful provisioning
                if result.is_success() and result.resource:
                    self._update_state(result.resource)
        
        return resource_results
    
    def _provision_resource(self, change: ResourceChange) -> ResourceExecutionResult:
        """Provision a single resource.
        
        Args:
            change: Resource change to execute
            
        Returns:
            ResourceExecutionResult
        """
        resource_id = change.resource_id
        start_time = datetime.utcnow()
        
        try:
            # Get provisioner for resource type
            resource = change.desired_resource or change.current_resource
            if not resource:
                raise ProvisioningError(
                    f"No resource found for {resource_id}",
                    context=ErrorContext(resource_id=resource_id)
                )
            
            provisioner = self.provisioners.get(resource.type)
            if not provisioner:
                raise ProvisioningError(
                    f"No provisioner found for resource type: {resource.type}",
                    context=ErrorContext(
                        resource_id=resource_id,
                        resource_type=resource.type
                    )
                )
            
            # Create provision plan
            from warpcore.provisioners.base import Resource as ProvisionerResource
            
            # Convert to provisioner Resource format
            current_prov_resource = None
            if change.current_resource:
                current_prov_resource = ProvisionerResource(
                    id=change.current_resource.id,
                    type=change.current_resource.type,
                    physical_id=change.current_resource.physical_id,
                    properties=change.current_resource.properties,
                    dependencies=change.current_resource.dependencies,
                    tags=change.current_resource.tags
                )
            
            desired_prov_resource = ProvisionerResource(
                id=resource.id,
                type=resource.type,
                physical_id=resource.physical_id,
                properties=resource.properties,
                dependencies=resource.dependencies,
                tags=resource.tags
            )
            
            plan = provisioner.plan(desired_prov_resource, current_prov_resource)
            
            # Execute provisioning
            self.logger.info(f"Provisioning {resource_id} ({change.change_type.value})...")
            
            from warpcore.state.models import Resource as StateResource
            
            with self._audit_context(
                operation=self._AUDIT_OPERATIONS.get(change.change_type),
                resource_id=resource_id,
                resource_type=resource.type,
                stack=self._stack_for(resource),
                before=change.current_resource,
            ) as audit_record:
                result_resource = provisioner.provision(plan)
                
                # Convert back to state Resource format
                state_resource = StateResource(
                    id=result_resource.id,
                    type=result_resource.type,
                    physical_id=result_resource.physical_id,
                    properties=result_resource.properties,
                    dependencies=result_resource.dependencies,
                    tags=result_resource.tags
                )
                
                if audit_record is not None:
                    audit_record.after = state_resource
            
            end_time = datetime.utcnow()
            duration = (end_time - start_time).total_seconds()
            
            self.logger.info(f"Successfully provisioned {resource_id} in {duration:.1f}s")
            
            return ResourceExecutionResult(
                resource_id=resource_id,
                status=ExecutionStatus.SUCCESS,
                resource=state_resource,
                start_time=start_time,
                end_time=end_time,
                duration=duration
            )
        
        except DeploymentError as e:
            end_time = datetime.utcnow()
            duration = (end_time - start_time).total_seconds()
            
            self.logger.error(f"Failed to provision {resource_id}: {str(e)}")
            
            return ResourceExecutionResult(
                resource_id=resource_id,
                status=ExecutionStatus.FAILED,
                error=e,
                start_time=start_time,
                end_time=end_time,
                duration=duration
            )
        
        except Exception as e:
            end_time = datetime.utcnow()
            duration = (end_time - start_time).total_seconds()
            
            error = ProvisioningError(
                message=f"Unexpected error provisioning {resource_id}: {str(e)}",
                context=ErrorContext(resource_id=resource_id),
                cause=e
            )
            
            self.logger.error(f"Failed to provision {resource_id}: {str(e)}")
            
            return ResourceExecutionResult(
                resource_id=resource_id,
                status=ExecutionStatus.FAILED,
                error=error,
                start_time=start_time,
                end_time=end_time,
                duration=duration
            )
    
    def _destroy_resource(self, resource: Resource) -> ResourceExecutionResult:
        """Destroy a single resource.
        
        Args:
            resource: Resource to destroy
            
        Returns:
            ResourceExecutionResult
        """
        resource_id = resource.id
        start_time = datetime.utcnow()
        
        try:
            # Get provisioner for resource type
            provisioner = self.provisioners.get(resource.type)
            if not provisioner:
                raise ProvisioningError(
                    f"No provisioner found for resource type: {resource.type}",
                    context=ErrorContext(
                        resource_id=resource_id,
                        resource_type=resource.type
                    )
                )
            
            # Convert to provisioner Resource format
            from warpcore.provisioners.base import Resource as ProvisionerResource
            prov_resource = ProvisionerResource(
                id=resource.id,
                type=resource.type,
                physical_id=resource.physical_id,
                properties=resource.properties,
                dependencies=resource.dependencies,
                tags=resource.tags
            )
            
            # Execute destruction
            self.logger.info(f"Destroying {resource_id}...")
            
            with self._audit_context(
                operation=AuditOperation.DELETE,
                resource_id=resource_id,
                resource_type=resource.type,
                stack=self._stack_for(resource),
                before=resource,
            ):
                provisioner.destroy(prov_resource)
            
            end_time = datetime.utcnow()
            duration = (end_time - start_time).total_seconds()
            
            self.logger.info(f"Successfully destroyed {resource_id} in {duration:.1f}s")
            
            return ResourceExecutionResult(
                resource_id=resource_id,
                status=ExecutionStatus.SUCCESS,
                start_time=start_time,
                end_time=end_time,
                duration=duration
            )
        
        except DeploymentError as e:
            end_time = datetime.utcnow()
            duration = (end_time - start_time).total_seconds()
            
            self.logger.error(f"Failed to destroy {resource_id}: {str(e)}")
            
            return ResourceExecutionResult(
                resource_id=resource_id,
                status=ExecutionStatus.FAILED,
                error=e,
                start_time=start_time,
                end_time=end_time,
                duration=duration
            )
        
        except Exception as e:
            end_time = datetime.utcnow()
            duration = (end_time - start_time).total_seconds()
            
            error = ProvisioningError(
                message=f"Unexpected error destroying {resource_id}: {str(e)}",
                context=ErrorContext(resource_id=resource_id),
                cause=e
            )
            
            self.logger.error(f"Failed to destroy {resource_id}: {str(e)}")
            
            return ResourceExecutionResult(
                resource_id=resource_id,
                status=ExecutionStatus.FAILED,
                error=error,
                start_time=start_time,
                end_time=end_time,
                duration=duration
            )
    
    def _update_state(self, resource: Resource) -> None:
        """Update state with provisioned resource.
        
        Args:
            resource: Resource to add/update in state
        """
        try:
            # Determine stack name from resource tags or use default
            stack_name = resource.tags.get('warpcore:agent', 'shared-infrastructure')
            
            # Load first: add_resource requires a loaded state, and save()
            # takes the state to write. Called from the result-collection loop,
            # so this is single-threaded even during a parallel wave.
            state = self.state_manager.load()
            state.add_resource(stack_name, resource)
            self.state_manager.save(state)
            
            self.logger.debug(f"Updated state for resource: {resource.id}")
        
        except Exception as e:
            self.logger.error(f"Failed to update state for {resource.id}: {str(e)}")
            # Don't fail the deployment if state update fails
    
    def _remove_from_state(self, resource: Resource) -> None:
        """Remove resource from state.
        
        Args:
            resource: Resource to remove from state
        """
        try:
            # Find and remove resource from state
            state = self.state_manager.load()
            result = state.get_resource_with_stack(resource.id)
            
            if result:
                stack_name, _ = result
                state.remove_resource(stack_name, resource.id)
                self.state_manager.save(state)
                self.logger.debug(f"Removed resource from state: {resource.id}")
        
        except Exception as e:
            self.logger.error(f"Failed to remove {resource.id} from state: {str(e)}")
            # Don't fail the destruction if state update fails
