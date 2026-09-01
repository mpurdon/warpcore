"""API call tracing via botocore's event system."""

import boto3
import pytest
from moto import mock_aws

from warpcore.utils.api_trace import ApiCallTracer

REGION = "us-east-1"


@pytest.fixture
def aws_credentials(monkeypatch):
    for key in ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY",
                "AWS_SECURITY_TOKEN", "AWS_SESSION_TOKEN"):
        monkeypatch.setenv(key, "testing")
    monkeypatch.setenv("AWS_DEFAULT_REGION", REGION)


@pytest.fixture
def traced_session(aws_credentials):
    with mock_aws():
        session = boto3.Session(region_name=REGION)
        tracer = ApiCallTracer().attach(session)
        yield session, tracer


def test_successful_calls_are_traced(traced_session):
    session, tracer = traced_session
    session.client("s3", region_name=REGION).list_buckets()

    calls = tracer.calls()
    assert any(c.service == "s3" and c.operation == "ListBuckets" for c in calls)
    assert all(c.duration_ms >= 0 for c in calls)


def test_tracing_covers_clients_created_after_attachment(traced_session):
    session, tracer = traced_session
    s3 = session.client("s3", region_name=REGION)
    s3.create_bucket(Bucket="traced-bucket")
    assert any(c.operation == "CreateBucket" for c in tracer.calls())


def test_failed_calls_record_an_error_code(traced_session):
    session, tracer = traced_session
    s3 = session.client("s3", region_name=REGION)
    with pytest.raises(Exception):
        s3.get_bucket_location(Bucket="does-not-exist-anywhere")

    errored = [c for c in tracer.calls() if c.error_code]
    assert errored, "expected the failure to be traced"


def test_attach_is_idempotent(traced_session):
    session, tracer = traced_session
    tracer.attach(session)
    tracer.attach(session)
    session.client("s3", region_name=REGION).list_buckets()

    list_calls = [c for c in tracer.calls() if c.operation == "ListBuckets"]
    assert len(list_calls) == 1, "handlers were registered more than once"


def test_stats_aggregate_by_service_and_operation(traced_session):
    session, tracer = traced_session
    s3 = session.client("s3", region_name=REGION)
    s3.list_buckets()
    s3.list_buckets()

    stats = tracer.stats()
    assert stats.total >= 2
    assert stats.by_service["s3"] >= 2
    assert stats.by_operation["s3.ListBuckets"] >= 2
    assert stats.average_duration_ms >= 0


def test_drain_returns_and_clears(traced_session):
    session, tracer = traced_session
    session.client("s3", region_name=REGION).list_buckets()

    drained = tracer.drain()
    assert drained
    assert tracer.calls() == []


def test_cap_drops_rather_than_growing_without_bound(traced_session):
    session, tracer = traced_session
    tracer.max_calls = 1
    s3 = session.client("s3", region_name=REGION)
    s3.list_buckets()
    s3.list_buckets()
    s3.list_buckets()

    assert len(tracer.calls()) == 1
    assert tracer.dropped >= 1


def test_stats_on_an_empty_tracer_do_not_divide_by_zero():
    stats = ApiCallTracer().stats()
    assert stats.total == 0
    assert stats.average_duration_ms == 0.0
