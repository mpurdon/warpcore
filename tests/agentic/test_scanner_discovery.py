"""Scanner discovery: scope, hydration, and error containment.

Exercised against moto rather than mocks so the ARN -> service-identifier
conversion is validated against something that actually rejects a wrong id.
"""

import boto3
import pytest
from moto import mock_aws

from warpcore.agentic.scanner import AWSScanner, ScanScope

REGION = "us-east-1"
PROJECT_TAGS = {"warpcore:project": "demo", "warpcore:environment": "dev"}


@pytest.fixture
def aws_credentials(monkeypatch):
    for key, value in {
        "AWS_ACCESS_KEY_ID": "testing",
        "AWS_SECRET_ACCESS_KEY": "testing",
        "AWS_SECURITY_TOKEN": "testing",
        "AWS_SESSION_TOKEN": "testing",
        "AWS_DEFAULT_REGION": REGION,
    }.items():
        monkeypatch.setenv(key, value)


@pytest.fixture
def populated_account(aws_credentials):
    """An account holding two tagged resources and one untagged one."""
    with mock_aws():
        session = boto3.Session(region_name=REGION)

        s3 = session.client("s3", region_name=REGION)
        s3.create_bucket(Bucket="tagged-bucket")
        s3.put_bucket_tagging(
            Bucket="tagged-bucket",
            Tagging={"TagSet": [{"Key": k, "Value": v} for k, v in PROJECT_TAGS.items()]},
        )
        s3.create_bucket(Bucket="untagged-bucket")

        ddb = session.client("dynamodb", region_name=REGION)
        ddb.create_table(
            TableName="tagged-table",
            KeySchema=[{"AttributeName": "pk", "KeyType": "HASH"}],
            AttributeDefinitions=[{"AttributeName": "pk", "AttributeType": "S"}],
            BillingMode="PAY_PER_REQUEST",
            Tags=[{"Key": k, "Value": v} for k, v in PROJECT_TAGS.items()],
        )

        yield session


def _scanner(session):
    return AWSScanner(
        boto_session=session, project_name="demo", environment="dev", region=REGION
    )


class TestScanScope:
    def test_project_scope_returns_only_tagged_resources(self, populated_account):
        scanned = _scanner(populated_account).scan_resources(scope=ScanScope.PROJECT)
        names = {r.id for r in scanned.get_all_resources()}
        assert "untagged-bucket" not in names
        assert names, "expected the tagged resources to be found"

    def test_account_scope_includes_untagged_resources(self, populated_account):
        scanned = _scanner(populated_account).scan_resources(scope=ScanScope.ACCOUNT)
        names = {r.id for r in scanned.get_all_resources()}
        assert "untagged-bucket" in names

    def test_account_scope_is_a_superset_of_project_scope(self, populated_account):
        scanner = _scanner(populated_account)
        project = scanner.scan_resources(scope=ScanScope.PROJECT)
        account = scanner.scan_resources(scope=ScanScope.ACCOUNT)
        assert len(account.resources) >= len(project.resources)

    def test_default_scope_is_project(self, populated_account):
        """Drift detection calls scan_resources() bare; it must stay scoped."""
        scanned = _scanner(populated_account).scan_resources()
        assert "untagged-bucket" not in {r.id for r in scanned.get_all_resources()}


class TestTypeFilterAndLimit:
    def test_resource_types_filter_is_applied(self, populated_account):
        scanned = _scanner(populated_account).scan_resources(
            scope=ScanScope.ACCOUNT, resource_types=["AWS::S3::Bucket"]
        )
        assert scanned.resources
        assert {r.type for r in scanned.get_all_resources()} == {"AWS::S3::Bucket"}

    def test_max_resources_truncates_and_flags(self, populated_account):
        scanned = _scanner(populated_account).scan_resources(
            scope=ScanScope.ACCOUNT, max_resources=1
        )
        assert len(scanned.resources) == 1
        assert scanned.truncated is True

    def test_untruncated_scan_is_not_flagged(self, populated_account):
        scanned = _scanner(populated_account).scan_resources(scope=ScanScope.ACCOUNT)
        assert scanned.truncated is False


class TestHydration:
    def test_unhydrated_scan_leaves_properties_empty(self, populated_account):
        scanned = _scanner(populated_account).scan_resources(
            scope=ScanScope.ACCOUNT, hydrate=False
        )
        assert all(r.properties == {} for r in scanned.get_all_resources())

    def test_hydration_populates_properties(self, populated_account):
        scanned = _scanner(populated_account).scan_resources(
            scope=ScanScope.ACCOUNT, hydrate=True
        )
        buckets = [r for r in scanned.get_all_resources() if r.type == "AWS::S3::Bucket"]
        assert buckets
        assert all(r.properties.get("BucketName") for r in buckets)

    def test_dynamodb_hydration_uses_the_table_name_not_the_arn(self, populated_account):
        """describe_table rejects an ARN; this is the bug the ARN work fixes."""
        scanned = _scanner(populated_account).scan_resources(
            scope=ScanScope.ACCOUNT, hydrate=True, resource_types=["AWS::DynamoDB::Table"]
        )
        tables = scanned.get_all_resources()
        assert tables, "expected the dynamodb table to be discovered"
        assert tables[0].properties.get("TableName") == "tagged-table"

    def test_hydration_records_errors_instead_of_raising(self, populated_account):
        """A resource that cannot be read must not abort the whole inventory."""
        scanner = _scanner(populated_account)
        scanned = scanner.scan_resources(scope=ScanScope.ACCOUNT, hydrate=False)

        from warpcore.state.models import Resource
        scanned.add_resource(Resource(
            id="ghost",
            type="AWS::Lambda::Function",
            physical_id=f"arn:aws:lambda:{REGION}:123456789012:function:does-not-exist",
        ))

        scanner.hydrate(scanned)
        assert any(e.physical_id.endswith("does-not-exist") for e in scanned.errors)
        assert scanned.resources, "other resources should survive the failure"

    def test_unsupported_type_is_reported_not_raised(self, populated_account):
        from warpcore.state.models import Resource
        scanner = _scanner(populated_account)
        scanned = scanner.scan_resources(scope=ScanScope.ACCOUNT, hydrate=False)
        scanned.add_resource(Resource(
            id="stream", type="AWS::Kinesis::Stream",
            physical_id=f"arn:aws:kinesis:{REGION}:123456789012:stream/s",
        ))
        scanner.hydrate(scanned)
        assert any("no detail reader" in e.message for e in scanned.errors)


class TestScannedState:
    def test_count_by_type_orders_by_frequency(self, populated_account):
        scanned = _scanner(populated_account).scan_resources(scope=ScanScope.ACCOUNT)
        counts = scanned.count_by_type()
        assert counts == dict(sorted(counts.items(), key=lambda kv: (-kv[1], kv[0])))

    def test_lookup_by_physical_id(self, populated_account):
        scanned = _scanner(populated_account).scan_resources(scope=ScanScope.ACCOUNT)
        resource = scanned.get_all_resources()[0]
        assert scanned.has_resource(resource.physical_id)
        assert scanned.get_resource_by_physical_id(resource.physical_id).id == resource.id


def test_hydration_output_is_json_serialisable(populated_account):
    """boto3 returns datetimes; state files are JSON."""
    import json

    scanned = _scanner(populated_account).scan_resources(
        scope=ScanScope.ACCOUNT, hydrate=True
    )
    for resource in scanned.get_all_resources():
        json.dumps(resource.properties)  # must not raise


class TestLogicalIdCollisions:
    """A role named after the function it serves must not evict the function.

    Found against a real account: 23 resources enumerated, 22 scanned, because
    `gitf-wake` the IAM role and `gitf-wake` the Lambda shared a dict key.
    """

    def _pair(self):
        from warpcore.state.models import Resource
        return (
            Resource(id="gitf-wake", type="AWS::IAM::Role",
                     physical_id="arn:aws:iam::515020252848:role/gitf-wake"),
            Resource(id="gitf-wake", type="AWS::Lambda::Function",
                     physical_id="arn:aws:lambda:us-east-1:515020252848:function:gitf-wake"),
        )

    def test_both_resources_survive(self):
        from warpcore.agentic.scanner import ScannedState

        state = ScannedState()
        role, function = self._pair()
        state.add_resource(role)
        state.add_resource(function)

        assert len(state.resources) == 2
        assert {r.type for r in state.get_all_resources()} == {
            "AWS::IAM::Role", "AWS::Lambda::Function"
        }

    def test_each_is_still_reachable_by_physical_id(self):
        from warpcore.agentic.scanner import ScannedState

        state = ScannedState()
        role, function = self._pair()
        state.add_resource(role)
        state.add_resource(function)

        assert state.get_resource_by_physical_id(role.physical_id).type == "AWS::IAM::Role"
        assert state.get_resource_by_physical_id(function.physical_id).type == \
            "AWS::Lambda::Function"

    def test_re_adding_the_same_physical_resource_still_replaces(self):
        """Deduplication by identity must keep working."""
        from warpcore.agentic.scanner import ScannedState
        from warpcore.state.models import Resource

        state = ScannedState()
        arn = "arn:aws:s3:::b"
        state.add_resource(Resource(id="b", type="AWS::S3::Bucket", physical_id=arn))
        state.add_resource(Resource(id="b", type="AWS::S3::Bucket", physical_id=arn,
                                    properties={"Versioning": "Enabled"}))

        assert len(state.resources) == 1
        assert state.get_all_resources()[0].properties == {"Versioning": "Enabled"}

    def test_resources_without_physical_ids_still_disambiguate_by_type(self):
        from warpcore.agentic.scanner import ScannedState
        from warpcore.state.models import Resource

        state = ScannedState()
        state.add_resource(Resource(id="x", type="AWS::IAM::Role"))
        state.add_resource(Resource(id="x", type="AWS::Lambda::Function"))
        assert len(state.resources) == 2
