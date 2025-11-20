"""YAML configuration parser for Strands deployment system."""

import os
from pathlib import Path
from typing import Dict, List, Optional

import yaml
from pydantic import ValidationError

from .models import (
    AgentConfig,
    APIGatewayConfig,
    EnvironmentConfig,
    IPAMConfig,
    MonitoringConfig,
    ProjectConfig,
    SharedConfig,
    VPCConfig,
)


class ConfigValidationError(Exception):
    """Exception raised when configuration validation fails."""

    def __init__(self, message: str, errors: Optional[List[Dict]] = None):
        self.message = message
        self.errors = errors or []
        super().__init__(self.message)

    def __str__(self) -> str:
        """Format validation errors for display."""
        if not self.errors:
            return self.message

        error_lines = [self.message, ""]
        for error in self.errors:
            location = " -> ".join(str(loc) for loc in error.get("loc", []))
            msg = error.get("msg", "Unknown error")
            error_lines.append(f"  • {location}: {msg}")

        return "\n".join(error_lines)


class Config:
    """Configuration manager for Strands deployment system."""

    def __init__(self, config_path: str):
        """Initialize configuration manager.

        Args:
            config_path: Path to strands.yaml configuration file
        """
        self.config_path = Path(config_path)
        self.data: Dict = {}
        self.project: Optional[ProjectConfig] = None
        self.agents: List[AgentConfig] = []
        self.shared: Optional[SharedConfig] = None
        self.environments: Dict[str, EnvironmentConfig] = {}

    def load(self) -> "Config":
        """Load and validate configuration from YAML file.

        Returns:
            Self for method chaining

        Raises:
            ConfigValidationError: If configuration is invalid
            FileNotFoundError: If configuration file doesn't exist
        """
        if not self.config_path.exists():
            raise FileNotFoundError(f"Configuration file not found: {self.config_path}")

        try:
            with open(self.config_path, "r") as f:
                self.data = yaml.safe_load(f) or {}
        except yaml.YAMLError as e:
            raise ConfigValidationError(f"Failed to parse YAML: {e}")

        # Validate configuration
        validation_errors = self.validate()
        if validation_errors:
            raise ConfigValidationError(
                f"Configuration validation failed with {len(validation_errors)} error(s)",
                validation_errors,
            )

        # Parse configuration sections
        self._parse_project()
        self._parse_agents()
        self._parse_shared()
        self._parse_environments()

        return self

    def validate(self) -> List[Dict]:
        """Validate configuration against schema.

        Returns:
            List of validation errors (empty if valid)
        """
        errors = []

        # Validate required top-level keys
        if "project" not in self.data:
            errors.append({"loc": ["project"], "msg": "Required field 'project' is missing"})

        if "agents" not in self.data:
            errors.append({"loc": ["agents"], "msg": "Required field 'agents' is missing"})
        elif not isinstance(self.data["agents"], list) or len(self.data["agents"]) == 0:
            errors.append({"loc": ["agents"], "msg": "At least one agent must be defined"})

        # Validate project configuration
        if "project" in self.data:
            try:
                ProjectConfig(**self.data["project"])
            except ValidationError as e:
                for error in e.errors():
                    errors.append(
                        {
                            "loc": ["project"] + list(error["loc"]),
                            "msg": error["msg"],
                        }
                    )

        # Validate agents
        if "agents" in self.data and isinstance(self.data["agents"], list):
            for idx, agent_data in enumerate(self.data["agents"]):
                try:
                    AgentConfig(**agent_data)
                except ValidationError as e:
                    for error in e.errors():
                        errors.append(
                            {
                                "loc": ["agents", idx] + list(error["loc"]),
                                "msg": error["msg"],
                            }
                        )

        # Validate shared configuration
        if "shared" in self.data:
            try:
                self._parse_shared_config(self.data["shared"])
            except ValidationError as e:
                for error in e.errors():
                    errors.append(
                        {
                            "loc": ["shared"] + list(error["loc"]),
                            "msg": error["msg"],
                        }
                    )

        # Validate environments
        if "environments" in self.data:
            if not isinstance(self.data["environments"], dict):
                errors.append(
                    {"loc": ["environments"], "msg": "Environments must be a dictionary"}
                )
            else:
                for env_name, env_data in self.data["environments"].items():
                    try:
                        # Add environment name to data
                        env_config_data = {"name": env_name, **env_data}
                        EnvironmentConfig(**env_config_data)
                    except ValidationError as e:
                        for error in e.errors():
                            errors.append(
                                {
                                    "loc": ["environments", env_name] + list(error["loc"]),
                                    "msg": error["msg"],
                                }
                            )

        return errors

    def get_agents(self, agent_filter: Optional[str] = None) -> List[AgentConfig]:
        """Get list of agent configurations.

        Args:
            agent_filter: Optional agent name to filter by

        Returns:
            List of agent configurations
        """
        if agent_filter:
            return [agent for agent in self.agents if agent.name == agent_filter]
        return self.agents

    def get_environment(self, env_name: str) -> EnvironmentConfig:
        """Get environment-specific configuration with overrides applied.

        Args:
            env_name: Environment name

        Returns:
            Environment configuration with overrides

        Raises:
            ConfigValidationError: If environment doesn't exist
        """
        if env_name not in self.environments:
            available = ", ".join(self.environments.keys())
            raise ConfigValidationError(
                f"Environment '{env_name}' not found. Available environments: {available}"
            )

        return self.environments[env_name]

    def get_agent(self, agent_name: str) -> Optional[AgentConfig]:
        """Get specific agent configuration by name.

        Args:
            agent_name: Agent name

        Returns:
            Agent configuration or None if not found
        """
        for agent in self.agents:
            if agent.name == agent_name:
                return agent
        return None

    def _parse_project(self):
        """Parse project configuration."""
        if "project" in self.data:
            self.project = ProjectConfig(**self.data["project"])

    def _parse_agents(self):
        """Parse agent configurations."""
        if "agents" in self.data and isinstance(self.data["agents"], list):
            self.agents = [AgentConfig(**agent_data) for agent_data in self.data["agents"]]

    def _parse_shared(self):
        """Parse shared infrastructure configuration."""
        if "shared" in self.data:
            self.shared = self._parse_shared_config(self.data["shared"])
        else:
            self.shared = SharedConfig()

    def _parse_shared_config(self, shared_data: Dict) -> SharedConfig:
        """Parse shared configuration with nested structures.

        Args:
            shared_data: Raw shared configuration data

        Returns:
            Parsed SharedConfig object
        """
        # Parse VPC configuration
        vpc_config = None
        if "vpc" in shared_data:
            vpc_data = shared_data["vpc"]
            ipam_config = None
            if "ipam" in vpc_data:
                ipam_config = IPAMConfig(**vpc_data["ipam"])
            vpc_config = VPCConfig(
                enabled=vpc_data.get("enabled", False),
                cidr=vpc_data.get("cidr"),
                ipam=ipam_config,
            )

        # Parse API Gateway configuration
        api_gateway_config = None
        if "api_gateway" in shared_data:
            api_gateway_config = APIGatewayConfig(**shared_data["api_gateway"])

        # Parse monitoring configuration
        monitoring_config = None
        if "monitoring" in shared_data:
            monitoring_config = MonitoringConfig(**shared_data["monitoring"])

        return SharedConfig(
            vpc=vpc_config,
            api_gateway=api_gateway_config,
            monitoring=monitoring_config,
        )

    def _parse_environments(self):
        """Parse environment configurations with overrides."""
        if "environments" not in self.data:
            return

        for env_name, env_data in self.data["environments"].items():
            # Start with base environment data
            env_config_data = {"name": env_name, **env_data}

            # Parse VPC override if present
            if "vpc" in env_data:
                vpc_data = env_data["vpc"]
                ipam_config = None
                if "ipam" in vpc_data:
                    ipam_config = IPAMConfig(**vpc_data["ipam"])
                env_config_data["vpc"] = VPCConfig(
                    enabled=vpc_data.get("enabled", False),
                    cidr=vpc_data.get("cidr"),
                    ipam=ipam_config,
                )

            self.environments[env_name] = EnvironmentConfig(**env_config_data)

    def to_dict(self) -> Dict:
        """Convert configuration to dictionary.

        Returns:
            Dictionary representation of configuration
        """
        return {
            "project": self.project.model_dump() if self.project else {},
            "agents": [agent.model_dump() for agent in self.agents],
            "shared": self.shared.model_dump() if self.shared else {},
            "environments": {
                name: env.model_dump() for name, env in self.environments.items()
            },
        }
