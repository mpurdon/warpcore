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
    server = build_server(str(project), attach_running_app=False)
    assert tool_names(server) == sorted([
        "project_summary", "list_resources", "resource", "connections", "scenarios", "live_detail", "health", "findings",
        "deploy_plan", "connect_plan", "write_mute_finding", "write_scenario",
    ])


def test_canvas_tools_answer_without_aws(project):
    server = build_server(str(project), attach_running_app=False)
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
    server = build_server(str(project), attach_running_app=False)
    out = _call(server, "write_scenario", name="Health", trigger_at="api", event="GET /health", steps=[{"at": "fn", "note": "answers"}])
    assert out == {"added": "Health", "steps": 1}
    data = yaml.safe_load(project.read_text())
    assert [s["name"] for s in data["scenarios"]] == ["Order", "Health"]
    bad = _call(server, "write_scenario", name="X", trigger_at="ghost", event=None, steps=[])
    assert "not on the canvas" in bad["error"]
    _call(server, "write_mute_finding", finding_id="idle:fn", reason="batch job, runs nightly")
    assert (project.parent / ".warpcore" / "findings-mutes.yaml").exists()


class FakeBridge:
    """The running app, as the MCP server sees it."""

    def __init__(self):
        self.calls = []

    def alive(self):
        return True

    def tools(self):
        return [
            {"name": "canvas_addNode", "kind": "project", "description": "Add a resource.",
             "input_schema": {"type": "object", "properties": {"type": {"type": "string"}, "x": {"type": "number"}, "config": {"type": "object"}}, "required": ["type"]}},
            {"name": "account_deploy", "kind": "aws-change", "description": "Deploy.", "input_schema": {"type": "object", "properties": {}, "required": []}},
            {"name": "query_path", "kind": "query", "description": "Path.", "input_schema": {"type": "object", "properties": {"from": {"type": "string"}, "to": {"type": "string"}}, "required": ["from", "to"]}},
        ]

    def run(self, command, args):
        self.calls.append((command, args))
        return {"ok": True, "summary": command, "result": {"id": "sqs-1"}}


def test_the_running_app_becomes_tools(project):
    from warpcore.mcp_server import attach_app
    bridge = FakeBridge()
    server = build_server(str(project), app=bridge)
    names = tool_names(server)
    assert "canvas_addNode" in names and "account_deploy" in names and "project_summary" in names
    tool = next(t for t in asyncio.run(server.list_tools()) if t.name == "canvas_addNode")
    assert tool.inputSchema["required"] == ["type"]
    assert "x" in tool.inputSchema["properties"]
    deploy = next(t for t in asyncio.run(server.list_tools()) if t.name == "account_deploy")
    assert "confirms it in the app" in deploy.description
    out = _call(server, "canvas_addNode", type="sqs", x=10.0)
    assert out == {"ok": True, "summary": "canvas.addNode", "result": {"id": "sqs-1"}}
    assert bridge.calls == [("canvas.addNode", {"type": "sqs", "x": 10.0})]
    assert attach_app(build_server(str(project), attach_running_app=False), bridge) == ["canvas_addNode", "account_deploy", "query_path"]
    path = next(t for t in asyncio.run(server.list_tools()) if t.name == "query_path")
    assert sorted(path.inputSchema["required"]) == ["from_", "to"]
    _call(server, "query_path", from_="api", to="fn")
    assert bridge.calls[-1] == ("query.path", {"from": "api", "to": "fn"})


def test_without_the_app_only_file_tools(project):
    server = build_server(str(project), attach_running_app=False)
    assert "canvas_addNode" not in tool_names(server)


def test_app_bridge_speaks_http(tmp_path):
    """The bridge client against a stand-in for the app's door."""
    import threading
    from http.server import BaseHTTPRequestHandler, HTTPServer
    from warpcore.mcp_server import AppBridge

    seen = []

    class Door(BaseHTTPRequestHandler):
        def log_message(self, *_a):  # quiet
            pass

        def _send(self, code, body):
            data = json.dumps(body).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            if self.headers.get("X-Warpcore-Token") != "secret":
                return self._send(401, {"error": "bad token"})
            if self.path == "/health":
                return self._send(200, {"ok": True})
            if self.path == "/tools":
                return self._send(200, {"tools": [{"name": "query_project", "kind": "query", "description": "d", "input_schema": {"type": "object", "properties": {}, "required": []}}]})
            self._send(404, {})

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
            seen.append(body)
            self._send(200, {"ok": True, "summary": body["command"], "result": {"name": "shop"}})

    server = HTTPServer(("127.0.0.1", 0), Door)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        app_file = tmp_path / "app.json"
        app_file.write_text(json.dumps({"port": server.server_address[1], "token": "secret"}))
        bridge = AppBridge.find(app_file)
        assert bridge is not None
        assert [t["name"] for t in bridge.tools()] == ["query_project"]
        assert bridge.run("query.project", {}) == {"ok": True, "summary": "query.project", "result": {"name": "shop"}}
        assert seen == [{"command": "query.project", "args": {}}]
        app_file.write_text(json.dumps({"port": server.server_address[1], "token": "wrong"}))
        assert AppBridge.find(app_file) is None
        assert AppBridge.find(tmp_path / "missing.json") is None
    finally:
        server.shutdown()
