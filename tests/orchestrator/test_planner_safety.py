"""The planner's rules that keep a deploy from touching what it does not own."""

from warpcore.orchestrator.planner import DeploymentPlanner
from warpcore.orchestrator.refs import ref
from warpcore.provisioners.base import ChangeType
from warpcore.state.models import Resource, State


def _state(*resources):
    st = State(environment="dev", region="us-east-1", account="1", project_name="p")
    for r in resources:
        st.add_resource("shared", r)
    return st


def _res(id, **kw):
    base = dict(type="AWS::S3::Bucket", properties={"BucketName": id}, dependencies=[], tags={}, metadata={})
    base.update(kw)
    return Resource(id=id, **base)


def test_adopted_resources_are_never_planned_for_deletion():
    adopted = _res("bucket-a", physical_id="bucket-a", metadata={"adopted": True})
    created = _res("bucket-b", physical_id="bucket-b", metadata={"managed": True})
    plan = DeploymentPlanner().create_deployment_plan(desired_resources={}, current_state=_state(adopted, created))
    assert [c.resource_id for c in plan.get_changes_by_type(ChangeType.DELETE)] == ["bucket-b"]


def test_a_taken_over_resource_is_owned_again():
    taken = _res("bucket-a", physical_id="bucket-a", metadata={"adopted": True, "managed": True})
    plan = DeploymentPlanner().create_deployment_plan(desired_resources={}, current_state=_state(taken))
    assert [c.resource_id for c in plan.get_changes_by_type(ChangeType.DELETE)] == ["bucket-a"]


def test_destruction_skips_adopted_unless_asked():
    adopted = _res("bucket-a", physical_id="bucket-a", metadata={"adopted": True})
    created = _res("bucket-b", physical_id="bucket-b", metadata={"managed": True})
    planner = DeploymentPlanner()
    assert planner.create_destruction_plan(_state(adopted, created)).resource_ids == ["bucket-b"]
    assert set(planner.create_destruction_plan(_state(adopted, created), include_adopted=True).resource_ids) == {"bucket-a", "bucket-b"}


def test_recorded_properties_volatile_tags_and_refs_are_not_changes():
    current = _res("fn", type="AWS::Lambda::Function", physical_id="arn:fn",
                   properties={"FunctionName": "fn", "Role": "arn:role", "CodeSha256": "abc"},
                   tags={"warpcore:deployed-at": "then", "warpcore:version": "1", "team": "a"}, metadata={"managed": True})
    desired = _res("fn", type="AWS::Lambda::Function",
                   properties={"FunctionName": "fn", "Role": ref("role")}, tags={"team": "a"})
    plan = DeploymentPlanner().create_deployment_plan(desired_resources={"fn": desired}, current_state=_state(current))
    assert plan.all_changes["fn"].change_type is ChangeType.NO_CHANGE


def test_a_dependency_that_is_not_changing_does_not_block_the_wave():
    role = _res("role", type="AWS::IAM::Role", physical_id="arn:role", properties={"RoleName": "r"}, metadata={"managed": True})
    fn = _res("fn", type="AWS::Lambda::Function", properties={"FunctionName": "fn", "Role": ref("role")}, dependencies=["role"])
    desired = {"role": role.model_copy(update={"physical_id": None}), "fn": fn}
    plan = DeploymentPlanner().create_deployment_plan(desired_resources=desired, current_state=_state(role))
    assert plan.all_changes["role"].change_type is ChangeType.NO_CHANGE
    assert [w.resource_ids for w in plan.waves] == [["fn"]]
    # The resource keeps its real dependency list for the record.
    assert plan.all_changes["fn"].desired_resource.dependencies == ["role"]
