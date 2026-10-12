"""One shape in, each provider's shape out, and the reply mapped back."""

import json
from types import SimpleNamespace as NS
from unittest.mock import Mock

import pytest

from warpcore.assistant.converse import _to_bedrock_messages, _to_openai_messages, converse

TOOLS = [{"name": "canvas_addNode", "description": "Add a resource.", "input_schema": {"type": "object", "properties": {"type": {"type": "string"}}, "required": ["type"]}}]
MESSAGES = [
    {"role": "user", "content": [{"type": "text", "text": "add a queue"}]},
    {"role": "assistant", "content": [{"type": "text", "text": "Adding it."}, {"type": "tool_use", "id": "t1", "name": "canvas_addNode", "input": {"type": "sqs"}}]},
    {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "t1", "content": {"id": "sqs-1"}, "is_error": False}]},
]


def test_anthropic_turn_maps_blocks_and_stop_reason():
    client = Mock()
    client.messages.create.return_value = NS(
        content=[NS(type="text", text="Done."), NS(type="tool_use", id="t2", name="view_select", input={"id": "sqs-1"})],
        stop_reason="tool_use", model="claude-opus-5", usage=NS(input_tokens=120, output_tokens=30),
    )
    turn = converse("anthropic", "claude-opus-5", "sys", MESSAGES, TOOLS, client=client)
    assert turn.content == [{"type": "text", "text": "Done."}, {"type": "tool_use", "id": "t2", "name": "view_select", "input": {"id": "sqs-1"}}]
    assert turn.stop_reason == "tool_use" and turn.usage == {"input": 120, "output": 30}
    kwargs = client.messages.create.call_args.kwargs
    assert kwargs["tools"][0]["input_schema"]["required"] == ["type"] and kwargs["system"] == "sys"


def test_openai_messages_carry_tool_calls_and_results():
    msgs = _to_openai_messages("sys", MESSAGES)
    assert msgs[0] == {"role": "system", "content": "sys"}
    assert msgs[2]["tool_calls"][0]["function"] == {"name": "canvas_addNode", "arguments": json.dumps({"type": "sqs"})}
    assert msgs[3] == {"role": "tool", "tool_call_id": "t1", "content": json.dumps({"id": "sqs-1"})}
    client = Mock()
    client.chat.completions.create.return_value = NS(
        choices=[NS(message=NS(content=None, tool_calls=[NS(id="c1", function=NS(name="query_project", arguments="{}"))]), finish_reason="tool_calls")],
        model="gpt-5", usage=NS(prompt_tokens=10, completion_tokens=5),
    )
    turn = converse("openai", "gpt-5", "sys", MESSAGES, TOOLS, client=client)
    assert turn.content == [{"type": "tool_use", "id": "c1", "name": "query_project", "input": {}}] and turn.stop_reason == "tool_use"


def test_bedrock_converse_shape():
    msgs = _to_bedrock_messages(MESSAGES)
    assert msgs[1]["content"][1] == {"toolUse": {"toolUseId": "t1", "name": "canvas_addNode", "input": {"type": "sqs"}}}
    assert msgs[2]["content"][0]["toolResult"]["status"] == "success"
    client = Mock()
    client.converse.return_value = {"output": {"message": {"content": [{"text": "ok"}]}}, "stopReason": "end_turn", "usage": {"inputTokens": 7, "outputTokens": 2}}
    turn = converse("bedrock", "anthropic.claude-opus-5", "sys", MESSAGES, TOOLS, client=client)
    assert turn.content == [{"type": "text", "text": "ok"}] and turn.stop_reason == "end_turn"
    assert client.converse.call_args.kwargs["toolConfig"]["tools"][0]["toolSpec"]["name"] == "canvas_addNode"


def test_missing_client_is_a_clear_error():
    from warpcore.assistant.converse import _anthropic
    with pytest.raises(RuntimeError, match="anthropic client"):
        _anthropic(None, "m", "sys", [], [], 10)
