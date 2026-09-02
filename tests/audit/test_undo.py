"""Undo: planning, safety checks, and execution."""

from typing import Optional

import pytest

from warpcore.audit.models import AuditOperation, AuditStatus, UndoKind
from warpcore.audit.recorder import AuditRecorder
from warpcore.audit.undo import UndoExecutor
from warpcore.provisioners.base import ChangeType, ProvisionPlan
from warpcore.provisioners.base import Resource as ProvisionerResource
from warpcore.state.manager import StateManager
from warpcore.state.models import Resource
from warpcore.utils.errors import DeploymentError


class FakeProvisioner:
    """Records what it was asked to do instead of calling AWS."""

    def __init__(self):
        self.provisioned = []
        self.destroyed = []
        self.fail_on_destroy = False

    def plan(self, desired, current) -> ProvisionPlan:
        change = ChangeType.UPDATE if current else ChangeType.CREATE
        return ProvisionPlan(resource=desired, change_type=change, current_state=current)

    def provision(self, plan: ProvisionPlan) -> ProvisionerResource:
        resource = plan.resource
        self.provisioned.append(resource)
        return ProvisionerResource(
            id=resource.id, type=resource.type,
            physical_id=resource.physical_id or f"arn:aws:lambda:us-east-1:1:function:{resource.id}-new",
            properties=resource.properties, dependencies=resource.dependencies,
            tags=resource.tags,
        )

    def destroy(self, resource: ProvisionerResource) -> None:
        if self.fail_on_destroy:
            raise DeploymentError(message="destroy failed")
        self.destroyed.append(resource)


TYPE = "AWS::Lambda::Function"


@pytest.fixture
def state_manager(tmp_path):
    manager = StateManager(str(tmp_path / "state.json"))
    manager.initialize(environment="dev", region="us-east-1",
                       account="123456789012", project_name="demo")
    return manager


@pytest.fixture
def recorder(tmp_path):
    return AuditRecorder(environment="dev", audit_dir=tmp_path)


@pytest.fixture
def provisioner():
    return FakeProvisioner()


@pytest.fixture
def executor(provisioner, state_manager, recorder):
    return UndoExecutor({TYPE: provisioner}, state_manager, recorder)


def _resource(name="fn", memory=512, physical: Optional[str] = "arn:aws:lambda:us-east-1:1:function:fn"):
    return Resource(id=name, type=TYPE, physical_id=physical,
                    properties={"MemorySize": memory})


def _record_create(recorder, state_manager, resource):
    """Simulate a create having happened, in both state and the audit log."""
    state = state_manager.load()
    state.add_resource("app", resource)
    state_manager.save(state)
    with recorder.operation(AuditOperation.CREATE, resource.id, TYPE, stack="app") as rec:
        rec.after = resource
    return recorder.entries()[0]


class TestPlanning:
    def test_create_plans_a_destroy(self, executor, recorder, state_manager):
        entry = _record_create(recorder, state_manager, _resource())
        plan = executor.plan(entry)
        assert plan.is_executable()
        assert plan.steps[0].kind is UndoKind.DESTROY
        assert plan.has_destructive_steps()

    def test_delete_plans_a_recreate_and_is_not_destructive(self, executor, recorder):
        with recorder.operation(AuditOperation.DELETE, "fn", TYPE, stack="app") as rec:
            rec.before = _resource()
        plan = executor.plan(recorder.entries()[0])
        assert plan.steps[0].kind is UndoKind.RECREATE
        assert not plan.has_destructive_steps()

    def test_already_undone_entry_is_blocked(self, executor, recorder, state_manager):
        entry = _record_create(recorder, state_manager, _resource())
        recorder.mark_undone(entry.id, "someundo")
        plan = executor.plan(recorder.get(entry.id))
        assert not plan.is_executable()
        assert "already undone" in plan.blocked_reason

    def test_failed_entry_is_blocked(self, executor, recorder):
        with pytest.raises(RuntimeError):
            with recorder.operation(AuditOperation.CREATE, "fn", TYPE):
                raise RuntimeError("boom")
        plan = executor.plan(recorder.entries()[0])
        assert "nothing to reverse" in plan.blocked_reason

    def test_missing_provisioner_is_blocked(self, state_manager, recorder):
        executor = UndoExecutor({}, state_manager, recorder)
        entry = _record_create(recorder, state_manager, _resource())
        plan = executor.plan(entry)
        assert "no provisioner registered" in plan.blocked_reason

    def test_undo_of_an_undo_is_blocked(self, executor, recorder):
        with recorder.operation(AuditOperation.DELETE, "fn", TYPE) as rec:
            rec.before = _resource()
            rec.undoes_entry = "original"
        plan = executor.plan(recorder.entries()[0])
        assert "itself an undo" in plan.blocked_reason


class TestSafetyChecks:
    def test_drift_since_the_entry_blocks_undo(self, executor, recorder, state_manager):
        entry = _record_create(recorder, state_manager, _resource())

        state = state_manager.load()
        state.get_resource("fn").physical_id = "arn:aws:lambda:us-east-1:1:function:different"
        state_manager.save(state)

        plan = executor.plan(recorder.get(entry.id))
        assert not plan.is_executable()
        assert "now points at" in plan.blocked_reason

    def test_force_overrides_drift(self, executor, recorder, state_manager):
        entry = _record_create(recorder, state_manager, _resource())
        state = state_manager.load()
        state.get_resource("fn").physical_id = "arn:aws:lambda:us-east-1:1:function:different"
        state_manager.save(state)

        assert executor.plan(recorder.get(entry.id), force=True).is_executable()

    def test_dependents_block_a_destructive_undo(self, executor, recorder, state_manager):
        entry = _record_create(recorder, state_manager, _resource())

        state = state_manager.load()
        state.add_resource("app", Resource(
            id="downstream", type=TYPE, physical_id="arn:x", dependencies=["fn"],
        ))
        state_manager.save(state)

        plan = executor.plan(recorder.get(entry.id))
        assert "downstream" in plan.blocked_reason

    def test_resource_gone_from_state_blocks_undo(self, executor, recorder, state_manager):
        entry = _record_create(recorder, state_manager, _resource())
        state = state_manager.load()
        state.remove_resource("app", "fn")
        state_manager.save(state)

        plan = executor.plan(recorder.get(entry.id))
        assert "no longer in state" in plan.blocked_reason


class TestExecution:
    def test_undoing_a_create_destroys_and_removes_from_state(
        self, executor, recorder, state_manager, provisioner
    ):
        entry = _record_create(recorder, state_manager, _resource())
        executor.execute(entry, executor.plan(entry))

        assert [r.id for r in provisioner.destroyed] == ["fn"]
        assert state_manager.load().get_resource("fn") is None

    def test_undoing_a_create_marks_the_original_undone(
        self, executor, recorder, state_manager
    ):
        entry = _record_create(recorder, state_manager, _resource())
        executor.execute(entry, executor.plan(entry))
        assert recorder.get(entry.id).status is AuditStatus.UNDONE

    def test_the_undo_is_itself_recorded_pointing_back(
        self, executor, recorder, state_manager
    ):
        entry = _record_create(recorder, state_manager, _resource())
        executor.execute(entry, executor.plan(entry))

        undo_entries = [e for e in recorder.entries() if e.undoes_entry == entry.id]
        assert len(undo_entries) == 1
        assert undo_entries[0].operation is AuditOperation.DELETE

    def test_undoing_an_update_reapplies_the_previous_properties(
        self, executor, recorder, state_manager, provisioner
    ):
        original = _resource(memory=512)
        state = state_manager.load()
        state.add_resource("app", _resource(memory=1024))
        state_manager.save(state)

        with recorder.operation(AuditOperation.UPDATE, "fn", TYPE, stack="app") as rec:
            rec.before = original
            rec.after = _resource(memory=1024)

        entry = recorder.entries()[0]
        executor.execute(entry, executor.plan(entry))

        assert provisioner.provisioned[0].properties["MemorySize"] == 512
        assert state_manager.load().get_resource("fn").properties["MemorySize"] == 512

    def test_undoing_a_delete_recreates_with_a_new_physical_id(
        self, executor, recorder, state_manager, provisioner
    ):
        with recorder.operation(AuditOperation.DELETE, "fn", TYPE, stack="app") as rec:
            rec.before = _resource()

        entry = recorder.entries()[0]
        executor.execute(entry, executor.plan(entry))

        recreated = state_manager.load().get_resource("fn")
        assert recreated is not None
        assert recreated.physical_id.endswith("-new"), "should have a freshly allocated id"

    def test_a_blocked_plan_cannot_be_executed(self, executor, recorder, state_manager):
        entry = _record_create(recorder, state_manager, _resource())
        recorder.mark_undone(entry.id, "x")
        blocked = executor.plan(recorder.get(entry.id))

        with pytest.raises(DeploymentError):
            executor.execute(entry, blocked)

    def test_a_failing_undo_is_recorded_and_original_stays_undone_false(
        self, executor, recorder, state_manager, provisioner
    ):
        entry = _record_create(recorder, state_manager, _resource())
        provisioner.fail_on_destroy = True

        with pytest.raises(DeploymentError):
            executor.execute(entry, executor.plan(entry))

        # The failed attempt is on the record...
        assert any(e.status is AuditStatus.FAILED and e.undoes_entry == entry.id
                   for e in recorder.entries())
        # ...and the original is NOT marked undone, because it was not.
        assert not recorder.get(entry.id).is_undone()
