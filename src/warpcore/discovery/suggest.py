"""Suggestions a model makes over the canvas's facts, in two shapes.

Both take a JSON description the app already has and return a structured
answer the app then checks: a name for an application the rules could not
name, and a scenario draft the scenario checker validates hop by hop. The
model proposes; the deterministic side disposes.
"""

import json
from typing import Any, Dict, List

from warpcore.discovery.findings import _parse_json


def suggest_names(llm: Any, clusters: List[Dict[str, Any]], project_name: str) -> Dict[str, Any]:
    """Name each application from its members' names, types and tags.

    `clusters`: [{id, current_name, members: [{name, type, tags}]}]
    Returns {"clusters": [{"id", "name", "reason"}]}.
    """
    prompt = (
        f"An operator imported an AWS account into a project called {project_name!r}. The import groups resources into "
        "applications; the groups below could not be named by their name prefixes, so each was named after its busiest member "
        "or an AWS id. Give each group a short name a team would recognise (one or two lowercase words, hyphenated, no "
        "environment tokens like dev or prod, no AWS ids), and one short reason. If the members really share nothing, say "
        "\"shared platform\".\n\n"
        "Answer with JSON only, in this shape:\n"
        '{"clusters": [{"id": "<cluster id>", "name": "...", "reason": "..."}]}\n\n'
        f"Groups:\n{json.dumps(clusters, separators=(',', ':'))}\n"
    )
    parsed = _parse_json(llm._call_llm(prompt))  # noqa: SLF001
    out: List[Dict[str, str]] = []
    known = {c.get("id") for c in clusters}
    for item in parsed.get("clusters") or []:
        if item.get("id") in known and isinstance(item.get("name"), str) and item["name"].strip():
            out.append({"id": item["id"], "name": item["name"].strip()[:48], "reason": str(item.get("reason") or "").strip()[:160]})
    return {"clusters": out}


def draft_scenario(llm: Any, graph: Dict[str, Any], ask: str = "") -> Dict[str, Any]:
    """Draft a scenario: a trigger and the steps a request takes through the graph.

    `graph`: {nodes: [{id, type, name, band?}], edges: [{source, target, kind, detail}],
              hops: {node id: [reachable node ids]}, trigger?: {at, event}}
    Returns {"name", "trigger": {"at", "event"}, "steps": [{"at", "note", "takes"?, "detached"?}]}.
    Steps must follow `hops`; the app checks them again and marks any it cannot ground.
    """
    trigger = graph.get("trigger")
    prompt = (
        "You are drafting a scenario for an operator's canvas: a named event that arrives at one resource and the "
        "steps the request takes through the others, in order. Use only node ids from the graph. Each step's `at` must "
        "be reachable from the previous step (or the trigger) according to `hops`; do not invent hops. Write each "
        "step's note as what happens there, in plain words (\"validates the signature\", \"writes the order row\"). "
        "Give `takes` in milliseconds where a duration is natural (a function run, a query), and mark fire-and-forget "
        "steps such as publishing to a topic `detached`. Keep it to the path that tells the story: five to ten steps.\n"
        + (f"The trigger is fixed: {json.dumps(trigger)}.\n" if trigger else "Choose the trigger: the resource where traffic arrives (an API, a queue, a rule, a load balancer) and a short event name.\n")
        + (f"The operator asked for: {ask.strip()}\n" if ask.strip() else "")
        + "\nAnswer with JSON only, in this shape:\n"
        '{"name": "...", "trigger": {"at": "<node id>", "event": "..."}, "steps": [{"at": "<node id>", "note": "...", "takes": 40, "detached": false}]}\n\n'
        f"Graph:\n{json.dumps({k: v for k, v in graph.items() if k != 'trigger'}, separators=(',', ':'))}\n"
    )
    parsed = _parse_json(llm._call_llm(prompt))  # noqa: SLF001
    ids = {n.get("id") for n in graph.get("nodes") or []}
    steps = []
    for st in parsed.get("steps") or []:
        if st.get("at") not in ids:
            continue
        step: Dict[str, Any] = {"at": st["at"]}
        if isinstance(st.get("note"), str) and st["note"].strip():
            step["note"] = st["note"].strip()[:200]
        if isinstance(st.get("takes"), (int, float)) and st["takes"] > 0:
            step["takes"] = int(st["takes"])
        if st.get("detached") is True:
            step["detached"] = True
        steps.append(step)
    out_trigger = trigger or parsed.get("trigger") or {}
    if out_trigger.get("at") not in ids:
        raise ValueError("the draft's trigger is not on the canvas")
    return {
        "name": str(parsed.get("name") or "Drafted scenario").strip()[:80],
        "trigger": {"at": out_trigger["at"], **({"event": str(out_trigger["event"])[:80]} if out_trigger.get("event") else {})},
        "steps": steps,
    }
