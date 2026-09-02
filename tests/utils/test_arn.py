"""ARN parsing: the scanner is only as good as this."""

import pytest

from warpcore.utils.arn import (
    logical_id_from_arn,
    parse_arn,
    resource_type_from_arn,
    service_identifier,
)


class TestParseArn:
    def test_parses_slash_separated_resource(self):
        arn = parse_arn("arn:aws:iam::123456789012:role/my-role")
        assert arn.service == "iam"
        assert arn.account == "123456789012"
        assert arn.resource_type == "role"
        assert arn.resource_id == "my-role"

    def test_parses_colon_separated_resource(self):
        arn = parse_arn("arn:aws:lambda:us-east-1:123456789012:function:my-fn")
        assert arn.resource_type == "function"
        assert arn.resource_id == "my-fn"

    def test_keeps_colons_inside_the_resource_part(self):
        # Versioned Lambda ARNs carry a trailing qualifier.
        arn = parse_arn("arn:aws:lambda:us-east-1:123456789012:function:my-fn:PROD")
        assert arn.resource_id == "my-fn:PROD"

    def test_s3_arn_has_no_region_or_account(self):
        arn = parse_arn("arn:aws:s3:::my-bucket")
        assert arn.region == ""
        assert arn.account == ""
        assert arn.resource_id == "my-bucket"

    @pytest.mark.parametrize("value", ["", "not-an-arn", "my-bucket", "arn:aws:s3"])
    def test_returns_none_for_non_arns(self, value):
        assert parse_arn(value) is None


class TestResourceTypeFromArn:
    @pytest.mark.parametrize("arn,expected", [
        ("arn:aws:lambda:us-east-1:1:function:f", "AWS::Lambda::Function"),
        ("arn:aws:iam::1:role/r", "AWS::IAM::Role"),
        ("arn:aws:iam::1:policy/p", "AWS::IAM::ManagedPolicy"),
        ("arn:aws:s3:::b", "AWS::S3::Bucket"),
        ("arn:aws:dynamodb:us-east-1:1:table/t", "AWS::DynamoDB::Table"),
        ("arn:aws:sqs:us-east-1:1:q", "AWS::SQS::Queue"),
        ("arn:aws:sns:us-east-1:1:t", "AWS::SNS::Topic"),
        ("arn:aws:ec2:us-east-1:1:vpc/vpc-1", "AWS::EC2::VPC"),
        ("arn:aws:ec2:us-east-1:1:security-group/sg-1", "AWS::EC2::SecurityGroup"),
        ("arn:aws:ec2:us-east-1:1:subnet/subnet-1", "AWS::EC2::Subnet"),
        ("arn:aws:events:us-east-1:1:rule/r", "AWS::Events::Rule"),
        ("arn:aws:logs:us-east-1:1:log-group:/aws/lambda/f", "AWS::Logs::LogGroup"),
    ])
    def test_known_types(self, arn, expected):
        assert resource_type_from_arn(arn) == expected

    def test_distinguishes_ec2_subtypes(self):
        # The old implementation collapsed every ec2 ARN to EC2::Instance.
        assert resource_type_from_arn("arn:aws:ec2:us-east-1:1:vpc/vpc-1") != \
               resource_type_from_arn("arn:aws:ec2:us-east-1:1:subnet/subnet-1")

    def test_unknown_service_still_produces_a_usable_type(self):
        assert resource_type_from_arn("arn:aws:kinesis:us-east-1:1:stream/s") == \
               "AWS::Kinesis::Stream"

    def test_non_arn_is_marked_unknown(self):
        assert resource_type_from_arn("just-a-name") == "AWS::Unknown::Resource"


class TestServiceIdentifier:
    def test_sqs_becomes_a_queue_url(self):
        # get_queue_attributes takes a URL, not an ARN.
        assert service_identifier("arn:aws:sqs:us-east-1:123456789012:my-q") == \
            "https://sqs.us-east-1.amazonaws.com/123456789012/my-q"

    def test_dynamodb_becomes_a_bare_table_name(self):
        assert service_identifier("arn:aws:dynamodb:us-east-1:1:table/my-table") == "my-table"

    def test_s3_becomes_a_bare_bucket_name(self):
        assert service_identifier("arn:aws:s3:::my-bucket") == "my-bucket"

    def test_lambda_qualifier_is_stripped(self):
        assert service_identifier("arn:aws:lambda:us-east-1:1:function:f:PROD") == "f"

    def test_sns_keeps_the_arn(self):
        arn = "arn:aws:sns:us-east-1:1:my-topic"
        assert service_identifier(arn) == arn

    def test_non_arn_passes_through(self):
        assert service_identifier("my-bucket") == "my-bucket"


def test_logical_id_prefers_the_trailing_segment():
    assert logical_id_from_arn("arn:aws:logs:us-east-1:1:log-group:/aws/lambda/fn") == "fn"
    assert logical_id_from_arn("arn:aws:iam::1:role/path/to/my-role") == "my-role"


class TestServiceIdentifierRealWorldArns:
    """Cases found by running discovery against a real AWS account."""

    def test_iam_role_path_is_stripped(self):
        # GetRole(RoleName=) rejects slashes: "must contain only alphanumeric
        # characters and/or the following: +=,.@_-"
        arn = ("arn:aws:iam::515020252848:role/aws-reserved/sso.amazonaws.com/"
               "AWSReservedSSO_AccountAdmin_04e55675397e1c0b")
        assert service_identifier(arn) == "AWSReservedSSO_AccountAdmin_04e55675397e1c0b"

    def test_iam_role_without_a_path_is_unchanged(self):
        assert service_identifier("arn:aws:iam::1:role/gitf-wake") == "gitf-wake"

    def test_log_group_stream_wildcard_is_stripped(self):
        # describe_log_groups rejects the trailing ":*" that the logs API
        # itself puts on the ARN.
        arn = "arn:aws:logs:us-east-1:515020252848:log-group:/aws/lambda/gitf-wake:*"
        assert service_identifier(arn) == "/aws/lambda/gitf-wake"

    def test_log_group_without_wildcard_is_unchanged(self):
        arn = "arn:aws:logs:us-east-1:1:log-group:/aws/lambda/fn"
        assert service_identifier(arn) == "/aws/lambda/fn"

    def test_log_group_type_survives_the_wildcard(self):
        arn = "arn:aws:logs:us-east-1:1:log-group:/aws/lambda/fn:*"
        assert resource_type_from_arn(arn) == "AWS::Logs::LogGroup"
