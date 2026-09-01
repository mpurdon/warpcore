"""Append-only audit log.

Entries are written as JSONL under ``.warpcore/audit/<environment>.jsonl``.
The file is never rewritten in place: marking an entry undone appends a marker
line referencing it, and markers are folded in at read time. An audit trail
that can be edited after the fact is not an audit trail.
"""

import json
import os
import threading
import uuid
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, Iterator, List, Optional

from warpcore.audit.models import (
    ApiCall,
    AuditEntry,
    AuditOperation,
    AuditStatus,
)
from warpcore.state.models import Resource
from warpcore.utils.logging import get_logger

logger = get_logger(__name__)

DEFAULT_AUDIT_DIR = Path(".warpcore") / "audit"

_MARKER_KEY = "_marker"


def resource_snapshot(resource: Optional[Resource]) -> Optional[Dict[str, Any]]:
    """Serialise a state Resource for storage in an audit entry."""
    if resource is None:
        return None
    return {
        "id": resource.id,
        "type": resource.type,
        "physical_id": resource.physical_id,
        "properties": resource.properties,
        "dependencies": resource.dependencies,
        "tags": resource.tags,
        "metadata": resource.metadata,
    }


def resource_from_snapshot(snapshot: Dict[str, Any]) -> Resource:
    """Rebuild a state Resource from an audit snapshot."""
    return Resource(**snapshot)


class AuditRecorder:
    """Writes and reads the audit trail for one environment."""

    def __init__(
        self,
        environment: str,
        audit_dir: Optional[Path] = None,
        session_id: Optional[str] = None,
        actor: str = "",
        command: str = "",
        project_name: str = "",
        region: str = "",
        enabled: bool = True,
    ):
        self.environment = environment
        self.audit_dir = Path(audit_dir) if audit_dir else DEFAULT_AUDIT_DIR
        self.session_id = session_id or uuid.uuid4().hex[:8]
        self.actor = actor
        self.command = command
        self.project_name = project_name
        self.region = region
        self.enabled = enabled
        self._lock = threading.Lock()
        self.logger = get_logger(__name__)

    @property
    def path(self) -> Path:
        """Path to this environment's audit log."""
        return self.audit_dir / f"{self.environment}.jsonl"

    # ---------------------------------------------------------------- writing

    def record(self, entry: AuditEntry) -> AuditEntry:
        """Append an entry to the log."""
        if not self.enabled:
            return entry

        entry.session_id = entry.session_id or self.session_id
        entry.environment = entry.environment or self.environment
        entry.project_name = entry.project_name or self.project_name
        entry.region = entry.region or self.region
        entry.actor = entry.actor or self.actor
        entry.command = entry.command or self.command

        self._append(entry.model_dump(mode="json"))
        self.logger.debug(f"audit: {entry.id} {entry.summary()}")
        return entry

    def mark_undone(self, entry_id: str, by_entry_id: str) -> None:
        """Append a marker recording that an entry has been undone."""
        if not self.enabled:
            return
        self._append({
            _MARKER_KEY: "undone",
            "entry_id": entry_id,
            "by": by_entry_id,
            "at": datetime.utcnow().isoformat(),
        })

    def _append(self, payload: Dict[str, Any]) -> None:
        """Append one JSON line, creating the log directory on demand."""
        with self._lock:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            line = json.dumps(payload, default=str, separators=(",", ":"))
            # Open per-write and fsync: a crash mid-deployment must not lose
            # the record of what had already been changed in AWS.
            with open(self.path, "a", encoding="utf-8") as f:
                f.write(line + "\n")
                f.flush()
                os.fsync(f.fileno())

    @contextmanager
    def operation(
        self,
        operation: AuditOperation,
        resource_id: str,
        resource_type: str = "",
        stack: str = "",
        before: Optional[Resource] = None,
    ) -> Iterator["OperationRecord"]:
        """Time an operation and record it, whether it succeeds or fails.

        The caller sets ``record.after`` (and optionally ``record.physical_id``
        and ``record.api_calls``) inside the block; everything else - timing,
        status, exception text - is captured automatically.
        """
        record = OperationRecord(
            operation=operation,
            resource_id=resource_id,
            resource_type=resource_type,
            stack=stack,
            before=before,
        )
        started = datetime.utcnow()
        try:
            yield record
        except Exception as e:
            record.error = str(e)
            record.status = AuditStatus.FAILED
            raise
        finally:
            entry = record.to_entry(
                duration_ms=(datetime.utcnow() - started).total_seconds() * 1000.0
            )
            self.record(entry)
            record.entry_id = entry.id

    # ---------------------------------------------------------------- reading

    def entries(
        self,
        limit: Optional[int] = None,
        operation: Optional[AuditOperation] = None,
        resource_id: Optional[str] = None,
        session_id: Optional[str] = None,
        include_undone: bool = True,
        newest_first: bool = True,
    ) -> List[AuditEntry]:
        """Read entries back, with undo markers applied."""
        if not self.path.exists():
            return []

        raw_entries: List[AuditEntry] = []
        undo_markers: Dict[str, Dict[str, Any]] = {}

        with open(self.path, "r", encoding="utf-8") as f:
            for lineno, line in enumerate(f, start=1):
                line = line.strip()
                if not line:
                    continue
                try:
                    payload = json.loads(line)
                except json.JSONDecodeError:
                    self.logger.warning(f"audit log {self.path}:{lineno} is not valid JSON; skipped")
                    continue

                if payload.get(_MARKER_KEY) == "undone":
                    undo_markers[payload["entry_id"]] = payload
                    continue

                try:
                    raw_entries.append(AuditEntry(**payload))
                except Exception as e:  # noqa: BLE001 - a bad row must not break the read
                    self.logger.warning(f"audit log {self.path}:{lineno} is not a valid entry: {e}")

        for entry in raw_entries:
            marker = undo_markers.get(entry.id)
            if marker:
                entry.undone_at = datetime.fromisoformat(marker["at"])
                entry.undone_by_entry = marker.get("by")
                entry.status = AuditStatus.UNDONE

        results = raw_entries
        if operation is not None:
            results = [e for e in results if e.operation is operation]
        if resource_id is not None:
            results = [e for e in results if e.resource_id == resource_id]
        if session_id is not None:
            results = [e for e in results if e.session_id == session_id]
        if not include_undone:
            results = [e for e in results if not e.is_undone()]

        results.sort(key=lambda e: e.timestamp, reverse=newest_first)
        if limit is not None:
            results = results[:limit]
        return results

    def get(self, entry_id: str) -> Optional[AuditEntry]:
        """Look up one entry by full id or unambiguous prefix."""
        matches = [e for e in self.entries(newest_first=False) if e.id.startswith(entry_id)]
        if not matches:
            return None
        if len(matches) > 1 and not any(e.id == entry_id for e in matches):
            raise ValueError(
                f"'{entry_id}' matches {len(matches)} entries: "
                + ", ".join(e.id for e in matches[:5])
            )
        exact = [e for e in matches if e.id == entry_id]
        return exact[0] if exact else matches[0]

    def sessions(self, limit: int = 20) -> List[Dict[str, Any]]:
        """Group entries into CLI sessions, newest first."""
        grouped: Dict[str, Dict[str, Any]] = {}
        for entry in self.entries(newest_first=False):
            bucket = grouped.setdefault(entry.session_id, {
                "session_id": entry.session_id,
                "started": entry.timestamp,
                "ended": entry.timestamp,
                "command": entry.command,
                "actor": entry.actor,
                "count": 0,
                "failed": 0,
            })
            bucket["ended"] = entry.timestamp
            bucket["count"] += 1
            if entry.status is AuditStatus.FAILED:
                bucket["failed"] += 1

        ordered = sorted(grouped.values(), key=lambda s: s["started"], reverse=True)
        return ordered[:limit]


class OperationRecord:
    """Mutable handle yielded by ``AuditRecorder.operation``."""

    def __init__(
        self,
        operation: AuditOperation,
        resource_id: str,
        resource_type: str = "",
        stack: str = "",
        before: Optional[Resource] = None,
    ):
        self.operation = operation
        self.resource_id = resource_id
        self.resource_type = resource_type
        self.stack = stack
        self.before: Optional[Resource] = before
        self.after: Optional[Resource] = None
        self.physical_id: Optional[str] = None
        self.status: AuditStatus = AuditStatus.SUCCESS
        self.error: Optional[str] = None
        self.api_calls: List[ApiCall] = []
        self.undoes_entry: Optional[str] = None
        self.entry_id: Optional[str] = None

    def to_entry(self, duration_ms: float) -> AuditEntry:
        """Build the immutable entry that gets written to the log."""
        physical = self.physical_id
        if physical is None and self.after is not None:
            physical = self.after.physical_id
        if physical is None and self.before is not None:
            physical = self.before.physical_id

        return AuditEntry(
            operation=self.operation,
            status=self.status,
            resource_id=self.resource_id,
            resource_type=self.resource_type or (
                self.after.type if self.after else
                self.before.type if self.before else ""
            ),
            physical_id=physical,
            stack=self.stack,
            before=resource_snapshot(self.before),
            after=resource_snapshot(self.after),
            duration_ms=duration_ms,
            error=self.error,
            api_calls=self.api_calls,
            undoes_entry=self.undoes_entry,
        )
