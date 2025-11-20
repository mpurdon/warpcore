"""Monorepo support for detecting and managing multiple agents."""

import os
from pathlib import Path
from typing import List, Optional, Set

from .models import AgentConfig


class MonorepoDetector:
    """Detect and manage agents in a monorepo structure."""

    def __init__(self, root_path: Path):
        """Initialize monorepo detector.

        Args:
            root_path: Root path of the monorepo
        """
        self.root_path = root_path

    def detect_agents(
        self,
        search_paths: Optional[List[str]] = None,
        exclude_patterns: Optional[List[str]] = None,
    ) -> List[Path]:
        """Detect agent directories in monorepo.

        Looks for directories containing agent markers:
        - main.py or handler.py (Python agents)
        - strands.agent.yaml (agent configuration marker)
        - requirements.txt or pyproject.toml (Python project)

        Args:
            search_paths: Optional list of paths to search (relative to root)
            exclude_patterns: Optional list of directory patterns to exclude

        Returns:
            List of paths to detected agent directories
        """
        if search_paths is None:
            search_paths = ["apps", "agents", "packages", "services", "."]

        if exclude_patterns is None:
            exclude_patterns = [
                "node_modules",
                ".git",
                ".venv",
                "venv",
                "__pycache__",
                ".pytest_cache",
                "dist",
                "build",
            ]

        agent_dirs = []
        exclude_set = set(exclude_patterns)

        for search_path in search_paths:
            full_search_path = self.root_path / search_path
            if not full_search_path.exists():
                continue

            # Walk through directory tree
            for dirpath, dirnames, filenames in os.walk(full_search_path):
                # Filter out excluded directories
                dirnames[:] = [d for d in dirnames if d not in exclude_set]

                current_path = Path(dirpath)

                # Check if this directory contains agent markers
                if self._is_agent_directory(current_path, filenames):
                    agent_dirs.append(current_path)
                    # Don't search subdirectories of detected agents
                    dirnames.clear()

        return agent_dirs

    def _is_agent_directory(self, path: Path, filenames: List[str]) -> bool:
        """Check if directory contains agent markers.

        Args:
            path: Directory path to check
            filenames: List of filenames in the directory

        Returns:
            True if directory appears to be an agent
        """
        # Check for agent marker file
        if "strands.agent.yaml" in filenames:
            return True

        # Check for Python handler files
        has_handler = any(
            f in filenames for f in ["main.py", "handler.py", "app.py", "lambda_function.py"]
        )

        # Check for Python project markers
        has_python_project = any(f in filenames for f in ["requirements.txt", "pyproject.toml"])

        # Must have both handler and project marker
        return has_handler and has_python_project

    def filter_agents(
        self,
        agents: List[AgentConfig],
        agent_filter: Optional[str] = None,
        tags: Optional[dict] = None,
    ) -> List[AgentConfig]:
        """Filter agents based on criteria.

        Args:
            agents: List of agent configurations
            agent_filter: Optional agent name or comma-separated names to include
            tags: Optional dictionary of tags to filter by

        Returns:
            Filtered list of agent configurations
        """
        filtered = agents

        # Filter by name
        if agent_filter:
            agent_names = {name.strip() for name in agent_filter.split(",")}
            filtered = [agent for agent in filtered if agent.name in agent_names]

        # Filter by tags
        if tags:
            filtered = [
                agent
                for agent in filtered
                if all(agent.tags.get(key) == value for key, value in tags.items())
            ]

        return filtered

    def get_agent_dependencies(
        self, agent: AgentConfig, all_agents: List[AgentConfig]
    ) -> List[AgentConfig]:
        """Get dependencies between agents in monorepo.

        This is a placeholder for future dependency detection logic.
        Could analyze imports, shared libraries, or explicit dependencies.

        Args:
            agent: Agent to get dependencies for
            all_agents: All agents in the monorepo

        Returns:
            List of agent dependencies
        """
        # TODO: Implement dependency detection
        # Could look at:
        # - Shared Python packages
        # - Import statements
        # - Explicit dependencies in agent config
        return []

    def group_agents_by_path(self, agents: List[AgentConfig]) -> dict[str, List[AgentConfig]]:
        """Group agents by their parent directory.

        Useful for organizing agents by service, team, or feature.

        Args:
            agents: List of agent configurations

        Returns:
            Dictionary mapping parent directory to list of agents
        """
        groups: dict[str, List[AgentConfig]] = {}

        for agent in agents:
            agent_path = Path(agent.path)
            parent = str(agent_path.parent) if agent_path.parent != Path(".") else "root"

            if parent not in groups:
                groups[parent] = []
            groups[parent].append(agent)

        return groups

    def validate_agent_names_unique(self, agents: List[AgentConfig]) -> List[str]:
        """Validate that all agent names are unique in the monorepo.

        Args:
            agents: List of agent configurations

        Returns:
            List of duplicate agent names (empty if all unique)
        """
        seen: Set[str] = set()
        duplicates: Set[str] = set()

        for agent in agents:
            if agent.name in seen:
                duplicates.add(agent.name)
            seen.add(agent.name)

        return sorted(duplicates)

    def get_changed_agents(
        self, agents: List[AgentConfig], changed_files: List[str]
    ) -> List[AgentConfig]:
        """Determine which agents are affected by changed files.

        Useful for CI/CD to deploy only changed agents.

        Args:
            agents: List of all agent configurations
            changed_files: List of changed file paths (relative to root)

        Returns:
            List of agents that should be redeployed
        """
        changed_agents = []
        changed_paths = {Path(f) for f in changed_files}

        for agent in agents:
            agent_path = self.root_path / agent.path

            # Check if any changed file is within agent directory
            for changed_path in changed_paths:
                full_changed_path = self.root_path / changed_path
                try:
                    # Check if changed file is relative to agent path
                    full_changed_path.relative_to(agent_path)
                    changed_agents.append(agent)
                    break
                except ValueError:
                    # Not relative to this agent
                    continue

        return changed_agents
