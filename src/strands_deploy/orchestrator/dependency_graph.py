"""Dependency graph builder for resource deployment ordering."""

from typing import Dict, List, Set, Optional
from dataclasses import dataclass
from collections import defaultdict, deque

from strands_deploy.state.models import Resource
from strands_deploy.utils.errors import DependencyError


@dataclass
class DependencyNode:
    """Node in the dependency graph."""
    
    resource_id: str
    resource: Resource
    dependencies: Set[str]  # Resource IDs this node depends on
    dependents: Set[str]  # Resource IDs that depend on this node


class DependencyGraph:
    """Directed acyclic graph (DAG) of resource dependencies."""
    
    def __init__(self):
        """Initialize empty dependency graph."""
        self.nodes: Dict[str, DependencyNode] = {}
        self._adjacency_list: Dict[str, Set[str]] = defaultdict(set)
        self._reverse_adjacency_list: Dict[str, Set[str]] = defaultdict(set)
    
    def add_resource(self, resource: Resource) -> None:
        """Add a resource to the dependency graph.
        
        Args:
            resource: Resource to add to the graph
        """
        if resource.id in self.nodes:
            # Update existing node
            node = self.nodes[resource.id]
            node.resource = resource
            
            # Update dependencies
            old_deps = node.dependencies.copy()
            new_deps = set(resource.dependencies)
            
            # Remove old edges
            for dep_id in old_deps - new_deps:
                self._adjacency_list[dep_id].discard(resource.id)
                self._reverse_adjacency_list[resource.id].discard(dep_id)
            
            # Add new edges
            for dep_id in new_deps - old_deps:
                self._adjacency_list[dep_id].add(resource.id)
                self._reverse_adjacency_list[resource.id].add(dep_id)
            
            node.dependencies = new_deps
        else:
            # Create new node
            dependencies = set(resource.dependencies)
            node = DependencyNode(
                resource_id=resource.id,
                resource=resource,
                dependencies=dependencies,
                dependents=set()
            )
            self.nodes[resource.id] = node
            
            # Add edges to adjacency lists
            for dep_id in dependencies:
                self._adjacency_list[dep_id].add(resource.id)
                self._reverse_adjacency_list[resource.id].add(dep_id)
    
    def remove_resource(self, resource_id: str) -> None:
        """Remove a resource from the dependency graph.
        
        Args:
            resource_id: ID of resource to remove
        """
        if resource_id not in self.nodes:
            return
        
        node = self.nodes[resource_id]
        
        # Remove all edges involving this node
        for dep_id in node.dependencies:
            self._adjacency_list[dep_id].discard(resource_id)
        
        for dependent_id in node.dependents:
            self._reverse_adjacency_list[dependent_id].discard(resource_id)
        
        # Remove from adjacency lists
        del self._adjacency_list[resource_id]
        del self._reverse_adjacency_list[resource_id]
        
        # Remove node
        del self.nodes[resource_id]
    
    def get_dependencies(self, resource_id: str) -> Set[str]:
        """Get direct dependencies of a resource.
        
        Args:
            resource_id: ID of resource
            
        Returns:
            Set of resource IDs that this resource depends on
        """
        if resource_id not in self.nodes:
            return set()
        return self.nodes[resource_id].dependencies.copy()
    
    def get_dependents(self, resource_id: str) -> Set[str]:
        """Get direct dependents of a resource.
        
        Args:
            resource_id: ID of resource
            
        Returns:
            Set of resource IDs that depend on this resource
        """
        return self._adjacency_list[resource_id].copy()
    
    def get_all_dependencies(self, resource_id: str) -> Set[str]:
        """Get all transitive dependencies of a resource.
        
        Args:
            resource_id: ID of resource
            
        Returns:
            Set of all resource IDs in the dependency chain
        """
        visited = set()
        queue = deque([resource_id])
        
        while queue:
            current_id = queue.popleft()
            if current_id in visited:
                continue
            
            visited.add(current_id)
            
            # Add dependencies to queue
            if current_id in self.nodes:
                for dep_id in self.nodes[current_id].dependencies:
                    if dep_id not in visited:
                        queue.append(dep_id)
        
        # Remove the resource itself from the result
        visited.discard(resource_id)
        return visited
    
    def get_all_dependents(self, resource_id: str) -> Set[str]:
        """Get all transitive dependents of a resource.
        
        Args:
            resource_id: ID of resource
            
        Returns:
            Set of all resource IDs that depend on this resource
        """
        visited = set()
        queue = deque([resource_id])
        
        while queue:
            current_id = queue.popleft()
            if current_id in visited:
                continue
            
            visited.add(current_id)
            
            # Add dependents to queue
            for dependent_id in self._adjacency_list[current_id]:
                if dependent_id not in visited:
                    queue.append(dependent_id)
        
        # Remove the resource itself from the result
        visited.discard(resource_id)
        return visited
    
    def detect_circular_dependencies(self) -> Optional[List[str]]:
        """Detect circular dependencies in the graph.
        
        Returns:
            List of resource IDs forming a cycle, or None if no cycle exists
        """
        # Use DFS with color marking to detect cycles
        # White (0): unvisited, Gray (1): visiting, Black (2): visited
        color = {node_id: 0 for node_id in self.nodes}
        parent = {}
        
        def dfs(node_id: str) -> Optional[List[str]]:
            """DFS helper to detect cycles."""
            color[node_id] = 1  # Mark as visiting
            
            # Visit all dependents (nodes that depend on this one)
            for dependent_id in self._adjacency_list[node_id]:
                if color[dependent_id] == 1:
                    # Found a back edge - cycle detected
                    # Reconstruct the cycle
                    cycle = [dependent_id]
                    current = node_id
                    while current != dependent_id:
                        cycle.append(current)
                        current = parent.get(current)
                        if current is None:
                            break
                    cycle.append(dependent_id)
                    return list(reversed(cycle))
                
                if color[dependent_id] == 0:
                    parent[dependent_id] = node_id
                    cycle = dfs(dependent_id)
                    if cycle:
                        return cycle
            
            color[node_id] = 2  # Mark as visited
            return None
        
        # Try DFS from each unvisited node
        for node_id in self.nodes:
            if color[node_id] == 0:
                cycle = dfs(node_id)
                if cycle:
                    return cycle
        
        return None
    
    def validate(self) -> None:
        """Validate the dependency graph.
        
        Raises:
            DependencyError: If validation fails (circular dependencies, missing dependencies)
        """
        # Check for circular dependencies
        cycle = self.detect_circular_dependencies()
        if cycle:
            cycle_str = " -> ".join(cycle)
            raise DependencyError(
                f"Circular dependency detected: {cycle_str}",
                resource_id=cycle[0] if cycle else None
            )
        
        # Check for missing dependencies
        for node_id, node in self.nodes.items():
            for dep_id in node.dependencies:
                if dep_id not in self.nodes:
                    raise DependencyError(
                        f"Resource '{node_id}' depends on '{dep_id}' which does not exist",
                        resource_id=node_id
                    )
    
    def topological_sort(self) -> List[str]:
        """Perform topological sort on the dependency graph.
        
        Returns:
            List of resource IDs in dependency order (dependencies before dependents)
            
        Raises:
            DependencyError: If graph contains cycles
        """
        # Validate graph first
        self.validate()
        
        # Kahn's algorithm for topological sort
        in_degree = {node_id: len(node.dependencies) for node_id, node in self.nodes.items()}
        queue = deque([node_id for node_id, degree in in_degree.items() if degree == 0])
        result = []
        
        while queue:
            node_id = queue.popleft()
            result.append(node_id)
            
            # Reduce in-degree for all dependents
            for dependent_id in self._adjacency_list[node_id]:
                in_degree[dependent_id] -= 1
                if in_degree[dependent_id] == 0:
                    queue.append(dependent_id)
        
        # If result doesn't contain all nodes, there's a cycle
        if len(result) != len(self.nodes):
            raise DependencyError(
                "Cannot perform topological sort: graph contains cycles",
                resource_id=None
            )
        
        return result
    
    def get_deployment_waves(self) -> List[List[str]]:
        """Group resources into parallel deployment waves.
        
        Resources in the same wave have no dependencies on each other and can be
        deployed in parallel.
        
        Returns:
            List of waves, where each wave is a list of resource IDs that can be
            deployed in parallel
            
        Raises:
            DependencyError: If graph contains cycles
        """
        # Validate graph first
        self.validate()
        
        # Use modified Kahn's algorithm to group by levels
        in_degree = {node_id: len(node.dependencies) for node_id, node in self.nodes.items()}
        current_wave = [node_id for node_id, degree in in_degree.items() if degree == 0]
        waves = []
        
        while current_wave:
            waves.append(current_wave)
            next_wave = []
            
            # Process all nodes in current wave
            for node_id in current_wave:
                # Reduce in-degree for all dependents
                for dependent_id in self._adjacency_list[node_id]:
                    in_degree[dependent_id] -= 1
                    if in_degree[dependent_id] == 0:
                        next_wave.append(dependent_id)
            
            current_wave = next_wave
        
        # Verify all nodes were processed
        total_processed = sum(len(wave) for wave in waves)
        if total_processed != len(self.nodes):
            raise DependencyError(
                "Cannot create deployment waves: graph contains cycles",
                resource_id=None
            )
        
        return waves
    
    def get_destruction_order(self) -> List[str]:
        """Get resource destruction order (reverse of deployment order).
        
        Returns:
            List of resource IDs in destruction order (dependents before dependencies)
            
        Raises:
            DependencyError: If graph contains cycles
        """
        deployment_order = self.topological_sort()
        return list(reversed(deployment_order))
    
    def get_resource(self, resource_id: str) -> Optional[Resource]:
        """Get a resource from the graph.
        
        Args:
            resource_id: ID of resource
            
        Returns:
            Resource object or None if not found
        """
        node = self.nodes.get(resource_id)
        return node.resource if node else None
    
    def has_resource(self, resource_id: str) -> bool:
        """Check if a resource exists in the graph.
        
        Args:
            resource_id: ID of resource
            
        Returns:
            True if resource exists, False otherwise
        """
        return resource_id in self.nodes
    
    def size(self) -> int:
        """Get the number of resources in the graph.
        
        Returns:
            Number of resources
        """
        return len(self.nodes)
    
    def is_empty(self) -> bool:
        """Check if the graph is empty.
        
        Returns:
            True if graph has no resources, False otherwise
        """
        return len(self.nodes) == 0
    
    def clear(self) -> None:
        """Clear all resources from the graph."""
        self.nodes.clear()
        self._adjacency_list.clear()
        self._reverse_adjacency_list.clear()
