"""`warpcore limits`.

`limits check` raised NameError on every invocation. The surrounding code also
had a shallow-copy bug that let `limits set` corrupt the module defaults, and
reported an over-limit agent as both a violation and a warning.
"""

import json

import pytest
from click.testing import CliRunner

import warpcore.cli.limits as limits_module
from warpcore.cli.main import cli

CONFIG = """\
project:
  name: demo
  region: us-east-1
agents:
  - name: over-memory
    path: ./a
    memory: 4096
    timeout: 30
  - name: near-memory
    path: ./b
    memory: 2500
    timeout: 30
  - name: fine
    path: ./c
    memory: 512
    timeout: 30
environments:
  dev:
    account: "123456789012"
    region: us-east-1
"""

CLEAN_CONFIG = """\
project:
  name: demo
  region: us-east-1
agents:
  - name: fine
    path: ./c
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
    (tmp_path / "clean.yaml").write_text(CLEAN_CONFIG)
    return tmp_path


def _run(args):
    return CliRunner().invoke(cli, args, catch_exceptions=False)


class TestCheck:
    def test_runs_without_a_name_error(self, project):
        assert "not defined" not in _run(["limits", "check"]).output

    def test_violation_exits_nonzero(self, project):
        result = _run(["limits", "check"])
        assert result.exit_code == 1
        assert "over-memory" in result.output

    def test_clean_config_exits_zero(self, project):
        result = _run(["limits", "check", "--config", "clean.yaml"])
        assert result.exit_code == 0
        assert "within all limits" in result.output

    def test_an_over_limit_agent_is_not_also_warned_about(self, project):
        """4096 MB exceeds 3008 and is also above 80% of it; report it once."""
        output = _run(["limits", "check"]).output
        warnings_section = output.split("Warnings:")[-1] if "Warnings:" in output else ""
        assert "over-memory" not in warnings_section

    def test_approaching_agent_is_warned_about(self, project):
        output = _run(["limits", "check"]).output
        assert "near-memory" in output
        assert "approaching" in output

    def test_agent_well_under_the_limit_is_not_mentioned(self, project):
        assert "'fine'" not in _run(["limits", "check"]).output

    def test_timeout_violations_are_reported(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        (tmp_path / "warpcore.yaml").write_text(CLEAN_CONFIG.replace(
            "timeout: 30", "timeout: 600"))
        result = _run(["limits", "check"])
        assert result.exit_code == 1
        assert "timeout" in result.output

    def test_missing_config_exits_nonzero(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        result = _run(["limits", "check"])
        assert result.exit_code == 1
        assert "not found" in result.output

    def test_unknown_environment_is_reported(self, project):
        result = _run(["limits", "check", "--config", "clean.yaml", "--env", "nope"])
        assert result.exit_code == 1
        assert "nope" in result.output


class TestLimitsFile:
    def test_defaults_are_not_mutated_by_loading(self, project):
        """_load_limits returned a shallow copy, so `limits set` reached into
        DEFAULT_LIMITS and `limits reset` then restored the mutated values."""
        original = limits_module.DEFAULT_LIMITS["lambda"]["max_memory_mb"]
        loaded = limits_module._load_limits()
        loaded["lambda"]["max_memory_mb"] = 1
        assert limits_module.DEFAULT_LIMITS["lambda"]["max_memory_mb"] == original

    def test_set_persists_and_check_honours_it(self, project):
        assert _run(["limits", "set", "lambda", "max_memory_mb", "256"]).exit_code == 0
        result = _run(["limits", "check", "--config", "clean.yaml"])
        assert result.exit_code == 1, "512 MB should now exceed the 256 MB limit"

    def test_set_does_not_corrupt_the_defaults_on_disk(self, project):
        _run(["limits", "set", "lambda", "max_memory_mb", "256"])
        assert limits_module.DEFAULT_LIMITS["lambda"]["max_memory_mb"] == 3008

    def test_partial_limits_file_is_merged_over_defaults(self, project):
        """A file written by an older version must not make check raise KeyError."""
        limits_path = project / ".warpcore" / "limits.json"
        limits_path.parent.mkdir(parents=True, exist_ok=True)
        limits_path.write_text(json.dumps({"lambda": {"max_memory_mb": 1024}}))

        result = _run(["limits", "check", "--config", "clean.yaml"])
        assert result.exit_code == 0
        assert "not defined" not in result.output and "KeyError" not in result.output

    def test_corrupt_limits_file_falls_back_to_defaults(self, project):
        limits_path = project / ".warpcore" / "limits.json"
        limits_path.parent.mkdir(parents=True, exist_ok=True)
        limits_path.write_text("{ not json")
        assert _run(["limits", "check", "--config", "clean.yaml"]).exit_code == 0

    def test_unknown_category_is_rejected(self, project):
        output = _run(["limits", "set", "nope", "x", "1"]).output
        assert "Unknown category" in output

    def test_unknown_limit_name_is_rejected(self, project):
        output = _run(["limits", "set", "lambda", "nope", "1"]).output
        assert "Unknown limit" in output


class TestShow:
    def test_show_runs(self, project):
        assert _run(["limits", "show"]).exit_code == 0

    def test_show_json_is_parseable(self, project):
        payload = json.loads(_run(["limits", "show", "--json-output"]).stdout)
        assert payload["lambda"]["max_memory_mb"] == 3008
