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

# Suffix used to disambiguate two resources that share a logical id. Naming a
# role after the function it serves is the norm in AWS, and state keys
# resources by logical id, so one would silently overwrite the other.
_TYPE_SUFFIX = {
    "AWS::IAM::Role": "role",
    "AWS::Lambda::Function": "function",
    "AWS::S3::Bucket": "bucket",
    "AWS::DynamoDB::Table": "table",
    "AWS::SQS::Queue": "queue",
    "AWS::SNS::Topic": "topic",
    "AWS::Logs::LogGroup": "log-group",
    "AWS::Events::Rule": "rule",
    "AWS::EC2::VPC": "vpc",
    "AWS::EC2::Subnet": "subnet",
    "AWS::EC2::SecurityGroup": "security-group",
    "AWS::SecretsManager::Secret": "secret",
    "AWS::StepFunctions::StateMachine": "state-machine",
}

# When two resources collide, the one earlier in this list keeps the plain
# name. A Lambda called `gitf-wake` is what a person means by that name; its
# execution role is the thing that should become `gitf-wake-role`.
_NAME_PRIORITY = [
    "AWS::Lambda::Function",
    "AWS::DynamoDB::Table",
    "AWS::S3::Bucket",
    "AWS::SQS::Queue",
    "AWS::SNS::Topic",
    "AWS::StepFunctions::StateMachine",
    "AWS::Events::Rule",
    "AWS::SecretsManager::Secret",
    "AWS::IAM::Role",
    "AWS::Logs::LogGroup",
]


def _name_rank(resource_type: str) -> int:
    """Lower sorts first and therefore keeps the unsuffixed name."""
    try:
        return _NAME_PRIORITY.index(resource_type)
    except ValueError:
        return len(_NAME_PRIORITY)


def _suffix_for(resource_type: str) -> str:
    """Readable suffix for a type, falling back to the ARN-ish tail."""
    if resource_type in _TYPE_SUFFIX:
        return _TYPE_SUFFIX[resource_type]
    return resource_type.rsplit("::", 1)[-1].lower()


@dataclass
class AdoptionItem:
    """One resource considered for adoption."""

    resource: Resource
    stack: str
    action: str          # "adopt" | "already-managed" | "conflict"
    detail: str = ""
    # Set when the resource had to be renamed to keep its logical id unique.
    original_id: Optional[str] = None


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

        # Sorted so that name collisions resolve deterministically, and so the
        # more meaningful resource keeps the plain name.
        ordered = sorted(
            scanned_state.get_all_resources(),
            key=lambda r: (_name_rank(r.type), r.type, r.id),
        )

        # Logical ids claimed by this plan, on top of those already in state.
        # Without this, two scanned resources sharing an id are both marked
        # "adopt" and the second silently overwrites the first on write.
        claimed: Dict[str, str] = {}

        for resource in ordered:
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

            original_id = resource.id
            unique_id = self._unique_id(resource, claimed, existing_ids)
            if unique_id != original_id:
                resource = resource.model_copy(deep=True)
                resource.id = unique_id

            claimed[unique_id] = resource.physical_id or unique_id

            plan.items.append(AdoptionItem(
                resource=resource,
                stack=target_stack,
                action="adopt",
                original_id=original_id if unique_id != original_id else None,
                detail=(
                    f"renamed from '{original_id}' - that id is taken by another "
                    f"discovered resource, and state keys resources by logical id"
                    if unique_id != original_id else ""
                ),
            ))

        return plan

    @staticmethod
    def _unique_id(
        resource: Resource,
        claimed: Dict[str, str],
        existing_ids: Dict[str, str],
    ) -> str:
        """Pick a logical id for a resource that nothing else has claimed."""
        taken = set(claimed) | set(existing_ids)
        if resource.id not in taken:
            return resource.id

        candidate = f"{resource.id}-{_suffix_for(resource.type)}"
        if candidate not in taken:
            return candidate

        suffix = 2
        while f"{candidate}-{suffix}" in taken:
            suffix += 1
        return f"{candidate}-{suffix}"

    def apply(self, plan: AdoptionPlan) -> int:
        """Write the plan's adoptable resources into state.

        Returns the number of resources adopted. Conflicts are skipped; the
        caller is expected to have surfaced them from the plan first.
        """
        state = self.state_manager.load()
        before = len(state.all_resources())

        adopted = 0
        for item in plan.to_adopt():
            resource = item.resource.model_copy(deep=True)
            resource.metadata = {
                **(resource.metadata or {}),
                "adopted": True,
                "adopted_from": "account-scan",
            }
            if item.original_id:
                resource.metadata["original_id"] = item.original_id
            state.add_resource(item.stack, resource)
            adopted += 1

        self.state_manager.save(state)

        # Report what actually landed, not what was attempted: state stacks key
        # on logical id, so a collision that slipped through would show up here
        # as a mismatch rather than as a silently short state file.
        written = len(state.all_resources())
        if written < before + adopted:
            self.logger.warning(
                f"Planned {adopted} adoptions but state grew by "
                f"{written - before}; logical ids collided"
            )

        self.logger.info(f"Adopted {adopted} resources into state")
        return adopted
