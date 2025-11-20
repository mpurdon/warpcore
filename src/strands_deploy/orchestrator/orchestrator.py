"""Main orchestrator that coordinates deployment planning and execution."""

from typing import Dict, Optional
import boto3

from strands_deploy.config.models import AgentConfig
from strands_deploy.config.parser import Config
from strands_deploy.state.models import Resource, State
from strands_deploy.state.manager import StateManager
from strands_deploy.state.checkpoint import CheckpointManager
from strands_deploy.orchestrator.planner import DeploymentPlanner, DeploymentPlan, DestructionPlan
from strands_deploy.orchestrator.executor import (
    DeploymentExecutor,
    DeploymentResult,
    DestructionResult,
    ProgressCallback
)
from strands_deploy.orchestrator.rollback import (
    RollbackManager,
    AutoRollbackExecutor,
    RollbackStrategy,
    RollbackPlan,
    RollbackResult
)
from strands_deploy.provisioners.base import BaseProvisioner
from strands_deploy.tagging.manager import TagManager
from strands_deploy.utils.logging import get_logger

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
        max_workers: int = 10
    ):
        """Initialize deployment orchestrator.
        
        Args:
            config: Configuration
            state_manager: State manager
            provisioners: Dictionary of provisioners by resource type
            boto_session: Boto3 session
            checkpoint_manager: Optional checkpoint manager
            max_workers: Maximum parallel workers
        """
        self.config = config
        self.state_manager = state_manager
        self.provisioners = provisioners
        self.boto_session = boto_session
        self.checkpoint_manager = checkpoint_manager
        self.max_workers = max_workers
        
        # Initialize components
        self.planner = DeploymentPlanner()
        self.executor = DeploymentExecutor(
            provisioners=provisioners,
            state_manager=state_manager,
            checkpoint_manager=checkpoint_manager,
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
        self.tag_manager = TagManager(config)
        
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
            return self.auto_rollback_executor.execute_with_auto_rollback(
                plan=plan,
                state_before=state_before,
                parallel=parallel,
                progress_callback=progress_callback
            )
        else:
            # Execute without auto-rollback
            result = self.executor.execute_deployment(
                plan=plan,
                parallel=parallel,
                progress_callback=progress_callback
            )
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
            from strands_deploy.orchestrator.executor import ExecutionStatus
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
        agent_filter: Optional[str] = None
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
            agent_filter=agent_filter
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
            from strands_deploy.orchestrator.executor import ExecutionStatus
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
    
    def _build_desired_resources(
        self,
        agent_filter: Optional[str] = None
    ) -> Dict[str, Resource]:
        """Build desired resources from configuration.
        
        Args:
            agent_filter: Optional agent name to filter
            
        Returns:
            Dictionary of desired resources (resource_id -> Resource)
        """
        desired_resources = {}
        
        # Get agents from configuration
        agents = self.config.get_agents()
        
        # Filter agents if specified
        if agent_filter:
            agents = [a for a in agents if a.name == agent_filter]
        
        # Build resources for each agent
        for agent in agents:
            agent_resources = self._build_agent_resources(agent)
            desired_resources.update(agent_resources)
        
        # Build shared resources
        shared_resources = self._build_shared_resources()
        desired_resources.update(shared_resources)
        
        return desired_resources
    
    def _build_agent_resources(self, agent: AgentConfig) -> Dict[str, Resource]:
        """Build resources for a single agent.
        
        Args:
            agent: Agent configuration
            
        Returns:
            Dictionary of resources for the agent
        """
        resources = {}
        
        # This is a placeholder - actual implementation would:
        # 1. Create Lambda function resource
        # 2. Create API Gateway resource
        # 3. Create IAM role resource
        # 4. Create any agent-specific resources (S3, DynamoDB, etc.)
        # 5. Set up dependencies between resources
        # 6. Apply tags using tag_manager
        
        # For now, return empty dict
        # This will be implemented when integrating with provisioners
        
        return resources
    
    def _build_shared_resources(self) -> Dict[str, Resource]:
        """Build shared infrastructure resources.
        
        Returns:
            Dictionary of shared resources
        """
        resources = {}
        
        # This is a placeholder - actual implementation would:
        # 1. Create VPC resources if enabled
        # 2. Create shared IAM roles
        # 3. Create shared security groups
        # 4. Apply tags using tag_manager
        
        # For now, return empty dict
        # This will be implemented when integrating with provisioners
        
        return resources
