"""Shared pytest fixtures and configuration."""

import pytest
from unittest.mock import Mock, MagicMock
from datetime import datetime


@pytest.fixture
def mock_boto_session():
    """Create a mock boto3 session for testing."""
    session = Mock()
    session.client.return_value = Mock()
    session.resource.return_value = Mock()
    return session


@pytest.fixture
def mock_s3_client():
    """Create a mock S3 client."""
    client = Mock()
    client.list_objects_v2.return_value = {"Contents": []}
    client.get_object.return_value = {"Body": Mock()}
    client.put_object.return_value = {}
    return client


@pytest.fixture
def sample_state():
    """Create a sample state dictionary for testing."""
    return {
        "version": "1.0.0",
        "project": "test-project",
        "environment": "dev",
        "stacks": {
            "main-stack": {
                "name": "test-project-dev-main",
                "resources": {
                    "lambda-function-1": {
                        "type": "AWS::Lambda::Function",
                        "physical_id": "arn:aws:lambda:us-east-1:123456789012:function:test-func",
                        "status": "DEPLOYED",
                        "properties": {
                            "FunctionName": "test-func",
                            "Runtime": "python3.11",
                            "MemorySize": 512,
                            "Timeout": 30,
                        },
                        "tags": {
                            "warpcore:project": "test-project",
                            "warpcore:environment": "dev",
                        },
                    },
                    "iam-role-1": {
                        "type": "AWS::IAM::Role",
                        "physical_id": "arn:aws:iam::123456789012:role/test-role",
                        "status": "DEPLOYED",
                        "properties": {
                            "RoleName": "test-role",
                        },
                        "tags": {
                            "warpcore:project": "test-project",
                            "warpcore:environment": "dev",
                        },
                    },
                }
            }
        }
    }


@pytest.fixture
def sample_config():
    """Create a sample configuration dictionary for testing."""
    return {
        "project": {
            "name": "test-project",
            "region": "us-east-1",
            "tags": {
                "team": "platform",
            }
        },
        "agents": [
            {
                "name": "test-agent",
                "path": "./agent",
                "runtime": "python3.11",
                "memory": 512,
                "timeout": 30,
                "handler": "main.handler",
                "environment": {
                    "LOG_LEVEL": "INFO",
                }
            }
        ],
        "environments": {
            "dev": {
                "account": "123456789012",
                "region": "us-east-1",
            }
        }
    }


@pytest.fixture
def sample_deployment_metadata():
    """Create sample deployment metadata for testing."""
    return {
        "deploymentId": "deploy-123456",
        "projectName": "test-project",
        "environment": "dev",
        "startTime": datetime.utcnow().isoformat(),
        "endTime": None,
        "duration": 0,
        "status": "in_progress",
        "deployedBy": "arn:aws:iam::123456789012:user/test-user",
        "deploymentMethod": "cli",
        "version": "1.0.0",
        "changes": {
            "created": [],
            "updated": [],
            "deleted": [],
        },
        "resourceCount": 0,
        "estimatedCost": 0.0,
        "tags": {},
        "errorMessage": None,
    }
