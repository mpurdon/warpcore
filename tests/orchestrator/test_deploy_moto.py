"""A whole deploy against moto: compile, plan, provision, record, re-plan, delete, roll back."""

import json

import boto3
import pytest
import yaml
from moto import mock_aws

from warpcore.config.parser import Config
from warpcore.orchestrator.orchestrator import DeploymentOrchestrator
from warpcore.orchestrator.rollback import RollbackStrategy
from warpcore.provisioners import (
    APIGatewayProvisioner, CloudWatchProvisioner, DynamoDBProvisioner, IAMRoleProvisioner, LambdaProvisioner,
    S3Provisioner, SNSProvisioner, SQSProvisioner,
)
from warpcore.provisioners.base import ChangeType
from warpcore.state.manager import StateManager

REGION = "us-east-1"
ACCOUNT = "123456789012"


def _provisioners(session):
    return {
        "AWS::IAM::Role": IAMRoleProvisioner(session),
        "AWS::Lambda::Function": LambdaProvisioner(session),
        "AWS::ApiGatewayV2::Api": APIGatewayProvisioner(session),
        "AWS::S3::Bucket": S3Provisioner(session),
        "AWS::DynamoDB::Table": DynamoDBProvisioner(session),
        "AWS::SQS::Queue": SQSProvisioner(session),
        "AWS::SNS::Topic": SNSProvisioner(session),
        "AWS::Logs::LogGroup": CloudWatchProvisioner(session),
        "AWS::CloudWatch::Alarm": CloudWatchProvisioner(session),
    }


def _project(tmp_path, nodes, edges):
    (tmp_path / "functions" / "api").mkdir(parents=True, exist_ok=True)
    (tmp_path / "functions" / "api" / "main.py").write_text("def handler(event, context):\n    return {'ok': True}\n")
    data = {
        "project": {"name": "shop", "region": REGION},
        "agents": [],
        "resources": [],
        "environments": {"dev": {"account": ACCOUNT, "region": REGION, "logging": {"retention_days": 7}}},
        "canvas": {"nodes": nodes, "edges": edges},
    }
    path = tmp_path / "warpcore.yaml"
    path.write_text(yaml.safe_dump(data))
    return path


NODES = [
    {"id": "lambda-1", "type": "lambda", "label": "api", "x": 0, "y": 0, "config": {"path": "functions/api", "handler": "main.handler", "memory": 256}},
    {"id": "dynamodb-1", "type": "dynamodb", "label": "orders", "x": 0, "y": 0, "config": {"tableName": "shop-dev-orders", "partitionKey": "id"}},
    {"id": "sqs-1", "type": "sqs", "label": "jobs", "x": 0, "y": 0, "config": {"queueName": "shop-dev-jobs"}},
    {"id": "sqs-2", "type": "sqs", "label": "dead", "x": 0, "y": 0, "config": {"queueName": "shop-dev-jobs-dlq"}},
    {"id": "sns-1", "type": "sns", "label": "events", "x": 0, "y": 0, "config": {"topicName": "shop-dev-events"}},
    {"id": "s3-1", "type": "s3", "label": "uploads", "x": 0, "y": 0, "config": {"bucketName": "shop-dev-uploads-1234"}},
    {"id": "api-gateway-1", "type": "api-gateway", "label": "api", "x": 0, "y": 0, "config": {"apiName": "shop-dev-api"}},
]
EDGES = [
    {"id": "e1", "source": "lambda-1", "target": "dynamodb-1", "config": {}},
    {"id": "e2", "source": "lambda-1", "target": "sqs-1", "config": {}},
    {"id": "e3", "source": "sqs-1", "target": "sqs-2", "config": {"isDLQ": True, "maxRetries": 3}},
    {"id": "e4", "source": "api-gateway-1", "target": "lambda-1", "config": {"method": "POST", "path": "/orders"}},
]


@pytest.fixture
def aws_credentials(monkeypatch):
    for key in ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SECURITY_TOKEN", "AWS_SESSION_TOKEN"):
        monkeypatch.setenv(key, "testing")
    monkeypatch.setenv("AWS_DEFAULT_REGION", REGION)
    monkeypatch.delenv("AWS_PROFILE", raising=False)


@pytest.fixture
def orchestrator_factory(tmp_path, aws_credentials, monkeypatch):
    monkeypatch.chdir(tmp_path)
    with mock_aws():
        session = boto3.Session(region_name=REGION)

        def make(nodes=NODES, edges=EDGES, provisioners=None):
            config = Config(str(_project(tmp_path, nodes, edges))).load()
            manager = StateManager(str(tmp_path / ".warpcore" / "state" / "shop-dev.json"))
            if not manager.exists():
                manager.initialize(environment="dev", region=REGION, account=ACCOUNT, project_name="shop")
            return DeploymentOrchestrator(config=config, state_manager=manager, provisioners=provisioners or _provisioners(session), boto_session=session), session

        yield make


def test_the_whole_system_deploys_and_is_recorded(orchestrator_factory):
    orch, session = orchestrator_factory()
    plan = orch.plan_deployment()
    assert plan.get_summary() == {"create": 9, "update": 0, "delete": 0, "no_change": 0}
    assert not orch.compile_skipped

    result, rollback = orch.deploy(rollback_strategy=RollbackStrategy.AUTOMATIC)
    assert rollback is None
    assert result.is_success(), [str(e) for e in result.get_failed_resource_ids()]
    assert result.successful_resources == 9

    state = orch.state_manager.load()
    fn = state.get_resource("lambda-1")
    assert fn.physical_id.startswith("arn:aws:lambda:")
    assert fn.metadata["managed"] is True
    # The function's role reference was filled in with the real ARN.
    assert fn.properties["Role"] == state.get_resource("lambda-1-role").physical_id
    # The redrive policy points at the dead-letter queue's ARN.
    redrive = json.loads(session.client("sqs").get_queue_attributes(QueueUrl=state.get_resource("sqs-1").physical_id, AttributeNames=["RedrivePolicy"])["Attributes"]["RedrivePolicy"])
    assert redrive["deadLetterTargetArn"] == state.get_resource("sqs-2").properties["QueueArn"]
    # The API routes to the function.
    api_id = state.get_resource("api-gateway-1").physical_id
    routes = session.client("apigatewayv2").get_routes(ApiId=api_id)["Items"]
    assert [r["RouteKey"] for r in routes] == ["POST /orders"]
    # The role may write the table.
    policy = session.client("iam").get_role_policy(RoleName="shop-dev-api-role", PolicyName="warpcore-access")["PolicyDocument"]
    assert any("dynamodb:PutItem" in st["Action"] for st in policy["Statement"])
    # Logs live under the function's name with the environment's retention.
    groups = session.client("logs").describe_log_groups(logGroupNamePrefix="/aws/lambda/shop-dev-api")["logGroups"]
    assert groups and groups[0]["retentionInDays"] == 7

    # Deployed again: nothing to do.
    again, _ = orchestrator_factory()
    plan2 = again.plan_deployment()
    assert not plan2.has_changes(), {k: (c.change_type, c.reason) for k, c in plan2.all_changes.items() if c.change_type is not ChangeType.NO_CHANGE}


def test_removing_a_node_deletes_it_on_the_next_deploy(orchestrator_factory):
    orch, session = orchestrator_factory()
    orch.deploy()
    fewer = [n for n in NODES if n["id"] != "sns-1"]
    orch2, _ = orchestrator_factory(nodes=fewer)
    plan = orch2.plan_deployment()
    assert [c.resource_id for c in plan.get_changes_by_type(ChangeType.DELETE)] == ["sns-1"]
    result, _ = orch2.deploy()
    assert result.is_success()
    assert orch2.state_manager.load().get_resource("sns-1") is None
    assert session.client("sns").list_topics()["Topics"] == []


def test_a_failure_rolls_back_what_this_run_created(orchestrator_factory):
    orch, session = orchestrator_factory()

    class Broken(S3Provisioner):
        def provision(self, plan):
            raise RuntimeError("bucket name taken")

    provisioners = _provisioners(session)
    provisioners["AWS::S3::Bucket"] = Broken(session)
    orch, _ = orchestrator_factory(provisioners=provisioners)
    result, rollback = orch.deploy(rollback_strategy=RollbackStrategy.AUTOMATIC)
    assert not result.is_success()
    assert rollback is not None and rollback.is_success()
    # Everything the run created before the failure is gone again.
    assert session.client("sns").list_topics()["Topics"] == []
    assert session.client("dynamodb").list_tables()["TableNames"] == []
    state = orch.state_manager.load()
    assert list(state.all_resources()) == []
