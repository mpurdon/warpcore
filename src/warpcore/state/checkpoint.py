"""Checkpoint system for deployment recovery."""

import json
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

from .models import State


class CheckpointError(Exception):
    """Base exception for checkpoint errors."""

    pass


class Checkpoint:
    """Represents a deployment checkpoint."""

    def __init__(
        self,
        checkpoint_id: str,
        deployment_id: str,
        timestamp: datetime,
        completed_resources: List[str],
        pending_resources: List[str],
        failed_resources: List[str],
        state_snapshot: State,
        metadata: Optional[Dict[str, Any]] = None,
    ):
        """
        Initialize Checkpoint.

        Args:
            checkpoint_id: Unique checkpoint identifier
            deployment_id: Deployment identifier
            timestamp: Checkpoint creation time
            completed_resources: List of successfully deployed resource IDs
            pending_resources: List of resource IDs yet to be deployed
            failed_resources: List of resource IDs that failed deployment
            state_snapshot: State snapshot at checkpoint time
            metadata: Additional metadata
        """
        self.checkpoint_id = checkpoint_id
        self.deployment_id = deployment_id
        self.timestamp = timestamp
        self.completed_resources = completed_resources
        self.pending_resources = pending_resources
        self.failed_resources = failed_resources
        self.state_snapshot = state_snapshot
        self.metadata = metadata or {}

    def to_dict(self) -> Dict[str, Any]:
        """Convert checkpoint to dictionary for serialization."""
        return {
            "checkpoint_id": self.checkpoint_id,
            "deployment_id": self.deployment_id,
            "timestamp": self.timestamp.isoformat(),
            "completed_resources": self.completed_resources,
            "pending_resources": self.pending_resources,
            "failed_resources": self.failed_resources,
            "state_snapshot": self.state_snapshot.to_dict(),
            "metadata": self.metadata,
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "Checkpoint":
        """Create Checkpoint from dictionary."""
        return cls(
            checkpoint_id=data["checkpoint_id"],
            deployment_id=data["deployment_id"],
            timestamp=datetime.fromisoformat(data["timestamp"]),
            completed_resources=data["completed_resources"],
            pending_resources=data["pending_resources"],
            failed_resources=data["failed_resources"],
            state_snapshot=State.from_dict(data["state_snapshot"]),
            metadata=data.get("metadata", {}),
        )


class CheckpointManager:
    """Manages deployment checkpoints for recovery."""

    def __init__(self, checkpoint_dir: str):
        """
        Initialize CheckpointManager.

        Args:
            checkpoint_dir: Directory to store checkpoint files
        """
        self.checkpoint_dir = Path(checkpoint_dir)
        self.checkpoint_dir.mkdir(parents=True, exist_ok=True)

    def _get_checkpoint_path(self, deployment_id: str) -> Path:
        """Get path to checkpoint file for a deployment."""
        return self.checkpoint_dir / f"{deployment_id}.checkpoint.json"

    def save_checkpoint(
        self,
        deployment_id: str,
        completed_resources: List[str],
        pending_resources: List[str],
        failed_resources: List[str],
        state_snapshot: State,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> Checkpoint:
        """
        Save a deployment checkpoint.

        Args:
            deployment_id: Deployment identifier
            completed_resources: List of successfully deployed resource IDs
            pending_resources: List of resource IDs yet to be deployed
            failed_resources: List of resource IDs that failed deployment
            state_snapshot: Current state snapshot
            metadata: Additional metadata

        Returns:
            Created Checkpoint object

        Raises:
            CheckpointError: If checkpoint cannot be saved
        """
        checkpoint_id = f"{deployment_id}-{datetime.utcnow().strftime('%Y%m%d%H%M%S')}"
        checkpoint = Checkpoint(
            checkpoint_id=checkpoint_id,
            deployment_id=deployment_id,
            timestamp=datetime.utcnow(),
            completed_resources=completed_resources,
            pending_resources=pending_resources,
            failed_resources=failed_resources,
            state_snapshot=state_snapshot,
            metadata=metadata,
        )

        try:
            checkpoint_path = self._get_checkpoint_path(deployment_id)
            with open(checkpoint_path, "w") as f:
                json.dump(checkpoint.to_dict(), f, indent=2)
            return checkpoint
        except Exception as e:
            raise CheckpointError(f"Failed to save checkpoint: {e}")

    def load_checkpoint(self, deployment_id: str) -> Optional[Checkpoint]:
        """
        Load the most recent checkpoint for a deployment.

        Args:
            deployment_id: Deployment identifier

        Returns:
            Checkpoint object or None if no checkpoint exists

        Raises:
            CheckpointError: If checkpoint file is corrupted
        """
        checkpoint_path = self._get_checkpoint_path(deployment_id)

        if not checkpoint_path.exists():
            return None

        try:
            with open(checkpoint_path, "r") as f:
                data = json.load(f)
                return Checkpoint.from_dict(data)
        except json.JSONDecodeError as e:
            raise CheckpointError(f"Failed to parse checkpoint file: {e}")
        except Exception as e:
            raise CheckpointError(f"Failed to load checkpoint: {e}")

    def has_checkpoint(self, deployment_id: str) -> bool:
        """
        Check if a checkpoint exists for a deployment.

        Args:
            deployment_id: Deployment identifier

        Returns:
            True if checkpoint exists, False otherwise
        """
        return self._get_checkpoint_path(deployment_id).exists()

    def clear_checkpoint(self, deployment_id: str) -> bool:
        """
        Clear checkpoint for a deployment.

        Args:
            deployment_id: Deployment identifier

        Returns:
            True if checkpoint was deleted, False if it didn't exist
        """
        checkpoint_path = self._get_checkpoint_path(deployment_id)
        if checkpoint_path.exists():
            checkpoint_path.unlink()
            return True
        return False

    def list_checkpoints(self) -> List[str]:
        """
        List all deployment IDs with checkpoints.

        Returns:
            List of deployment IDs
        """
        checkpoints = []
        for checkpoint_file in self.checkpoint_dir.glob("*.checkpoint.json"):
            # Extract deployment_id from filename
            deployment_id = checkpoint_file.stem.replace(".checkpoint", "")
            checkpoints.append(deployment_id)
        return checkpoints

    def get_resume_plan(self, deployment_id: str) -> Optional[Dict[str, Any]]:
        """
        Get a resume plan for an interrupted deployment.

        Args:
            deployment_id: Deployment identifier

        Returns:
            Dictionary with resume plan details or None if no checkpoint

        Raises:
            CheckpointError: If checkpoint cannot be loaded
        """
        checkpoint = self.load_checkpoint(deployment_id)
        if checkpoint is None:
            return None

        return {
            "deployment_id": deployment_id,
            "checkpoint_id": checkpoint.checkpoint_id,
            "checkpoint_time": checkpoint.timestamp.isoformat(),
            "completed_count": len(checkpoint.completed_resources),
            "pending_count": len(checkpoint.pending_resources),
            "failed_count": len(checkpoint.failed_resources),
            "completed_resources": checkpoint.completed_resources,
            "pending_resources": checkpoint.pending_resources,
            "failed_resources": checkpoint.failed_resources,
            "can_resume": len(checkpoint.pending_resources) > 0,
            "needs_cleanup": len(checkpoint.failed_resources) > 0,
        }

    def cleanup_old_checkpoints(self, max_age_days: int = 7) -> int:
        """
        Clean up checkpoints older than specified days.

        Args:
            max_age_days: Maximum age of checkpoints to keep

        Returns:
            Number of checkpoints deleted
        """
        deleted_count = 0
        cutoff_time = datetime.utcnow().timestamp() - (max_age_days * 86400)

        for checkpoint_file in self.checkpoint_dir.glob("*.checkpoint.json"):
            if checkpoint_file.stat().st_mtime < cutoff_time:
                checkpoint_file.unlink()
                deleted_count += 1

        return deleted_count


class DeploymentRecovery:
    """Handles deployment recovery from checkpoints."""

    def __init__(self, checkpoint_manager: CheckpointManager):
        """
        Initialize DeploymentRecovery.

        Args:
            checkpoint_manager: CheckpointManager instance
        """
        self.checkpoint_manager = checkpoint_manager

    def can_resume(self, deployment_id: str) -> bool:
        """
        Check if a deployment can be resumed.

        Args:
            deployment_id: Deployment identifier

        Returns:
            True if deployment can be resumed, False otherwise
        """
        resume_plan = self.checkpoint_manager.get_resume_plan(deployment_id)
        return resume_plan is not None and resume_plan["can_resume"]

    def get_recovery_state(self, deployment_id: str) -> Optional[State]:
        """
        Get the state snapshot from checkpoint for recovery.

        Args:
            deployment_id: Deployment identifier

        Returns:
            State snapshot or None if no checkpoint
        """
        checkpoint = self.checkpoint_manager.load_checkpoint(deployment_id)
        return checkpoint.state_snapshot if checkpoint else None

    def get_pending_resources(self, deployment_id: str) -> List[str]:
        """
        Get list of resources that still need to be deployed.

        Args:
            deployment_id: Deployment identifier

        Returns:
            List of pending resource IDs
        """
        checkpoint = self.checkpoint_manager.load_checkpoint(deployment_id)
        return checkpoint.pending_resources if checkpoint else []

    def get_failed_resources(self, deployment_id: str) -> List[str]:
        """
        Get list of resources that failed deployment.

        Args:
            deployment_id: Deployment identifier

        Returns:
            List of failed resource IDs
        """
        checkpoint = self.checkpoint_manager.load_checkpoint(deployment_id)
        return checkpoint.failed_resources if checkpoint else []

    def should_skip_resource(self, deployment_id: str, resource_id: str) -> bool:
        """
        Check if a resource should be skipped during resume (already completed).

        Args:
            deployment_id: Deployment identifier
            resource_id: Resource ID to check

        Returns:
            True if resource should be skipped, False otherwise
        """
        checkpoint = self.checkpoint_manager.load_checkpoint(deployment_id)
        if checkpoint is None:
            return False
        return resource_id in checkpoint.completed_resources

    def mark_resource_completed(
        self, deployment_id: str, resource_id: str, state_snapshot: State
    ) -> None:
        """
        Mark a resource as completed in the checkpoint.

        Args:
            deployment_id: Deployment identifier
            resource_id: Resource ID that was completed
            state_snapshot: Updated state snapshot
        """
        checkpoint = self.checkpoint_manager.load_checkpoint(deployment_id)
        if checkpoint is None:
            return

        # Move resource from pending to completed
        if resource_id in checkpoint.pending_resources:
            checkpoint.pending_resources.remove(resource_id)
        if resource_id not in checkpoint.completed_resources:
            checkpoint.completed_resources.append(resource_id)

        # Update state snapshot
        checkpoint.state_snapshot = state_snapshot
        checkpoint.timestamp = datetime.utcnow()

        # Save updated checkpoint
        self.checkpoint_manager.save_checkpoint(
            deployment_id=deployment_id,
            completed_resources=checkpoint.completed_resources,
            pending_resources=checkpoint.pending_resources,
            failed_resources=checkpoint.failed_resources,
            state_snapshot=state_snapshot,
            metadata=checkpoint.metadata,
        )

    def mark_resource_failed(
        self, deployment_id: str, resource_id: str, error: str, state_snapshot: State
    ) -> None:
        """
        Mark a resource as failed in the checkpoint.

        Args:
            deployment_id: Deployment identifier
            resource_id: Resource ID that failed
            error: Error message
            state_snapshot: Current state snapshot
        """
        checkpoint = self.checkpoint_manager.load_checkpoint(deployment_id)
        if checkpoint is None:
            return

        # Move resource from pending to failed
        if resource_id in checkpoint.pending_resources:
            checkpoint.pending_resources.remove(resource_id)
        if resource_id not in checkpoint.failed_resources:
            checkpoint.failed_resources.append(resource_id)

        # Add error to metadata
        if "errors" not in checkpoint.metadata:
            checkpoint.metadata["errors"] = {}
        checkpoint.metadata["errors"][resource_id] = error

        # Update state snapshot
        checkpoint.state_snapshot = state_snapshot
        checkpoint.timestamp = datetime.utcnow()

        # Save updated checkpoint
        self.checkpoint_manager.save_checkpoint(
            deployment_id=deployment_id,
            completed_resources=checkpoint.completed_resources,
            pending_resources=checkpoint.pending_resources,
            failed_resources=checkpoint.failed_resources,
            state_snapshot=state_snapshot,
            metadata=checkpoint.metadata,
        )
