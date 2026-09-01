"""Trace every AWS API call made through a boto3 session.

Registers on botocore's event system rather than wrapping clients, so it
catches calls made anywhere - provisioners, the scanner, the cost manager -
without those call sites knowing about it.

Deployments run resources in parallel, so the collector is thread-safe and
per-call timing is stashed in botocore's per-request ``context`` dict rather
than on the tracer.
"""

import threading
import time
from collections import Counter
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Dict, List, Optional

import boto3

from warpcore.audit.models import ApiCall
from warpcore.utils.logging import get_logger

logger = get_logger(__name__)

_START_KEY = "warpcore_call_start"


@dataclass
class ApiCallStats:
    """Aggregate view of traced calls, for the debug views."""

    total: int = 0
    errors: int = 0
    total_duration_ms: float = 0.0
    by_service: Dict[str, int] = field(default_factory=dict)
    by_operation: Dict[str, int] = field(default_factory=dict)
    by_error_code: Dict[str, int] = field(default_factory=dict)
    slowest: List[ApiCall] = field(default_factory=list)

    @property
    def average_duration_ms(self) -> float:
        return self.total_duration_ms / self.total if self.total else 0.0


class ApiCallTracer:
    """Collects an ApiCall record for every botocore request."""

    def __init__(self, max_calls: int = 10000):
        self._calls: List[ApiCall] = []
        self._lock = threading.Lock()
        self.max_calls = max_calls
        self.dropped = 0
        self._registered_sessions: List[int] = []

    # ----------------------------------------------------------- attachment

    def attach(self, session: boto3.Session) -> "ApiCallTracer":
        """Register handlers on a boto3 session.

        Safe to call more than once with the same session; handlers are
        registered under a unique id so re-attachment does not double-count.
        """
        session_key = id(session)
        if session_key in self._registered_sessions:
            return self

        events = session.events
        events.register("before-call.*.*", self._on_before_call,
                        unique_id=f"warpcore-trace-before-{id(self)}")
        events.register("after-call.*.*", self._on_after_call,
                        unique_id=f"warpcore-trace-after-{id(self)}")
        events.register("after-call-error.*.*", self._on_after_call_error,
                        unique_id=f"warpcore-trace-error-{id(self)}")

        self._registered_sessions.append(session_key)
        logger.debug(f"API tracing attached to boto3 session {session_key}")
        return self

    # -------------------------------------------------------------- handlers

    def _on_before_call(self, model=None, context=None, **kwargs: Any) -> None:
        """Stamp the start time into botocore's per-request context."""
        if context is not None:
            context[_START_KEY] = time.perf_counter()

    def _on_after_call(self, model=None, http_response=None, parsed=None,
                       context=None, **kwargs: Any) -> None:
        """Record a completed call."""
        if model is None:
            return
        self._record(
            service=_service_name(model),
            operation=model.name,
            context=context,
            status_code=getattr(http_response, "status_code", None),
            error_code=(parsed or {}).get("Error", {}).get("Code") if parsed else None,
            request_id=((parsed or {}).get("ResponseMetadata", {}) or {}).get("RequestId"),
        )

    def _on_after_call_error(self, model=None, exception=None,
                             context=None, **kwargs: Any) -> None:
        """Record a call that raised before producing a response."""
        if model is None:
            return
        self._record(
            service=_service_name(model),
            operation=model.name,
            context=context,
            status_code=None,
            error_code=type(exception).__name__ if exception else "UnknownError",
            request_id=None,
        )

    def _record(
        self,
        service: str,
        operation: str,
        context: Optional[Dict[str, Any]],
        status_code: Optional[int],
        error_code: Optional[str],
        request_id: Optional[str],
    ) -> None:
        started = (context or {}).get(_START_KEY)
        duration_ms = (time.perf_counter() - started) * 1000.0 if started else 0.0

        call = ApiCall(
            service=service,
            operation=operation,
            duration_ms=round(duration_ms, 2),
            status_code=status_code,
            error_code=error_code,
            request_id=request_id,
            timestamp=datetime.utcnow(),
        )

        with self._lock:
            if len(self._calls) >= self.max_calls:
                self.dropped += 1
                return
            self._calls.append(call)

        logger.debug(
            f"aws {service}.{operation} {duration_ms:.0f}ms"
            + (f" error={error_code}" if error_code else "")
        )

    # ---------------------------------------------------------------- access

    def calls(self) -> List[ApiCall]:
        """Snapshot of everything traced so far."""
        with self._lock:
            return list(self._calls)

    def drain(self) -> List[ApiCall]:
        """Take the traced calls and reset, for attaching to one audit entry."""
        with self._lock:
            calls = list(self._calls)
            self._calls.clear()
            return calls

    def reset(self) -> None:
        with self._lock:
            self._calls.clear()
            self.dropped = 0

    def stats(self, slowest_n: int = 10) -> ApiCallStats:
        """Aggregate the trace for display."""
        calls = self.calls()
        stats = ApiCallStats(total=len(calls))

        by_service: Counter = Counter()
        by_operation: Counter = Counter()
        by_error: Counter = Counter()

        for call in calls:
            by_service[call.service] += 1
            by_operation[f"{call.service}.{call.operation}"] += 1
            stats.total_duration_ms += call.duration_ms
            if call.error_code:
                stats.errors += 1
                by_error[call.error_code] += 1

        stats.by_service = dict(by_service.most_common())
        stats.by_operation = dict(by_operation.most_common())
        stats.by_error_code = dict(by_error.most_common())
        stats.slowest = sorted(calls, key=lambda c: c.duration_ms, reverse=True)[:slowest_n]
        return stats


def _service_name(model: Any) -> str:
    """Pull a readable service name out of a botocore operation model."""
    service_model = getattr(model, "service_model", None)
    if service_model is None:
        return "unknown"
    return (
        getattr(service_model, "service_name", None)
        or getattr(service_model, "endpoint_prefix", None)
        or "unknown"
    )
