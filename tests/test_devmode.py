"""Developer mode wiring."""

import json

import boto3
import pytest
from moto import mock_aws

from warpcore.devmode import DevMode, get_dev_mode, init_dev_mode, latest_session_manifest

REGION = "us-east-1"


@pytest.fixture
def aws_credentials(monkeypatch):
    for key in ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY",
                "AWS_SECURITY_TOKEN", "AWS_SESSION_TOKEN"):
        monkeypatch.setenv(key, "testing")
    monkeypatch.setenv("AWS_DEFAULT_REGION", REGION)


def test_inactive_by_default():
    mode = init_dev_mode(enabled=False)
    assert not mode.enabled
    assert get_dev_mode() is mode


def test_env_var_activates_it(monkeypatch):
    monkeypatch.setenv("WARPCORE_DEV", "1")
    assert init_dev_mode(enabled=False).enabled


@pytest.mark.parametrize("value", ["0", "", "no", "off"])
def test_env_var_falsey_values_do_not_activate(monkeypatch, value):
    monkeypatch.setenv("WARPCORE_DEV", value)
    assert not init_dev_mode(enabled=False).enabled


def test_inactive_mode_does_not_trace(aws_credentials):
    mode = init_dev_mode(enabled=False)
    with mock_aws():
        session = mode.attach_session(boto3.Session(region_name=REGION))
        session.client("s3", region_name=REGION).list_buckets()
    assert mode.api_calls() == []


def test_active_mode_traces(aws_credentials):
    mode = init_dev_mode(enabled=True)
    with mock_aws():
        session = mode.attach_session(boto3.Session(region_name=REGION))
        session.client("s3", region_name=REGION).list_buckets()
    assert any(c.operation == "ListBuckets" for c in mode.api_calls())


def test_manifest_captures_runtime_and_api(aws_credentials, tmp_path):
    mode = init_dev_mode(enabled=True, command="deploy --env dev",
                         environment="dev", region=REGION)
    with mock_aws():
        session = mode.attach_session(boto3.Session(region_name=REGION))
        session.client("s3", region_name=REGION).list_buckets()

    path = mode.write_manifest(tmp_path)
    manifest = json.loads(path.read_text())

    assert manifest["command"] == "deploy --env dev"
    assert manifest["environment"] == "dev"
    assert manifest["runtime"]["boto3"]
    assert manifest["api"]["total_calls"] >= 1


def test_inactive_mode_writes_no_manifest(tmp_path):
    assert init_dev_mode(enabled=False).write_manifest(tmp_path) is None


def test_latest_manifest_reads_back(tmp_path):
    mode = init_dev_mode(enabled=True, command="x")
    mode.write_manifest(tmp_path)
    assert latest_session_manifest(tmp_path)["session_id"] == mode.session_id


def test_latest_manifest_is_none_when_empty(tmp_path):
    assert latest_session_manifest(tmp_path) is None


def test_bind_recorder_stamps_the_session_id(tmp_path):
    from warpcore.audit.recorder import AuditRecorder

    mode = init_dev_mode(enabled=True)
    recorder = mode.bind_recorder(AuditRecorder(environment="dev", audit_dir=tmp_path))
    assert recorder.session_id == mode.session_id
