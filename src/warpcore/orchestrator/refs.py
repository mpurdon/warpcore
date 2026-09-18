"""References between compiled resources.

A function needs its role's ARN, a queue's redrive policy needs the
dead-letter queue's ARN, an API route needs the function's ARN. None of
those exist until the dependency is provisioned, so the compiler writes a
reference where the value will go and the value is filled in later: once
against the deployment state when the plan is made (for dependencies that
already exist), and again at provision time (for ones created earlier in
the same run).

A reference is a small dict, kept deliberately JSON-plain so it survives
the state file, the plan event and the audit trail unchanged:

    {"$ref": "<resource id>", "$attr": "physical_id"}
    {"$ref": "<resource id>", "$prop": "QueueArn"}
"""

from typing import Any, Callable, Dict, List, Optional, Tuple

REF = "$ref"
ATTR = "$attr"
PROP = "$prop"

Lookup = Callable[[str], Optional[Any]]


def ref(resource_id: str, attr: str = "physical_id") -> Dict[str, str]:
    """A reference to another resource's physical id (or another attribute)."""
    return {REF: resource_id, ATTR: attr}


def prop_ref(resource_id: str, prop: str) -> Dict[str, str]:
    """A reference to a property another resource reports after provisioning."""
    return {REF: resource_id, PROP: prop}


def is_ref(value: Any) -> bool:
    return isinstance(value, dict) and REF in value and (ATTR in value or PROP in value)


def resolve(value: Any, lookup: Lookup) -> Tuple[Any, List[str]]:
    """Replace every reference in `value` whose target `lookup` knows.

    `lookup(resource_id)` returns the provisioned resource (anything with
    `physical_id` and `properties`) or None. References to unknown resources
    are left in place and reported, so the caller can decide whether that
    is fine (planning) or fatal (provisioning).

    Returns the resolved value and the ids that could not be resolved.
    """
    unresolved: List[str] = []

    def walk(v: Any) -> Any:
        if is_ref(v):
            target = lookup(v[REF])
            if target is None:
                unresolved.append(v[REF])
                return v
            if ATTR in v:
                got = getattr(target, v[ATTR], None)
            else:
                got = (getattr(target, "properties", None) or {}).get(v[PROP])
            if got is None:
                unresolved.append(v[REF])
                return v
            return got
        if isinstance(v, dict):
            return {k: walk(x) for k, x in v.items()}
        if isinstance(v, list):
            return [walk(x) for x in v]
        return v

    return walk(value), unresolved


def references_in(value: Any) -> List[str]:
    """Every resource id referenced anywhere inside `value`."""
    found: List[str] = []

    def walk(v: Any) -> None:
        if is_ref(v):
            found.append(v[REF])
        elif isinstance(v, dict):
            for x in v.values():
                walk(x)
        elif isinstance(v, list):
            for x in v:
                walk(x)

    walk(value)
    return found
