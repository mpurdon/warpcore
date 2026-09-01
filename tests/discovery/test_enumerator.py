"""Service enumeration - the part that sees untagged resources."""

import boto3
import pytest
from moto import mock_aws

from warpcore.discovery.enumerator import ServiceEnumerator

REGION = "us-east-1"


@pytest.fixture
def aws_credentials(monkeypatch):
    for key in ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY",
                "AWS_SECURITY_TOKEN", "AWS_SESSION_TOKEN"):
        monkeypatch.setenv(key, "testing")
    monkeypatch.setenv("AWS_DEFAULT_REGION", REGION)


@pytest.fixture
def account(aws_credentials):
    with mock_aws():
        session = boto3.Session(region_name=REGION)
        s3 = session.client("s3", region_name=REGION)
        s3.create_bucket(Bucket="never-tagged")

        ddb = session.client("dynamodb", region_name=REGION)
        ddb.create_table(
            TableName="orders",
            KeySchema=[{"AttributeName": "pk", "KeyType": "HASH"}],
            AttributeDefinitions=[{"AttributeName": "pk", "AttributeType": "S"}],
            BillingMode="PAY_PER_REQUEST",
        )

        sqs = session.client("sqs", region_name=REGION)
        sqs.create_queue(QueueName="work")

        sns = session.client("sns", region_name=REGION)
        sns.create_topic(Name="alerts")

        yield session


def _enumerator(session):
    return ServiceEnumerator(session, region=REGION, account="123456789012")


def test_finds_never_tagged_resources(account):
    """The whole reason this module exists."""
    resources = _enumerator(account).enumerate(services=["s3"])
    assert "never-tagged" in {r.id for r in resources}


def test_enumerates_multiple_services(account):
    resources = _enumerator(account).enumerate(
        services=["s3", "dynamodb", "sqs", "sns"]
    )
    found = {r.type for r in resources}
    assert "AWS::S3::Bucket" in found
    assert "AWS::DynamoDB::Table" in found
    assert "AWS::SQS::Queue" in found
    assert "AWS::SNS::Topic" in found


def test_synthesised_arns_round_trip_through_the_parser(account):
    from warpcore.utils.arn import resource_type_from_arn

    for resource in _enumerator(account).enumerate(services=["dynamodb", "sqs", "sns", "s3"]):
        assert resource.physical_id.startswith("arn:")
        assert resource_type_from_arn(resource.physical_id) == resource.type


def test_a_failing_service_does_not_stop_the_others(account, monkeypatch):
    enumerator = _enumerator(account)

    def boom(self):
        raise RuntimeError("permission denied")

    monkeypatch.setitem(ServiceEnumerator._ENUMERATORS, "dynamodb", boom)
    resources = enumerator.enumerate(services=["s3", "dynamodb"])

    assert any(r.type == "AWS::S3::Bucket" for r in resources)
    assert any(e.service == "dynamodb" for e in enumerator.errors)


def test_unknown_service_is_ignored(account):
    enumerator = _enumerator(account)
    assert enumerator.enumerate(services=["not-a-service"]) == []


def test_supported_services_is_stable(account):
    services = _enumerator(account).supported_services()
    assert services == sorted(services)
    assert "lambda" in services and "iam" in services
