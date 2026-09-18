"""Taking over adopted resources: the state rewritten in provisioner terms, the
compiler keeping the live shape, the release steps for the previous manager."""

import json

import yaml

from warpcore.config.parser import Config
from warpcore.discovery.takeover import normalise, release_steps, take_over
from warpcore.orchestrator.compiler import compile_project
from warpcore.orchestrator.planner import DeploymentPlanner
from warpcore.provisioners.base import ChangeType
from warpcore.state.manager import StateManager
from warpcore.state.models import Resource

ACCOUNT, REGION = "123456789012", "us-east-1"
FN_ARN = f"arn:aws:lambda:{REGION}:{ACCOUNT}:function:orders-api"
ROLE_ARN = f"arn:aws:iam::{ACCOUNT}:role/orders-exec"

HYDRATED_FN = {
    "FunctionName": "orders-api", "Runtime": "python3.11", "Role": ROLE_ARN, "Handler": "main.handler",
    "MemorySize": 512, "Timeout": 30, "CodeSha256": "abc=", "TracingConfig": {"Mode": "PassThrough"},
    "Environment": {"Variables": {"TABLE": "orders"}}, "VpcConfig": {"SubnetIds": [], "SecurityGroupIds": []},
    "EventSourceMappings": [], "FunctionArn": FN_ARN, "LastModified": "2026-01-01T00:00:00.000+0000",
}


class TestNormalise:
    def test_lambda_keeps_what_the_provisioner_reads_and_drops_the_rest(self):
        out = normalise("AWS::Lambda::Function", HYDRATED_FN)
        assert out == {
            "FunctionName": "orders-api", "Runtime": "python3.11", "Role": ROLE_ARN, "Handler": "main.handler",
            "MemorySize": 512, "Timeout": 30, "Environment": {"TABLE": "orders"}, "TracingConfig": {"Mode": "PassThrough"},
            "CodeSha256": "abc=",
        }

    def test_role_queue_and_table(self):
        role = normalise("AWS::IAM::Role", {
            "RoleName": "orders-exec", "AssumeRolePolicyDocument": '{"Version": "2012-10-17", "Statement": []}',
            "AttachedPolicies": [{"PolicyArn": "arn:aws:iam::aws:policy/ReadOnlyAccess"}],
            "PolicyDocuments": [{"name": "inline-1", "source": "inline", "document": {"Statement": [{"Effect": "Allow", "Action": "s3:GetObject", "Resource": "*"}]}},
                                {"name": "ReadOnlyAccess", "source": "managed", "document": {}}],
        })
        assert role["AssumeRolePolicyDocument"] == {"Version": "2012-10-17", "Statement": []}
        assert list(role["InlinePolicies"]) == ["inline-1"]
        assert role["ManagedPolicyArns"] == ["arn:aws:iam::aws:policy/ReadOnlyAccess"]
        queue = normalise("AWS::SQS::Queue", {"QueueArn": f"arn:aws:sqs:{REGION}:{ACCOUNT}:jobs.fifo", "FifoQueue": "true", "VisibilityTimeout": "45",
                                              "RedrivePolicy": '{"deadLetterTargetArn":"arn:x","maxReceiveCount":"3"}'})
        assert queue["QueueName"] == "jobs.fifo" and queue["FifoQueue"] is True and queue["VisibilityTimeout"] == 45
        assert queue["RedrivePolicy"]["maxReceiveCount"] == "3"
        table = normalise("AWS::DynamoDB::Table", {"TableName": "orders", "KeySchema": [{"AttributeName": "id", "KeyType": "HASH"}],
                                                   "AttributeDefinitions": [{"AttributeName": "id", "AttributeType": "S"}],
                                                   "BillingModeSummary": {"BillingMode": "PAY_PER_REQUEST"}, "TableArn": "arn:x", "ItemCount": 3})
        assert table == {"TableName": "orders", "KeySchema": [{"AttributeName": "id", "KeyType": "HASH"}],
                         "AttributeDefinitions": [{"AttributeName": "id", "AttributeType": "S"}], "BillingMode": "PAY_PER_REQUEST"}

    def test_a_type_no_provisioner_manages_is_none(self):
        assert normalise("AWS::EC2::Instance", {"InstanceId": "i-1"}) is None


def _state(tmp_path, *resources):
    manager = StateManager(str(tmp_path / "state.json"))
    manager.initialize(environment="dev", region=REGION, account=ACCOUNT, project_name="shop")
    state = manager.load()
    for r in resources:
        state.add_resource("discovered", r)
    manager.save(state)
    return manager


def _adopted_fn(provenance=None):
    return Resource(id="orders-api", type="AWS::Lambda::Function", physical_id=FN_ARN, properties=dict(HYDRATED_FN),
                    tags={"Project": "shop"}, metadata={"adopted": True, "adopted_from": "account-scan", **({"provenance": provenance} if provenance else {})})


class TestTakeOver:
    def test_matches_by_id_arn_or_name_and_rewrites_the_entry(self, tmp_path):
        manager = _state(tmp_path, _adopted_fn(), Resource(id="host", type="AWS::EC2::Instance", physical_id="arn:aws:ec2:us-east-1:1:instance/i-1", metadata={"adopted": True}))
        result = take_over(manager, ["orders-api", "i-1", "ghost"])
        actions = {i.resource_id: i.action for i in result.items}
        assert actions == {"orders-api": "taken", "host": "unsupported", "ghost": "not-found"}
        fn = manager.load().get_resource("orders-api")
        assert fn.metadata["managed"] is True and fn.metadata["adopted"] is True
        assert fn.properties["Role"] == ROLE_ARN and "LastModified" not in fn.properties
        # A second take-over is a no-op.
        assert take_over(manager, [FN_ARN]).items[0].action == "already"

    def test_dry_run_writes_nothing(self, tmp_path):
        manager = _state(tmp_path, _adopted_fn())
        result = take_over(manager, ["orders-api"], dry_run=True)
        assert result.items[0].action == "taken"
        assert "managed" not in manager.load().get_resource("orders-api").metadata

    def test_release_steps_name_the_previous_manager(self, tmp_path):
        manager = _state(tmp_path, _adopted_fn({"manager": "terraform", "address": "module.api.aws_lambda_function.orders"}))
        result = take_over(manager, ["orders-api"])
        assert any("terraform state rm 'module.api.aws_lambda_function.orders'" in s for s in result.release)
        steps = release_steps([{"manager": "sst-v3", "app": "shop", "stage": "dev", "urn": "urn:pulumi:dev::shop::sst:aws:Function$aws:lambda/function:Function::Api"}])
        assert "sst state remove" in steps[0] and "Do not run `sst remove`" in steps[0]
        cfn = release_steps([{"manager": "cdk", "stack": "ShopStack", "logical_id": "ApiFn1234"}])
        assert "DeletionPolicy: Retain" in cfn[0] and "ShopStack: ApiFn1234" in cfn[0]


def _project(tmp_path, memory=None, path=None):
    node = {"id": "lambda-orders-api", "type": "lambda", "label": "orders-api", "x": 0, "y": 0, "arn": FN_ARN,
            "config": {"functionName": "orders-api", "runtime": "python3.11", "handler": "main.handler", "memory": memory or 512, "timeout": 30,
                       "environment": {"TABLE": "<redacted>"}, **({"path": path} if path else {})}}
    data = {"project": {"name": "shop", "region": REGION}, "agents": [], "resources": [],
            "environments": {"dev": {"account": ACCOUNT, "region": REGION}},
            "canvas": {"nodes": [node], "edges": []}}
    p = tmp_path / "warpcore.yaml"
    p.write_text(yaml.safe_dump(data))
    return Config(str(p)).load()


class TestCompilingATakenOverResource:
    def test_before_take_over_it_is_observed(self, tmp_path):
        manager = _state(tmp_path, _adopted_fn())
        out = compile_project(_project(tmp_path), "dev", state=manager.load())
        assert out.resources == {} and out.skipped[0]["reason"].startswith("discovered")

    def test_after_take_over_the_first_plan_changes_nothing(self, tmp_path):
        manager = _state(tmp_path, _adopted_fn())
        take_over(manager, ["orders-api"])
        state = manager.load()
        out = compile_project(_project(tmp_path), "dev", state=state)
        # Keyed by the state's id, not the canvas node id; no role, no logs, no stub.
        assert list(out.resources) == ["orders-api"]
        fn = out.resources["orders-api"]
        assert fn.properties["Role"] == ROLE_ARN and "CodePath" not in fn.properties and fn.dependencies == []
        assert fn.properties["Environment"] == {"TABLE": "orders"}  # redacted values never overwrite the live ones
        plan = DeploymentPlanner().create_deployment_plan(desired_resources=out.resources, current_state=state)
        assert plan.all_changes["orders-api"].change_type is ChangeType.NO_CHANGE

    def test_an_edit_on_the_canvas_becomes_an_update_of_that_property_only(self, tmp_path):
        manager = _state(tmp_path, _adopted_fn())
        take_over(manager, ["orders-api"])
        state = manager.load()
        out = compile_project(_project(tmp_path, memory=1024), "dev", state=state)
        plan = DeploymentPlanner().create_deployment_plan(desired_resources=out.resources, current_state=state)
        change = plan.all_changes["orders-api"]
        assert change.change_type is ChangeType.UPDATE
        from warpcore.orchestrator.plan_detail import detail_change
        d = detail_change(change)
        assert [(p.key, p.before, p.after) for p in d.properties] == [("MemorySize", 512, 1024)]
        assert d.code is None  # no code path: the deployed code stays

    def test_a_code_path_on_a_taken_over_function_ships_the_code(self, tmp_path):
        (tmp_path / "fn").mkdir()
        (tmp_path / "fn" / "main.py").write_text("def handler(e, c): return 0\n")
        manager = _state(tmp_path, _adopted_fn())
        take_over(manager, ["orders-api"])
        out = compile_project(_project(tmp_path, path="fn"), "dev", state=manager.load())
        assert out.resources["orders-api"].properties["CodePath"] == str((tmp_path / "fn").resolve())
