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

from pathlib import Path
from typing import Any, Dict, List, Optional

import yaml


def build_server(config_path: str, profile: Optional[str] = None, region: Optional[str] = None):
    """A FastMCP server over one project. Imported lazily so the CLI loads without `mcp`."""
    from mcp.server.fastmcp import FastMCP

    path = Path(config_path).resolve()
    project_dir = path.parent
    server = FastMCP(
        "warpcore",
        instructions=(
            f"The warpcore project at {path}. Read the canvas first (project_summary, list_resources); "
            "resource ids are the canvas node ids. Live tools call AWS with the project's profile and are slower."
        ),
    )

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


__all__ = ["build_server", "serve", "tool_names"]

if __name__ == "__main__":  # pragma: no cover
    import sys
    serve(sys.argv[1] if len(sys.argv) > 1 else "warpcore.yaml")
