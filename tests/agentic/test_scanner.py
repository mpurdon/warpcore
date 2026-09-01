"""Tests for the AWS Scanner component."""
import pytest

# These tests were written against an `AWSScanner`/`ScannedState` API that does
# not exist and never has: they import `ScannedResource` (a class with
# resource_id/arn fields) and construct `ScannedState(resources=[...])` as a
# list. The real ScannedState is dict-keyed and holds warpcore.state.models
# Resource objects. Nothing here exercises the shipped code, so it is skipped
# rather than left to abort collection for the whole suite.
#
# Real scanner coverage lives in tests/agentic/test_scanner_discovery.py.
# Rewriting these against the actual API is tracked separately.
pytest.skip(
    "written against a ScannedResource API that does not exist; "
    "see tests/agentic/test_scanner_discovery.py for real coverage",
    allow_module_level=True,
)


import pytest
from unittest.mock import Mock, MagicMock, patch
from datetime import datetime

from warpcore.agentic.scanner import AWSScanner, ScannedResource, ScannedState


class TestAWSScanner:
    """Test suite for AWSScanner."""

    @pytest.fixture
    def mock_boto_session(self):
        """Create a mock boto3 session."""
        session = Mock()
        return session

    @pytest.fixture
    def scanner(self, mock_boto_session):
        """Create an AWSScanner instance with mock session."""
        return AWSScanner(
            boto_session=mock_boto_session,
            project_name="test-project",
            environment="dev",
            region="us-east-1"
        )

    def test_scanner_initialization(self, scanner):
        """Test scanner initializes with correct parameters."""
        assert scanner.project_name == "test-project"
        assert scanner.environment == "dev"
        assert scanner.region == "us-east-1"

    def test_parse_lambda_arn(self, scanner):
        """Test parsing Lambda ARN to resource type."""
        arn = "arn:aws:lambda:us-east-1:123456789012:function:my-function"
        resource_type = scanner._parse_resource_type_from_arn(arn)
        assert resource_type == "AWS::Lambda::Function"

    def test_parse_iam_role_arn(self, scanner):
        """Test parsing IAM Role ARN to resource type."""
        arn = "arn:aws:iam::123456789012:role/my-role"
        resource_type = scanner._parse_resource_type_from_arn(arn)
        assert resource_type == "AWS::IAM::Role"

    def test_parse_dynamodb_arn(self, scanner):
        """Test parsing DynamoDB ARN to resource type."""
        arn = "arn:aws:dynamodb:us-east-1:123456789012:table/my-table"
        resource_type = scanner._parse_resource_type_from_arn(arn)
        assert resource_type == "AWS::DynamoDB::Table"

    def test_parse_s3_arn(self, scanner):
        """Test parsing S3 ARN to resource type."""
        arn = "arn:aws:s3:::my-bucket"
        resource_type = scanner._parse_resource_type_from_arn(arn)
        assert resource_type == "AWS::S3::Bucket"

    def test_parse_sqs_arn(self, scanner):
        """Test parsing SQS ARN to resource type."""
        arn = "arn:aws:sqs:us-east-1:123456789012:my-queue"
        resource_type = scanner._parse_resource_type_from_arn(arn)
        assert resource_type == "AWS::SQS::Queue"

    def test_parse_sns_arn(self, scanner):
        """Test parsing SNS ARN to resource type."""
        arn = "arn:aws:sns:us-east-1:123456789012:my-topic"
        resource_type = scanner._parse_resource_type_from_arn(arn)
        assert resource_type == "AWS::SNS::Topic"

    def test_parse_vpc_arn(self, scanner):
        """Test parsing VPC ARN to resource type."""
        arn = "arn:aws:ec2:us-east-1:123456789012:vpc/vpc-12345678"
        resource_type = scanner._parse_resource_type_from_arn(arn)
        assert resource_type == "AWS::EC2::VPC"

    def test_parse_api_gateway_arn(self, scanner):
        """Test parsing API Gateway ARN to resource type."""
        arn = "arn:aws:execute-api:us-east-1:123456789012:abcd1234"
        resource_type = scanner._parse_resource_type_from_arn(arn)
        assert resource_type == "AWS::ApiGateway::RestApi"

    def test_parse_unknown_arn(self, scanner):
        """Test parsing unknown service ARN returns None."""
        arn = "arn:aws:unknown:us-east-1:123456789012:resource"
        resource_type = scanner._parse_resource_type_from_arn(arn)
        assert resource_type is None

    @patch.object(AWSScanner, '_get_tagging_client')
    def test_scan_resources_empty(self, mock_get_client, scanner):
        """Test scanning when no resources found."""
        mock_client = Mock()
        mock_client.get_paginator.return_value.paginate.return_value = [
            {"ResourceTagMappingList": []}
        ]
        mock_get_client.return_value = mock_client

        result = scanner.scan_resources()

        assert isinstance(result, ScannedState)
        assert len(result.resources) == 0

    @patch.object(AWSScanner, '_get_tagging_client')
    @patch.object(AWSScanner, 'get_resource_details')
    def test_scan_resources_finds_lambda(self, mock_get_details, mock_get_client, scanner):
        """Test scanning finds Lambda function."""
        mock_client = Mock()
        mock_client.get_paginator.return_value.paginate.return_value = [
            {
                "ResourceTagMappingList": [
                    {
                        "ResourceARN": "arn:aws:lambda:us-east-1:123456789012:function:my-function",
                        "Tags": [
                            {"Key": "warpcore:project", "Value": "test-project"},
                            {"Key": "warpcore:environment", "Value": "dev"}
                        ]
                    }
                ]
            }
        ]
        mock_get_client.return_value = mock_client

        mock_get_details.return_value = {
            "FunctionName": "my-function",
            "Runtime": "python3.11",
            "MemorySize": 512
        }

        result = scanner.scan_resources()

        assert len(result.resources) == 1
        resource = result.resources[0]
        assert resource.resource_type == "AWS::Lambda::Function"
        assert resource.arn == "arn:aws:lambda:us-east-1:123456789012:function:my-function"


class TestScannedResource:
    """Test suite for ScannedResource model."""

    def test_scanned_resource_creation(self):
        """Test creating a ScannedResource."""
        resource = ScannedResource(
            resource_id="my-function",
            resource_type="AWS::Lambda::Function",
            arn="arn:aws:lambda:us-east-1:123456789012:function:my-function",
            tags={"environment": "dev"},
            properties={"MemorySize": 512}
        )

        assert resource.resource_id == "my-function"
        assert resource.resource_type == "AWS::Lambda::Function"
        assert resource.tags["environment"] == "dev"
        assert resource.properties["MemorySize"] == 512


class TestScannedState:
    """Test suite for ScannedState model."""

    def test_scanned_state_empty(self):
        """Test empty ScannedState."""
        state = ScannedState(resources=[])
        assert len(state.resources) == 0

    def test_scanned_state_with_resources(self):
        """Test ScannedState with multiple resources."""
        resources = [
            ScannedResource(
                resource_id="lambda-1",
                resource_type="AWS::Lambda::Function",
                arn="arn:aws:lambda:us-east-1:123:function:lambda-1",
                tags={},
                properties={}
            ),
            ScannedResource(
                resource_id="table-1",
                resource_type="AWS::DynamoDB::Table",
                arn="arn:aws:dynamodb:us-east-1:123:table/table-1",
                tags={},
                properties={}
            ),
        ]
        state = ScannedState(resources=resources)

        assert len(state.resources) == 2
        assert state.resources[0].resource_type == "AWS::Lambda::Function"
        assert state.resources[1].resource_type == "AWS::DynamoDB::Table"
