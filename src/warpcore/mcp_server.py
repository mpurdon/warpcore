"""The project as an MCP server, so an agent in an editor can read it.

Claude Code, Cursor and their kind act on what they can see. This exposes a
warpcore project the way the Visual Builder sees it: the canvas, the
wiring, the scenarios, what the account says about each resource, the
review's findings, the deploy plan. Every tool is read-only except the two
that say so in their name, and those write only the project's own files.

Run with `warpcore mcp --config warpcore.yaml`; the transport is stdio, the
one every client speaks. The `mcp` package is optional (`pip install
"warpcore[mcp]"`).
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, List, Optional

import yaml


APP_FILE = Path.home() / ".warpcore" / "app.json"
APP_TIMEOUT = 240  # seconds a command may wait on the operator's confirmation


class AppBridge:
    """The running Visual Builder, reached over its local bridge.

    The app writes ~/.warpcore/app.json with its port and a token when it
    starts; every request carries the token, so only something that can
    read the operator's home directory can drive their app.
    """

    def __init__(self, port: int, token: str):
        self.port = port
        self.token = token

    @classmethod
    def find(cls, app_file: Path = APP_FILE) -> Optional["AppBridge"]:
        try:
            data = json.loads(app_file.read_text())
            bridge = cls(int(data["port"]), str(data["token"]))
        except (OSError, ValueError, KeyError, TypeError):
            return None
        return bridge if bridge.alive() else None

    def _request(self, method: str, route: str, body: Optional[Dict[str, Any]] = None, timeout: float = APP_TIMEOUT) -> Dict[str, Any]:
        import urllib.request
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}{route}", data=data, method=method,
                                     headers={"Content-Type": "application/json", "X-Warpcore-Token": self.token})
        with urllib.request.urlopen(req, timeout=timeout) as r:  # noqa: S310 - loopback, token-checked
            return json.loads(r.read() or b"{}")

    def alive(self) -> bool:
        try:
            return bool(self._request("GET", "/health", timeout=2).get("ok"))
        except Exception:  # noqa: BLE001 - not running is the common case
            return False

    def tools(self) -> List[Dict[str, Any]]:
        return list(self._request("GET", "/tools", timeout=15).get("tools") or [])

    def run(self, command: str, args: Dict[str, Any]) -> Dict[str, Any]:
        return self._request("POST", "/command", {"command": command, "args": args})


def _app_tool(bridge: AppBridge, spec: Dict[str, Any]):
    """A function with the command's own signature, so FastMCP publishes its schema."""
    import inspect
    import keyword

    props = (spec.get("input_schema") or {}).get("properties") or {}
    required = set((spec.get("input_schema") or {}).get("required") or [])
    kinds = {"string": str, "number": float, "integer": int, "boolean": bool, "array": list, "object": dict}
    params = []
    # A command may call an argument `from`; Python cannot. The tool takes
    # `from_` and hands the command the name it declared.
    names = {(f"{name}_" if keyword.iskeyword(name) else name): name for name in props}
    for pyname, name in names.items():
        p = props[name]
        annotation = kinds.get(p.get("type", "string"), Any)
        if name in required:
            params.append(inspect.Parameter(pyname, inspect.Parameter.KEYWORD_ONLY, annotation=annotation))
        else:
            params.append(inspect.Parameter(pyname, inspect.Parameter.KEYWORD_ONLY, default=None, annotation=Optional[annotation]))
    command = spec["name"].replace("_", ".", 1)

    def tool(**kwargs):
        args = {names[k]: v for k, v in kwargs.items() if v is not None}
        return bridge.run(command, args)

    tool.__name__ = spec["name"]
    tool.__doc__ = spec.get("description", "")
    tool.__signature__ = inspect.Signature(params)  # type: ignore[attr-defined]
    tool.__annotations__ = {p.name: p.annotation for p in params}
    return tool


def attach_app(server, bridge: AppBridge) -> List[str]:
    """Register the running app's commands as tools. Returns their names."""
    names = []
    for spec in bridge.tools():
        kind = spec.get("kind", "")
        desc = spec.get("description", "")
        if kind == "aws-change":
            desc += " The operator confirms it in the app before it runs; the call waits for their answer."
        server.add_tool(_app_tool(bridge, spec), name=spec["name"], description=desc)
        names.append(spec["name"])
    return names


def build_server(config_path: str, profile: Optional[str] = None, region: Optional[str] = None, app: Optional[AppBridge] = None,
                 attach_running_app: bool = True):
    """A FastMCP server over one project. Imported lazily so the CLI loads without `mcp`.

    When the Visual Builder is running, its commands are tools too: the
    canvas as it is on screen, selection, lenses, scenarios, deploys with
    the operator's confirmation. Without it, the file is what there is.
    """
    from mcp.server.fastmcp import FastMCP

    path = Path(config_path).resolve()
    project_dir = path.parent
    bridge = app if app is not None else (AppBridge.find() if attach_running_app else None)
    server = FastMCP(
        "warpcore",
        instructions=(
            f"The warpcore project at {path}. Read the canvas first (project_summary, list_resources); "
            "resource ids are the canvas node ids. Live tools call AWS with the project's profile and are slower."
            + (" The Visual Builder is running: tools named group_action (query_project, canvas_addNode, view_select, account_deploy, ...) "
               "act on the open canvas as the operator sees it, and the file tools below read what was last saved. Prefer the app's "
               "query_* tools for the current state." if bridge else "")
        ),
    )
    if bridge:
        attach_app(server, bridge)

    def load() -> Dict[str, Any]:
        return yaml.safe_load(path.read_text()) or {}

    def nodes() -> List[Dict[str, Any]]:
        return ((load().get("canvas") or {}).get("nodes")) or []

    def edges() -> List[Dict[str, Any]]:
        return ((load().get("canvas") or {}).get("edges")) or []

    def env_name(data: Dict[str, Any], wanted: Optional[str]) -> str:
        envs = data.get("environments") or {}
        if wanted:
            return wanted
        return next(iter(envs)) if isinstance(envs, dict) and envs else "dev"

    def session_for(data: Dict[str, Any], environment: Optional[str]):
        from warpcore.utils.aws_client import AWSClientManager
        envs = data.get("environments") or {}
        block = (envs.get(env_name(data, environment)) or {}) if isinstance(envs, dict) else {}
        prof = profile or block.get("profile")
        reg = region or block.get("region") or (data.get("project") or {}).get("region") or "us-east-1"
        manager = AWSClientManager(profile=prof, region=reg)
        return manager.session, reg

    # ------------------------------------------------------------ canvas

    @server.tool()
    def project_summary() -> Dict[str, Any]:
        """The project: name, environments, counts of resources by type, scenarios, and what the canvas holds."""
        data = load()
        ns = nodes()
        by_type: Dict[str, int] = {}
        for n in ns:
            if n.get("type") in ("application", "band", "enclosure") or n.get("hidden"):
                continue
            by_type[n.get("type", "?")] = by_type.get(n.get("type", "?"), 0) + 1
        return {
            "path": str(path),
            "project": data.get("project"),
            "environments": {k: {kk: vv for kk, vv in (v or {}).items() if kk in ("account", "region", "profile")} for k, v in (data.get("environments") or {}).items()},
            "resources_by_type": dict(sorted(by_type.items())),
            "edges": len(edges()),
            "scenarios": [{"name": s.get("name"), "steps": len(s.get("steps") or [])} for s in data.get("scenarios") or []],
            "discovered": sum(1 for n in ns if n.get("arn")),
            "managed": sum(1 for n in ns if n.get("arn") and (n.get("meta") or {}).get("managed")),
        }

    @server.tool()
    def list_resources(type: Optional[str] = None, query: Optional[str] = None) -> List[Dict[str, Any]]:
        """Resources on the canvas, optionally by type (e.g. lambda, dynamodb, ec2-instance) or a substring of the name."""
        out = []
        for n in nodes():
            if n.get("type") in ("application", "band", "enclosure") or n.get("hidden"):
                continue
            if type and n.get("type") != type:
                continue
            label = str(n.get("label") or n.get("id"))
            if query and query.lower() not in label.lower() and query.lower() not in str(n.get("id")).lower():
                continue
            meta = n.get("meta") or {}
            out.append({
                "id": n.get("id"), "type": n.get("type"), "name": label, "arn": n.get("arn"), "region": n.get("region"),
                "parent": n.get("parent"), "health": meta.get("health"), "provenance": meta.get("provenance"),
                "managed": bool(meta.get("managed")), "application": (meta.get("application") or {}).get("name"),
            })
        return out

    @server.tool()
    def resource(id: str) -> Dict[str, Any]:
        """One resource in full: its config, metadata, and every edge in and out with what the edge means."""
        for n in nodes():
            if n.get("id") == id or n.get("arn") == id or n.get("label") == id:
                es = [e for e in edges() if e.get("source") == n.get("id") or e.get("target") == n.get("id")]
                return {**n, "edges": [{"id": e.get("id"), "source": e.get("source"), "target": e.get("target"), "meta": e.get("meta"), "config": e.get("config")} for e in es]}
        return {"error": f"no resource {id} on the canvas"}

    @server.tool()
    def connections() -> List[Dict[str, Any]]:
        """Every edge on the canvas: source, target, layer, and the discovered relationship or access it carries."""
        return [{"id": e.get("id"), "source": e.get("source"), "target": e.get("target"), "meta": e.get("meta"), "config": e.get("config")} for e in edges()]

    @server.tool()
    def scenarios() -> List[Dict[str, Any]]:
        """The scenarios: named events played through the resources, with their steps."""
        return list(load().get("scenarios") or [])

    # -------------------------------------------------------------- live

    @server.tool()
    def live_detail(arn: str, hours: int = 24, environment: Optional[str] = None) -> Dict[str, Any]:
        """What AWS says about one resource now: configuration, network, metrics over `hours`, logs, related resources, health."""
        from warpcore.discovery.detail import ResourceDetailReader
        session, reg = session_for(load(), environment)
        return ResourceDetailReader(session, reg).read(arn, window_hours=hours).to_dict()

    @server.tool()
    def health(environment: Optional[str] = None) -> Dict[str, Any]:
        """Live health of every resource on the canvas that reports one: running, stopped, gone."""
        from warpcore.discovery.health import canvas_health
        data = load()
        session, reg = session_for(data, environment)
        return canvas_health(session, reg, nodes())

    @server.tool()
    def findings(hours: int = 24, environment: Optional[str] = None) -> Dict[str, Any]:
        """The review: what is wrong, wasteful or fragile, from metrics over `hours`, with evidence, effort and savings."""
        from warpcore.discovery.findings import ProjectReviewer
        data = load()
        session, reg = session_for(data, environment)
        return ProjectReviewer(session, reg, project_dir=project_dir).review(nodes(), hours=hours).to_dict()

    @server.tool()
    def deploy_plan(environment: Optional[str] = None) -> Dict[str, Any]:
        """What a deploy would create, change or delete, property by property, without applying anything."""
        from warpcore.cli.main import create_orchestrator, load_config
        from warpcore.orchestrator.plan_detail import detail_plan
        data = load()
        env = env_name(data, environment)
        config = load_config(str(path))
        orchestrator = create_orchestrator(config, env, profile=profile, region=region)
        plan = orchestrator.plan_deployment()
        return {
            "summary": plan.get_summary(),
            "changes": [d.to_dict() for d in detail_plan(plan)],
            "notes": orchestrator.compile_notes,
            "skipped": orchestrator.compile_skipped,
        }

    @server.tool()
    def connect_plan(arn: str, environment: Optional[str] = None) -> Dict[str, Any]:
        """How to reach an EC2 instance from this machine: the checks and the command. Advice only."""
        from warpcore.discovery.connect import ConnectAdvisor
        data = load()
        session, reg = session_for(data, environment)
        return ConnectAdvisor(session, reg, profile=profile).plan(arn).to_dict()

    # ------------------------------------------------------------ writes

    @server.tool()
    def write_mute_finding(finding_id: str, reason: str) -> Dict[str, Any]:
        """Accept a finding with a reason. Writes .warpcore/findings-mutes.yaml in the project; nothing in AWS."""
        from warpcore.discovery.findings import write_mute
        write_mute(project_dir, finding_id, reason)
        return {"muted": finding_id, "reason": reason}

    @server.tool()
    def write_scenario(name: str, trigger_at: str, event: Optional[str], steps: List[Dict[str, Any]]) -> Dict[str, Any]:
        """Add a scenario to the project file. Steps are {at: <node id>, note?, takes?}. The Visual Builder checks every hop against the wiring when it opens."""
        data = load()
        ids = {n.get("id") for n in nodes()}
        bad = [s.get("at") for s in steps if s.get("at") not in ids] + ([trigger_at] if trigger_at not in ids else [])
        if bad:
            return {"error": f"not on the canvas: {', '.join(map(str, bad))}"}
        scenario = {"name": name, "trigger": {"at": trigger_at, **({"event": event} if event else {})}, "steps": steps}
        data.setdefault("scenarios", []).append(scenario)
        path.write_text(yaml.safe_dump(data, sort_keys=False, allow_unicode=True))
        return {"added": name, "steps": len(steps)}

    return server


def serve(config_path: str, profile: Optional[str] = None, region: Optional[str] = None) -> None:
    build_server(config_path, profile, region).run(transport="stdio")


def tool_names(server) -> List[str]:
    """The registered tools, for tests and `--list`."""
    import asyncio
    return sorted(t.name for t in asyncio.run(server.list_tools()))


__all__ = ["AppBridge", "attach_app", "build_server", "serve", "tool_names"]

if __name__ == "__main__":  # pragma: no cover
    import sys
    serve(sys.argv[1] if len(sys.argv) > 1 else "warpcore.yaml")
