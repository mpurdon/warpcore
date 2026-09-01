"""State manager for loading, saving, and managing deployment state."""

import fcntl
import json
import os
from pathlib import Path
from typing import List, Optional, Set, Tuple

from .models import Resource, Stack, State


class StateError(Exception):
    """Base exception for state management errors."""

    pass


class StateLockError(StateError):
    """Exception raised when state file cannot be locked."""

    pass


class StateNotFoundError(StateError):
    """Exception raised when state file does not exist."""

    pass


class CircularDependencyError(StateError):
    """Exception raised when circular dependencies are detected."""

    pass


class StateManager:
    """Manages deployment state with file locking and dependency tracking."""

    def __init__(self, state_path: str):
        """
        Initialize StateManager.

        Args:
            state_path: Path to the state file
        """
        self.state_path = Path(state_path)
        self._lock_file: Optional[int] = None
        self._current_state: Optional[State] = None

    def load(self) -> State:
        """
        Load state from file.

        Returns:
            State object

        Raises:
            StateNotFoundError: If state file does not exist
            StateError: If state file is corrupted or invalid
        """
        if not self.state_path.exists():
            raise StateNotFoundError(f"State file not found: {self.state_path}")

        try:
            with open(self.state_path, "r") as f:
                data = json.load(f)
                self._current_state = State.from_dict(data)
                return self._current_state
        except json.JSONDecodeError as e:
            raise StateError(f"Failed to parse state file: {e}")
        except Exception as e:
            raise StateError(f"Failed to load state file: {e}")

    def save(self, state: State) -> None:
        """
        Save state to file.

        Args:
            state: State object to save

        Raises:
            StateError: If state cannot be saved
        """
        # Ensure directory exists
        self.state_path.parent.mkdir(parents=True, exist_ok=True)

        try:
            # Write to temporary file first
            temp_path = self.state_path.with_suffix(".tmp")
            with open(temp_path, "w") as f:
                json.dump(state.to_dict(), f, indent=2)

            # Atomic rename
            temp_path.replace(self.state_path)
            self._current_state = state
        except Exception as e:
            raise StateError(f"Failed to save state file: {e}")

    def initialize(
        self, environment: str, region: str, account: str, project_name: str
    ) -> State:
        """
        Initialize a new state file.

        Args:
            environment: Environment name
            region: AWS region
            account: AWS account ID
            project_name: Project name

        Returns:
            New State object
        """
        state = State(
            environment=environment, region=region, account=account, project_name=project_name
        )
        self.save(state)
        return state

    def exists(self) -> bool:
        """Check if state file exists."""
        return self.state_path.exists()

    def lock(self, timeout: int = 30) -> None:
        """
        Acquire exclusive lock on state file.

        Args:
            timeout: Lock timeout in seconds

        Raises:
            StateLockError: If lock cannot be acquired
        """
        lock_path = self.state_path.with_suffix(".lock")
        lock_path.parent.mkdir(parents=True, exist_ok=True)

        try:
            # Open lock file
            self._lock_file = os.open(str(lock_path), os.O_CREAT | os.O_RDWR)

            # Try to acquire exclusive lock with timeout
            import time

            start_time = time.time()
            while True:
                try:
                    fcntl.flock(self._lock_file, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except BlockingIOError:
                    if time.time() - start_time > timeout:
                        raise StateLockError(
                            f"Failed to acquire lock on state file after {timeout}s"
                        )
                    time.sleep(0.1)
        except Exception as e:
            if self._lock_file is not None:
                os.close(self._lock_file)
                self._lock_file = None
            raise StateLockError(f"Failed to acquire lock: {e}")

    def unlock(self) -> None:
        """Release lock on state file."""
        if self._lock_file is not None:
            try:
                fcntl.flock(self._lock_file, fcntl.LOCK_UN)
                os.close(self._lock_file)
            finally:
                self._lock_file = None

    def __enter__(self):
        """Context manager entry - acquire lock and load state."""
        self.lock()
        if self.exists():
            self.load()
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        """Context manager exit - release lock."""
        self.unlock()

    def add_resource(self, stack_name: str, resource: Resource) -> None:
        """
        Add a resource to the state.

        Args:
            stack_name: Stack name
            resource: Resource to add

        Raises:
            StateError: If state is not loaded
        """
        if self._current_state is None:
            raise StateError("State not loaded. Call load() first.")

        self._current_state.add_resource(stack_name, resource)

    def remove_resource(self, stack_name: str, resource_id: str) -> Optional[Resource]:
        """
        Remove a resource from the state.

        Args:
            stack_name: Stack name
            resource_id: Resource ID to remove

        Returns:
            Removed resource or None if not found

        Raises:
            StateError: If state is not loaded
        """
        if self._current_state is None:
            raise StateError("State not loaded. Call load() first.")

        return self._current_state.remove_resource(stack_name, resource_id)

    def get_resource(self, resource_id: str) -> Optional[Resource]:
        """
        Get a resource by ID.

        Args:
            resource_id: Resource ID

        Returns:
            Resource or None if not found

        Raises:
            StateError: If state is not loaded
        """
        if self._current_state is None:
            raise StateError("State not loaded. Call load() first.")

        return self._current_state.get_resource(resource_id)

    def get_state(self) -> State:
        """
        Get the current state.

        Returns:
            Current State object

        Raises:
            StateError: If state is not loaded
        """
        if self._current_state is None:
            raise StateError("State not loaded. Call load() first.")

        return self._current_state

    def build_dependency_graph(self) -> dict[str, List[str]]:
        """
        Build dependency graph from current state.

        Returns:
            Dictionary mapping resource IDs to their dependencies

        Raises:
            StateError: If state is not loaded
        """
        if self._current_state is None:
            raise StateError("State not loaded. Call load() first.")

        graph = {}
        for _, resource in self._current_state.all_resources():
            graph[resource.id] = resource.dependencies.copy()

        return graph

    def topological_sort(self, resource_ids: Optional[List[str]] = None) -> List[str]:
        """
        Perform topological sort on resources based on dependencies.

        Args:
            resource_ids: Optional list of specific resource IDs to sort.
                         If None, sorts all resources.

        Returns:
            List of resource IDs in dependency order (dependencies first)

        Raises:
            CircularDependencyError: If circular dependencies are detected
            StateError: If state is not loaded
        """
        if self._current_state is None:
            raise StateError("State not loaded. Call load() first.")

        # Build dependency graph
        graph = self.build_dependency_graph()

        # Filter to specific resources if requested
        if resource_ids is not None:
            resource_set = set(resource_ids)
            graph = {rid: deps for rid, deps in graph.items() if rid in resource_set}

        # Kahn's algorithm for topological sort
        in_degree = {rid: 0 for rid in graph}
        for rid in graph:
            for dep in graph[rid]:
                if dep in in_degree:
                    in_degree[dep] += 1

        # Find nodes with no incoming edges
        queue = [rid for rid, degree in in_degree.items() if degree == 0]
        result = []

        while queue:
            # Sort queue for deterministic ordering
            queue.sort()
            node = queue.pop(0)
            result.append(node)

            # Reduce in-degree for dependent nodes
            for rid, deps in graph.items():
                if node in deps:
                    in_degree[rid] -= 1
                    if in_degree[rid] == 0:
                        queue.append(rid)

        # Check for circular dependencies
        if len(result) != len(graph):
            remaining = set(graph.keys()) - set(result)
            raise CircularDependencyError(
                f"Circular dependency detected among resources: {remaining}"
            )

        # Reverse to get dependencies-first order
        return list(reversed(result))

    def reverse_topological_sort(self, resource_ids: Optional[List[str]] = None) -> List[str]:
        """
        Perform reverse topological sort (for destruction order).

        Args:
            resource_ids: Optional list of specific resource IDs to sort.
                         If None, sorts all resources.

        Returns:
            List of resource IDs in reverse dependency order (dependents first)

        Raises:
            CircularDependencyError: If circular dependencies are detected
            StateError: If state is not loaded
        """
        return list(reversed(self.topological_sort(resource_ids)))

    def detect_circular_dependencies(self) -> Optional[List[str]]:
        """
        Detect circular dependencies in the state.

        Returns:
            List of resource IDs involved in circular dependency, or None if no cycles

        Raises:
            StateError: If state is not loaded
        """
        if self._current_state is None:
            raise StateError("State not loaded. Call load() first.")

        try:
            self.topological_sort()
            return None
        except CircularDependencyError:
            # Find cycle using DFS
            graph = self.build_dependency_graph()
            visited = set()
            rec_stack = set()
            cycle = []

            def dfs(node: str, path: List[str]) -> bool:
                visited.add(node)
                rec_stack.add(node)
                path.append(node)

                for neighbor in graph.get(node, []):
                    if neighbor not in visited:
                        if dfs(neighbor, path):
                            return True
                    elif neighbor in rec_stack:
                        # Found cycle
                        cycle_start = path.index(neighbor)
                        cycle.extend(path[cycle_start:])
                        return True

                path.pop()
                rec_stack.remove(node)
                return False

            for node in graph:
                if node not in visited:
                    if dfs(node, []):
                        return cycle

            return None

    def get_resource_tree(self, resource_id: str) -> dict[str, List[str]]:
        """
        Get the dependency tree for a resource.

        Args:
            resource_id: Resource ID

        Returns:
            Dictionary mapping resource IDs to their direct dependencies

        Raises:
            StateError: If state is not loaded or resource not found
        """
        if self._current_state is None:
            raise StateError("State not loaded. Call load() first.")

        resource = self.get_resource(resource_id)
        if resource is None:
            raise StateError(f"Resource not found: {resource_id}")

        tree = {}
        visited = set()

        def build_tree(rid: str):
            if rid in visited:
                return
            visited.add(rid)

            res = self.get_resource(rid)
            if res:
                tree[rid] = res.dependencies.copy()
                for dep in res.dependencies:
                    build_tree(dep)

        build_tree(resource_id)
        return tree

    def validate_dependencies(self) -> List[Tuple[str, str]]:
        """
        Validate that all resource dependencies exist.

        Returns:
            List of tuples (resource_id, missing_dependency_id) for missing dependencies

        Raises:
            StateError: If state is not loaded
        """
        if self._current_state is None:
            raise StateError("State not loaded. Call load() first.")

        missing = []
        all_resource_ids = {resource.id for _, resource in self._current_state.all_resources()}

        for _, resource in self._current_state.all_resources():
            for dep in resource.dependencies:
                if dep not in all_resource_ids:
                    missing.append((resource.id, dep))

        return missing
