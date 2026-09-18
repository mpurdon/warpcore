"""Progress reporting for `deploy` and `destroy`.

The executor reports through a plain callable, ``(resource_id, status, error)``.
Two consumers sit on top of it:

- ``RichRunProgress`` drives the spinner and bar a person sees in a terminal.
- ``JsonRunProgress`` writes one JSON object per line to stdout so a program
  (the Visual Builder) can follow the run: a ``plan`` event before anything
  is touched, a ``resource`` event every time a resource starts or finishes,
  and a ``complete`` event at the end. Same NDJSON shape the discovery
  commands stream, so a consumer handles both the same way.

Both keep per-resource start times so the finishing event can carry a real
duration rather than leaving the consumer to guess.
"""

import json
import sys
import time
from typing import Any, Dict, List, Optional, TextIO

from warpcore.orchestrator.executor import ExecutionStatus
from warpcore.orchestrator.planner import DeploymentPlan, DestructionPlan

# Event names. Producers and consumers share these so spelling cannot drift.
PLAN = "plan"
RESOURCE = "resource"
COMPLETE = "complete"
ERROR = "error"


class RunProgress:
    """Base callable that tracks timing; subclasses decide how to show it."""

    def __init__(self) -> None:
        self._started = time.monotonic()
        self._resource_started: Dict[str, float] = {}
        self.total = 0
        self.completed = 0

    def elapsed(self) -> float:
        return round(time.monotonic() - self._started, 2)

    def __call__(self, resource_id: str, status: ExecutionStatus, error: Optional[str]) -> None:
        """The executor's contract. Never raises: progress must not fail a run."""
        try:
            if status == ExecutionStatus.IN_PROGRESS:
                self._resource_started[resource_id] = time.monotonic()
                self.on_resource_start(resource_id)
                return
            started = self._resource_started.pop(resource_id, None)
            duration = round(time.monotonic() - started, 2) if started is not None else None
            self.completed += 1
            self.on_resource_done(resource_id, status, error, duration)
        except Exception:  # noqa: BLE001 - a broken reporter must not stop a deployment
            pass

    # Hooks -----------------------------------------------------------------

    def on_plan(self, kind: str, plan: Any, **context: Any) -> None:
        """Called once with the plan, before execution starts."""

    def on_resource_start(self, resource_id: str) -> None:
        pass

    def on_resource_done(
        self, resource_id: str, status: ExecutionStatus, error: Optional[str], duration: Optional[float]
    ) -> None:
        pass

    def on_complete(self, kind: str, result: Any, rollback: Any = None) -> None:
        """Called once with the executor's result."""

    def on_error(self, message: str) -> None:
        """Called when the run dies before or outside execution."""


class JsonRunProgress(RunProgress):
    """NDJSON to a stream, one event per line, flushed immediately."""

    def __init__(self, stream: Optional[TextIO] = None) -> None:
        super().__init__()
        self._stream = stream or sys.stdout

    def _write(self, event: str, **fields: Any) -> None:
        payload: Dict[str, Any] = {"event": event, "elapsed": self.elapsed()}
        payload.update(fields)
        try:
            self._stream.write(json.dumps(payload, default=str, separators=(",", ":")) + "\n")
            self._stream.flush()
        except Exception:  # noqa: BLE001
            pass

    def on_plan(self, kind: str, plan: Any, **context: Any) -> None:
        changes = describe_plan(plan)
        self.total = len(changes)
        self._write(PLAN, kind=kind, total=self.total, changes=changes, **context)

    def on_resource_start(self, resource_id: str) -> None:
        self._write(RESOURCE, id=resource_id, status="in_progress")

    def on_resource_done(
        self, resource_id: str, status: ExecutionStatus, error: Optional[str], duration: Optional[float]
    ) -> None:
        self._write(
            RESOURCE,
            id=resource_id,
            status=status.value,
            error=error,
            duration=duration,
            completed=self.completed,
            total=self.total,
        )

    def on_complete(self, kind: str, result: Any, rollback: Any = None) -> None:
        fields: Dict[str, Any] = {
            "kind": kind,
            "status": _status_value(getattr(result, "status", None)),
            "total": getattr(result, "total_resources", 0),
            "successful": getattr(result, "successful_resources", 0),
            "failed": getattr(result, "failed_resources", 0),
            "skipped": getattr(result, "skipped_resources", 0),
            "duration": round(float(getattr(result, "duration", 0.0) or 0.0), 2),
            "failures": _failures(result),
        }
        if rollback is not None:
            fields["rollback"] = {
                "status": _status_value(getattr(rollback, "status", None)),
                "total": getattr(rollback, "total_resources", 0),
                "successful": getattr(rollback, "successful_resources", 0),
            }
        self._write(COMPLETE, **fields)

    def on_error(self, message: str) -> None:
        self._write(ERROR, message=message)


class RichRunProgress(RunProgress):
    """Drives a rich.progress task: the spinner and bar shown in a terminal."""

    def __init__(self, progress: Any, task_id: Any) -> None:
        super().__init__()
        self.progress = progress
        self.task_id = task_id

    def on_plan(self, kind: str, plan: Any, **context: Any) -> None:
        self.total = len(describe_plan(plan))
        self.progress.update(self.task_id, total=self.total or None)

    def on_resource_start(self, resource_id: str) -> None:
        self.progress.update(self.task_id, description=f"[cyan]Provisioning:[/cyan] {resource_id}")

    def on_resource_done(
        self, resource_id: str, status: ExecutionStatus, error: Optional[str], duration: Optional[float]
    ) -> None:
        mark = "[green]✓[/green]" if status == ExecutionStatus.SUCCESS else "[red]✗[/red]"
        self.progress.update(self.task_id, completed=self.completed, description=f"{mark} {resource_id}")

    def on_complete(self, kind: str, result: Any, rollback: Any = None) -> None:
        ok = getattr(result, "status", None) == ExecutionStatus.SUCCESS
        self.progress.update(self.task_id, description="[green]Complete[/green]" if ok else "[red]Failed[/red]")


# ---------------------------------------------------------------- helpers


def describe_plan(plan: Any) -> List[Dict[str, Any]]:
    """Every resource a plan will touch, in execution order, as plain dicts."""
    out: List[Dict[str, Any]] = []
    if isinstance(plan, DeploymentPlan):
        for wave in plan.waves:
            for resource_id in wave.resource_ids:
                change = wave.get_change(resource_id) or plan.all_changes.get(resource_id)
                desired = getattr(change, "desired_resource", None) or getattr(change, "current_resource", None)
                entry = {
                    "id": resource_id,
                    "type": getattr(desired, "type", None),
                    "change": _status_value(getattr(change, "change_type", None)),
                    "wave": wave.wave_number,
                    "reason": getattr(change, "reason", None),
                }
                if change is not None:
                    from warpcore.orchestrator.plan_detail import detail_change
                    d = detail_change(change).to_dict()
                    entry["properties"] = d["properties"]
                    entry["code"] = d["code"]
                    entry["iam"] = d["iam"]
                out.append(entry)
        # Deletes run after the waves, so they follow them here.
        for resource_id, change in plan.all_changes.items():
            if _status_value(getattr(change, "change_type", None)) == "delete":
                current = getattr(change, "current_resource", None)
                out.append({
                    "id": resource_id,
                    "type": getattr(current, "type", None),
                    "physical_id": getattr(current, "physical_id", None),
                    "change": "delete",
                    "wave": len(plan.waves) + 1,
                    "reason": getattr(change, "reason", None),
                })
    elif isinstance(plan, DestructionPlan):
        for index, resource_id in enumerate(plan.resource_ids):
            resource = plan.resources.get(resource_id)
            out.append({
                "id": resource_id,
                "type": getattr(resource, "type", None),
                "physical_id": getattr(resource, "physical_id", None),
                "change": "delete",
                "wave": index,
            })
    return out


def _status_value(value: Any) -> Optional[str]:
    return getattr(value, "value", value)


def _failures(result: Any) -> Dict[str, str]:
    details = getattr(result, "failed_resources_details", None)
    if isinstance(details, dict):
        return {k: str(v) for k, v in details.items()}
    failures: Dict[str, str] = {}
    for wave in getattr(result, "wave_results", []) or []:
        for resource_id, r in getattr(wave, "resource_results", {}).items():
            if getattr(r, "error", None):
                failures[resource_id] = str(r.error)
    for resource_id, r in (getattr(result, "resource_results", {}) or {}).items():
        if getattr(r, "error", None):
            failures[resource_id] = str(r.error)
    return failures
