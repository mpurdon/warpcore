"""Pydantic models for configuration schema."""

from typing import Dict, List, Optional
from pydantic import BaseModel, Field, field_validator, model_validator


class IPAMConfig(BaseModel):
    """IPAM configuration for VPC CIDR allocation."""

    enabled: bool = False
    pool_id: Optional[str] = Field(None, description="IPAM pool ID for CIDR allocation")
    netmask_length: Optional[int] = Field(
        None, ge=16, le=28, description="Netmask length for CIDR allocation"
    )

    @model_validator(mode="after")
    def validate_ipam_config(self):
        """Validate IPAM configuration."""
        if self.enabled and not self.pool_id:
            raise ValueError("pool_id is required when IPAM is enabled")
        if self.enabled and not self.netmask_length:
            raise ValueError("netmask_length is required when IPAM is enabled")
        return self


class VPCConfig(BaseModel):
    """VPC configuration."""

    enabled: bool = False
    cidr: Optional[str] = Field(None, description="VPC CIDR block (e.g., 10.0.0.0/16)")
    ipam: Optional[IPAMConfig] = Field(default_factory=lambda: IPAMConfig())

    @model_validator(mode="after")
    def validate_vpc_config(self):
        """Validate VPC configuration - either CIDR or IPAM must be specified."""
        if self.enabled:
            if not self.cidr and not (self.ipam and self.ipam.enabled):
                raise ValueError(
                    "Either 'cidr' or 'ipam' configuration must be provided when VPC is enabled"
                )
            if self.cidr and self.ipam and self.ipam.enabled:
                raise ValueError(
                    "Cannot specify both 'cidr' and 'ipam' - choose one method for CIDR allocation"
                )
        return self


class APIGatewayConfig(BaseModel):
    """API Gateway configuration."""

    type: str = Field("http", pattern="^(http|rest)$")
    cors: bool = True


class MonitoringConfig(BaseModel):
    """Monitoring configuration."""

    xray: bool = True
    alarms: bool = True


class SharedConfig(BaseModel):
    """Shared infrastructure configuration."""

    vpc: Optional[VPCConfig] = Field(default_factory=lambda: VPCConfig())
    api_gateway: Optional[APIGatewayConfig] = Field(default_factory=lambda: APIGatewayConfig())
    monitoring: Optional[MonitoringConfig] = Field(default_factory=lambda: MonitoringConfig())


class TagConfig(BaseModel):
    """Tag configuration for resources."""

    tags: Dict[str, str] = Field(default_factory=dict)

    @field_validator("tags")
    @classmethod
    def validate_tags(cls, v: Dict[str, str]) -> Dict[str, str]:
        """Validate tag keys and values."""
        for key, value in v.items():
            if not key or not isinstance(key, str):
                raise ValueError(f"Tag key must be a non-empty string: {key}")
            if not isinstance(value, str):
                raise ValueError(f"Tag value must be a string for key '{key}': {value}")
            if len(key) > 128:
                raise ValueError(f"Tag key exceeds 128 characters: {key}")
            if len(value) > 256:
                raise ValueError(f"Tag value exceeds 256 characters for key '{key}'")
        return v


class AgentConfig(BaseModel):
    """Agent configuration."""

    name: str = Field(..., min_length=1, max_length=64, pattern="^[a-z0-9-]+$")
    path: str = Field(..., min_length=1)
    runtime: str = Field("python3.11", pattern="^python3\\.(9|10|11|12)$")
    memory: int = Field(512, ge=128, le=10240)
    timeout: int = Field(30, ge=1, le=900)
    handler: str = Field("main.handler", min_length=1)
    environment: Dict[str, str] = Field(default_factory=dict)
    tags: Dict[str, str] = Field(default_factory=dict)

    @field_validator("name")
    @classmethod
    def validate_name(cls, v: str) -> str:
        """Validate agent name follows AWS naming conventions."""
        if not v:
            raise ValueError("Agent name cannot be empty")
        if not v[0].isalpha():
            raise ValueError("Agent name must start with a letter")
        return v

    @field_validator("environment")
    @classmethod
    def validate_environment(cls, v: Dict[str, str]) -> Dict[str, str]:
        """Validate environment variables."""
        for key, value in v.items():
            if not key or not isinstance(key, str):
                raise ValueError(f"Environment variable key must be a non-empty string: {key}")
            if not isinstance(value, str):
                raise ValueError(
                    f"Environment variable value must be a string for key '{key}': {value}"
                )
        return v


class ProjectConfig(BaseModel):
    """Project-level configuration."""

    name: str = Field(..., min_length=1, max_length=64, pattern="^[a-z0-9-]+$")
    region: str = Field(..., min_length=1)
    tags: Dict[str, str] = Field(default_factory=dict)

    @field_validator("region")
    @classmethod
    def validate_region(cls, v: str) -> str:
        """Validate AWS region format."""
        valid_regions = [
            "us-east-1",
            "us-east-2",
            "us-west-1",
            "us-west-2",
            "eu-west-1",
            "eu-west-2",
            "eu-west-3",
            "eu-central-1",
            "eu-north-1",
            "ap-northeast-1",
            "ap-northeast-2",
            "ap-northeast-3",
            "ap-southeast-1",
            "ap-southeast-2",
            "ap-south-1",
            "sa-east-1",
            "ca-central-1",
        ]
        if v not in valid_regions:
            raise ValueError(
                f"Invalid AWS region: {v}. Must be one of: {', '.join(valid_regions)}"
            )
        return v


class EnvironmentConfig(BaseModel):
    """Environment-specific configuration."""

    name: str = Field(..., min_length=1)
    account: str = Field(..., pattern="^[0-9]{12}$")
    region: str = Field(..., min_length=1)
    vpc: Optional[VPCConfig] = None
    tags: Dict[str, str] = Field(default_factory=dict)

    @field_validator("account")
    @classmethod
    def validate_account(cls, v: str) -> str:
        """Validate AWS account ID format."""
        if not v.isdigit() or len(v) != 12:
            raise ValueError(f"AWS account ID must be a 12-digit number: {v}")
        return v

    @field_validator("region")
    @classmethod
    def validate_region(cls, v: str) -> str:
        """Validate AWS region format."""
        valid_regions = [
            "us-east-1",
            "us-east-2",
            "us-west-1",
            "us-west-2",
            "eu-west-1",
            "eu-west-2",
            "eu-west-3",
            "eu-central-1",
            "eu-north-1",
            "ap-northeast-1",
            "ap-northeast-2",
            "ap-northeast-3",
            "ap-southeast-1",
            "ap-southeast-2",
            "ap-south-1",
            "sa-east-1",
            "ca-central-1",
        ]
        if v not in valid_regions:
            raise ValueError(
                f"Invalid AWS region: {v}. Must be one of: {', '.join(valid_regions)}"
            )
        return v
