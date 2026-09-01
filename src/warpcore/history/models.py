"""Data models for deployment history."""

from datetime import datetime
from typing import Any, Dict, List, Optional
from pydantic import BaseModel, Field
from enum import Enum


class DeploymentStatus(Enum):
    """Status of a deployment."""

    SUCCESS = "success"
    FAILED = "failed"
    IN_PROGRESS = "in_progress"
    CANCELLED = "cancelled"


class LogLevel(Enum):
    """Log entry level."""

    DEBUG = "DEBUG"
    INFO = "INFO"
    WARNING = "WARNING"
    ERROR = "ERROR"


class LogEntry(BaseModel):
    """Structured log entry."""

    timestamp: datetime = Field(..., description="Log timestamp")
    level: LogLevel = Field(..., description="Log level")
    message: str = Field(..., description="Log message")
    resource_id: Optional[str] = Field(None, description="Associated resource ID")
    context: Dict[str, Any] = Field(default_factory=dict, description="Additional context")


class APICall(BaseModel):
    """AWS API call record."""

    service: str = Field(..., description="AWS service name (e.g., 'lambda', 'iam')")
    operation: str = Field(..., description="API operation (e.g., 'CreateFunction')")
    resource_id: Optional[str] = Field(None, description="Associated resource ID")
    start_time: datetime = Field(..., description="Call start time")
    duration: float = Field(..., description="Duration in seconds")
    status_code: int = Field(..., description="HTTP status code")
    request: Optional[Dict[str, Any]] = Field(None, description="Request parameters")
    response: Optional[Dict[str, Any]] = Field(None, description="Response data")
    error: Optional[str] = Field(None, description="Error message if failed")


class ResourceChange(BaseModel):
    """Record of a resource change."""

    resource_id: str = Field(..., description="Resource ID")
    change_type: str = Field(..., description="Type of change (created, updated, deleted)")
    resource_type: str = Field(..., description="AWS resource type")
    physical_id: Optional[str] = Field(None, description="Physical resource ID/ARN")


class DeploymentMetadata(BaseModel):
    """Metadata for a deployment."""

    deployment_id: str = Field(..., description="Unique deployment ID")
    project_name: str = Field(..., description="Project name")
    environment: str = Field(..., description="Environment name")
    start_time: datetime = Field(..., description="Deployment start time")
    end_time: Optional[datetime] = Field(None, description="Deployment end time")
    duration: float = Field(0.0, description="Duration in seconds")
    status: DeploymentStatus = Field(..., description="Deployment status")
    deployed_by: str = Field(..., description="IAM user/role ARN that deployed")
    deployment_method: str = Field("cli", description="Deployment method (cli, api, etc.)")
    version: str = Field(..., description="Deployment system version")
    changes: Dict[str, List[str]] = Field(
        default_factory=dict, description="Resource changes (created, updated, deleted)"
    )
    resource_count: int = Field(0, description="Total number of resources")
    estimated_cost: float = Field(0.0, description="Estimated monthly cost in USD")
    tags: Dict[str, str] = Field(default_factory=dict, description="Deployment tags")
    error_message: Optional[str] = Field(None, description="Error message if failed")

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for JSON serialization."""
        return {
            "deploymentId": self.deployment_id,
            "projectName": self.project_name,
            "environment": self.environment,
            "startTime": self.start_time.isoformat(),
            "endTime": self.end_time.isoformat() if self.end_time else None,
            "duration": self.duration,
            "status": self.status.value,
            "deployedBy": self.deployed_by,
            "deploymentMethod": self.deployment_method,
            "version": self.version,
            "changes": self.changes,
            "resourceCount": self.resource_count,
            "estimatedCost": self.estimated_cost,
            "tags": self.tags,
            "errorMessage": self.error_message,
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "DeploymentMetadata":
        """Create from dictionary."""
        return cls(
            deployment_id=data["deploymentId"],
            project_name=data["projectName"],
            environment=data["environment"],
            start_time=datetime.fromisoformat(data["startTime"]),
            end_time=datetime.fromisoformat(data["endTime"]) if data.get("endTime") else None,
            duration=data.get("duration", 0.0),
            status=DeploymentStatus(data["status"]),
            deployed_by=data["deployedBy"],
            deployment_method=data.get("deploymentMethod", "cli"),
            version=data["version"],
            changes=data.get("changes", {}),
            resource_count=data.get("resourceCount", 0),
            estimated_cost=data.get("estimatedCost", 0.0),
            tags=data.get("tags", {}),
            error_message=data.get("errorMessage"),
        )


class DeploymentRecord(BaseModel):
    """Complete deployment record with all artifacts."""

    metadata: DeploymentMetadata = Field(..., description="Deployment metadata")
    config: Dict[str, Any] = Field(..., description="Configuration used for deployment")
    state_before: Optional[Dict[str, Any]] = Field(None, description="State before deployment")
    state_after: Dict[str, Any] = Field(..., description="State after deployment")
    execution_log: List[LogEntry] = Field(
        default_factory=list, description="Structured execution logs"
    )
    resource_logs: Dict[str, str] = Field(
        default_factory=dict, description="Per-resource logs"
    )
    api_calls: List[APICall] = Field(default_factory=list, description="AWS API calls made")


class ConfigDiff(BaseModel):
    """Configuration difference between deployments."""

    added: Dict[str, Any] = Field(default_factory=dict, description="Added configuration")
    removed: Dict[str, Any] = Field(default_factory=dict, description="Removed configuration")
    modified: Dict[str, Any] = Field(
        default_factory=dict, description="Modified configuration (old -> new)"
    )


class StateDiff(BaseModel):
    """State difference between deployments."""

    added_resources: List[str] = Field(default_factory=list, description="Added resource IDs")
    removed_resources: List[str] = Field(default_factory=list, description="Removed resource IDs")
    modified_resources: List[str] = Field(
        default_factory=list, description="Modified resource IDs"
    )


class DeploymentDiff(BaseModel):
    """Difference between two deployments."""

    deployment_id_1: str = Field(..., description="First deployment ID")
    deployment_id_2: str = Field(..., description="Second deployment ID")
    config_diff: ConfigDiff = Field(..., description="Configuration differences")
    state_diff: StateDiff = Field(..., description="State differences")
    duration_diff: float = Field(..., description="Duration difference in seconds")
    cost_diff: float = Field(..., description="Cost difference in USD")
