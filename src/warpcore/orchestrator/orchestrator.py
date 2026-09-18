"""Main orchestrator that coordinates deployment planning and execution."""

from typing import Dict, Optional
import boto3

from warpcore.config.models import AgentConfig
from warpcore.config.parser import Config
from warpcore.state.models import Resource, State
from warpcore.state.manager import StateManager
from warpcore.state.checkpoint import CheckpointManager
from warpcore.orchestrator.planner import DeploymentPlanner, DeploymentPlan, DestructionPlan
from warpcore.audit.recorder import AuditRecorder
from warpcore.orchestrator.executor import (
    DeploymentExecutor,
    DeploymentResult,
    DestructionResult,
    ProgressCallback
)
from warpcore.orchestrator.rollback import (
    RollbackManager,
    AutoRollbackExecutor,
    RollbackStrategy,
    RollbackPlan,
    RollbackResult
)
from warpcore.orchestrator.compiler import compile_project
from warpcore.orchestrator.refs import resolve
from warpcore.provisioners.base import BaseProvisioner
from warpcore.tagging.manager import TagManager
from warpcore.utils.logging import get_logger

logger = get_logger(__name__)


class DeploymentOrchestrator:
    """Coordinates deployment planning, execution, and rollback."""
    
    def __init__(
        self,
        config: Config,
        state_manager: StateManager,
        provisioners: Dict[str, BaseProvisioner],
        boto_session: boto3.Session,
        checkpoint_manager: Optional[CheckpointManager] = None,
        audit_recorder: Optional["AuditRecorder"] = None,
        max_workers: int = 10
    ):
        """Initialize deployment orchestrator.
        
        Args:
            config: Configuration
            state_manager: State manager
            provisioners: Dictionary of provisioners by resource type
            boto_session: Boto3 session
            checkpoint_manager: Optional checkpoint manager
            audit_recorder: Optional audit recorder, passed to the executor so
                every provision and destroy lands in the audit trail
            max_workers: Maximum parallel workers
        """
        self.config = config
        self.state_manager = state_manager
        self.provisioners = provisioners
        self.boto_session = boto_session
        self.checkpoint_manager = checkpoint_manager
        self.audit_recorder = audit_recorder
        self.max_workers = max_workers
        
        # Initialize components
        self.planner = DeploymentPlanner()
        self.executor = DeploymentExecutor(
            provisioners=provisioners,
            state_manager=state_manager,
            checkpoint_manager=checkpoint_manager,
            audit_recorder=audit_recorder,
            max_workers=max_workers
        )
        self.rollback_manager = RollbackManager(
            executor=self.executor,
            planner=self.planner
        )
        self.auto_rollback_executor = AutoRollbackExecutor(
            executor=self.executor,
            rollback_manager=self.rollback_manager
        )
        # TagManager takes the ProjectConfig, not the whole Config. Passing
        # the latter raised AttributeError in the constructor, so building an
        # orchestrator at all - and therefore deploy, destroy and diff -
        # failed before doing any work.
        self.tag_manager = TagManager(config.project)
        # The environment the state was initialised for; the compiler names
        # resources by it. Falls back to the first environment in the file.
        state = state_manager.load() if state_manager.exists() else None
        self.environment = (state.environment if state and state.environment else None) or next(iter(config.environments), "dev")
        self.compile_notes: list = []
        self.compile_skipped: list = []
        
        self.logger = get_logger(__name__)
    
    def plan_deployment(
        self,
        agent_filter: Optional[str] = None
    ) -> DeploymentPlan:
        """Create a deployment plan.
        
        Args:
            agent_filter: Optional agent name to filter resources
            
        Returns:
            DeploymentPlan
        """
        self.logger.info("Planning deployment...")
        
        # Load current state
        current_state = self.state_manager.load()
        
        # Build desired resources from configuration
        desired_resources = self._build_desired_resources(agent_filter)
        
        # Create deployment plan
        plan = self.planner.create_deployment_plan(
            desired_resources=desired_resources,
            current_state=current_state,
            agent_filter=agent_filter
        )
        
        return plan
    
    def execute_deployment(
        self,
        plan: DeploymentPlan,
        parallel: bool = True,
        rollback_strategy: RollbackStrategy = RollbackStrategy.NONE,
        progress_callback: Optional[ProgressCallback] = None
    ) -> tuple[DeploymentResult, Optional[RollbackResult]]:
        """Execute a deployment plan.
        
        Args:
            plan: Deployment plan to execute
            parallel: Whether to execute in parallel
            rollback_strategy: Rollback strategy to use
            progress_callback: Optional progress callback
            
        Returns:
            Tuple of (DeploymentResult, RollbackResult or None)
        """
        self.logger.info(f"Executing deployment (parallel={parallel}, rollback={rollback_strategy.value})...")
        
        # Save state before deployment for potential rollback
        state_before = self.state_manager.load()
        
        # Execute based on rollback strategy
        if rollback_strategy == RollbackStrategy.AUTOMATIC:
            result, rollback = self.auto_rollback_executor.execute_with_auto_rollback(
                plan=plan,
                state_before=state_before,
                parallel=parallel,
                progress_callback=progress_callback
            )
            if rollback is None and result.is_success():
                self._apply_deletes(plan, progress_callback, result)
            return result, rollback
        else:
            # Execute without auto-rollback
            result = self.executor.execute_deployment(
                plan=plan,
                parallel=parallel,
                progress_callback=progress_callback
            )
            if result.is_success():
                self._apply_deletes(plan, progress_callback, result)
            return result, None
    
    def deploy(
        self,
        agent_filter: Optional[str] = None,
        parallel: bool = True,
        rollback_strategy: RollbackStrategy = RollbackStrategy.NONE,
        progress_callback: Optional[ProgressCallback] = None
    ) -> tuple[DeploymentResult, Optional[RollbackResult]]:
        """Plan and execute deployment in one step.
        
        Args:
            agent_filter: Optional agent name to filter resources
            parallel: Whether to execute in parallel
            rollback_strategy: Rollback strategy to use
            progress_callback: Optional progress callback
            
        Returns:
            Tuple of (DeploymentResult, RollbackResult or None)
        """
        # Create plan
        plan = self.plan_deployment(agent_filter=agent_filter)
        
        if not plan.has_changes():
            self.logger.info("No changes to deploy")
            from warpcore.orchestrator.executor import ExecutionStatus
            result = DeploymentResult(
                status=ExecutionStatus.SUCCESS,
                total_resources=0,
                successful_resources=0,
                failed_resources=0
            )
            return result, None
        
        # Execute plan
        return self.execute_deployment(
            plan=plan,
            parallel=parallel,
            rollback_strategy=rollback_strategy,
            progress_callback=progress_callback
        )
    
    def plan_destruction(
        self,
        agent_filter: Optional[str] = None,
        include_adopted: bool = False,
    ) -> DestructionPlan:
        """Create a destruction plan.
        
        Args:
            agent_filter: Optional agent name to filter resources
            
        Returns:
            DestructionPlan
        """
        self.logger.info("Planning destruction...")
        
        # Load current state
        current_state = self.state_manager.load()
        
        # Create destruction plan
        plan = self.planner.create_destruction_plan(
            current_state=current_state,
            agent_filter=agent_filter,
            include_adopted=include_adopted,
        )
        
        return plan
    
    def execute_destruction(
        self,
        plan: DestructionPlan,
        progress_callback: Optional[ProgressCallback] = None
    ) -> DestructionResult:
        """Execute a destruction plan.
        
        Args:
            plan: Destruction plan to execute
            progress_callback: Optional progress callback
            
        Returns:
            DestructionResult
        """
        self.logger.info("Executing destruction...")
        
        result = self.executor.execute_destruction(
            plan=plan,
            progress_callback=progress_callback
        )
        
        return result
    
    def destroy(
        self,
        agent_filter: Optional[str] = None,
        progress_callback: Optional[ProgressCallback] = None
    ) -> DestructionResult:
        """Plan and execute destruction in one step.
        
        Args:
            agent_filter: Optional agent name to filter resources
            progress_callback: Optional progress callback
            
        Returns:
            DestructionResult
        """
        # Create plan
        plan = self.plan_destruction(agent_filter=agent_filter)
        
        if plan.get_total_resources() == 0:
            self.logger.info("No resources to destroy")
            from warpcore.orchestrator.executor import ExecutionStatus
            return DestructionResult(
                status=ExecutionStatus.SUCCESS,
                total_resources=0,
                successful_resources=0,
                failed_resources=0
            )
        
        # Execute plan
        return self.execute_destruction(
            plan=plan,
            progress_callback=progress_callback
        )
    
    def create_rollback_plan(
        self,
        deployment_result: DeploymentResult,
        state_before: State,
        agent_filter: Optional[str] = None
    ) -> RollbackPlan:
        """Create a rollback plan for a failed deployment.
        
        Args:
            deployment_result: Result of the failed deployment
            state_before: State before the deployment
            agent_filter: Optional agent filter
            
        Returns:
            RollbackPlan
        """
        return self.rollback_manager.create_rollback_plan(
            deployment_result=deployment_result,
            state_before=state_before,
            agent_filter=agent_filter
        )
    
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
            RollbackResult
        """
        return self.rollback_manager.execute_rollback(
            plan=plan,
            progress_callback=progress_callback
        )
    
    def _apply_deletes(self, plan: DeploymentPlan, progress_callback, result) -> None:
        """Resources the configuration no longer has are removed, after
        everything else succeeded, in reverse dependency order. Adopted
        resources are never in the plan's deletes (planner.is_adopted)."""
        from warpcore.provisioners.base import ChangeType
        deletes = [c for c in plan.all_changes.values() if c.change_type == ChangeType.DELETE and c.current_resource]
        if not deletes:
            return
        current = self.state_manager.load()
        subset = State(version=current.version, environment=current.environment, region=current.region,
                       account=current.account, project_name=current.project_name)
        for c in deletes:
            located = current.get_resource_with_stack(c.resource_id)
            if located:
                subset.add_resource(located[0], located[1])
        destruction = self.planner.create_destruction_plan(current_state=subset)
        if destruction.get_total_resources() == 0:
            return
        outcome = self.executor.execute_destruction(plan=destruction, progress_callback=progress_callback)
        result.total_resources += outcome.total_resources
        result.successful_resources += outcome.successful_resources
        result.failed_resources += outcome.failed_resources
        if outcome.failed_resources:
            from warpcore.orchestrator.executor import ExecutionStatus
            result.status = ExecutionStatus.PARTIAL

    def _build_desired_resources(
        self,
        agent_filter: Optional[str] = None
    ) -> Dict[str, Resource]:
        """What the configuration asks for, compiled (orchestrator/compiler.py).

        References to resources already in the state are filled in here so
        the planner compares like with like; ones to resources not yet
        created stay as references and are filled in at provision time.
        """
        state = self.state_manager.load()
        compiled = compile_project(
            self.config, self.environment, account=state.account or None, region=state.region or self.boto_session.region_name,
            agent_filter=agent_filter,
        )
        self.compile_notes = compiled.notes
        self.compile_skipped = compiled.skipped
        desired: Dict[str, Resource] = {}
        for rid, resource in compiled.resources.items():
            properties, _ = resolve(resource.properties, state.get_resource)
            desired[rid] = resource.model_copy(update={"properties": properties})
        return desired
