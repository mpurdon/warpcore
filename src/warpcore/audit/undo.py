"""Reversing recorded operations.

Undo is planned before it is executed, and the plan is what the CLI shows the
user. Every undo is itself recorded as a new audit entry pointing back at the
entry it reverses, so the trail stays append-only and an undo is as visible as
the change it undid.

What undo does NOT do: it does not try to be a general-purpose time machine.
It reverses one recorded operation using the snapshot taken at the time. If
the resource has been changed since - by another deploy, by the console, by
another engineer - the plan says so and refuses unless forced.
"""

from typing import Dict, List, Optional

from warpcore.audit.models import (
    AuditEntry,
    AuditOperation,
    AuditStatus,
    UndoKind,
    UndoPlan,
    UndoStep,
)
from warpcore.audit.recorder import AuditRecorder, resource_from_snapshot
from warpcore.provisioners.base import BaseProvisioner
from warpcore.provisioners.base import Resource as ProvisionerResource
from warpcore.state.manager import StateManager, StateNotFoundError
from warpcore.state.models import Resource as StateResource
from warpcore.utils.errors import DeploymentError
from warpcore.utils.logging import get_logger

logger = get_logger(__name__)


def _to_provisioner_resource(resource: StateResource) -> ProvisionerResource:
    """Convert a state Resource into the dataclass provisioners expect."""
    return ProvisionerResource(
        id=resource.id,
        type=resource.type,
        physical_id=resource.physical_id,
        properties=resource.properties,
        dependencies=resource.dependencies,
        tags=resource.tags,
    )


def _to_state_resource(resource: ProvisionerResource) -> StateResource:
    """Convert a provisioner Resource back into the state model."""
    return StateResource(
        id=resource.id,
        type=resource.type,
        physical_id=resource.physical_id,
        properties=resource.properties,
        dependencies=resource.dependencies,
        tags=resource.tags,
    )


class UndoExecutor:
    """Plans and applies the reversal of an audit entry."""

    def __init__(
        self,
        provisioners: Dict[str, BaseProvisioner],
        state_manager: StateManager,
        recorder: AuditRecorder,
    ):
        self.provisioners = provisioners
        self.state_manager = state_manager
        self.recorder = recorder
        self.logger = get_logger(__name__)

    # ------------------------------------------------------------------ plan

    def plan(self, entry: AuditEntry, force: bool = False) -> UndoPlan:
        """Work out how to reverse an entry, and whether it is safe to."""
        plan = UndoPlan(entry_id=entry.id)

        if entry.is_undone():
            plan.blocked_reason = (
                f"entry was already undone at {entry.undone_at:%Y-%m-%d %H:%M:%S} "
                f"by {entry.undone_by_entry}"
            )
            return plan

        if entry.status is AuditStatus.FAILED:
            plan.blocked_reason = (
                "entry records a failed operation; there is nothing to reverse"
            )
            return plan

        if entry.undoes_entry:
            plan.blocked_reason = (
                f"entry is itself an undo of {entry.undoes_entry}; "
                "re-run the original command instead of undoing an undo"
            )
            return plan

        kind = entry.undo_kind()
        if kind is UndoKind.NONE:
            plan.blocked_reason = "operation type has no defined reversal"
            return plan
        if kind is UndoKind.UNSUPPORTED:
            plan.blocked_reason = (
                "entry is missing the snapshot needed to reverse it "
                f"({'physical_id' if entry.operation is AuditOperation.CREATE else 'before state'})"
            )
            return plan

        if kind is not UndoKind.STATE_RESTORE:
            provisioner_missing = self._check_provisioner(entry)
            if provisioner_missing:
                plan.blocked_reason = provisioner_missing
                return plan

        drift = self._check_drift(entry)
        if drift and not force:
            plan.blocked_reason = f"{drift} (re-run with --force to undo anyway)"
            return plan

        dependents = self._check_dependents(entry, kind)
        if dependents and not force:
            plan.blocked_reason = (
                f"{', '.join(dependents)} still depend on {entry.resource_id}; "
                "undo would leave them pointing at a resource that no longer exists "
                "(re-run with --force to undo anyway)"
            )
            return plan

        plan.steps = [self._build_step(entry, kind)]
        return plan

    def _check_provisioner(self, entry: AuditEntry) -> Optional[str]:
        """Verify a provisioner exists for the entry's resource type."""
        resource_type = entry.resource_type
        if not resource_type:
            snapshot = entry.after or entry.before or {}
            resource_type = snapshot.get("type", "")
        if resource_type not in self.provisioners:
            return f"no provisioner registered for resource type '{resource_type}'"
        return None

    def _check_drift(self, entry: AuditEntry) -> Optional[str]:
        """Detect whether state has moved on since the entry was recorded."""
        try:
            state = self.state_manager.load()
        except StateNotFoundError:
            return None

        current = state.get_resource(entry.resource_id)

        if entry.operation is AuditOperation.CREATE:
            if current is None:
                return f"{entry.resource_id} is no longer in state; it may already be gone"
            if entry.physical_id and current.physical_id != entry.physical_id:
                return (
                    f"{entry.resource_id} now points at {current.physical_id}, not the "
                    f"{entry.physical_id} this entry created"
                )

        if entry.operation is AuditOperation.UPDATE and current is not None:
            expected = (entry.after or {}).get("properties")
            if expected is not None and current.properties != expected:
                return (
                    f"{entry.resource_id} has changed since this entry was recorded; "
                    "undoing would discard those later changes"
                )

        if entry.operation is AuditOperation.DELETE and current is not None:
            return f"{entry.resource_id} already exists in state; it was recreated already"

        return None

    def _check_dependents(self, entry: AuditEntry, kind: UndoKind) -> List[str]:
        """Resources that would be orphaned by removing this one."""
        if kind not in (UndoKind.DESTROY, UndoKind.STATE_RESTORE):
            return []
        try:
            state = self.state_manager.load()
        except StateNotFoundError:
            return []
        return state.get_dependents(entry.resource_id)

    def _build_step(self, entry: AuditEntry, kind: UndoKind) -> UndoStep:
        """Describe the single action that reverses this entry."""
        descriptions = {
            UndoKind.DESTROY: (
                f"destroy {entry.resource_id} ({entry.physical_id}) and remove it from state",
                True,
            ),
            UndoKind.REPROVISION: (
                f"re-apply the previous configuration of {entry.resource_id}",
                False,
            ),
            UndoKind.RECREATE: (
                f"recreate {entry.resource_id} from its pre-deletion snapshot "
                f"(it will get a new physical id)",
                False,
            ),
            UndoKind.STATE_RESTORE: (
                f"remove {entry.resource_id} from state; no AWS resource is touched",
                False,
            ),
        }
        description, destructive = descriptions[kind]
        return UndoStep(
            kind=kind,
            resource_id=entry.resource_id,
            resource_type=entry.resource_type,
            physical_id=entry.physical_id,
            description=description,
            destructive=destructive,
        )

    # --------------------------------------------------------------- execute

    def execute(self, entry: AuditEntry, plan: UndoPlan) -> AuditEntry:
        """Apply an undo plan, recording the undo as its own audit entry."""
        if not plan.is_executable():
            raise DeploymentError(
                message=f"Undo plan for {entry.id} is not executable: {plan.blocked_reason}"
            )

        step = plan.steps[0]
        self.logger.info(f"Undoing {entry.id}: {step.description}")

        # The undo is itself an auditable mutation, recorded with the inverse
        # operation so the trail reads correctly in both directions.
        inverse_operation = {
            UndoKind.DESTROY: AuditOperation.DELETE,
            UndoKind.REPROVISION: AuditOperation.UPDATE,
            UndoKind.RECREATE: AuditOperation.CREATE,
            UndoKind.STATE_RESTORE: AuditOperation.STATE_WRITE,
        }[step.kind]

        with self.recorder.operation(
            operation=inverse_operation,
            resource_id=entry.resource_id,
            resource_type=entry.resource_type,
            stack=entry.stack,
        ) as record:
            record.undoes_entry = entry.id

            if step.kind is UndoKind.DESTROY:
                record.before = resource_from_snapshot(entry.after) if entry.after else None
                self._destroy(entry)
                record.after = None

            elif step.kind is UndoKind.REPROVISION:
                record.before = resource_from_snapshot(entry.after) if entry.after else None
                record.after = self._reprovision(entry)

            elif step.kind is UndoKind.RECREATE:
                record.after = self._recreate(entry)

            elif step.kind is UndoKind.STATE_RESTORE:
                record.before = resource_from_snapshot(entry.after or entry.before or {})
                self._state_restore(entry)
                record.after = None

            undo_entry_id = record.entry_id

        # entry_id is populated by the context manager on exit.
        self.recorder.mark_undone(entry.id, undo_entry_id or "")
        return entry

    def _provisioner_for(self, resource: StateResource) -> BaseProvisioner:
        provisioner = self.provisioners.get(resource.type)
        if provisioner is None:
            raise DeploymentError(
                message=f"No provisioner registered for resource type '{resource.type}'"
            )
        return provisioner

    def _destroy(self, entry: AuditEntry) -> None:
        """Undo a create: delete the resource and drop it from state."""
        resource = resource_from_snapshot(entry.after)
        provisioner = self._provisioner_for(resource)
        provisioner.destroy(_to_provisioner_resource(resource))
        self._remove_from_state(entry.resource_id)

    def _reprovision(self, entry: AuditEntry) -> StateResource:
        """Undo an update: re-apply the previous configuration."""
        previous = resource_from_snapshot(entry.before)
        current = resource_from_snapshot(entry.after) if entry.after else None

        provisioner = self._provisioner_for(previous)
        provision_plan = provisioner.plan(
            _to_provisioner_resource(previous),
            _to_provisioner_resource(current) if current else None,
        )
        result = provisioner.provision(provision_plan)
        restored = _to_state_resource(result)
        self._write_to_state(entry.stack, restored)
        return restored

    def _recreate(self, entry: AuditEntry) -> StateResource:
        """Undo a delete: build the resource again from its snapshot."""
        previous = resource_from_snapshot(entry.before)
        # The old physical id is gone; provisioning must allocate a new one.
        previous.physical_id = None

        provisioner = self._provisioner_for(previous)
        provision_plan = provisioner.plan(_to_provisioner_resource(previous), None)
        result = provisioner.provision(provision_plan)
        recreated = _to_state_resource(result)
        self._write_to_state(entry.stack, recreated)
        return recreated

    def _state_restore(self, entry: AuditEntry) -> None:
        """Undo a state-only write by removing what it added."""
        self._remove_from_state(entry.resource_id)

    def _write_to_state(self, stack: str, resource: StateResource) -> None:
        state = self.state_manager.load()
        state.add_resource(stack or "shared-infrastructure", resource)
        self.state_manager.save(state)

    def _remove_from_state(self, resource_id: str) -> None:
        state = self.state_manager.load()
        located = state.get_resource_with_stack(resource_id)
        if located:
            stack_name, _ = located
            state.remove_resource(stack_name, resource_id)
            self.state_manager.save(state)
