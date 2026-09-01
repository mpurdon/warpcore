"""End-to-end: the discover commands against a populated moto account."""

import boto3
import pytest
import yaml
from click.testing import CliRunner
from moto import mock_aws

from warpcore.cli.main import cli
from warpcore.config.parser import Config

REGION = "us-east-1"


@pytest.fixture
def aws_credentials(monkeypatch):
    for key in ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY",
                "AWS_SECURITY_TOKEN", "AWS_SESSION_TOKEN"):
        monkeypatch.setenv(key, "testing")
    monkeypatch.setenv("AWS_DEFAULT_REGION", REGION)
    monkeypatch.delenv("WARPCORE_DEV", raising=False)


@pytest.fixture
def account(aws_credentials):
    """An account with a Lambda, a bucket and a table - none of them tagged."""
    with mock_aws():
        session = boto3.Session(region_name=REGION)

        iam = session.client("iam", region_name=REGION)
        role = iam.create_role(
            RoleName="lambda-exec",
            AssumeRolePolicyDocument='{"Version":"2012-10-17","Statement":[]}',
        )["Role"]["Arn"]

        session.client("lambda", region_name=REGION).create_function(
            FunctionName="checkout-agent",
            Runtime="python3.11",
            Role=role,
            Handler="main.handler",
            Code={"ZipFile": b"x"},
            MemorySize=1024,
            Timeout=60,
        )
        session.client("s3", region_name=REGION).create_bucket(Bucket="checkout-assets")
        session.client("dynamodb", region_name=REGION).create_table(
            TableName="checkout-orders",
            KeySchema=[{"AttributeName": "pk", "KeyType": "HASH"}],
            AttributeDefinitions=[{"AttributeName": "pk", "AttributeType": "S"}],
            BillingMode="PAY_PER_REQUEST",
        )
        yield session


def _run(runner, args):
    return runner.invoke(cli, args, catch_exceptions=False)


class TestInventory:
    def test_lists_untagged_resources(self, account):
        runner = CliRunner()
        result = _run(runner, ["discover", "inventory", "--region", REGION, "--no-hydrate"])
        assert result.exit_code == 0, result.output
        assert "checkout-assets" in result.output
        assert "checkout-orders" in result.output

    def test_json_output_is_machine_readable(self, account):
        import json

        runner = CliRunner()
        result = _run(runner, ["discover", "inventory", "--region", REGION,
                               "--no-hydrate", "--json"])
        assert result.exit_code == 0, result.output
        # stdout must be pure JSON: logs and progress go to stderr, and
        # `result.output` deliberately merges both.
        payload = json.loads(result.stdout)
        assert payload["region"] == REGION
        assert payload["counts"]
        assert any(r["id"] == "checkout-assets" for r in payload["resources"])

    def test_type_filter_narrows_the_scan(self, account):
        import json

        runner = CliRunner()
        result = _run(runner, ["discover", "inventory", "--region", REGION, "--json",
                               "--no-hydrate", "--type", "AWS::S3::Bucket"])
        payload = json.loads(result.stdout)
        assert {r["type"] for r in payload["resources"]} == {"AWS::S3::Bucket"}


class TestEmitConfig:
    def test_writes_a_loadable_config(self, account, tmp_path):
        runner = CliRunner()
        out = tmp_path / "warpcore.yaml"
        result = _run(runner, ["discover", "config", "--region", REGION,
                               "--project-name", "checkout", "--env", "dev",
                               "--out", str(out)])
        assert result.exit_code == 0, result.output
        assert out.exists()

        # The generated file must load through the real parser.
        config = Config(str(out))
        config.load()
        assert config.project.name == "checkout"
        assert "checkout-agent" in [a.name for a in config.agents]

    def test_lambda_configuration_is_carried_across(self, account, tmp_path):
        runner = CliRunner()
        out = tmp_path / "warpcore.yaml"
        _run(runner, ["discover", "config", "--region", REGION,
                      "--project-name", "checkout", "--out", str(out)])

        agents = yaml.safe_load(out.read_text())["agents"]
        agent = next(a for a in agents if a["name"] == "checkout-agent")
        assert agent["memory"] == 1024
        assert agent["timeout"] == 60
        assert agent["runtime"] == "python3.11"

    def test_refuses_to_clobber_without_force(self, account, tmp_path):
        runner = CliRunner()
        out = tmp_path / "warpcore.yaml"
        out.write_text("existing: true\n")

        result = runner.invoke(cli, ["discover", "config", "--region", REGION,
                                     "--project-name", "checkout", "--out", str(out)])
        assert result.exit_code == 1
        assert "already exists" in result.output
        assert out.read_text() == "existing: true\n"

    def test_force_overwrites(self, account, tmp_path):
        runner = CliRunner()
        out = tmp_path / "warpcore.yaml"
        out.write_text("existing: true\n")
        result = _run(runner, ["discover", "config", "--region", REGION,
                               "--project-name", "checkout", "--out", str(out), "--force"])
        assert result.exit_code == 0
        assert "existing" not in out.read_text()

    def test_warns_that_deploying_creates_new_resources(self, account, tmp_path):
        runner = CliRunner()
        result = _run(runner, ["discover", "config", "--region", REGION,
                               "--project-name", "checkout",
                               "--out", str(tmp_path / "c.yaml")])
        assert "Before you deploy this" in result.output


class TestAdopt:
    def test_dry_run_plans_without_writing_state(self, account, tmp_path, monkeypatch):
        runner = CliRunner()
        monkeypatch.chdir(tmp_path)

        config_path = tmp_path / "warpcore.yaml"
        _run(runner, ["discover", "config", "--region", REGION,
                      "--project-name", "checkout", "--env", "dev",
                      "--out", str(config_path)])

        result = _run(runner, ["discover", "adopt", "--env", "dev",
                               "--config", str(config_path),
                               "--scope", "account", "--dry-run"])
        assert result.exit_code == 0, result.output
        assert "would be adopted" in result.output

        state = tmp_path / ".warpcore" / "state" / "checkout-dev.json"
        assert not state.exists() or "checkout-assets" not in state.read_text()

    def test_adopt_writes_resources_into_state(self, account, tmp_path, monkeypatch):
        runner = CliRunner()
        monkeypatch.chdir(tmp_path)

        config_path = tmp_path / "warpcore.yaml"
        _run(runner, ["discover", "config", "--region", REGION,
                      "--project-name", "checkout", "--env", "dev",
                      "--out", str(config_path)])

        result = _run(runner, ["discover", "adopt", "--env", "dev",
                               "--config", str(config_path),
                               "--scope", "account", "--yes"])
        assert result.exit_code == 0, result.output

        from warpcore.state.manager import StateManager
        state = StateManager(
            str(tmp_path / ".warpcore" / "state" / "checkout-dev.json")
        ).load()
        ids = {r.id for _, r in state.all_resources()}
        assert "checkout-assets" in ids
        assert "checkout-orders" in ids

    def test_adopting_twice_is_idempotent(self, account, tmp_path, monkeypatch):
        runner = CliRunner()
        monkeypatch.chdir(tmp_path)
        config_path = tmp_path / "warpcore.yaml"
        _run(runner, ["discover", "config", "--region", REGION,
                      "--project-name", "checkout", "--env", "dev",
                      "--out", str(config_path)])

        args = ["discover", "adopt", "--env", "dev", "--config", str(config_path),
                "--scope", "account", "--yes"]
        _run(runner, args)
        from warpcore.state.manager import StateManager
        state_path = tmp_path / ".warpcore" / "state" / "checkout-dev.json"
        after_first = len(StateManager(str(state_path)).load().all_resources())

        second = _run(runner, args)

        assert "Nothing to adopt" in second.output
        after_second = len(StateManager(str(state_path)).load().all_resources())
        assert after_second == after_first, "second adopt duplicated resources"


def test_logs_and_progress_never_pollute_stdout(account):
    """Regression: setup_logging wrote to stdout, so --json was unpipeable."""
    import json

    runner = CliRunner()
    result = _run(runner, ["discover", "inventory", "--region", REGION,
                           "--no-hydrate", "--json"])
    json.loads(result.stdout)          # must not raise
    assert "Created AWS session" in result.output  # the log line still happened
    assert "Created AWS session" not in result.stdout
