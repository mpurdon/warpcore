"""Adopting discovered resources into state."""

import pytest

from warpcore.agentic.scanner import ScannedState
from warpcore.discovery.adopt import DEFAULT_STACK, ResourceAdopter
from warpcore.state.manager import StateManager
from warpcore.state.models import Resource


@pytest.fixture
def state_manager(tmp_path):
    manager = StateManager(str(tmp_path / "state.json"))
    manager.initialize(
        environment="dev", region="us-east-1",
        account="123456789012", project_name="demo",
    )
    return manager


def _scanned(*resources):
    state = ScannedState()
    for resource in resources:
        state.add_resource(resource)
    return state


def _bucket(name="data", arn=None, tags=None):
    return Resource(
        id=name, type="AWS::S3::Bucket",
        physical_id=arn or f"arn:aws:s3:::{name}",
        tags=tags or {},
    )


class TestPlan:
    def test_new_resources_are_marked_for_adoption(self, state_manager):
        plan = ResourceAdopter(state_manager).plan(_scanned(_bucket()))
        assert [i.action for i in plan.items] == ["adopt"]

    def test_resource_already_in_state_is_not_re_adopted(self, state_manager):
        state = state_manager.load()
        state.add_resource("app", _bucket())
        state_manager.save(state)

        plan = ResourceAdopter(state_manager).plan(_scanned(_bucket()))
        assert [i.action for i in plan.items] == ["already-managed"]
        assert plan.is_empty()

    def test_same_logical_id_different_physical_is_a_conflict(self, state_manager):
        state = state_manager.load()
        state.add_resource("app", _bucket(name="data", arn="arn:aws:s3:::old-data"))
        state_manager.save(state)

        plan = ResourceAdopter(state_manager).plan(
            _scanned(_bucket(name="data", arn="arn:aws:s3:::new-data"))
        )
        assert [i.action for i in plan.items] == ["conflict"]
        assert plan.is_empty()

    def test_stack_defaults_to_discovered(self, state_manager):
        plan = ResourceAdopter(state_manager).plan(_scanned(_bucket()))
        assert plan.items[0].stack == DEFAULT_STACK

    def test_warpcore_agent_tag_selects_the_stack(self, state_manager):
        resource = _bucket(tags={"warpcore:agent": "checkout"})
        plan = ResourceAdopter(state_manager).plan(_scanned(resource))
        assert plan.items[0].stack == "checkout"

    def test_explicit_stack_overrides_the_tag(self, state_manager):
        resource = _bucket(tags={"warpcore:agent": "checkout"})
        plan = ResourceAdopter(state_manager).plan(_scanned(resource), stack="chosen")
        assert plan.items[0].stack == "chosen"


class TestApply:
    def test_adopted_resources_land_in_state(self, state_manager):
        adopter = ResourceAdopter(state_manager)
        plan = adopter.plan(_scanned(_bucket(), _bucket("logs")))
        assert adopter.apply(plan) == 2

        state = state_manager.load()
        assert {r.id for _, r in state.all_resources()} == {"data", "logs"}

    def test_adoption_is_recorded_in_metadata(self, state_manager):
        adopter = ResourceAdopter(state_manager)
        adopter.apply(adopter.plan(_scanned(_bucket())))

        resource = state_manager.load().get_resource("data")
        assert resource.metadata["adopted"] is True
        assert resource.metadata["adopted_from"] == "account-scan"

    def test_conflicts_are_skipped_not_overwritten(self, state_manager):
        state = state_manager.load()
        state.add_resource("app", _bucket(name="data", arn="arn:aws:s3:::original"))
        state_manager.save(state)

        adopter = ResourceAdopter(state_manager)
        plan = adopter.plan(_scanned(_bucket(name="data", arn="arn:aws:s3:::replacement")))
        assert adopter.apply(plan) == 0

        assert state_manager.load().get_resource("data").physical_id == "arn:aws:s3:::original"

    def test_adoption_does_not_mutate_the_scanned_resource(self, state_manager):
        scanned_resource = _bucket()
        adopter = ResourceAdopter(state_manager)
        adopter.apply(adopter.plan(_scanned(scanned_resource)))
        assert scanned_resource.metadata == {}
