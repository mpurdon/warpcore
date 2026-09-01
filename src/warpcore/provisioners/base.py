"""Base provisioner interface and abstract classes."""

from abc import ABC, abstractmethod
from typing import Optional
from dataclasses import dataclass
from enum import Enum
import boto3


class ChangeType(Enum):
    """Type of change for a resource."""
    CREATE = "create"
    UPDATE = "update"
    DELETE = "delete"
    NO_CHANGE = "no_change"


@dataclass
class Resource:
    """Represents an AWS resource."""
    id: str
    type: str
    physical_id: Optional[str]
    properties: dict
    dependencies: list[str]
    tags: dict


@dataclass
class ProvisionPlan:
    """Plan for provisioning a resource."""
    resource: Resource
    change_type: ChangeType
    current_state: Optional[Resource]


class BaseProvisioner(ABC):
    """Base class for all resource provisioners."""
    
    def __init__(self, boto_session: boto3.Session):
        """Initialize provisioner with boto3 session.
        
        Args:
            boto_session: Configured boto3 session for AWS API calls
        """
        self.session = boto_session
    
    @abstractmethod
    def plan(self, desired: Resource, current: Optional[Resource]) -> ProvisionPlan:
        """Determine what changes are needed for the resource.
        
        Args:
            desired: The desired state of the resource
            current: The current state of the resource (None if doesn't exist)
            
        Returns:
            ProvisionPlan describing the changes needed
        """
        pass
    
    @abstractmethod
    def provision(self, plan: ProvisionPlan) -> Resource:
        """Execute the provisioning plan.
        
        Args:
            plan: The provisioning plan to execute
            
        Returns:
            Resource with updated physical_id and properties
        """
        pass
    
    @abstractmethod
    def destroy(self, resource: Resource) -> None:
        """Destroy the resource.
        
        Args:
            resource: The resource to destroy
        """
        pass
    
    def get_current_state(self, resource_id: str) -> Optional[Resource]:
        """Fetch current resource state from AWS.
        
        Args:
            resource_id: The logical ID of the resource
            
        Returns:
            Current resource state or None if doesn't exist
        """
        # Default implementation - subclasses should override
        return None
