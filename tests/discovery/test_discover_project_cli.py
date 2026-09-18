"""`warpcore discover project` against a populated moto account."""

import json

import boto3
import pytest
from click.testing import CliRunner
from moto import mock_aws

from warpcore.cli.main import cli
from warpcore.state.manager import StateManager

REGION = "us-east-1"


@pytest.fixture
def account(aws_credentials):
    """A function wired to a table through an environment variable, plus a queue that feeds it."""
    with mock_aws():
        session = boto3.Session(region_name=REGION)
        iam = session.client("iam", region_name=REGION)
        role = iam.create_role(
            RoleName="orders-exec",
            AssumeRolePolicyDocument='{"Version":"2012-10-17","Statement":[]}',
        )["Role"]["Arn"]
        session.client("dynamodb", region_name=REGION).create_table(
            TableName="orders",
            KeySchema=[{"AttributeName": "pk", "KeyType": "HASH"}],
            AttributeDefinitions=[{"AttributeName": "pk", "AttributeType": "S"}],
            BillingMode="PAY_PER_REQUEST",
        )
        sqs = session.client("sqs", region_name=REGION)
        queue_url = sqs.create_queue(QueueName="order-events")["QueueUrl"]
        queue_arn = sqs.get_queue_attributes(QueueUrl=queue_url, AttributeNames=["QueueArn"])["Attributes"]["QueueArn"]
        lam = session.client("lambda", region_name=REGION)
        lam.create_function(
            FunctionName="orders-api",
            Runtime="python3.11",
            Role=role,
            Handler="main.handler",
            Code={"ZipFile": b"x"},
            MemorySize=1024,
            Timeout=60,
            Environment={"Variables": {"TABLE_NAME": "orders", "SECRET": "hunter2"}},
        )
        lam.create_event_source_mapping(EventSourceArn=queue_arn, FunctionName="orders-api")
        session.client("s3", region_name=REGION).create_bucket(Bucket="orders-archive")
        yield session


def _run(runner, args):
    return runner.invoke(cli, args, catch_exceptions=False)


def _project(runner, *extra):
    result = _run(runner, ["discover", "project", "--project-name", "shop", "--env", "prod",
                           "--region", REGION, "--json", "--no-snapshot", *extra])
    assert result.exit_code == 0, result.output
    # stdout must be pure JSON: logs and progress go to stderr.
    return json.loads(result.stdout)


class TestDiscoverProject:
    def test_emits_canvas_ready_project(self, account):
        payload = _project(CliRunner())
        assert payload["environment"] == {"key": "prod", "account": "123456789012", "region": REGION}
        agent = payload["agents"][0]
        assert agent["config"]["name"] == "orders-api"
        assert agent["config"]["memory"] == 1024
        assert "hunter2" not in json.dumps(agent)
        types = {r["type"] for r in payload["resources"]}
        assert {"dynamodb", "sqs", "s3"} <= types
        kinds = {c["kind"] for c in payload["connections"]}
        assert {"role", "reference", "event-source"} <= kinds
        assert payload["roles"][0]["config"]["roleName"] == "orders-exec"

    def test_patterns_select_resources(self, account):
        payload = _project(CliRunner(), "--include", "type:dynamodb", "--include", "name:orders-api")
        assert {r["type"] for r in payload["resources"]} == {"dynamodb"}
        assert len(payload["agents"]) == 1
        assert payload["counts"]["excluded"] >= 2   # the queue, the bucket, the role...

    def test_execution_role_follows_its_function(self, account):
        # The patterns select the function only; its role is pulled in anyway.
        payload = _project(CliRunner(), "--include", "name:orders-api")
        assert [r["config"]["roleName"] for r in payload["roles"]] == ["orders-exec"]
        assert any(c["kind"] == "role" for c in payload["connections"])

    def test_lambda_as_plain_node(self, account):
        payload = _project(CliRunner(), "--lambda-as", "lambda")
        assert payload["agents"] == []
        assert any(r["type"] == "lambda" and r["config"]["functionName"] == "orders-api" for r in payload["resources"])

    def test_adopt_writes_local_state(self, account, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        payload = _project(CliRunner(), "--adopt")
        assert payload["adopted"] >= 3
        state = StateManager(payload["state_path"])
        assert state.exists()

    def test_progress_streams_then_result(self, account):
        result = _run(CliRunner(), ["discover", "project", "--project-name", "shop",
                                    "--region", REGION, "--progress", "--no-snapshot"])
        assert result.exit_code == 0, result.output
        lines = [json.loads(line) for line in result.stdout.splitlines() if line.strip()]
        assert lines[0]["event"] == "scan_start"
        assert any(line["event"] == "phase" and line.get("phase") == "hydrate" for line in lines)
        assert lines[-1]["event"] == "result"
        assert lines[-1]["data"]["counts"]["shown"] >= 3

    def test_rejects_bad_project_name(self, account):
        result = CliRunner().invoke(cli, ["discover", "project", "--project-name", "Shop!", "--json", "--no-snapshot"])
        assert result.exit_code == 2
