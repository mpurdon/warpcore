"""State file data models with CDK compatibility."""

from datetime import datetime
from typing import Any, Dict, List, Optional
from pydantic import BaseModel, Field


class Resource(BaseModel):
    """Represents a deployed AWS resource."""

    id: str = Field(..., description="Logical resource ID")
    type: str = Field(..., description="AWS resource type (e.g., AWS::Lambda::Function)")
    physical_id: Optional[str] = Field(None, description="Physical AWS resource ID/ARN")
    properties: Dict[str, Any] = Field(
        default_factory=dict, description="Resource configuration properties"
    )
    dependencies: List[str] = Field(
        default_factory=list, description="List of resource IDs this resource depends on"
    )
    tags: Dict[str, str] = Field(default_factory=dict, description="Resource tags")
    metadata: Dict[str, Any] = Field(
        default_factory=dict, description="Additional metadata (creation time, etc.)"
    )

    def to_cdk_format(self) -> Dict[str, Any]:
        """Convert to CDK-compatible format."""
        return {
            "Type": self.type,
            "PhysicalResourceId": self.physical_id,
            "Properties": self.properties,
            "DependsOn": self.dependencies,
            "Metadata": {
                **self.metadata,
                "Tags": self.tags,
            },
        }

    @classmethod
    def from_cdk_format(cls, resource_id: str, cdk_data: Dict[str, Any]) -> "Resource":
        """Create Resource from CDK-compatible format."""
        metadata = cdk_data.get("Metadata", {})
        tags = metadata.pop("Tags", {})

        return cls(
            id=resource_id,
            type=cdk_data.get("Type", ""),
            physical_id=cdk_data.get("PhysicalResourceId"),
            properties=cdk_data.get("Properties", {}),
            dependencies=cdk_data.get("DependsOn", []),
            tags=tags,
            metadata=metadata,
        )


class Stack(BaseModel):
    """Represents a logical stack of resources."""

    name: str = Field(..., description="Stack name")
    resources: Dict[str, Resource] = Field(
        default_factory=dict, description="Resources in this stack, keyed by resource ID"
    )
    outputs: Dict[str, Any] = Field(default_factory=dict, description="Stack outputs")
    metadata: Dict[str, Any] = Field(default_factory=dict, description="Stack metadata")

    def add_resource(self, resource: Resource) -> None:
        """Add a resource to the stack."""
        self.resources[resource.id] = resource

    def remove_resource(self, resource_id: str) -> Optional[Resource]:
        """Remove a resource from the stack and return it."""
        return self.resources.pop(resource_id, None)

    def get_resource(self, resource_id: str) -> Optional[Resource]:
        """Get a resource by ID."""
        return self.resources.get(resource_id)

    def has_resource(self, resource_id: str) -> bool:
        """Check if a resource exists in the stack."""
        return resource_id in self.resources

    def list_resources(self) -> List[Resource]:
        """Get all resources in the stack."""
        return list(self.resources.values())

    def to_cdk_format(self) -> Dict[str, Any]:
        """Convert to CDK-compatible format."""
        return {
            "Resources": {
                resource_id: resource.to_cdk_format()
                for resource_id, resource in self.resources.items()
            },
            "Outputs": self.outputs,
            "Metadata": self.metadata,
        }


class State(BaseModel):
    """Represents the complete deployment state."""

    version: str = Field("1.0", description="State file format version")
    environment: str = Field(..., description="Environment name (dev, staging, prod)")
    region: str = Field(..., description="AWS region")
    account: str = Field(..., description="AWS account ID")
    project_name: str = Field(..., description="Project name")
    timestamp: datetime = Field(
        default_factory=datetime.utcnow, description="Last update timestamp"
    )
    stacks: Dict[str, Stack] = Field(
        default_factory=dict, description="Stacks in this deployment, keyed by stack name"
    )
    metadata: Dict[str, Any] = Field(default_factory=dict, description="Global metadata")

    def add_stack(self, stack: Stack) -> None:
        """Add a stack to the state."""
        self.stacks[stack.name] = stack

    def remove_stack(self, stack_name: str) -> Optional[Stack]:
        """Remove a stack from the state and return it."""
        return self.stacks.pop(stack_name, None)

    def get_stack(self, stack_name: str) -> Optional[Stack]:
        """Get a stack by name."""
        return self.stacks.get(stack_name)

    def has_stack(self, stack_name: str) -> bool:
        """Check if a stack exists."""
        return stack_name in self.stacks

    def list_stacks(self) -> List[Stack]:
        """Get all stacks."""
        return list(self.stacks.values())

    def add_resource(self, stack_name: str, resource: Resource) -> None:
        """Add a resource to a specific stack, creating the stack if needed."""
        if stack_name not in self.stacks:
            self.stacks[stack_name] = Stack(name=stack_name)
        self.stacks[stack_name].add_resource(resource)
        self.timestamp = datetime.utcnow()

    def remove_resource(self, stack_name: str, resource_id: str) -> Optional[Resource]:
        """Remove a resource from a specific stack."""
        if stack_name in self.stacks:
            resource = self.stacks[stack_name].remove_resource(resource_id)
            self.timestamp = datetime.utcnow()
            return resource
        return None

    def get_resource(self, resource_id: str) -> Optional[Resource]:
        """Get a resource by ID, searching all stacks."""
        for stack in self.stacks.values():
            resource = stack.get_resource(resource_id)
            if resource:
                return resource
        return None

    def get_resource_with_stack(self, resource_id: str) -> Optional[tuple[str, Resource]]:
        """Get a resource and its stack name by resource ID."""
        for stack_name, stack in self.stacks.items():
            resource = stack.get_resource(resource_id)
            if resource:
                return (stack_name, resource)
        return None

    def all_resources(self) -> List[tuple[str, Resource]]:
        """Get all resources across all stacks with their stack names."""
        resources = []
        for stack_name, stack in self.stacks.items():
            for resource in stack.list_resources():
                resources.append((stack_name, resource))
        return resources

    def get_dependencies(self, resource_id: str) -> List[str]:
        """Get the dependencies of a resource."""
        resource = self.get_resource(resource_id)
        return resource.dependencies if resource else []

    def get_dependents(self, resource_id: str) -> List[str]:
        """Get resources that depend on the given resource."""
        dependents = []
        for _, resource in self.all_resources():
            if resource_id in resource.dependencies:
                dependents.append(resource.id)
        return dependents

    def to_cdk_format(self) -> Dict[str, Any]:
        """Convert to CDK-compatible format."""
        return {
            "Version": self.version,
            "Environment": {
                "Name": self.environment,
                "Region": self.region,
                "Account": self.account,
            },
            "ProjectName": self.project_name,
            "Timestamp": self.timestamp.isoformat(),
            "Stacks": {
                stack_name: stack.to_cdk_format() for stack_name, stack in self.stacks.items()
            },
            "Metadata": self.metadata,
        }

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for JSON serialization."""
        return {
            "version": self.version,
            "environment": self.environment,
            "region": self.region,
            "account": self.account,
            "project_name": self.project_name,
            "timestamp": self.timestamp.isoformat(),
            "stacks": {
                stack_name: {
                    "name": stack.name,
                    "resources": {
                        resource_id: {
                            "id": resource.id,
                            "type": resource.type,
                            "physical_id": resource.physical_id,
                            "properties": resource.properties,
                            "dependencies": resource.dependencies,
                            "tags": resource.tags,
                            "metadata": resource.metadata,
                        }
                        for resource_id, resource in stack.resources.items()
                    },
                    "outputs": stack.outputs,
                    "metadata": stack.metadata,
                }
                for stack_name, stack in self.stacks.items()
            },
            "metadata": self.metadata,
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "State":
        """Create State from dictionary."""
        stacks = {}
        for stack_name, stack_data in data.get("stacks", {}).items():
            resources = {}
            for resource_id, resource_data in stack_data.get("resources", {}).items():
                resources[resource_id] = Resource(**resource_data)

            stacks[stack_name] = Stack(
                name=stack_data["name"],
                resources=resources,
                outputs=stack_data.get("outputs", {}),
                metadata=stack_data.get("metadata", {}),
            )

        return cls(
            version=data.get("version", "1.0"),
            environment=data["environment"],
            region=data["region"],
            account=data["account"],
            project_name=data["project_name"],
            timestamp=datetime.fromisoformat(data["timestamp"]),
            stacks=stacks,
            metadata=data.get("metadata", {}),
        )
