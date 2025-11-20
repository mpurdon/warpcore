"""Deployment comparison utilities."""

from typing import Any, Dict, List, Set, Tuple
from strands_deploy.history.models import ConfigDiff, StateDiff, DeploymentDiff
from strands_deploy.utils.logging import get_logger

logger = get_logger(__name__)


class DeploymentComparator:
    """Compares deployments to identify differences."""

    def compare_configs(self, config1: Dict[str, Any], config2: Dict[str, Any]) -> ConfigDiff:
        """
        Compare two configurations.

        Args:
            config1: First configuration
            config2: Second configuration

        Returns:
            ConfigDiff with differences
        """
        added, removed, modified = self._deep_diff(config1, config2)

        return ConfigDiff(added=added, removed=removed, modified=modified)

    def compare_states(self, state1: Dict[str, Any], state2: Dict[str, Any]) -> StateDiff:
        """
        Compare two states.

        Args:
            state1: First state
            state2: Second state

        Returns:
            StateDiff with differences
        """
        # Extract resource IDs from both states
        resources1 = self._extract_resource_ids(state1)
        resources2 = self._extract_resource_ids(state2)

        # Find added, removed, and potentially modified resources
        added_resources = list(resources2 - resources1)
        removed_resources = list(resources1 - resources2)
        common_resources = resources1 & resources2

        # Check for modifications in common resources
        modified_resources = []
        for resource_id in common_resources:
            res1 = self._get_resource_from_state(state1, resource_id)
            res2 = self._get_resource_from_state(state2, resource_id)

            if res1 and res2 and self._resources_differ(res1, res2):
                modified_resources.append(resource_id)

        return StateDiff(
            added_resources=sorted(added_resources),
            removed_resources=sorted(removed_resources),
            modified_resources=sorted(modified_resources),
        )

    def _deep_diff(
        self, dict1: Dict[str, Any], dict2: Dict[str, Any], path: str = ""
    ) -> Tuple[Dict[str, Any], Dict[str, Any], Dict[str, Any]]:
        """
        Perform deep diff on two dictionaries.

        Args:
            dict1: First dictionary
            dict2: Second dictionary
            path: Current path in nested structure

        Returns:
            Tuple of (added, removed, modified) dictionaries
        """
        added = {}
        removed = {}
        modified = {}

        # Find keys in dict2 but not in dict1 (added)
        for key in dict2:
            if key not in dict1:
                full_path = f"{path}.{key}" if path else key
                added[full_path] = dict2[key]

        # Find keys in dict1 but not in dict2 (removed)
        for key in dict1:
            if key not in dict2:
                full_path = f"{path}.{key}" if path else key
                removed[full_path] = dict1[key]

        # Find keys in both (potentially modified)
        for key in dict1:
            if key in dict2:
                full_path = f"{path}.{key}" if path else key
                val1 = dict1[key]
                val2 = dict2[key]

                # If both are dicts, recurse
                if isinstance(val1, dict) and isinstance(val2, dict):
                    sub_added, sub_removed, sub_modified = self._deep_diff(val1, val2, full_path)
                    added.update(sub_added)
                    removed.update(sub_removed)
                    modified.update(sub_modified)
                # If both are lists, compare
                elif isinstance(val1, list) and isinstance(val2, list):
                    if val1 != val2:
                        modified[full_path] = {"old": val1, "new": val2}
                # Otherwise, compare values
                elif val1 != val2:
                    modified[full_path] = {"old": val1, "new": val2}

        return added, removed, modified

    def _extract_resource_ids(self, state: Dict[str, Any]) -> Set[str]:
        """Extract all resource IDs from a state."""
        resource_ids = set()

        stacks = state.get("stacks", {})
        for stack_name, stack_data in stacks.items():
            resources = stack_data.get("resources", {})
            resource_ids.update(resources.keys())

        return resource_ids

    def _get_resource_from_state(
        self, state: Dict[str, Any], resource_id: str
    ) -> Dict[str, Any] | None:
        """Get a resource from state by ID."""
        stacks = state.get("stacks", {})
        for stack_name, stack_data in stacks.items():
            resources = stack_data.get("resources", {})
            if resource_id in resources:
                return resources[resource_id]
        return None

    def _resources_differ(self, resource1: Dict[str, Any], resource2: Dict[str, Any]) -> bool:
        """Check if two resources differ in meaningful ways."""
        # Compare key properties
        if resource1.get("type") != resource2.get("type"):
            return True

        if resource1.get("physical_id") != resource2.get("physical_id"):
            return True

        # Compare properties (excluding metadata that changes every deployment)
        props1 = resource1.get("properties", {})
        props2 = resource2.get("properties", {})

        # Exclude timestamp-like fields
        exclude_keys = {"LastModified", "CreationDate", "UpdatedAt"}
        props1_filtered = {k: v for k, v in props1.items() if k not in exclude_keys}
        props2_filtered = {k: v for k, v in props2.items() if k not in exclude_keys}

        return props1_filtered != props2_filtered

    def format_config_diff(self, diff: ConfigDiff) -> str:
        """
        Format configuration diff as human-readable string.

        Args:
            diff: Configuration diff

        Returns:
            Formatted string
        """
        lines = []

        if diff.added:
            lines.append("Added:")
            for key, value in sorted(diff.added.items()):
                lines.append(f"  + {key}: {self._format_value(value)}")

        if diff.removed:
            lines.append("\nRemoved:")
            for key, value in sorted(diff.removed.items()):
                lines.append(f"  - {key}: {self._format_value(value)}")

        if diff.modified:
            lines.append("\nModified:")
            for key, change in sorted(diff.modified.items()):
                old_val = self._format_value(change["old"])
                new_val = self._format_value(change["new"])
                lines.append(f"  ~ {key}: {old_val} → {new_val}")

        return "\n".join(lines) if lines else "No configuration changes"

    def format_state_diff(self, diff: StateDiff) -> str:
        """
        Format state diff as human-readable string.

        Args:
            diff: State diff

        Returns:
            Formatted string
        """
        lines = []

        if diff.added_resources:
            lines.append(f"Added Resources ({len(diff.added_resources)}):")
            for resource_id in diff.added_resources:
                lines.append(f"  + {resource_id}")

        if diff.removed_resources:
            lines.append(f"\nRemoved Resources ({len(diff.removed_resources)}):")
            for resource_id in diff.removed_resources:
                lines.append(f"  - {resource_id}")

        if diff.modified_resources:
            lines.append(f"\nModified Resources ({len(diff.modified_resources)}):")
            for resource_id in diff.modified_resources:
                lines.append(f"  ~ {resource_id}")

        return "\n".join(lines) if lines else "No resource changes"

    def _format_value(self, value: Any) -> str:
        """Format a value for display."""
        if isinstance(value, (dict, list)):
            import json

            return json.dumps(value, separators=(",", ":"))[:100]
        return str(value)


def compare_deployments(
    deployment1: Dict[str, Any], deployment2: Dict[str, Any]
) -> DeploymentDiff:
    """
    Compare two complete deployment records.

    Args:
        deployment1: First deployment record
        deployment2: Second deployment record

    Returns:
        DeploymentDiff with all differences
    """
    comparator = DeploymentComparator()

    # Compare configurations
    config_diff = comparator.compare_configs(
        deployment1.get("config", {}), deployment2.get("config", {})
    )

    # Compare states
    state_diff = comparator.compare_states(
        deployment1.get("state_after", {}), deployment2.get("state_after", {})
    )

    # Calculate duration and cost differences
    metadata1 = deployment1.get("metadata", {})
    metadata2 = deployment2.get("metadata", {})

    duration_diff = metadata2.get("duration", 0) - metadata1.get("duration", 0)
    cost_diff = metadata2.get("estimatedCost", 0) - metadata1.get("estimatedCost", 0)

    return DeploymentDiff(
        deployment_id_1=metadata1.get("deploymentId", "unknown"),
        deployment_id_2=metadata2.get("deploymentId", "unknown"),
        config_diff=config_diff,
        state_diff=state_diff,
        duration_diff=duration_diff,
        cost_diff=cost_diff,
    )
