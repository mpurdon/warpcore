"""The in-app assistant's model turn: one call with tools, any provider.

The Visual Builder owns the conversation and runs the tools (they are its
commands); this package only asks the model what to do next. One message
shape for every provider, Anthropic's: a message is a role and a list of
blocks, a block is text, a tool use, or a tool result.
"""

from warpcore.assistant.converse import converse, serve_turns, Turn

__all__ = ["converse", "serve_turns", "Turn"]
