"""`warpcore deploy --progress` and `warpcore destroy --progress`.

Two things used to be true. `RichProgressCallback` subclassed a
`typing.Callable` alias, which made it an ABC with an abstract `__call__`, so
`deploy` and `destroy` died instantiating it before touching AWS. And nothing
outside the process could follow a run: the Visual Builder scraped Rich's
spinner text with regular expressions. `--progress` gives it NDJSON instead.
"""

import json
from datetime import datetime
from unittest.mock import patch

import pytest
from click.testing import CliRunner

from warpcore.cli.main import RichProgressCallback, cli
from warpcore.cli.run_progress import JsonRunProgress, RichRunProgress, describe_plan
from warpcore.orchestrator.executor import (
    DeploymentResult,
    DestructionResult,
    ExecutionStatus,
    ResourceExecutionResult,
    WaveExecutionResult,
)
from warpcore.orchestrator.planner import (
    DeploymentPlan,
    DeploymentWave,
    DestructionPlan,
    ResourceChange,
)
from warpcore.provisioners.base import ChangeType
from warpcore.state.models import Resource

CONFIG = """\
project:
  name: demo
  region: us-east-1
agents:
  - name: api-agent
    path: ./agents/api
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


def _plan():
    role = Resource(id="exec-role", type="AWS::IAM::Role")
    fn = Resource(id="api-agent", type="AWS::Lambda::Function", dependencies=["exec-role"])
    changes = {
        "exec-role": ResourceChange("exec-role", ChangeType.CREATE, desired_resource=role),
        "api-agent": ResourceChange("api-agent", ChangeType.UPDATE, desired_resource=fn, reason="code changed"),
    }
    w0 = DeploymentWave(0, ["exec-role"], {"exec-role": changes["exec-role"]})
    w1 = DeploymentWave(1, ["api-agent"], {"api-agent": changes["api-agent"]})
    return DeploymentPlan(waves=[w0, w1], all_changes=changes)


class FakeOrchestrator:
    """Runs a two-wave plan through whatever callback it is given."""

    def __init__(self, plan, fail=None):
        self._plan = plan
        self._fail = fail

    def plan_deployment(self, agent_filter=None):
        return self._plan

    def execute_deployment(self, plan, parallel, rollback_strategy, progress_callback):
        results = {}
        for wave in plan.waves:
            for rid in wave.resource_ids:
                progress_callback(rid, ExecutionStatus.IN_PROGRESS, None)
                failed = rid == self._fail
                progress_callback(rid, ExecutionStatus.FAILED if failed else ExecutionStatus.SUCCESS,
                                  "boom" if failed else None)
                results[rid] = ResourceExecutionResult(rid, ExecutionStatus.FAILED if failed else ExecutionStatus.SUCCESS)
        status = ExecutionStatus.PARTIAL if self._fail else ExecutionStatus.SUCCESS
        result = DeploymentResult(
            status=status,
            wave_results=[WaveExecutionResult(0, results)],
            start_time=datetime.utcnow(), end_time=datetime.utcnow(), duration=1.5,
            total_resources=len(results),
            successful_resources=sum(1 for r in results.values() if r.is_success()),
            failed_resources=sum(1 for r in results.values() if r.is_failed()),
        )
        return result, None

    def plan_destruction(self, agent_filter=None):
        resources = {c.resource_id: c.desired_resource for c in self._plan.all_changes.values()}
        return DestructionPlan(resource_ids=list(reversed(list(resources))), resources=resources)

    def execute_destruction(self, plan, progress_callback):
        for rid in plan.resource_ids:
            progress_callback(rid, ExecutionStatus.IN_PROGRESS, None)
            progress_callback(rid, ExecutionStatus.SUCCESS, None)
        return DestructionResult(status=ExecutionStatus.SUCCESS, total_resources=len(plan.resource_ids),
                                 successful_resources=len(plan.resource_ids), duration=0.4)


def _events(output):
    events = []
    for line in output.splitlines():
        line = line.strip()
        if line.startswith("{"):
            events.append(json.loads(line))
    return events


def test_rich_callback_is_instantiable_and_callable():
    """The regression: the class used to be an abstract Callable alias."""
    from rich.progress import Progress

    assert RichProgressCallback is RichRunProgress
    with Progress() as progress:
        cb = RichProgressCallback(progress, progress.add_task("x", total=None))
        cb.on_plan("deploy", _plan())
        cb("exec-role", ExecutionStatus.IN_PROGRESS, None)
        cb("exec-role", ExecutionStatus.SUCCESS, None)
        assert cb.completed == 1
        assert cb.total == 2


def test_describe_plan_lists_every_change_in_wave_order():
    described = describe_plan(_plan())
    assert [d["id"] for d in described] == ["exec-role", "api-agent"]
    assert described[0] == {"id": "exec-role", "type": "AWS::IAM::Role", "change": "create", "wave": 0, "reason": None}
    assert described[1]["change"] == "update"
    assert described[1]["reason"] == "code changed"


def test_json_progress_carries_duration(capsys):
    reporter = JsonRunProgress()
    reporter("x", ExecutionStatus.IN_PROGRESS, None)
    reporter("x", ExecutionStatus.SUCCESS, None)
    events = _events(capsys.readouterr().out)
    assert events[0] == {"event": "resource", "elapsed": events[0]["elapsed"], "id": "x", "status": "in_progress"}
    assert events[1]["status"] == "success"
    assert isinstance(events[1]["duration"], float)
    assert events[1]["completed"] == 1


def test_deploy_streams_plan_resources_and_complete(project):
    with patch("warpcore.cli.main.create_orchestrator", return_value=FakeOrchestrator(_plan())):
        result = CliRunner().invoke(cli, ["deploy", "--env", "dev", "--progress"])
    assert result.exit_code == 0, result.output
    events = _events(result.output)
    kinds = [e["event"] for e in events]
    assert kinds == ["plan", "resource", "resource", "resource", "resource", "complete"]

    plan = events[0]
    assert plan["kind"] == "deploy"
    assert plan["environment"] == "dev"
    assert plan["project"] == "demo"
    assert plan["total"] == 2
    assert [c["id"] for c in plan["changes"]] == ["exec-role", "api-agent"]

    assert [(e["id"], e["status"]) for e in events[1:5]] == [
        ("exec-role", "in_progress"), ("exec-role", "success"),
        ("api-agent", "in_progress"), ("api-agent", "success"),
    ]
    done = events[-1]
    assert done["status"] == "success"
    assert done["successful"] == 2
    assert done["failed"] == 0
    assert done["duration"] == 1.5
    # No Rich panels on stdout when a program is listening.
    assert "Deployment Configuration" not in result.output


def test_deploy_progress_reports_failure_and_exits_nonzero(project):
    orchestrator = FakeOrchestrator(_plan(), fail="api-agent")
    with patch("warpcore.cli.main.create_orchestrator", return_value=orchestrator):
        result = CliRunner().invoke(cli, ["deploy", "--env", "dev", "--progress"])
    assert result.exit_code == 1
    events = _events(result.output)
    failed = [e for e in events if e["event"] == "resource" and e["status"] == "failed"]
    assert failed and failed[0]["id"] == "api-agent" and failed[0]["error"] == "boom"
    assert events[-1]["status"] == "partial"
    assert events[-1]["failed"] == 1


def test_deploy_progress_with_empty_plan_completes_cleanly(project):
    empty = DeploymentPlan(waves=[], all_changes={})
    with patch("warpcore.cli.main.create_orchestrator", return_value=FakeOrchestrator(empty)):
        result = CliRunner().invoke(cli, ["deploy", "--env", "dev", "--progress"])
    assert result.exit_code == 0, result.output
    events = _events(result.output)
    assert [e["event"] for e in events] == ["plan", "complete"]
    assert events[0]["total"] == 0
    assert events[1]["total"] == 0


def test_deploy_without_progress_still_prints_panels(project):
    with patch("warpcore.cli.main.create_orchestrator", return_value=FakeOrchestrator(_plan())):
        result = CliRunner().invoke(cli, ["deploy", "--env", "dev"])
    assert result.exit_code == 0, result.output
    assert "Deployment successful" in result.output
    assert "Total resources: 2" in result.output


def test_deploy_progress_error_before_execution_is_an_event(project):
    with patch("warpcore.cli.main.create_orchestrator", side_effect=RuntimeError("no credentials")):
        result = CliRunner().invoke(cli, ["deploy", "--env", "dev", "--progress"])
    assert result.exit_code == 1
    events = _events(result.output)
    assert events[-1]["event"] == "error"
    assert "no credentials" in events[-1]["message"]


def test_destroy_progress_needs_no_confirmation(project):
    from warpcore.cli.main import get_state_path
    from warpcore.state.manager import StateManager

    manager = StateManager(str(get_state_path("dev", "demo")))
    manager.initialize(environment="dev", region="us-east-1", account="123456789012", project_name="demo")

    with patch("warpcore.cli.main.create_orchestrator", return_value=FakeOrchestrator(_plan())):
        result = CliRunner().invoke(cli, ["destroy", "--env", "dev", "--progress"])
    assert result.exit_code == 0, result.output
    events = _events(result.output)
    assert events[0]["event"] == "plan"
    assert events[0]["kind"] == "destroy"
    assert [c["change"] for c in events[0]["changes"]] == ["delete", "delete"]
    assert events[-1] == {**events[-1], "event": "complete", "status": "success", "total": 2}


def test_destroy_progress_without_state_reports_empty_plan(project):
    result = CliRunner().invoke(cli, ["destroy", "--env", "dev", "--progress"])
    assert result.exit_code == 0, result.output
    events = _events(result.output)
    assert [e["event"] for e in events] == ["plan", "complete"]
    assert events[0]["total"] == 0
