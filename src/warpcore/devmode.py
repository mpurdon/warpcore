"""Developer mode: tracing, auditing and introspection for debugging.

Enabled with ``warpcore --dev ...`` or ``WARPCORE_DEV=1``. It turns on:

* debug-level logging, including botocore's own request logs
* an API call trace for every AWS request the run makes
* full request/response timing captured onto audit entries
* a session manifest under ``.warpcore/dev/`` that ``warpcore debug session``
  reads back

The audit trail itself is NOT gated on dev mode - a record of what was changed
in AWS is worth having on every run, and it is cheap and local. Dev mode adds
the API-level detail on top.
"""

import json
import logging
import os
import platform
import sys
import uuid
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

import boto3

from warpcore import __version__
from warpcore.audit.recorder import AuditRecorder
from warpcore.utils.api_trace import ApiCallTracer
from warpcore.utils.logging import get_logger

logger = get_logger(__name__)

DEV_DIR = Path(".warpcore") / "dev"
ENV_FLAG = "WARPCORE_DEV"


@dataclass
class DevMode:
    """Per-invocation developer mode state."""

    enabled: bool = False
    session_id: str = field(default_factory=lambda: uuid.uuid4().hex[:8])
    started_at: datetime = field(default_factory=datetime.utcnow)
    command: str = ""
    environment: str = ""
    project_name: str = ""
    region: str = ""
    profile: Optional[str] = None
    actor: str = ""

    tracer: Optional[ApiCallTracer] = None
    recorder: Optional[AuditRecorder] = None
    _sessions: List[boto3.Session] = field(default_factory=list)

    # ------------------------------------------------------------ lifecycle

    def activate(self) -> "DevMode":
        """Turn on debug logging and start an API tracer."""
        self.enabled = True
        if self.tracer is None:
            self.tracer = ApiCallTracer()

        root = logging.getLogger()
        root.setLevel(logging.DEBUG)
        for handler in root.handlers:
            handler.setLevel(logging.DEBUG)

        # setup_logging() quiets these to WARNING; dev mode wants them back,
        # but at INFO - botocore at DEBUG dumps full signed requests including
        # credential material.
        for noisy in ("boto3", "botocore", "urllib3"):
            logging.getLogger(noisy).setLevel(logging.INFO)

        logger.debug(f"developer mode active (session {self.session_id})")
        return self

    def attach_session(self, session: boto3.Session) -> boto3.Session:
        """Wire API tracing into a boto3 session, if dev mode is on."""
        if self.enabled and self.tracer is not None:
            self.tracer.attach(session)
        self._sessions.append(session)
        return session

    def bind_recorder(self, recorder: AuditRecorder) -> AuditRecorder:
        """Attach the audit recorder this run should write to."""
        recorder.session_id = self.session_id
        recorder.command = recorder.command or self.command
        self.recorder = recorder
        return recorder

    # ------------------------------------------------------------- reporting

    def api_calls(self) -> List:
        return self.tracer.calls() if self.tracer else []

    def drain_api_calls(self) -> List:
        """Take the traced calls so far, for attaching to one audit entry."""
        return self.tracer.drain() if self.tracer else []

    def manifest(self) -> Dict[str, Any]:
        """Everything worth knowing about this invocation."""
        stats = self.tracer.stats() if self.tracer else None
        return {
            "session_id": self.session_id,
            "started_at": self.started_at.isoformat(),
            "finished_at": datetime.utcnow().isoformat(),
            "command": self.command,
            "environment": self.environment,
            "project_name": self.project_name,
            "region": self.region,
            "profile": self.profile,
            "actor": self.actor,
            "runtime": {
                "python": sys.version.split()[0],
                "platform": platform.platform(),
                "boto3": boto3.__version__,
                "warpcore": __version__,
                "cwd": str(Path.cwd()),
                "pid": os.getpid(),
            },
            "api": None if stats is None else {
                "total_calls": stats.total,
                "errors": stats.errors,
                "total_duration_ms": round(stats.total_duration_ms, 1),
                "average_duration_ms": round(stats.average_duration_ms, 1),
                "by_service": stats.by_service,
                "by_operation": stats.by_operation,
                "by_error_code": stats.by_error_code,
                "slowest": [
                    {
                        "service": c.service,
                        "operation": c.operation,
                        "duration_ms": c.duration_ms,
                        "error_code": c.error_code,
                    }
                    for c in stats.slowest
                ],
                "dropped": self.tracer.dropped if self.tracer else 0,
            },
        }

    def write_manifest(self, dev_dir: Optional[Path] = None) -> Optional[Path]:
        """Persist the session manifest for `warpcore debug session`."""
        if not self.enabled:
            return None
        target_dir = Path(dev_dir) if dev_dir else DEV_DIR
        target_dir.mkdir(parents=True, exist_ok=True)
        path = target_dir / f"session-{self.session_id}.json"
        path.write_text(json.dumps(self.manifest(), indent=2, default=str))
        logger.debug(f"wrote dev session manifest to {path}")
        return path


_active: DevMode = DevMode()


def init_dev_mode(
    enabled: bool = False,
    command: str = "",
    environment: str = "",
    project_name: str = "",
    region: str = "",
    profile: Optional[str] = None,
) -> DevMode:
    """Create and install the DevMode for this invocation."""
    global _active
    _active = DevMode(
        command=command,
        environment=environment,
        project_name=project_name,
        region=region,
        profile=profile,
    )
    if enabled or _env_flag_set():
        _active.activate()
    return _active


def get_dev_mode() -> DevMode:
    """The DevMode for this invocation (inactive by default)."""
    return _active


def _env_flag_set() -> bool:
    return os.environ.get(ENV_FLAG, "").lower() in ("1", "true", "yes", "on")


def latest_session_manifest(dev_dir: Optional[Path] = None) -> Optional[Dict[str, Any]]:
    """Read back the most recent dev session manifest."""
    target_dir = Path(dev_dir) if dev_dir else DEV_DIR
    if not target_dir.exists():
        return None
    manifests = sorted(target_dir.glob("session-*.json"), key=lambda p: p.stat().st_mtime)
    if not manifests:
        return None
    try:
        return json.loads(manifests[-1].read_text())
    except (json.JSONDecodeError, OSError):
        return None
