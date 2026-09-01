"""Executor: state persistence and audit recording during a deployment."""

import pytest

from warpcore.audit.models import AuditOperation, AuditStatus
from warpcore.audit.recorder import AuditRecorder
from warpcore.orchestrator.executor import DeploymentExecutor, ExecutionStatus
from warpcore.orchestrator.planner import DeploymentPlan, DeploymentWave, ResourceChange
from warpcore.provisioners.base import ChangeType, ProvisionPlan
from warpcore.provisioners.base import Resource as ProvisionerResource
from warpcore.state.manager import StateManager
from warpcore.state.models import Resource

TYPE = "AWS::Lambda::Function"


class FakeProvisioner:
    def __init__(self, fail_on=None):
        self.fail_on = fail_on or set()
        self.provisioned = []
        self.destroyed = []

    def plan(self, desired, current):
        return ProvisionPlan(
            resource=desired,
            change_type=ChangeType.UPDATE if current else ChangeType.CREATE,
            current_state=current,
        )

    def provision(self, plan):
        resource = plan.resource
        if resource.id in self.fail_on:
            raise RuntimeError(f"AccessDenied provisioning {resource.id}")
        self.provisioned.append(resource.id)
        return ProvisionerResource(
            id=resource.id, type=resource.type,
            physical_id=f"arn:aws:lambda:us-east-1:1:function:{resource.id}",
            properties=resource.properties, dependencies=resource.dependencies,
            tags=resource.tags,
        )

    def destroy(self, resource):
        self.destroyed.append(resource.id)


@pytest.fixture
def state_manager(tmp_path):
    manager = StateManager(str(tmp_path / "state.json"))
    manager.initialize(environment="dev", region="us-east-1",
                       account="123456789012", project_name="demo")
    return manager


@pytest.fixture
def recorder(tmp_path):
    return AuditRecorder(environment="dev", audit_dir=tmp_path / "audit")


def _desired(name, memory=512, tags=None):
    return Resource(id=name, type=TYPE, properties={"MemorySize": memory},
                    tags=tags or {"warpcore:agent": "app"})


def _plan(*changes):
    wave = DeploymentWave(wave_number=1, resource_ids=[c.resource_id for c in changes])
    for change in changes:
        wave.add_change(change)
    return DeploymentPlan(waves=[wave],
                          all_changes={c.resource_id: c for c in changes})


def _create(name, **kwargs):
    return ResourceChange(resource_id=name, change_type=ChangeType.CREATE,
                          desired_resource=_desired(name, **kwargs))


class TestStatePersistence:
    def test_provisioned_resources_are_written_to_the_state_file(
        self, state_manager, recorder
    ):
        """Regression: save() was called without its required state argument,
        inside a try/except that swallowed the TypeError, so nothing persisted."""
        executor = DeploymentExecutor(
            provisioners={TYPE: FakeProvisioner()},
            state_manager=state_manager,
            audit_recorder=recorder,
        )
        result = executor.execute_deployment(_plan(_create("fn-a")), parallel=False)
        assert result.status is ExecutionStatus.SUCCESS

        # Re-read from disk, not from the in-memory state.
        reloaded = StateManager(str(state_manager.state_path)).load()
        assert reloaded.get_resource("fn-a") is not None
        assert reloaded.get_resource("fn-a").physical_id.endswith("fn-a")

    def test_resources_are_filed_under_their_agent_stack(self, state_manager, recorder):
        executor = DeploymentExecutor(
            provisioners={TYPE: FakeProvisioner()}, state_manager=state_manager,
            audit_recorder=recorder,
        )
        executor.execute_deployment(_plan(_create("fn-a")), parallel=False)

        located = StateManager(str(state_manager.state_path)).load().get_resource_with_stack("fn-a")
        assert located[0] == "app"

    def test_parallel_execution_persists_every_resource(self, state_manager, recorder):
        executor = DeploymentExecutor(
            provisioners={TYPE: FakeProvisioner()}, state_manager=state_manager,
            audit_recorder=recorder,
        )
        changes = [_create(f"fn-{i}") for i in range(5)]
        executor.execute_deployment(_plan(*changes), parallel=True)

        reloaded = StateManager(str(state_manager.state_path)).load()
        assert {r.id for _, r in reloaded.all_resources()} == {f"fn-{i}" for i in range(5)}


class TestAuditRecording:
    def test_each_provisioned_resource_gets_an_entry(self, state_manager, recorder):
        executor = DeploymentExecutor(
            provisioners={TYPE: FakeProvisioner()}, state_manager=state_manager,
            audit_recorder=recorder,
        )
        executor.execute_deployment(_plan(_create("fn-a"), _create("fn-b")), parallel=False)

        entries = recorder.entries()
        assert {e.resource_id for e in entries} == {"fn-a", "fn-b"}
        assert all(e.operation is AuditOperation.CREATE for e in entries)
        assert all(e.status is AuditStatus.SUCCESS for e in entries)

    def test_entries_capture_the_physical_id_for_undo(self, state_manager, recorder):
        executor = DeploymentExecutor(
            provisioners={TYPE: FakeProvisioner()}, state_manager=state_manager,
            audit_recorder=recorder,
        )
        executor.execute_deployment(_plan(_create("fn-a")), parallel=False)

        entry = recorder.entries()[0]
        assert entry.physical_id.endswith("fn-a")
        assert entry.is_undoable()

    def test_a_failed_provision_is_recorded_as_failed(self, state_manager, recorder):
        executor = DeploymentExecutor(
            provisioners={TYPE: FakeProvisioner(fail_on={"fn-b"})},
            state_manager=state_manager, audit_recorder=recorder,
        )
        executor.execute_deployment(_plan(_create("fn-a"), _create("fn-b")), parallel=False)

        by_id = {e.resource_id: e for e in recorder.entries()}
        assert by_id["fn-a"].status is AuditStatus.SUCCESS
        assert by_id["fn-b"].status is AuditStatus.FAILED
        assert "AccessDenied" in by_id["fn-b"].error

    def test_a_failed_entry_is_not_undoable(self, state_manager, recorder):
        executor = DeploymentExecutor(
            provisioners={TYPE: FakeProvisioner(fail_on={"fn-a"})},
            state_manager=state_manager, audit_recorder=recorder,
        )
        executor.execute_deployment(_plan(_create("fn-a")), parallel=False)
        assert not recorder.entries()[0].is_undoable()

    def test_parallel_writes_do_not_lose_entries(self, state_manager, recorder):
        executor = DeploymentExecutor(
            provisioners={TYPE: FakeProvisioner()}, state_manager=state_manager,
            audit_recorder=recorder, max_workers=8,
        )
        changes = [_create(f"fn-{i}") for i in range(20)]
        executor.execute_deployment(_plan(*changes), parallel=True)

        assert len(recorder.entries()) == 20

    def test_executor_works_without_a_recorder(self, state_manager):
        """Auditing must be optional, not a hard dependency of deploying."""
        executor = DeploymentExecutor(
            provisioners={TYPE: FakeProvisioner()}, state_manager=state_manager,
        )
        result = executor.execute_deployment(_plan(_create("fn-a")), parallel=False)
        assert result.status is ExecutionStatus.SUCCESS
