"""`warpcore diff` and `warpcore graph`.

Both were written against an API that never existed - DeploymentPlanner takes
no constructor arguments, and plan_deployment / get_roots / add_dependency /
get_all_resources are not defined on the classes they were called on. Both
failed on the first line that touched the config.
"""

import json
from unittest.mock import patch

import pytest
from click.testing import CliRunner

from warpcore.cli.main import cli
from warpcore.orchestrator.dependency_graph import DependencyGraph
from warpcore.orchestrator.planner import (
    DeploymentPlan,
    DeploymentWave,
    ResourceChange,
)
from warpcore.provisioners.base import ChangeType
from warpcore.state.manager import StateManager
from warpcore.state.models import Resource

CONFIG = """\
project:
  name: demo
  region: us-east-1
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


@pytest.fixture
def state(project):
    path = project / ".warpcore" / "state" / "demo-dev.json"
    manager = StateManager(str(path))
    manager.initialize(environment="dev", region="us-east-1",
                       account="123456789012", project_name="demo")
    current = manager.load()
    current.add_resource("app", Resource(
        id="exec-role", type="AWS::IAM::Role",
        physical_id="arn:aws:iam::123456789012:role/exec-role",
    ))
    current.add_resource("app", Resource(
        id="api-agent", type="AWS::Lambda::Function",
        physical_id="arn:aws:lambda:us-east-1:123456789012:function:api-agent",
        properties={"MemorySize": 512}, dependencies=["exec-role"],
    ))
    manager.save(current)
    return manager


def _run(*args):
    return CliRunner().invoke(cli, list(args), catch_exceptions=False)


def _plan_with(*changes):
    """A DeploymentPlan shaped the way the real planner returns one."""
    wave = DeploymentWave(wave_number=1, resource_ids=[c.resource_id for c in changes])
    for change in changes:
        wave.add_change(change)
    return DeploymentPlan(
        waves=[wave],
        all_changes={c.resource_id: c for c in changes},
        estimated_duration=90,
    )


def _change(resource_id, change_type, **kwargs):
    resource = Resource(id=resource_id, type="AWS::Lambda::Function", **kwargs)
    return ResourceChange(
        resource_id=resource_id,
        change_type=change_type,
        desired_resource=resource if change_type is not ChangeType.DELETE else None,
        current_resource=resource if change_type is not ChangeType.CREATE else None,
    )


class TestDiff:
    """The planner is stubbed: diff's job is rendering a plan, not building one."""

    def test_renders_a_plan(self, project):
        plan = _plan_with(
            _change("new-fn", ChangeType.CREATE, properties={"MemorySize": 512}),
            _change("old-fn", ChangeType.DELETE),
        )
        with patch("warpcore.cli.main.create_orchestrator") as factory:
            factory.return_value.plan_deployment.return_value = plan
            result = _run("diff", "--env", "dev")

        assert result.exit_code == 0, result.output
        assert "1 to add" in result.output
        assert "1 to destroy" in result.output
        assert "new-fn" in result.output

    def test_no_changes_says_so(self, project):
        with patch("warpcore.cli.main.create_orchestrator") as factory:
            factory.return_value.plan_deployment.return_value = DeploymentPlan(waves=[])
            result = _run("diff", "--env", "dev")

        assert result.exit_code == 0
        assert "No changes" in result.output

    def test_json_output_is_parseable(self, project):
        plan = _plan_with(_change("new-fn", ChangeType.CREATE))
        with patch("warpcore.cli.main.create_orchestrator") as factory:
            factory.return_value.plan_deployment.return_value = plan
            result = _run("diff", "--env", "dev", "--json-output")

        payload = json.loads(result.stdout)
        assert payload["summary"] == {"to_add": 1, "to_change": 0, "to_destroy": 0}
        assert payload["changes"]["create"] == ["new-fn"]
        assert payload["waves"] == [{"wave": 1, "resources": ["new-fn"]}]

    def test_agent_filter_is_passed_through(self, project):
        with patch("warpcore.cli.main.create_orchestrator") as factory:
            factory.return_value.plan_deployment.return_value = DeploymentPlan(waves=[])
            _run("diff", "--env", "dev", "--agent", "api-agent")
            factory.return_value.plan_deployment.assert_called_once_with(
                agent_filter="api-agent"
            )

    def test_unknown_environment_exits_nonzero(self, project):
        result = _run("diff", "--env", "nope")
        assert result.exit_code == 1
        assert "nope" in result.output

    def test_missing_config_exits_nonzero(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        assert _run("diff", "--env", "dev").exit_code == 1


class TestGraph:
    def test_tree_format_lists_resources(self, state):
        result = _run("graph", "--env", "dev")
        assert result.exit_code == 0, result.output
        assert "exec-role" in result.output

    def test_dependencies_are_registered_from_the_resource(self, state):
        """add_resource reads resource.dependencies; the old code also called a
        non-existent add_dependency()."""
        result = _run("graph", "--env", "dev")
        # api-agent depends on exec-role, so it hangs beneath it in the tree.
        assert "api-agent" in result.output

    def test_ascii_format(self, state):
        result = _run("graph", "--env", "dev", "--format", "ascii")
        assert result.exit_code == 0, result.output
        assert "Level 0" in result.output

    def test_dot_format_writes_a_file(self, state, tmp_path):
        out = tmp_path / "graph.dot"
        result = _run("graph", "--env", "dev", "--format", "dot", "--output", str(out))
        assert result.exit_code == 0, result.output

        dot = out.read_text()
        assert "digraph" in dot
        assert '"exec-role" -> "api-agent"' in dot, "dependency edge missing"

    def test_unknown_environment_is_reported(self, state):
        result = _run("graph", "--env", "nope")
        assert "nope" in result.output


class TestDependencyGraphAdditions:
    """get_roots and resource_ids did not exist; graph.py called both."""

    def _graph(self):
        graph = DependencyGraph()
        graph.add_resource(Resource(id="role", type="AWS::IAM::Role"))
        graph.add_resource(Resource(id="fn", type="AWS::Lambda::Function",
                                    dependencies=["role"]))
        graph.add_resource(Resource(id="api", type="AWS::ApiGatewayV2::Api",
                                    dependencies=["fn"]))
        return graph

    def test_resource_ids_are_sorted(self):
        assert self._graph().resource_ids() == ["api", "fn", "role"]

    def test_roots_depend_on_nothing(self):
        assert self._graph().get_roots() == ["role"]

    def test_leaves_have_no_dependents(self):
        assert self._graph().get_leaves() == ["api"]

    def test_empty_graph_has_no_roots(self):
        assert DependencyGraph().get_roots() == []

    def test_disconnected_resources_are_all_roots(self):
        graph = DependencyGraph()
        for name in ("a", "b"):
            graph.add_resource(Resource(id=name, type="AWS::S3::Bucket"))
        assert graph.get_roots() == ["a", "b"]
