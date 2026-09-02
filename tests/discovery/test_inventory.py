"""Multi-region account inventory."""

import boto3
import pytest
from moto import mock_aws

from warpcore.discovery.inventory import enabled_regions, scan_account

ACCOUNT = "123456789012"


@pytest.fixture
def aws_credentials(monkeypatch):
    for key in ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY",
                "AWS_SECURITY_TOKEN", "AWS_SESSION_TOKEN"):
        monkeypatch.setenv(key, "testing")
    monkeypatch.setenv("AWS_DEFAULT_REGION", "us-east-1")


@pytest.fixture
def two_region_account(aws_credentials):
    with mock_aws():
        session = boto3.Session()
        session.client("s3", region_name="us-east-1").create_bucket(Bucket="east-bucket")
        session.client("s3", region_name="us-west-2").create_bucket(
            Bucket="west-bucket",
            CreateBucketConfiguration={"LocationConstraint": "us-west-2"},
        )
        session.client("sqs", region_name="us-east-1").create_queue(QueueName="east-q")
        session.client("sqs", region_name="us-west-2").create_queue(QueueName="west-q")
        yield session


def test_enabled_regions_returns_a_sorted_list(two_region_account):
    regions = enabled_regions(two_region_account)
    assert regions == sorted(regions)
    assert "us-east-1" in regions and "us-west-2" in regions


def test_scans_each_region_and_merges(two_region_account):
    inventory = scan_account(
        two_region_account, ACCOUNT, regions=["us-east-1", "us-west-2"],
        resource_types=["AWS::SQS::Queue"],
    )
    ids = {r.id for r in inventory.scanned.get_all_resources()}
    assert {"east-q", "west-q"} <= ids


def test_each_resource_is_stamped_with_its_region(two_region_account):
    inventory = scan_account(
        two_region_account, ACCOUNT, regions=["us-east-1", "us-west-2"],
        resource_types=["AWS::SQS::Queue"],
    )
    by_id = {r.id: r.metadata["region"] for r in inventory.scanned.get_all_resources()}
    assert by_id["east-q"] == "us-east-1"
    assert by_id["west-q"] == "us-west-2"


def test_per_region_counts_are_reported(two_region_account):
    inventory = scan_account(
        two_region_account, ACCOUNT, regions=["us-east-1", "us-west-2"],
        resource_types=["AWS::SQS::Queue"],
    )
    assert set(inventory.region_summary()) == {"us-east-1", "us-west-2"}
    assert all(c >= 1 for c in inventory.region_summary().values())


def test_global_resources_are_reported_once(two_region_account):
    """IAM is returned by every region's scan; the merge must dedupe it."""
    iam = two_region_account.client("iam")
    iam.create_role(RoleName="shared", AssumeRolePolicyDocument="{}")

    inventory = scan_account(
        two_region_account, ACCOUNT, regions=["us-east-1", "us-west-2"],
        resource_types=["AWS::IAM::Role"],
    )
    roles = [r for r in inventory.scanned.get_all_resources() if r.id == "shared"]
    assert len(roles) == 1


def test_a_failing_region_does_not_abort_the_others(two_region_account, monkeypatch):
    from warpcore.agentic import scanner as scanner_module

    original = scanner_module.AWSScanner.scan_resources

    def flaky(self, *args, **kwargs):
        if self.region == "us-west-2":
            raise RuntimeError("region is having a bad day")
        return original(self, *args, **kwargs)

    monkeypatch.setattr(scanner_module.AWSScanner, "scan_resources", flaky)

    inventory = scan_account(
        two_region_account, ACCOUNT, regions=["us-east-1", "us-west-2"],
        resource_types=["AWS::SQS::Queue"],
    )
    assert any(r.id == "east-q" for r in inventory.scanned.get_all_resources())
    failed = [r for r in inventory.regions if r.failed]
    assert [r.region for r in failed] == ["us-west-2"]
