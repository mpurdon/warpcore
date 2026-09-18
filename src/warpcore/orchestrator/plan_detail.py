"""What a plan changes, property by property.

A plan says "update"; an operator wants to know what. This turns each
change into the properties that differ, and for the two cases that matter
most says more: whether a function's code actually redeploys (its package
hash against the hash last deployed) and which IAM actions a role gains or
loses. The CLI's diff and the Visual Builder's Activity drawer both read it.
"""

import hashlib
import json
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Set, Tuple

from warpcore.orchestrator.planner import DeploymentPlan, ResourceChange
from warpcore.orchestrator.refs import is_ref
from warpcore.provisioners.base import ChangeType
from warpcore.provisioners.lambda_function import package_code

# Properties the provisioner writes after the fact; never a change to show.
RECORDED = {"CodeSha256", "ApiEndpoint", "IntegrationIds", "QueueArn", "TopicArn", "FunctionArn", "ResourceType"}


@dataclass
class PropertyChange:
    key: str
    before: Any
    after: Any


@dataclass
class IamChange:
    """Actions a role gains or loses, with the ARNs they apply to."""

    added: List[Tuple[List[str], List[str]]] = field(default_factory=list)
    removed: List[Tuple[List[str], List[str]]] = field(default_factory=list)


@dataclass
class ChangeDetail:
    resource_id: str
    resource_type: Optional[str]
    action: str                          # create | update | delete | no_change
    properties: List[PropertyChange] = field(default_factory=list)
    code: Optional[str] = None           # "redeploys" | "unchanged" | "stub" | None
    iam: Optional[IamChange] = None
    reason: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": self.resource_id,
            "type": self.resource_type,
            "action": self.action,
            "reason": self.reason,
            "properties": [{"key": p.key, "before": p.before, "after": p.after} for p in self.properties],
            "code": self.code,
            "iam": {
                "added": [{"actions": a, "resources": r} for a, r in self.iam.added],
                "removed": [{"actions": a, "resources": r} for a, r in self.iam.removed],
            } if self.iam else None,
        }


def detail_change(change: ResourceChange) -> ChangeDetail:
    """The detail of one change."""
    desired, current = change.desired_resource, change.current_resource
    resource = desired or current
    detail = ChangeDetail(
        resource_id=change.resource_id,
        resource_type=resource.type if resource else None,
        action=change.change_type.value,
        reason=change.reason,
    )
    if change.change_type is ChangeType.DELETE or resource is None:
        return detail

    before = (current.properties if current else {}) or {}
    after = desired.properties if desired else {}
    for key in sorted(set(before) | set(after)):
        if key in RECORDED:
            continue
        a, b = before.get(key), after.get(key)
        if is_ref(b):
            continue  # stands for the value the state holds
        if change.change_type is ChangeType.CREATE or a != b:
            detail.properties.append(PropertyChange(key=key, before=a if current else None, after=b))

    if resource.type == "AWS::Lambda::Function" and desired:
        detail.code = _code_state(desired.properties, before)
    if resource.type == "AWS::IAM::Role" and desired:
        detail.iam = _iam_change(before, desired.properties)
    return detail


def _code_state(after: Dict[str, Any], before: Dict[str, Any]) -> Optional[str]:
    path = after.get("CodePath")
    if not path:
        return None
    if ".warpcore/stubs/" in str(path).replace("\\", "/"):
        return "stub"
    try:
        sha = hashlib.sha256(package_code(str(path))).hexdigest()
    except (OSError, ValueError):
        return None
    deployed = before.get("CodeSha256")
    if not deployed:
        return "redeploys"
    return "unchanged" if _same_sha(sha, deployed) else "redeploys"


def _same_sha(local_hex: str, deployed: str) -> bool:
    """Lambda reports the hash base64-encoded; the provisioner stores whichever it had."""
    import base64
    if local_hex == deployed:
        return True
    try:
        return base64.b64encode(bytes.fromhex(local_hex)).decode() == deployed
    except ValueError:
        return False


def _statements(properties: Dict[str, Any]) -> Set[Tuple[Tuple[str, ...], Tuple[str, ...]]]:
    out = set()
    for doc in (properties.get("InlinePolicies") or {}).values():
        if isinstance(doc, str):
            try:
                doc = json.loads(doc)
            except ValueError:
                continue
        for st in (doc or {}).get("Statement") or []:
            if st.get("Effect") != "Allow":
                continue
            actions = st.get("Action") or []
            resources = st.get("Resource") or []
            actions = [actions] if isinstance(actions, str) else list(actions)
            resources = [resources] if isinstance(resources, str) else list(resources)
            out.add((tuple(sorted(actions)), tuple(sorted(resources))))
    return out


def _iam_change(before: Dict[str, Any], after: Dict[str, Any]) -> IamChange:
    was, now = _statements(before), _statements(after)
    return IamChange(
        added=[(list(a), list(r)) for a, r in sorted(now - was)],
        removed=[(list(a), list(r)) for a, r in sorted(was - now)],
    )


def detail_plan(plan: DeploymentPlan) -> List[ChangeDetail]:
    """Every change in the plan, creates and updates first, then deletes."""
    order = {ChangeType.CREATE: 0, ChangeType.UPDATE: 1, ChangeType.DELETE: 2, ChangeType.NO_CHANGE: 3}
    changes = sorted(plan.all_changes.values(), key=lambda c: (order.get(c.change_type, 9), c.resource_id))
    return [detail_change(c) for c in changes if c.change_type is not ChangeType.NO_CHANGE]
