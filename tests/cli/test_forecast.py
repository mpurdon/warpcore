"""`warpcore forecast`.

The command raised NameError on every invocation before this: it called a
ConfigParser that was never imported, then six CostEstimator methods that did
not exist.
"""

import json

import pytest
from click.testing import CliRunner

from warpcore.cli.main import cli

CONFIG = """\
project:
  name: demo
  region: us-east-1
  cost_estimation:
    executions_per_month: 500000
agents:
  - name: api-agent
    path: ./agents/api
    memory: 512
    timeout: 30
environments:
  dev:
    account: "123456789012"
    region: us-east-1
"""


@pytest.fixture
def project(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    (tmp_path / "warpcore.yaml").write_text(CONFIG)
    return tmp_path


def _run(args):
    return CliRunner().invoke(cli, args, catch_exceptions=False)


class TestItRunsAtAll:
    def test_command_succeeds(self, project):
        result = _run(["forecast"])
        assert result.exit_code == 0, result.output

    def test_no_undefined_name_error(self, project):
        assert "not defined" not in _run(["forecast"]).output

    def test_reports_a_cost_per_agent(self, project):
        assert "api-agent" in _run(["forecast"]).output


class TestJsonOutput:
    def _payload(self, args=("forecast", "--json-output")):
        return json.loads(_run(list(args)).stdout)

    def test_json_is_parseable(self, project):
        payload = self._payload()
        assert payload["period"] == "monthly"
        assert payload["total_cost"] > 0

    def test_breakdown_covers_the_priced_services(self, project):
        services = self._payload()["breakdown"]["api-agent"]
        assert set(services) == {"Lambda", "API Gateway", "CloudWatch Logs", "X-Ray"}

    def test_uses_executions_per_month_from_the_config(self, project):
        """Previously hardcoded to 1M regardless of what the project said."""
        assert self._payload()["monthly_requests"] == 500000


class TestAssumptions:
    def test_duration_defaults_to_one_second(self, project):
        payload = json.loads(_run(["forecast", "--json-output"]).stdout)
        assert payload["avg_duration_ms"] == 1000

    def test_duration_is_overridable(self, project):
        payload = json.loads(
            _run(["forecast", "--avg-duration-ms", "5000", "--json-output"]).stdout
        )
        assert payload["avg_duration_ms"] == 5000

    def test_longer_duration_costs_more(self, project):
        cheap = json.loads(_run(["forecast", "--json-output"]).stdout)["total_cost"]
        dear = json.loads(
            _run(["forecast", "--avg-duration-ms", "10000", "--json-output"]).stdout
        )["total_cost"]
        assert dear > cheap

    @pytest.mark.parametrize("period,factor", [("daily", 1 / 30), ("yearly", 12)])
    def test_period_scales_the_total(self, project, period, factor):
        monthly = json.loads(_run(["forecast", "--json-output"]).stdout)["total_cost"]
        scaled = json.loads(
            _run(["forecast", "--period", period, "--json-output"]).stdout
        )["total_cost"]
        assert scaled == pytest.approx(monthly * factor, rel=0.05)


class TestErrorHandling:
    def test_missing_config_exits_nonzero(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        result = _run(["forecast"])
        assert result.exit_code == 1
        assert "not found" in result.output

    def test_unknown_environment_is_reported(self, project):
        """--env was accepted and silently ignored, mislabelling the output."""
        result = _run(["forecast", "--env", "nope"])
        assert result.exit_code == 1
        assert "nope" in result.output

    def test_known_environment_is_accepted(self, project):
        assert _run(["forecast", "--env", "dev"]).exit_code == 0


class TestSharedInfrastructure:
    def test_vpc_disabled_adds_no_shared_costs(self, project):
        payload = json.loads(_run(["forecast", "--json-output"]).stdout)
        assert "shared-infrastructure" not in payload["breakdown"]

    def test_missing_vpc_block_does_not_crash(self, tmp_path, monkeypatch):
        """shared.vpc is None when omitted; `.enabled` used to be read blindly."""
        monkeypatch.chdir(tmp_path)
        (tmp_path / "warpcore.yaml").write_text(CONFIG + "shared:\n  monitoring:\n    xray: true\n")
        assert _run(["forecast"]).exit_code == 0

    def test_enabled_vpc_adds_nat_and_endpoint_costs(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        (tmp_path / "warpcore.yaml").write_text(
            CONFIG + "shared:\n  vpc:\n    enabled: true\n    cidr: 10.0.0.0/16\n"
        )
        payload = json.loads(_run(["forecast", "--json-output"]).stdout)
        shared = payload["breakdown"]["shared-infrastructure"]
        assert shared["NAT Gateway"] > 0
        assert shared["VPC Endpoints"] > 0
