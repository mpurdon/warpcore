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


class TestLogicalIdCollisions:
    """State stacks key resources by logical id. Two discovered resources that
    share one - a Lambda and the role it uses, the commonest naming convention
    in AWS - must not silently overwrite each other.

    Found by adopting a real account: adoption reported 23 resources and wrote 22.
    """

    def _role_and_function(self):
        return (
            Resource(id="gitf-wake", type="AWS::IAM::Role",
                     physical_id="arn:aws:iam::515020252848:role/gitf-wake"),
            Resource(id="gitf-wake", type="AWS::Lambda::Function",
                     physical_id="arn:aws:lambda:us-east-1:515020252848:function:gitf-wake"),
        )

    def test_everything_planned_actually_lands_in_state(self, state_manager):
        adopter = ResourceAdopter(state_manager)
        plan = adopter.plan(_scanned(*self._role_and_function()))
        planned = len(plan.to_adopt())
        adopted = adopter.apply(plan)

        assert planned == 2
        assert adopted == 2
        assert len(state_manager.load().all_resources()) == 2

    def test_the_lambda_keeps_the_plain_name(self, state_manager):
        """A person who says "gitf-wake" means the function, not its role."""
        adopter = ResourceAdopter(state_manager)
        adopter.apply(adopter.plan(_scanned(*self._role_and_function())))

        state = state_manager.load()
        assert state.get_resource("gitf-wake").type == "AWS::Lambda::Function"
        assert state.get_resource("gitf-wake-role").type == "AWS::IAM::Role"

    def test_the_rename_is_reported_in_the_plan(self, state_manager):
        plan = ResourceAdopter(state_manager).plan(_scanned(*self._role_and_function()))
        renamed = [i for i in plan.items if i.original_id]
        assert len(renamed) == 1
        assert renamed[0].original_id == "gitf-wake"
        assert "renamed from" in renamed[0].detail

    def test_the_original_name_is_kept_in_metadata(self, state_manager):
        adopter = ResourceAdopter(state_manager)
        adopter.apply(adopter.plan(_scanned(*self._role_and_function())))
        role = state_manager.load().get_resource("gitf-wake-role")
        assert role.metadata["original_id"] == "gitf-wake"

    def test_three_way_collision_still_resolves(self, state_manager):
        resources = (
            *self._role_and_function(),
            Resource(id="gitf-wake", type="AWS::Logs::LogGroup",
                     physical_id="arn:aws:logs:us-east-1:1:log-group:gitf-wake"),
        )
        adopter = ResourceAdopter(state_manager)
        adopter.apply(adopter.plan(_scanned(*resources)))

        ids = {r.id for _, r in state_manager.load().all_resources()}
        assert ids == {"gitf-wake", "gitf-wake-role", "gitf-wake-log-group"}

    def test_collision_with_a_name_already_in_state_is_still_a_conflict(self, state_manager):
        """Renaming applies within a plan; clashing with managed state does not."""
        state = state_manager.load()
        state.add_resource("app", Resource(
            id="gitf-wake", type="AWS::Lambda::Function", physical_id="arn:other",
        ))
        state_manager.save(state)

        plan = ResourceAdopter(state_manager).plan(_scanned(self._role_and_function()[1]))
        assert [i.action for i in plan.items] == ["conflict"]

    def test_no_collision_means_no_rename(self, state_manager):
        adopter = ResourceAdopter(state_manager)
        plan = adopter.plan(_scanned(_bucket("data"), _bucket("logs")))
        assert all(i.original_id is None for i in plan.items)
