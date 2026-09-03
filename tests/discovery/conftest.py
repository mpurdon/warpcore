"""Shared fixtures for the discovery tests."""

import pytest

REGION = "us-east-1"


@pytest.fixture
def aws_credentials(monkeypatch):
    """Fake credentials so boto3 never looks at the real ones under moto."""
    for key in ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY",
                "AWS_SECURITY_TOKEN", "AWS_SESSION_TOKEN"):
        monkeypatch.setenv(key, "testing")
    monkeypatch.setenv("AWS_DEFAULT_REGION", REGION)
    monkeypatch.delenv("WARPCORE_DEV", raising=False)
