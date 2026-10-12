"""The worker: one request per line, one answer per line, errors kept in-band."""

import io
import json
from unittest.mock import patch

from warpcore.assistant.converse import Turn, serve_turns


def test_serve_answers_each_line_and_survives_errors():
    calls = []

    def fake(provider, model, system, messages, tools, max_tokens=4096, client=None, endpoint=None):
        calls.append((provider, model, max_tokens, endpoint))
        if provider == "openai":
            raise RuntimeError("no key")
        return Turn([{"type": "text", "text": "hi"}], "end_turn", "m", {"input": 1, "output": 1})

    stdin = io.StringIO(
        json.dumps({"id": "a", "provider": "anthropic", "model": "m", "system": "s", "messages": [], "tools": [], "max_tokens": 512}) + "\n"
        + "not json\n"
        + json.dumps({"id": "b", "provider": "openai"}) + "\n\n"
    )
    stdout = io.StringIO()
    with patch("warpcore.assistant.converse.converse", fake):
        serve_turns(stdin, stdout)
    lines = [json.loads(l) for l in stdout.getvalue().splitlines()]
    assert lines[0] == {"id": "a", "result": {"content": [{"type": "text", "text": "hi"}], "stop_reason": "end_turn", "model": "m", "usage": {"input": 1, "output": 1}}}
    assert lines[1]["id"] is None and "bad request" in lines[1]["error"]
    assert lines[2] == {"id": "b", "error": "no key"}
    assert calls == [("anthropic", "m", 512, None), ("openai", None, 4096, None)]
