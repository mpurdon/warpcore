"""Agentic reconciliation system for infrastructure drift detection and recovery."""

from typing import Dict, List, Optional
import boto3

from strands_deploy.agentic.models import (
    DriftItem,
    DriftReport,
    DriftSeverity,
    DriftType,
    FailureAnalysis,
    FailureContext,
    MissingResource,
    RecoveryPlan,
)
from strands_deploy.agentic.scanner import AWSScanner, ScannedState
from strands_deploy.agentic.llm_client import LLMClient, LLMProvider
from strands_deploy.state.models import Resource, State
from strands_deploy.state.manager import StateManager
from strands_deploy.utils.errors import DeploymentError, ErrorContext
from strands_deploy.utils.logging import get_logger

logger = get_logger(__name__)


class AgenticReconciler:
    """Agentic system for infrastructure drift detection and reconciliation."""
    
    def __init__(
        self,
        state_manager: StateManager,
        boto_session: boto3.Session,
        project_name: str,
        environment: str,
        region: str,
        llm_client: Optional[LLMClient] = None
    ):
        """Initialize agentic reconciler.
        
        Args:
            state_manager: State manager
            boto_session: Boto3 session
            project_name: Project name
            environment: Environment name
            region: AWS region
            llm_client: Optional LLM client (if not provided, will create default)
        """
        self.state_manager = state_manager
        self.boto_session = boto_session
        self.project_name = project_name
        self.environment = environment
        self.region = region
        
        # Initialize AWS scanner
        self.aws_scanner = AWSScanner(
            boto_session=boto_session,
            project_name=project_name,
            environment=environment,
            region=region
        )
        
        # Initialize LLM client
        self.llm_client = llm_client or self._create_default_llm_client()
        
        self.logger = get_logger(__name__)
    
    def _create_default_llm_client(self) -> LLMClient:
        """Create default LLM client."""
        # Try to detect available provider
        import os
        
        if os.getenv('OPENAI_API_KEY'):
            return LLMClient(provider=LLMProvider.OPENAI)
        elif os.getenv('ANTHROPIC_API_KEY'):
            return LLMClient(provider=LLMProvider.ANTHROPIC)
        else:
            # Return client without API key - will use fallback methods
            self.logger.warning("No LLM API key found - using fallback analysis")
            return LLMClient(provider=LLMProvider.OPENAI)
    
    def detect_drift(self) -> DriftReport:
        """Detect infrastructure drift by comparing state file with AWS.
        
        Returns:
            DriftReport with detected drift and LLM analysis
        """
        self.logger.info("Starting drift detection...")
        
        # Load desired state from state file
        desired_state = self.state_manager.load()
        
        # Scan actual state from AWS
        actual_state = self.aws_scanner.scan_resources()
        
        # Compare states to find drift
        drift_items = self._compare_states(desired_state, actual_state)
        
        # Count total resources checked
        total_resources = len(desired_state.all_resources()) + len(actual_state.get_all_resources())
        
        # Create initial report
        report = DriftReport(
            drift_items=drift_items,
            total_resources_checked=total_resources,
            drift_count=len(drift_items)
        )
        
        # Use LLM to analyze drift if any found
        if drift_items:
            self.logger.info(f"Detected {len(drift_items)} drift items, analyzing with LLM...")
            analysis = self.llm_client.analyze_drift(drift_items)
            report.analysis = analysis
        else:
            self.logger.info("No drift detected")
        
        return report
    
    def analyze_failure(
        self,
        error: DeploymentError,
        context: Optional[ErrorContext] = None
    ) -> FailureAnalysis:
        """Analyze deployment failure using LLM.
        
        Args:
            error: Deployment error
            context: Optional error context
            
        Returns:
            FailureAnalysis with root cause and suggested fixes
        """
        self.logger.info("Analyzing deployment failure with LLM...")
        
        # Build failure context
        failure_context = FailureContext(
            error_message=error.message,
            error_type=error.category.value,
            resource_id=error.context.resource_id if error.context else None,
            resource_type=error.context.resource_type if error.context else None,
            resource_config=error.context.additional_info if error.context else None,
            operation=error.context.operation if error.context else None,
            aws_request_id=error.context.request_id if error.context else None,
            logs=[]  # Could be populated from log files
        )
        
        # Use LLM to analyze
        analysis = self.llm_client.analyze_failure(failure_context)
        
        return analysis
    
    def find_missing_resources(self) -> List[MissingResource]:
        """Identify resources that should exist but don't.
        
        Returns:
            List of missing resources, prioritized by LLM
        """
        self.logger.info("Scanning for missing resources...")
        
        # Load desired state
        desired_state = self.state_manager.load()
        
        # Scan actual state
        actual_state = self.aws_scanner.scan_resources()
        
        # Find resources in state but not in AWS
        missing = []
        for stack_name, resource in desired_state.all_resources():
            if resource.physical_id and not actual_state.has_resource(resource.physical_id):
                missing_resource = MissingResource(
                    resource_id=resource.id,
                    resource_type=resource.type,
                    expected_config=resource.properties,
                    dependencies=resource.dependencies,
                    priority=5,  # Default medium priority
                    impact=f"Resource {resource.id} is missing from AWS"
                )
                missing.append(missing_resource)
        
        # Use LLM to prioritize
        if missing:
            self.logger.info(f"Found {len(missing)} missing resources, prioritizing with LLM...")
            missing = self.llm_client.prioritize_missing_resources(missing)
        else:
            self.logger.info("No missing resources found")
        
        return missing
    
    def generate_recovery_plan(self, drift_report: DriftReport) -> RecoveryPlan:
        """Generate recovery plan from drift report.
        
        Args:
            drift_report: Drift report
            
        Returns:
            RecoveryPlan with suggested actions
        """
        self.logger.info("Generating recovery plan with LLM...")
        
        if not drift_report.has_drift():
            return RecoveryPlan(
                actions=[],
                explanation="No drift detected - no recovery needed"
            )
        
        # Use LLM to suggest recovery actions
        recovery_plan = self.llm_client.suggest_recovery(drift_report.drift_items)
        
        return recovery_plan
    
    def _compare_states(
        self,
        desired_state: State,
        actual_state: ScannedState
    ) -> List[DriftItem]:
        """Compare desired and actual states to find drift.
        
        Args:
            desired_state: Desired state from state file
            actual_state: Actual state from AWS
            
        Returns:
            List of drift items
        """
        drift_items = []
        
        # Check for missing resources (in state but not in AWS)
        for stack_name, resource in desired_state.all_resources():
            if resource.physical_id:
                if not actual_state.has_resource(resource.physical_id):
                    drift_items.append(DriftItem(
                        resource_id=resource.id,
                        resource_type=resource.type,
                        drift_type=DriftType.MISSING,
                        severity=self._assess_severity(resource, DriftType.MISSING),
                        expected_state=resource.properties,
                        actual_state=None,
                        differences=["Resource does not exist in AWS"],
                        physical_id=resource.physical_id
                    ))
        
        # Check for unexpected resources (in AWS but not in state)
        for actual_resource in actual_state.get_all_resources():
            if actual_resource.physical_id:
                state_resource = desired_state.get_resource(actual_resource.id)
                if not state_resource:
                    drift_items.append(DriftItem(
                        resource_id=actual_resource.id,
                        resource_type=actual_resource.type,
                        drift_type=DriftType.UNEXPECTED,
                        severity=DriftSeverity.LOW,
                        expected_state=None,
                        actual_state=actual_resource.properties,
                        differences=["Resource exists in AWS but not in state"],
                        physical_id=actual_resource.physical_id
                    ))
        
        # Check for modified resources
        for stack_name, desired_resource in desired_state.all_resources():
            if desired_resource.physical_id:
                actual_resource = actual_state.get_resource_by_physical_id(
                    desired_resource.physical_id
                )
                if actual_resource:
                    differences = self._find_differences(
                        desired_resource,
                        actual_resource
                    )
                    if differences:
                        drift_items.append(DriftItem(
                            resource_id=desired_resource.id,
                            resource_type=desired_resource.type,
                            drift_type=DriftType.MODIFIED,
                            severity=self._assess_severity(desired_resource, DriftType.MODIFIED),
                            expected_state=desired_resource.properties,
                            actual_state=actual_resource.properties,
                            differences=differences,
                            physical_id=desired_resource.physical_id
                        ))
        
        # Check for orphaned resources (dependencies missing)
        for stack_name, resource in desired_state.all_resources():
            if resource.dependencies:
                for dep_id in resource.dependencies:
                    dep_resource = desired_state.get_resource(dep_id)
                    if dep_resource and dep_resource.physical_id:
                        if not actual_state.has_resource(dep_resource.physical_id):
                            drift_items.append(DriftItem(
                                resource_id=resource.id,
                                resource_type=resource.type,
                                drift_type=DriftType.ORPHANED,
                                severity=DriftSeverity.HIGH,
                                expected_state=resource.properties,
                                actual_state=None,
                                differences=[f"Dependency {dep_id} is missing"],
                                physical_id=resource.physical_id
                            ))
        
        return drift_items
    
    def _find_differences(
        self,
        desired: Resource,
        actual: Resource
    ) -> List[str]:
        """Find differences between desired and actual resource.
        
        Args:
            desired: Desired resource
            actual: Actual resource
            
        Returns:
            List of difference descriptions
        """
        differences = []
        
        # Compare tags
        if desired.tags != actual.tags:
            missing_tags = set(desired.tags.keys()) - set(actual.tags.keys())
            extra_tags = set(actual.tags.keys()) - set(desired.tags.keys())
            changed_tags = {
                k for k in desired.tags.keys() & actual.tags.keys()
                if desired.tags[k] != actual.tags[k]
            }
            
            if missing_tags:
                differences.append(f"Missing tags: {', '.join(missing_tags)}")
            if extra_tags:
                differences.append(f"Extra tags: {', '.join(extra_tags)}")
            if changed_tags:
                differences.append(f"Changed tags: {', '.join(changed_tags)}")
        
        # Note: Full property comparison would require service-specific logic
        # For now, we just check tags which are universally available
        
        return differences
    
    def _assess_severity(
        self,
        resource: Resource,
        drift_type: DriftType
    ) -> DriftSeverity:
        """Assess severity of drift.
        
        Args:
            resource: Resource with drift
            drift_type: Type of drift
            
        Returns:
            DriftSeverity
        """
        # Simple heuristic - could be enhanced with LLM
        if drift_type == DriftType.MISSING:
            # Missing resources are critical if they're core infrastructure
            if resource.type in ['AWS::Lambda::Function', 'AWS::ApiGateway::RestApi']:
                return DriftSeverity.CRITICAL
            elif resource.type in ['AWS::IAM::Role', 'AWS::EC2::VPC']:
                return DriftSeverity.HIGH
            else:
                return DriftSeverity.MEDIUM
        
        elif drift_type == DriftType.ORPHANED:
            return DriftSeverity.HIGH
        
        elif drift_type == DriftType.MODIFIED:
            return DriftSeverity.MEDIUM
        
        elif drift_type == DriftType.UNEXPECTED:
            return DriftSeverity.LOW
        
        return DriftSeverity.MEDIUM
