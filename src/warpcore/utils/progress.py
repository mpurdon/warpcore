"""Progress reporting for a scan.

A multi-region scan takes tens of seconds and does most of its work in
parallel, so a caller that only sees the final result has no idea whether it is
nearly done, stuck on one region, or being throttled. These events let a UI
show what is actually happening while it happens.

Events are plain dicts so they serialise to one JSON line each with no schema
negotiation. The emitter is thread-safe because regions and services are
scanned concurrently and every worker reports through the same callback.
"""

import json
import sys
import threading
import time
from typing import Any, Callable, Dict, List, Optional, Sequence

# A progress consumer. Receives one event dict at a time.
ProgressCallback = Callable[[Dict[str, Any]], None]

# Event names, so producers and consumers cannot drift on spelling.
SCAN_START = "scan_start"
REGION_START = "region_start"
REGION_PLAN = "region_plan"     # what this region intends to do
PHASE = "phase"                 # resource-explorer / tags / hydrate
SERVICE = "service"             # one service enumerator
REGION_DONE = "region_done"
SCAN_DONE = "scan_done"
RESULT = "result"               # terminal: carries the inventory itself


class ProgressEmitter:
    """Serialises progress events from many threads onto one callback."""

    def __init__(self, callback: Optional[ProgressCallback] = None):
        self._callback = callback
        self._lock = threading.Lock()
        self._started = time.monotonic()

    @property
    def enabled(self) -> bool:
        return self._callback is not None

    def emit(self, event: str, **fields: Any) -> None:
        """Send one event. Never raises: progress must not break a scan."""
        if self._callback is None:
            return
        payload = {"event": event, "elapsed": round(time.monotonic() - self._started, 2)}
        payload.update(fields)
        try:
            with self._lock:
                self._callback(payload)
        except Exception:  # noqa: BLE001 - a broken consumer must not stop the scan
            pass

    def child(self, **defaults: Any) -> "ScopedEmitter":
        """An emitter that stamps every event with the same fields.

        Used to bind a region once rather than passing it to every call.
        """
        return ScopedEmitter(self, defaults)


class ScopedEmitter:
    """A ProgressEmitter with fields pre-bound (typically a region)."""

    def __init__(self, parent: ProgressEmitter, defaults: Dict[str, Any]):
        self._parent = parent
        self._defaults = defaults

    @property
    def enabled(self) -> bool:
        return self._parent.enabled

    def emit(self, event: str, **fields: Any) -> None:
        merged = dict(self._defaults)
        merged.update(fields)
        self._parent.emit(event, **merged)


def ndjson_writer(stream=None) -> ProgressCallback:
    """A callback that writes each event as one JSON line.

    Compact and newline-delimited so a reader can act on each event as it
    arrives instead of waiting for the stream to close.
    """
    target = stream if stream is not None else sys.stdout

    def write(payload: Dict[str, Any]) -> None:
        target.write(json.dumps(payload, default=str, separators=(",", ":")) + "\n")
        target.flush()

    return write


def plan_for(services: Sequence[str], hydrate: bool) -> List[str]:
    """The phases a region will run, in order, for a progress denominator."""
    phases = ["resource-explorer", *[f"service:{s}" for s in services], "tags"]
    if hydrate:
        phases.append("hydrate")
    return phases
