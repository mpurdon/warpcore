"""Data models for agentic reconciliation system."""

from datetime import datetime
from enum import Enum
from typing import Any, Dict, List, Optional
from pydantic import BaseModel, Field

from strands_deploy.state.models import Resource


class DriftType(Enum):
    """Types of infrastructure drift."""
    MISSING = "missing"  # Resource in state but not in AWS
    UNEXPECTED = "unexpected"  # Resource in AWS but not in state
    MODIFIED = "modified"  # Resource properties differ
    ORPHANED = "orphaned"  # Resource exists but dependencies missing


class DriftSeverity(Enum):
    """Severity levels for drift."""
    CRITICAL = "critical"  # Service is down or severely impacted
    HIGH = "high"  # Significant functionality affected
    MEDIUM = "medium"  # Minor functionality affected
    LOW = "low"  # Cosmetic or non-functional drift


class DriftItem(BaseModel):
    """Represents a single drift detection."""
    
    resource_id: str = Field(..., description="Logical resource ID")
    resource_type: str = Field(..., description="AWS resource type")
    drift_type: DriftType = Field(..., description="Type of drift detected")
    severity: DriftSeverity = Field(..., description="Severity of the drift")
    expected_state: Optional[Dict[str, Any]] = Field(None, description="Expected resource state")
    actual_state: Optional[Dict[str, Any]] = Field(None, description="Actual resource state")
    differences: List[str] = Field(default_factory=list, description="List of specific differences")
    physical_id: Optional[str] = Field(None, description="Physical AWS resource ID")
    detected_at: datetime = Field(default_factory=datetime.utcnow, description="When drift was detected")


class DriftAnalysis(BaseModel):
    """LLM analysis of drift."""
    
    summary: str = Field(..., description="Natural language summary of drift")
    root_cause: Optional[str] = Field(None, description="Likely root cause of drift")
    impact: str = Field(..., description="Impact assessment")
    recommendations: List[str] = Field(default_factory=list, description="Recommended actions")
    confidence: float = Field(..., ge=0.0, le=1.0, description="Confidence score (0-1)")


class DriftReport(BaseModel):
    """Complete drift detection report."""
    
    drift_items: List[DriftItem] = Field(default_factory=list, description="List of detected drift")
    analysis: Optional[DriftAnalysis] = Field(None, description="LLM analysis of drift")
    total_resources_checked: int = Field(..., description="Total resources checked")
    drift_count: int = Field(..., description="Number of drifts detected")
    generated_at: datetime = Field(default_factory=datetime.utcnow, description="Report generation time")
    
    def has_drift(self) -> bool:
        """Check if any drift was detected."""
        return len(self.drift_items) > 0
    
    def get_critical_drift(self) -> List[DriftItem]:
        """Get critical severity drift items."""
        return [d for d in self.drift_items if d.severity == DriftSeverity.CRITICAL]
    
    def get_by_type(self, drift_type: DriftType) -> List[DriftItem]:
        """Get drift items by type."""
        return [d for d in self.drift_items if d.drift_type == drift_type]


class FailureContext(BaseModel):
    """Context information for failure analysis."""
    
    error_message: str = Field(..., description="Error message")
    error_type: str = Field(..., description="Error type/category")
    resource_id: Optional[str] = Field(None, description="Resource that failed")
    resource_type: Optional[str] = Field(None, description="Type of resource")
    resource_config: Optional[Dict[str, Any]] = Field(None, description="Resource configuration")
    operation: Optional[str] = Field(None, description="Operation being performed")
    aws_request_id: Optional[str] = Field(None, description="AWS request ID")
    logs: List[str] = Field(default_factory=list, description="Relevant log entries")
    state_snapshot: Optional[Dict[str, Any]] = Field(None, description="State at time of failure")


class FailureAnalysis(BaseModel):
    """LLM analysis of deployment failure."""
    
    root_cause: str = Field(..., description="Identified root cause")
    explanation: str = Field(..., description="Detailed explanation of the failure")
    suggested_fixes: List[str] = Field(default_factory=list, description="Suggested fixes")
    confidence: float = Field(..., ge=0.0, le=1.0, description="Confidence score (0-1)")
    related_issues: List[str] = Field(default_factory=list, description="Related known issues")
    prevention_tips: List[str] = Field(default_factory=list, description="Tips to prevent recurrence")


class MissingResource(BaseModel):
    """Represents a resource that should exist but doesn't."""
    
    resource_id: str = Field(..., description="Logical resource ID")
    resource_type: str = Field(..., description="AWS resource type")
    expected_config: Dict[str, Any] = Field(..., description="Expected configuration")
    dependencies: List[str] = Field(default_factory=list, description="Resource dependencies")
    priority: int = Field(..., ge=1, le=10, description="Priority (1=highest, 10=lowest)")
    impact: str = Field(..., description="Impact of missing resource")
    reason: Optional[str] = Field(None, description="Likely reason for missing")


class RecoveryAction(BaseModel):
    """A single recovery action."""
    
    action_type: str = Field(..., description="Type of action (create, update, delete)")
    resource_id: str = Field(..., description="Resource to act on")
    resource_type: str = Field(..., description="AWS resource type")
    configuration: Dict[str, Any] = Field(..., description="Resource configuration")
    dependencies: List[str] = Field(default_factory=list, description="Action dependencies")
    rationale: str = Field(..., description="Why this action is needed")


class RecoveryPlan(BaseModel):
    """Plan for recovering from drift or failures."""
    
    actions: List[RecoveryAction] = Field(default_factory=list, description="Recovery actions")
    explanation: str = Field(..., description="Overall explanation of recovery plan")
    estimated_duration: Optional[int] = Field(None, description="Estimated duration in seconds")
    risks: List[str] = Field(default_factory=list, description="Potential risks")
    rollback_plan: Optional[str] = Field(None, description="How to rollback if recovery fails")
    
    def get_action_count(self) -> int:
        """Get total number of actions."""
        return len(self.actions)
