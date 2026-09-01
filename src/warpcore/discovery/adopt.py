"""Import discovered AWS resources into warpcore state.

Adoption is the step that makes a resource warpcore did not create become one
it manages: the resource is written into the state file keyed by its logical
id and physical ARN, so the next plan/diff compares against it instead of
proposing to create it again.

Adoption never calls AWS. It only writes state, so it is always reversible by
restoring the previous state file - which is what the audit trail records.
"""

from dataclasses import dataclass, field
from typing import Dict, List, Optional

from warpcore.agentic.scanner import ScannedState
from warpcore.state.manager import StateManager, StateNotFoundError
from warpcore.state.models import Resource
from warpcore.utils.logging import get_logger

logger = get_logger(__name__)

DEFAULT_STACK = "discovered"


@dataclass
class AdoptionItem:
    """One resource considered for adoption."""

    resource: Resource
    stack: str
    action: str          # "adopt" | "already-managed" | "conflict"
    detail: str = ""


@dataclass
class AdoptionPlan:
    """What adoption would do, before it does it."""

    items: List[AdoptionItem] = field(default_factory=list)
    environment: str = ""
    project_name: str = ""

    def to_adopt(self) -> List[AdoptionItem]:
        return [i for i in self.items if i.action == "adopt"]

    def already_managed(self) -> List[AdoptionItem]:
        return [i for i in self.items if i.action == "already-managed"]

    def conflicts(self) -> List[AdoptionItem]:
        return [i for i in self.items if i.action == "conflict"]

    def is_empty(self) -> bool:
        return not self.to_adopt()


class ResourceAdopter:
    """Plans and applies adoption of scanned resources into state."""

    def __init__(self, state_manager: StateManager):
        self.state_manager = state_manager
        self.logger = get_logger(__name__)

    def plan(
        self,
        scanned_state: ScannedState,
        stack: Optional[str] = None,
    ) -> AdoptionPlan:
        """Work out which scanned resources are new to state.

        Args:
            scanned_state: Result of an AWSScanner scan.
            stack: Stack name to file adopted resources under. Defaults to the
                resource's ``warpcore:agent`` tag, then ``discovered``.
        """
        try:
            state = self.state_manager.load()
        except StateNotFoundError:
            state = None

        existing_by_physical: Dict[str, str] = {}
        existing_ids: Dict[str, str] = {}
        if state is not None:
            for stack_name, resource in state.all_resources():
                if resource.physical_id:
                    existing_by_physical[resource.physical_id] = resource.id
                existing_ids[resource.id] = stack_name

        plan = AdoptionPlan(
            environment=state.environment if state else "",
            project_name=state.project_name if state else "",
        )

        for resource in sorted(scanned_state.get_all_resources(), key=lambda r: (r.type, r.id)):
            target_stack = (
                stack
                or (resource.tags or {}).get("warpcore:agent")
                or DEFAULT_STACK
            )

            if resource.physical_id and resource.physical_id in existing_by_physical:
                plan.items.append(AdoptionItem(
                    resource=resource,
                    stack=target_stack,
                    action="already-managed",
                    detail=f"already in state as '{existing_by_physical[resource.physical_id]}'",
                ))
                continue

            if resource.id in existing_ids:
                plan.items.append(AdoptionItem(
                    resource=resource,
                    stack=target_stack,
                    action="conflict",
                    detail=f"logical id '{resource.id}' is already used in stack "
                           f"'{existing_ids[resource.id]}' by a different physical resource",
                ))
                continue

            plan.items.append(AdoptionItem(
                resource=resource,
                stack=target_stack,
                action="adopt",
            ))

        return plan

    def apply(self, plan: AdoptionPlan) -> int:
        """Write the plan's adoptable resources into state.

        Returns the number of resources adopted. Conflicts are skipped; the
        caller is expected to have surfaced them from the plan first.
        """
        state = self.state_manager.load()

        adopted = 0
        for item in plan.to_adopt():
            resource = item.resource.model_copy(deep=True)
            resource.metadata = {
                **(resource.metadata or {}),
                "adopted": True,
                "adopted_from": "account-scan",
            }
            state.add_resource(item.stack, resource)
            adopted += 1

        self.state_manager.save(state)
        self.logger.info(f"Adopted {adopted} resources into state")
        return adopted
