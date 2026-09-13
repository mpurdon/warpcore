"""What the model proposes is filtered to what the canvas has."""

from unittest.mock import Mock

import pytest

from warpcore.discovery.suggest import draft_scenario, suggest_names


def _llm(reply):
    llm = Mock()
    llm._call_llm.return_value = reply
    return llm


def test_names_are_kept_only_for_known_clusters():
    clusters = [{"id": "vpc-1", "current_name": "vpc-09c3", "members": [{"name": "orders-db", "type": "rds-instance", "tags": {}}]}]
    out = suggest_names(_llm('{"clusters": [{"id": "vpc-1", "name": "orders", "reason": "the database"}, {"id": "ghost", "name": "x", "reason": ""}]}'), clusters, "acct")
    assert out == {"clusters": [{"id": "vpc-1", "name": "orders", "reason": "the database"}]}


def test_a_draft_keeps_only_steps_on_the_canvas_and_a_fixed_trigger():
    graph = {
        "nodes": [{"id": "api", "type": "api-gateway", "name": "api"}, {"id": "fn", "type": "lambda", "name": "fn"}, {"id": "tbl", "type": "dynamodb", "name": "orders"}],
        "edges": [], "hops": {"api": ["fn"], "fn": ["tbl"]}, "trigger": {"at": "api", "event": "POST /orders"},
    }
    reply = '```json\n{"name": "Order placed", "trigger": {"at": "elsewhere"}, "steps": [{"at": "fn", "note": "validates", "takes": 40}, {"at": "nope"}, {"at": "tbl", "note": "writes the row", "detached": false}]}\n```'
    out = draft_scenario(_llm(reply), graph)
    assert out["trigger"] == {"at": "api", "event": "POST /orders"}
    assert out["steps"] == [{"at": "fn", "note": "validates", "takes": 40}, {"at": "tbl", "note": "writes the row"}]
    assert out["name"] == "Order placed"


def test_a_draft_whose_trigger_is_not_on_the_canvas_is_refused():
    graph = {"nodes": [{"id": "fn", "type": "lambda", "name": "fn"}], "edges": [], "hops": {}}
    with pytest.raises(ValueError):
        draft_scenario(_llm('{"name": "x", "trigger": {"at": "ghost"}, "steps": []}'), graph)
