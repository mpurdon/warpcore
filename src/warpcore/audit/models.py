"""Audit trail data models.

An audit entry records one mutating operation against AWS, with enough
before/after detail to reverse it. This is deliberately finer-grained than
`warpcore history`, which records whole deployments: history answers "what did
deploy #7 change", audit answers "what exactly happened to this one resource,
and can I put it back".
"""

import uuid
from datetime import datetime
from enum import Enum
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field


class AuditOperation(str, Enum):
    """The kind of mutation an entry records."""

    CREATE = "create"
    UPDATE = "update"
    DELETE = "delete"
    ADOPT = "adopt"            # wrote a discovered resource into state
    STATE_WRITE = "state_write"  # state-only change, no AWS call


class AuditStatus(str, Enum):
    """Outcome of the recorded operation."""

    SUCCESS = "success"
    FAILED = "failed"
    UNDONE = "undone"


class UndoKind(str, Enum):
    """How an entry would be reversed."""

    DESTROY = "destroy"              # undo a create
    REPROVISION = "reprovision"      # undo an update, re-applying `before`
    RECREATE = "recreate"            # undo a delete
    STATE_RESTORE = "state_restore"  # undo a state-only change
    NONE = "none"                    # nothing to undo
    UNSUPPORTED = "unsupported"      # cannot be reversed automatically


class ApiCall(BaseModel):
    """One AWS API call made during the operation."""

    service: str
    operation: str
    duration_ms: float = 0.0
    status_code: Optional[int] = None
    error_code: Optional[str] = None
    request_id: Optional[str] = None
    timestamp: datetime = Field(default_factory=datetime.utcnow)


class AuditEntry(BaseModel):
    """A single reversible operation."""

    id: str = Field(default_factory=lambda: uuid.uuid4().hex[:12])
    timestamp: datetime = Field(default_factory=datetime.utcnow)
    session_id: str = Field("", description="Groups entries from one CLI invocation")

    operation: AuditOperation
    status: AuditStatus = AuditStatus.SUCCESS

    resource_id: str
    resource_type: str = ""
    physical_id: Optional[str] = None
    stack: str = ""

    environment: str = ""
    project_name: str = ""
    region: str = ""

    # Full resource snapshots. `before` is what undo restores; `after` is what
    # undo removes. Either may be None depending on the operation.
    before: Optional[Dict[str, Any]] = None
    after: Optional[Dict[str, Any]] = None

    duration_ms: float = 0.0
    error: Optional[str] = None
    api_calls: List[ApiCall] = Field(default_factory=list)

    actor: str = Field("", description="IAM identity that performed the operation")
    command: str = Field("", description="CLI command that triggered it")

    # Undo bookkeeping
    undone_at: Optional[datetime] = None
    undone_by_entry: Optional[str] = None
    undoes_entry: Optional[str] = None

    def is_undone(self) -> bool:
        return self.undone_at is not None

    def is_undoable(self) -> bool:
        """Whether this entry is a candidate for undo at all."""
        if self.status is AuditStatus.FAILED:
            return False
        if self.is_undone():
            return False
        if self.undoes_entry:
            # Do not allow undoing an undo; redo is an explicit re-run.
            return False
        # UNSUPPORTED means the snapshot needed to reverse it was never
        # captured, which is just as un-undoable as having no reversal at all.
        return self.undo_kind() not in (UndoKind.NONE, UndoKind.UNSUPPORTED)

    def undo_kind(self) -> UndoKind:
        """How this entry would be reversed."""
        if self.operation is AuditOperation.CREATE:
            return UndoKind.DESTROY if self.physical_id else UndoKind.UNSUPPORTED
        if self.operation is AuditOperation.UPDATE:
            return UndoKind.REPROVISION if self.before else UndoKind.UNSUPPORTED
        if self.operation is AuditOperation.DELETE:
            return UndoKind.RECREATE if self.before else UndoKind.UNSUPPORTED
        if self.operation in (AuditOperation.ADOPT, AuditOperation.STATE_WRITE):
            return UndoKind.STATE_RESTORE
        return UndoKind.NONE

    def summary(self) -> str:
        """One-line human description."""
        verb = {
            AuditOperation.CREATE: "created",
            AuditOperation.UPDATE: "updated",
            AuditOperation.DELETE: "deleted",
            AuditOperation.ADOPT: "adopted",
            AuditOperation.STATE_WRITE: "wrote state for",
        }[self.operation]
        return f"{verb} {self.resource_id} ({self.resource_type})"

    def changed_properties(self) -> Dict[str, Any]:
        """Property-level diff between before and after, for display."""
        before_props = (self.before or {}).get("properties", {}) or {}
        after_props = (self.after or {}).get("properties", {}) or {}

        changes: Dict[str, Any] = {}
        for key in sorted(set(before_props) | set(after_props)):
            old = before_props.get(key)
            new = after_props.get(key)
            if old != new:
                changes[key] = {"before": old, "after": new}
        return changes


class UndoStep(BaseModel):
    """One action in an undo plan."""

    kind: UndoKind
    resource_id: str
    resource_type: str
    physical_id: Optional[str] = None
    description: str
    destructive: bool = False


class UndoPlan(BaseModel):
    """What undoing an entry would do, before it does it."""

    entry_id: str
    steps: List[UndoStep] = Field(default_factory=list)
    blocked_reason: Optional[str] = None

    def is_executable(self) -> bool:
        return self.blocked_reason is None and bool(self.steps)

    def has_destructive_steps(self) -> bool:
        return any(step.destructive for step in self.steps)
