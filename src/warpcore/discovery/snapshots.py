"""Snapshots of an account as each import saw it, and the difference between two.

Every `discover project` keeps what it found under .warpcore/snapshots/,
one file per import: the resources and connections, nothing derived.
Comparing the latest two says what appeared, what went, and what changed
since the last look, which is the first thing to ask of a canvas that has
just been re-imported.
"""

import json
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

SNAPSHOT_DIR = ".warpcore/snapshots"

# Config keys that change on their own and are not a change worth showing.
VOLATILE = {"storedBytes", "lastModified", "state", "publicIp", "privateIp"}


def snapshot_path(project_dir: Path, when: Optional[datetime] = None) -> Path:
    stamp = (when or datetime.now(timezone.utc)).strftime("%Y%m%dT%H%M%SZ")
    return Path(project_dir) / SNAPSHOT_DIR / f"{stamp}.json"


def write_snapshot(project_dir: Path, payload: Dict[str, Any], when: Optional[datetime] = None) -> Path:
    """Keep the import's resources and connections. Returns the file written."""
    path = snapshot_path(project_dir, when)
    path.parent.mkdir(parents=True, exist_ok=True)
    body = {
        "taken_at": (when or datetime.now(timezone.utc)).isoformat(timespec="seconds"),
        "account": payload.get("account"),
        "regions": payload.get("regions"),
        "resources": [
            {"arn": r.get("arn"), "name": r.get("name"), "type": r.get("type"), "config": r.get("config") or {},
             "health": r.get("health"), "provenance": r.get("provenance")}
            for r in list(payload.get("agents") or []) + list(payload.get("resources") or [])
        ],
        "connections": [
            {"from": c.get("from_arn"), "to": c.get("to_arn"), "kind": c.get("kind"), "detail": c.get("detail")}
            for c in payload.get("connections") or []
        ],
    }
    path.write_text(json.dumps(body, indent=1, default=str))
    return path


def list_snapshots(project_dir: Path) -> List[Path]:
    d = Path(project_dir) / SNAPSHOT_DIR
    if not d.exists():
        return []
    return sorted(d.glob("*.json"))


def read_snapshot(path: Path) -> Dict[str, Any]:
    return json.loads(Path(path).read_text())


@dataclass
class SnapshotDiff:
    before_at: str
    after_at: str
    added: List[Dict[str, Any]] = field(default_factory=list)
    removed: List[Dict[str, Any]] = field(default_factory=list)
    changed: List[Dict[str, Any]] = field(default_factory=list)
    connections_added: List[Dict[str, Any]] = field(default_factory=list)
    connections_removed: List[Dict[str, Any]] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        return self.__dict__

    def empty(self) -> bool:
        return not (self.added or self.removed or self.changed or self.connections_added or self.connections_removed)


def diff_snapshots(before: Dict[str, Any], after: Dict[str, Any]) -> SnapshotDiff:
    """What changed between two imports, by ARN."""
    b = {r["arn"]: r for r in before.get("resources") or [] if r.get("arn")}
    a = {r["arn"]: r for r in after.get("resources") or [] if r.get("arn")}
    out = SnapshotDiff(before_at=before.get("taken_at", ""), after_at=after.get("taken_at", ""))
    for arn in sorted(set(a) - set(b)):
        out.added.append({"arn": arn, "name": a[arn].get("name"), "type": a[arn].get("type")})
    for arn in sorted(set(b) - set(a)):
        out.removed.append({"arn": arn, "name": b[arn].get("name"), "type": b[arn].get("type")})
    for arn in sorted(set(a) & set(b)):
        x, y = b[arn], a[arn]
        changes = []
        cx, cy = x.get("config") or {}, y.get("config") or {}
        for key in sorted(set(cx) | set(cy)):
            if key in VOLATILE:
                continue
            if cx.get(key) != cy.get(key):
                changes.append({"key": key, "before": cx.get(key), "after": cy.get(key)})
        hx, hy = (x.get("health") or {}).get("level"), (y.get("health") or {}).get("level")
        if hx != hy:
            changes.append({"key": "health", "before": hx, "after": hy})
        if changes:
            out.changed.append({"arn": arn, "name": y.get("name"), "type": y.get("type"), "changes": changes})
    bc = {(c["from"], c["to"], c.get("kind")) for c in before.get("connections") or []}
    ac = {(c["from"], c["to"], c.get("kind")) for c in after.get("connections") or []}
    names = {**{arn: r.get("name") for arn, r in b.items()}, **{arn: r.get("name") for arn, r in a.items()}}
    for f, t, k in sorted(ac - bc):
        out.connections_added.append({"from": names.get(f, f), "to": names.get(t, t), "kind": k})
    for f, t, k in sorted(bc - ac):
        out.connections_removed.append({"from": names.get(f, f), "to": names.get(t, t), "kind": k})
    return out


def latest_diff(project_dir: Path) -> Optional[SnapshotDiff]:
    """The difference between the last two imports, or None with fewer than two."""
    paths = list_snapshots(project_dir)
    if len(paths) < 2:
        return None
    return diff_snapshots(read_snapshot(paths[-2]), read_snapshot(paths[-1]))
