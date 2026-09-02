"""Unit tests for AWSScanner internals.

Rewritten against the real API. The previous version imported a
`ScannedResource` class that has never existed and called
`_parse_resource_type_from_arn` / `_get_tagging_client`, neither of which is
defined - ARN parsing now lives in warpcore.utils.arn.

This file covers the parts a moto-backed test cannot reach cheaply: the
per-service detail readers and how the dispatch converts an ARN into the
identifier each service's own API expects. Behavioural coverage of scanning
against a real-shaped account is in test_scanner_discovery.py.
"""

from unittest.mock import Mock

import pytest
from botocore.exceptions import ClientError

from warpcore.agentic.scanner import AWSScanner, ScannedState
from warpcore.state.models import Resource


@pytest.fixture
def session():
    return Mock()


@pytest.fixture
def scanner(session):
    return AWSScanner(
        boto_session=session,
        project_name="test-project",
        environment="dev",
        region="us-east-1",
    )


def client_returning(session, **methods):
    """Point session.client(...) at a stub with the given method returns."""
    stub = Mock()
    for name, value in methods.items():
        getattr(stub, name).return_value = value
    session.client.return_value = stub
    return stub


class TestInitialization:
    def test_stores_its_scope(self, scanner):
        assert scanner.project_name == "test-project"
        assert scanner.environment == "dev"
        assert scanner.region == "us-east-1"

    def test_account_is_resolved_lazily_via_sts(self, session):
        client_returning(session, get_caller_identity={"Account": "123456789012"})
        scanner = AWSScanner(session, "p", "dev", "us-east-1")
        assert scanner.account == "123456789012"

    def test_explicit_account_skips_the_sts_call(self, session):
        scanner = AWSScanner(session, "p", "dev", "us-east-1", account="999999999999")
        assert scanner.account == "999999999999"

    def test_account_lookup_failure_is_not_fatal(self, session):
        stub = Mock()
        stub.get_caller_identity.side_effect = Exception("no credentials")
        session.client.return_value = stub
        scanner = AWSScanner(session, "p", "dev", "us-east-1")
        assert scanner.account == ""


class TestDetailReaderDispatch:
    def test_unsupported_type_returns_none_rather_than_raising(self, scanner):
        assert scanner.get_resource_details("AWS::Kinesis::Stream", "arn:x") is None

    def test_every_advertised_type_has_a_reader(self, scanner):
        for resource_type in scanner.supported_detail_types():
            assert resource_type in AWSScanner._DETAIL_READERS

    def test_supported_types_are_sorted(self, scanner):
        types = scanner.supported_detail_types()
        assert types == sorted(types)

    def test_client_errors_propagate_to_the_caller(self, scanner, session):
        stub = Mock()
        stub.get_function.side_effect = ClientError(
            {"Error": {"Code": "AccessDenied", "Message": "no"}}, "GetFunction"
        )
        session.client.return_value = stub
        with pytest.raises(ClientError):
            scanner.get_resource_details(
                "AWS::Lambda::Function",
                "arn:aws:lambda:us-east-1:1:function:f",
            )


class TestServiceIdentifierConversion:
    """The tagging API hands back ARNs; each service wants its own id shape.
    Passing the ARN straight through is what used to break hydration."""

    def test_lambda_reader_gets_a_function_name(self, scanner, session):
        stub = client_returning(session, get_function={"Configuration": {"FunctionName": "f"}})
        scanner.get_resource_details(
            "AWS::Lambda::Function", "arn:aws:lambda:us-east-1:1:function:f"
        )
        assert stub.get_function.call_args.kwargs["FunctionName"] == "f"

    def test_dynamodb_reader_gets_a_bare_table_name(self, scanner, session):
        stub = client_returning(session, describe_table={"Table": {}})
        scanner.get_resource_details(
            "AWS::DynamoDB::Table", "arn:aws:dynamodb:us-east-1:1:table/orders"
        )
        assert stub.describe_table.call_args.kwargs["TableName"] == "orders"

    def test_sqs_reader_gets_a_queue_url(self, scanner, session):
        stub = client_returning(session, get_queue_attributes={"Attributes": {}})
        scanner.get_resource_details(
            "AWS::SQS::Queue", "arn:aws:sqs:us-east-1:123456789012:work"
        )
        url = stub.get_queue_attributes.call_args.kwargs["QueueUrl"]
        assert url == "https://sqs.us-east-1.amazonaws.com/123456789012/work"

    def test_sns_reader_gets_the_arn_itself(self, scanner, session):
        arn = "arn:aws:sns:us-east-1:1:alerts"
        stub = client_returning(session, get_topic_attributes={"Attributes": {}})
        scanner.get_resource_details("AWS::SNS::Topic", arn)
        assert stub.get_topic_attributes.call_args.kwargs["TopicArn"] == arn

    def test_iam_reader_strips_the_role_path(self, scanner, session):
        """GetRole rejects slashes, so an SSO role's path must be dropped."""
        stub = client_returning(
            session,
            get_role={"Role": {"RoleName": "AWSReservedSSO_Admin"}},
            list_attached_role_policies={"AttachedPolicies": []},
            list_role_policies={"PolicyNames": []},
        )
        scanner.get_resource_details(
            "AWS::IAM::Role",
            "arn:aws:iam::1:role/aws-reserved/sso.amazonaws.com/AWSReservedSSO_Admin",
        )
        assert stub.get_role.call_args.kwargs["RoleName"] == "AWSReservedSSO_Admin"

    def test_log_group_reader_strips_the_stream_wildcard(self, scanner, session):
        stub = client_returning(session, describe_log_groups={"logGroups": []})
        scanner.get_resource_details(
            "AWS::Logs::LogGroup",
            "arn:aws:logs:us-east-1:1:log-group:/aws/lambda/fn:*",
        )
        prefix = stub.describe_log_groups.call_args.kwargs["logGroupNamePrefix"]
        assert prefix == "/aws/lambda/fn"


class TestDetailReaders:
    def test_lambda_details_drop_the_presigned_code_url(self, scanner, session):
        """`Code.Location` is a short-lived credential and must not reach state."""
        client_returning(session, get_function={
            "Configuration": {"FunctionName": "f", "MemorySize": 512},
            "Code": {"Location": "https://presigned.example/secret"},
        })
        details = scanner.get_resource_details(
            "AWS::Lambda::Function", "arn:aws:lambda:us-east-1:1:function:f"
        )
        assert details["MemorySize"] == 512
        assert "Code" not in details

    def test_iam_details_include_attached_and_inline_policies(self, scanner, session):
        client_returning(
            session,
            get_role={"Role": {"RoleName": "r"}},
            list_attached_role_policies={"AttachedPolicies": [{"PolicyName": "p"}]},
            list_role_policies={"PolicyNames": ["inline-1"]},
        )
        details = scanner.get_resource_details("AWS::IAM::Role", "arn:aws:iam::1:role/r")
        assert details["AttachedPolicies"] == [{"PolicyName": "p"}]
        assert details["InlinePolicyNames"] == ["inline-1"]

    def test_secret_reader_never_fetches_the_value(self, scanner, session):
        stub = client_returning(session, describe_secret={"Name": "s", "ARN": "arn:x"})
        scanner.get_resource_details(
            "AWS::SecretsManager::Secret", "arn:aws:secretsmanager:us-east-1:1:secret:s"
        )
        stub.describe_secret.assert_called_once()
        stub.get_secret_value.assert_not_called()

    def test_bucket_reader_tolerates_missing_sub_configuration(self, scanner, session):
        """A bucket with no encryption config raises rather than returning empty."""
        stub = Mock()
        error = ClientError({"Error": {"Code": "NoSuchConfiguration"}}, "op")
        stub.get_bucket_location.return_value = {"LocationConstraint": "us-east-1"}
        stub.get_bucket_encryption.side_effect = error
        stub.get_bucket_versioning.return_value = {"Status": "Enabled"}
        stub.get_public_access_block.side_effect = error
        session.client.return_value = stub

        details = scanner.get_resource_details("AWS::S3::Bucket", "arn:aws:s3:::data")
        assert details["BucketName"] == "data"
        assert details["Versioning"] == "Enabled"
        assert details["Encryption"] is None

    def test_events_rule_reader_includes_targets(self, scanner, session):
        client_returning(
            session,
            describe_rule={"Name": "r", "ScheduleExpression": "rate(1 day)",
                           "ResponseMetadata": {"RequestId": "x"}},
            list_targets_by_rule={"Targets": [{"Id": "t1"}]},
        )
        details = scanner.get_resource_details(
            "AWS::Events::Rule", "arn:aws:events:us-east-1:1:rule/r"
        )
        assert details["Targets"] == [{"Id": "t1"}]
        assert "ResponseMetadata" not in details, "boto plumbing should not reach state"


class TestScannedState:
    def test_starts_empty(self):
        state = ScannedState()
        assert state.get_all_resources() == []
        assert state.errors == []
        assert state.truncated is False

    def test_holds_state_model_resources(self):
        state = ScannedState()
        state.add_resource(Resource(id="f", type="AWS::Lambda::Function",
                                    physical_id="arn:aws:lambda:us-east-1:1:function:f"))
        assert len(state.get_all_resources()) == 1
        assert state.get_all_resources()[0].id == "f"

    def test_lookup_by_physical_id(self):
        state = ScannedState()
        arn = "arn:aws:s3:::b"
        state.add_resource(Resource(id="b", type="AWS::S3::Bucket", physical_id=arn))
        assert state.has_resource(arn)
        assert state.get_resource_by_physical_id(arn).id == "b"

    def test_unknown_physical_id_is_absent(self):
        state = ScannedState()
        assert not state.has_resource("arn:aws:s3:::missing")
        assert state.get_resource_by_physical_id("arn:aws:s3:::missing") is None

    def test_count_by_type(self):
        state = ScannedState()
        for i in range(2):
            state.add_resource(Resource(id=f"f{i}", type="AWS::Lambda::Function",
                                        physical_id=f"arn:lambda:{i}"))
        state.add_resource(Resource(id="b", type="AWS::S3::Bucket",
                                    physical_id="arn:aws:s3:::b"))
        assert state.count_by_type() == {
            "AWS::Lambda::Function": 2, "AWS::S3::Bucket": 1
        }
