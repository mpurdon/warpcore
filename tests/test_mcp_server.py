"""The project over MCP: every tool registered, the canvas tools answering offline."""

import asyncio
import json

import pytest
import yaml

pytest.importorskip("mcp")

from warpcore.mcp_server import build_server, tool_names


@pytest.fixture
def project(tmp_path):
    data = {
        "project": {"name": "shop", "region": "us-east-1"}, "agents": [], "resources": [],
        "environments": {"dev": {"account": "123456789012", "region": "us-east-1", "profile": "team"}},
        "scenarios": [{"name": "Order", "trigger": {"at": "api"}, "steps": [{"at": "fn"}]}],
        "canvas": {
            "nodes": [
                {"id": "api", "type": "api-gateway", "label": "orders-api", "x": 0, "y": 0, "config": {}},
                {"id": "fn", "type": "lambda", "label": "place-order", "x": 0, "y": 0, "arn": "arn:aws:lambda:us-east-1:1:function:place-order",
                 "config": {}, "meta": {"provenance": {"manager": "terraform", "address": "aws_lambda_function.place"}}},
                {"id": "application-x", "type": "application", "label": "shop", "x": 0, "y": 0},
            ],
            "edges": [{"id": "e1", "source": "api", "target": "fn", "config": {"method": "POST", "path": "/orders"}, "meta": {"layer": "triggers"}}],
        },
    }
    path = tmp_path / "warpcore.yaml"
    path.write_text(yaml.safe_dump(data))
    return path


def _call(server, tool, **args):
    result = asyncio.run(server.call_tool(tool, args))
    # FastMCP returns (content blocks, structured output); the structured half wraps the value under "result".
    if isinstance(result, tuple):
        return result[1]["result"]
    text = next(c.text for c in result if getattr(c, "type", "") == "text")
    return json.loads(text)


def test_every_tool_is_registered(project):
    server = build_server(str(project))
    assert tool_names(server) == sorted([
        "project_summary", "list_resources", "resource", "connections", "scenarios", "live_detail", "health", "findings",
        "deploy_plan", "connect_plan", "write_mute_finding", "write_scenario",
    ])


def test_canvas_tools_answer_without_aws(project):
    server = build_server(str(project))
    summary = _call(server, "project_summary")
    assert summary["resources_by_type"] == {"api-gateway": 1, "lambda": 1}
    assert summary["environments"]["dev"]["profile"] == "team"
    assert summary["scenarios"] == [{"name": "Order", "steps": 1}]
    fns = _call(server, "list_resources", type="lambda")
    assert fns[0]["provenance"]["manager"] == "terraform" and fns[0]["managed"] is False
    one = _call(server, "resource", id="place-order")
    assert one["id"] == "fn" and one["edges"][0]["config"]["path"] == "/orders"
    assert _call(server, "connections")[0]["meta"]["layer"] == "triggers"


def test_writes_touch_only_the_project(project):
    server = build_server(str(project))
    out = _call(server, "write_scenario", name="Health", trigger_at="api", event="GET /health", steps=[{"at": "fn", "note": "answers"}])
    assert out == {"added": "Health", "steps": 1}
    data = yaml.safe_load(project.read_text())
    assert [s["name"] for s in data["scenarios"]] == ["Order", "Health"]
    bad = _call(server, "write_scenario", name="X", trigger_at="ghost", event=None, steps=[])
    assert "not on the canvas" in bad["error"]
    _call(server, "write_mute_finding", finding_id="idle:fn", reason="batch job, runs nightly")
    assert (project.parent / ".warpcore" / "findings-mutes.yaml").exists()
