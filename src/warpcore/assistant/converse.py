"""One model turn with tools, in a provider-neutral shape.

Input: a system prompt, the messages so far, and the tools. Output: the
assistant's content blocks, why it stopped, and what it cost. The caller
runs the tools and comes back with results; this function keeps no state.

Blocks (Anthropic's shape, the one the others are mapped to):
  {"type": "text", "text": "..."}
  {"type": "tool_use", "id": "...", "name": "...", "input": {...}}
  {"type": "tool_result", "tool_use_id": "...", "content": "...", "is_error": false}
"""

from __future__ import annotations

import json
import os
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from warpcore.agentic.llm_client import LLMClient, LLMProvider

MAX_TOKENS = 4096


@dataclass
class Turn:
    content: List[Dict[str, Any]]
    stop_reason: str                      # end_turn | tool_use | max_tokens | other
    model: str
    usage: Dict[str, int] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        return {"content": self.content, "stop_reason": self.stop_reason, "model": self.model, "usage": self.usage}


STOP_REASONS = {"end_turn", "tool_use", "max_tokens"}


def _stop(reason: Optional[str]) -> str:
    return reason if reason in STOP_REASONS else "other"


def _blocks(message: Dict[str, Any]) -> List[Dict[str, Any]]:
    """A message's content as blocks; a bare string is one text block."""
    c = message["content"]
    return c if isinstance(c, list) else [{"type": "text", "text": str(c)}]


def _function_tools(tools: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Tools in the OpenAI function shape, which Ollama speaks too."""
    return [{"type": "function", "function": {"name": t["name"], "description": t.get("description", ""), "parameters": t["input_schema"]}} for t in tools]


def serve_turns(stdin, stdout) -> None:
    """Answer requests line by line until stdin closes (`warpcore assistant serve`)."""
    for line in stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError as e:
            stdout.write(json.dumps({"id": None, "error": f"bad request: {e}"}) + "\n")
            stdout.flush()
            continue
        rid = req.get("id")
        try:
            turn = converse(req["provider"], req.get("model"), req.get("system") or "", req.get("messages") or [], req.get("tools") or [],
                            max_tokens=int(req.get("max_tokens") or MAX_TOKENS), endpoint=req.get("endpoint"))
            stdout.write(json.dumps({"id": rid, "result": turn.to_dict()}, default=str) + "\n")
        except Exception as e:  # noqa: BLE001 - the app shows the message and keeps the worker
            stdout.write(json.dumps({"id": rid, "error": str(e)}) + "\n")
        stdout.flush()


def converse(provider: str, model: Optional[str], system: str, messages: List[Dict[str, Any]], tools: List[Dict[str, Any]],
             max_tokens: int = MAX_TOKENS, client: Any = None, endpoint: Optional[str] = None) -> Turn:
    """Ask the model for its next move. `client` overrides the SDK client (tests)."""
    prov = LLMProvider(provider)
    model_name = model or ""
    if client is None:
        llm = LLMClient(provider=prov, model=model, endpoint=endpoint)
        client = llm.client
        model_name = model or llm.model
    if prov == LLMProvider.ANTHROPIC:
        return _anthropic(client, model_name, system, messages, tools, max_tokens)
    if prov == LLMProvider.OPENAI:
        return _openai(client, model_name, system, messages, tools, max_tokens)
    if prov == LLMProvider.BEDROCK:
        return _bedrock(client, model_name, system, messages, tools, max_tokens)
    return _local(endpoint or os.environ.get("OLLAMA_HOST", "http://localhost:11434"), model_name, system, messages, tools)


# ------------------------------------------------------------ anthropic

def _anthropic(client, model, system, messages, tools, max_tokens) -> Turn:
    if client is None:
        raise RuntimeError("the anthropic client is not initialised: install `warpcore[ai]` and set ANTHROPIC_API_KEY")
    resp = client.messages.create(
        model=model, max_tokens=max_tokens, system=system, messages=messages,
        tools=[{"name": t["name"], "description": t.get("description", ""), "input_schema": t["input_schema"]} for t in tools],
    )
    content = []
    for block in resp.content:
        kind = getattr(block, "type", None)
        if kind == "text":
            content.append({"type": "text", "text": block.text})
        elif kind == "tool_use":
            content.append({"type": "tool_use", "id": block.id, "name": block.name, "input": dict(block.input or {})})
    usage = getattr(resp, "usage", None)
    return Turn(content, _stop(getattr(resp, "stop_reason", None)), getattr(resp, "model", model) or model,
                {"input": int(getattr(usage, "input_tokens", 0) or 0), "output": int(getattr(usage, "output_tokens", 0) or 0)})


# ------------------------------------------------------------ openai

def _to_openai_messages(system, messages) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = [{"role": "system", "content": system}]
    for m in messages:
        blocks = _blocks(m)
        if m["role"] == "assistant":
            text = "".join(b["text"] for b in blocks if b["type"] == "text")
            calls = [{"id": b["id"], "type": "function", "function": {"name": b["name"], "arguments": json.dumps(b.get("input") or {})}}
                     for b in blocks if b["type"] == "tool_use"]
            msg: Dict[str, Any] = {"role": "assistant", "content": text or None}
            if calls:
                msg["tool_calls"] = calls
            out.append(msg)
        else:
            results = [b for b in blocks if b["type"] == "tool_result"]
            for r in results:
                out.append({"role": "tool", "tool_call_id": r["tool_use_id"], "content": _result_text(r)})
            text = "".join(b["text"] for b in blocks if b["type"] == "text")
            if text:
                out.append({"role": "user", "content": text})
    return out


def _openai(client, model, system, messages, tools, max_tokens) -> Turn:
    if client is None:
        raise RuntimeError("the openai client is not initialised: install openai and set OPENAI_API_KEY")
    resp = client.chat.completions.create(
        model=model, max_tokens=max_tokens, messages=_to_openai_messages(system, messages),
        tools=_function_tools(tools) or None,
    )
    choice = resp.choices[0]
    msg = choice.message
    content: List[Dict[str, Any]] = []
    if getattr(msg, "content", None):
        content.append({"type": "text", "text": msg.content})
    for call in getattr(msg, "tool_calls", None) or []:
        try:
            args = json.loads(call.function.arguments or "{}")
        except json.JSONDecodeError:
            args = {}
        content.append({"type": "tool_use", "id": call.id, "name": call.function.name, "input": args})
    finish = getattr(choice, "finish_reason", "") or ""
    stop = {"stop": "end_turn", "tool_calls": "tool_use", "length": "max_tokens"}.get(finish, "other")
    usage = getattr(resp, "usage", None)
    return Turn(content, stop, getattr(resp, "model", model) or model,
                {"input": int(getattr(usage, "prompt_tokens", 0) or 0), "output": int(getattr(usage, "completion_tokens", 0) or 0)})


# ------------------------------------------------------------ bedrock

def _to_bedrock_messages(messages) -> List[Dict[str, Any]]:
    out = []
    for m in messages:
        blocks = _blocks(m)
        converted = []
        for b in blocks:
            if b["type"] == "text":
                converted.append({"text": b["text"]})
            elif b["type"] == "tool_use":
                converted.append({"toolUse": {"toolUseId": b["id"], "name": b["name"], "input": b.get("input") or {}}})
            elif b["type"] == "tool_result":
                converted.append({"toolResult": {"toolUseId": b["tool_use_id"], "content": [{"text": _result_text(b)}],
                                                 "status": "error" if b.get("is_error") else "success"}})
        out.append({"role": m["role"], "content": converted})
    return out


def _bedrock(client, model, system, messages, tools, max_tokens) -> Turn:
    if client is None:
        raise RuntimeError("the bedrock client is not initialised: are AWS credentials available?")
    kwargs: Dict[str, Any] = {
        "modelId": model, "system": [{"text": system}], "messages": _to_bedrock_messages(messages),
        "inferenceConfig": {"maxTokens": max_tokens},
    }
    if tools:
        kwargs["toolConfig"] = {"tools": [{"toolSpec": {"name": t["name"], "description": t.get("description", ""), "inputSchema": {"json": t["input_schema"]}}} for t in tools]}
    resp = client.converse(**kwargs)
    content: List[Dict[str, Any]] = []
    for b in (resp.get("output") or {}).get("message", {}).get("content", []):
        if "text" in b:
            content.append({"type": "text", "text": b["text"]})
        elif "toolUse" in b:
            tu = b["toolUse"]
            content.append({"type": "tool_use", "id": tu["toolUseId"], "name": tu["name"], "input": tu.get("input") or {}})
    usage = resp.get("usage") or {}
    return Turn(content, _stop(resp.get("stopReason")), model, {"input": int(usage.get("inputTokens", 0)), "output": int(usage.get("outputTokens", 0))})


# ------------------------------------------------------------ local (ollama)

def _local(endpoint, model, system, messages, tools) -> Turn:
    body = {
        "model": model, "stream": False,
        "messages": [{"role": "system", "content": system}] + _to_ollama_messages(messages),
        "tools": _function_tools(tools),
    }
    req = urllib.request.Request(f"{endpoint.rstrip('/')}/api/chat", data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=300) as r:  # noqa: S310 - a local endpoint the operator configured
        data = json.loads(r.read())
    msg = data.get("message") or {}
    content: List[Dict[str, Any]] = []
    if msg.get("content"):
        content.append({"type": "text", "text": msg["content"]})
    for i, call in enumerate(msg.get("tool_calls") or []):
        fn = call.get("function") or {}
        content.append({"type": "tool_use", "id": f"call_{i}", "name": fn.get("name", ""), "input": fn.get("arguments") or {}})
    return Turn(content, "tool_use" if any(b["type"] == "tool_use" for b in content) else "end_turn", model,
                {"input": int(data.get("prompt_eval_count", 0)), "output": int(data.get("eval_count", 0))})


def _to_ollama_messages(messages) -> List[Dict[str, Any]]:
    out = []
    for m in messages:
        blocks = _blocks(m)
        if m["role"] == "assistant":
            out.append({"role": "assistant", "content": "".join(b["text"] for b in blocks if b["type"] == "text"),
                        "tool_calls": [{"function": {"name": b["name"], "arguments": b.get("input") or {}}} for b in blocks if b["type"] == "tool_use"]})
        else:
            for b in blocks:
                if b["type"] == "tool_result":
                    out.append({"role": "tool", "content": _result_text(b)})
                elif b["type"] == "text":
                    out.append({"role": "user", "content": b["text"]})
    return out


def _result_text(block: Dict[str, Any]) -> str:
    c = block.get("content")
    if isinstance(c, str):
        return c
    return json.dumps(c, default=str)
