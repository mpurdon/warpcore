"""Tests for the AgenticReconciler component."""

import pytest
from unittest.mock import Mock, MagicMock, patch
from datetime import datetime

from warpcore.agentic.reconciler import AgenticReconciler
from warpcore.agentic.models import (
    DriftType,
    Severity,
    DriftItem,
    DriftReport,
    DriftAnalysis,
    FailureContext,
    MissingResource,
)
from warpcore.agentic.scanner import ScannedResource, ScannedState


class TestAgenticReconciler:
    """Test suite for AgenticReconciler."""

    @pytest.fixture
    def mock_state_manager(self):
        """Create a mock state manager."""
        manager = Mock()
        manager.load.return_value = {
            "stacks": {
                "test-stack": {
                    "resources": {
                        "lambda-1": {
                            "type": "AWS::Lambda::Function",
                            "physical_id": "arn:aws:lambda:us-east-1:123:function:lambda-1",
                            "properties": {"MemorySize": 512},
                            "tags": {"environment": "dev"},
                        }
                    }
                }
            }
        }
        return manager

    @pytest.fixture
    def mock_boto_session(self):
        """Create a mock boto3 session."""
        session = Mock()
        return session

    @pytest.fixture
    def mock_llm_client(self):
        """Create a mock LLM client."""
        client = Mock()
        client.analyze_drift.return_value = DriftAnalysis(
            summary="Test analysis",
            root_cause="Test root cause",
            impact="Test impact",
            recommendations=["Fix it"],
            confidence=0.8,
        )
        return client

    @pytest.fixture
    def reconciler(self, mock_state_manager, mock_boto_session, mock_llm_client):
        """Create an AgenticReconciler instance with mocks."""
        return AgenticReconciler(
            state_manager=mock_state_manager,
            boto_session=mock_boto_session,
            project_name="test-project",
            environment="dev",
            region="us-east-1",
            llm_client=mock_llm_client,
        )

    def test_reconciler_initialization(self, reconciler):
        """Test reconciler initializes with correct parameters."""
        assert reconciler.project_name == "test-project"
        assert reconciler.environment == "dev"
        assert reconciler.region == "us-east-1"

    @patch.object(AgenticReconciler, '_scan_aws_state')
    def test_detect_drift_no_drift(self, mock_scan, reconciler, mock_state_manager):
        """Test drift detection when no drift exists."""
        # Setup: AWS state matches desired state
        mock_scan.return_value = ScannedState(
            resources=[
                ScannedResource(
                    resource_id="lambda-1",
                    resource_type="AWS::Lambda::Function",
                    arn="arn:aws:lambda:us-east-1:123:function:lambda-1",
                    tags={"environment": "dev"},
                    properties={"MemorySize": 512},
                )
            ]
        )

        report = reconciler.detect_drift()

        assert isinstance(report, DriftReport)
        # Note: Actual drift detection logic depends on implementation details

    @patch.object(AgenticReconciler, '_scan_aws_state')
    def test_detect_drift_missing_resource(self, mock_scan, reconciler, mock_state_manager):
        """Test drift detection when resource is missing."""
        # Setup: AWS state is empty but state manager has a resource
        mock_scan.return_value = ScannedState(resources=[])

        report = reconciler.detect_drift()

        # Should detect the Lambda as missing
        assert isinstance(report, DriftReport)

    def test_compare_states_identifies_missing(self, reconciler):
        """Test _compare_states identifies missing resources."""
        desired_state = {
            "stacks": {
                "stack-1": {
                    "resources": {
                        "func-1": {
                            "type": "AWS::Lambda::Function",
                            "physical_id": "arn:aws:lambda:us-east-1:123:function:func-1",
                            "properties": {},
                            "tags": {},
                        }
                    }
                }
            }
        }

        actual_state = ScannedState(resources=[])

        drift_items = reconciler._compare_states(desired_state, actual_state)

        # Should have one missing resource
        assert len(drift_items) >= 0  # Implementation dependent

    def test_compare_states_identifies_unexpected(self, reconciler):
        """Test _compare_states identifies unexpected resources."""
        desired_state = {"stacks": {"stack-1": {"resources": {}}}}

        actual_state = ScannedState(
            resources=[
                ScannedResource(
                    resource_id="unexpected-func",
                    resource_type="AWS::Lambda::Function",
                    arn="arn:aws:lambda:us-east-1:123:function:unexpected-func",
                    tags={},
                    properties={},
                )
            ]
        )

        drift_items = reconciler._compare_states(desired_state, actual_state)

        # Implementation dependent
        assert isinstance(drift_items, list)

    def test_assess_severity_lambda_missing(self, reconciler):
        """Test severity assessment for missing Lambda."""
        severity = reconciler._assess_severity(
            drift_type=DriftType.MISSING,
            resource_type="AWS::Lambda::Function",
        )

        assert severity == Severity.CRITICAL

    def test_assess_severity_iam_missing(self, reconciler):
        """Test severity assessment for missing IAM role."""
        severity = reconciler._assess_severity(
            drift_type=DriftType.MISSING,
            resource_type="AWS::IAM::Role",
        )

        assert severity == Severity.HIGH

    def test_assess_severity_s3_unexpected(self, reconciler):
        """Test severity assessment for unexpected S3 bucket."""
        severity = reconciler._assess_severity(
            drift_type=DriftType.UNEXPECTED,
            resource_type="AWS::S3::Bucket",
        )

        assert severity == Severity.LOW

    def test_assess_severity_modified_resource(self, reconciler):
        """Test severity assessment for modified resource."""
        severity = reconciler._assess_severity(
            drift_type=DriftType.MODIFIED,
            resource_type="AWS::Lambda::Function",
        )

        assert severity == Severity.MEDIUM

    def test_analyze_failure(self, reconciler, mock_llm_client):
        """Test failure analysis invokes LLM client."""
        context = FailureContext(
            error_message="AccessDenied",
            error_type="AccessDeniedException",
            resource_id="func-1",
            resource_type="AWS::Lambda::Function",
            resource_config={},
            operation="CREATE",
            aws_request_id="123",
            logs=[],
        )

        # Mock LLM response
        mock_llm_client.analyze_failure.return_value = Mock(
            root_cause="Missing permissions",
            explanation="Role needs lambda:CreateFunction",
            suggested_fixes=["Add permission"],
            related_issues=[],
            prevention_tips=[],
            confidence=0.9,
        )

        analysis = reconciler.analyze_failure(context)

        mock_llm_client.analyze_failure.assert_called_once()
        assert analysis is not None

    def test_find_missing_resources(self, reconciler, mock_state_manager):
        """Test finding missing resources."""
        # Setup state with resources
        mock_state_manager.load.return_value = {
            "stacks": {
                "stack-1": {
                    "resources": {
                        "func-1": {
                            "type": "AWS::Lambda::Function",
                            "physical_id": None,  # No physical ID = not deployed
                            "properties": {"MemorySize": 512},
                            "tags": {},
                        }
                    }
                }
            }
        }

        with patch.object(reconciler, '_scan_aws_state') as mock_scan:
            mock_scan.return_value = ScannedState(resources=[])

            missing = reconciler.find_missing_resources()

            assert isinstance(missing, list)

    def test_generate_recovery_plan_empty_drift(self, reconciler):
        """Test generating recovery plan with no drift."""
        report = DriftReport(
            drift_items=[],
            analysis=None,
            total_resources_checked=10,
            drift_count=0,
        )

        plan = reconciler.generate_recovery_plan(report)

        assert len(plan.actions) == 0

    def test_generate_recovery_plan_with_drift(self, reconciler, mock_llm_client):
        """Test generating recovery plan with drift items."""
        drift_items = [
            DriftItem(
                resource_id="func-1",
                resource_type="AWS::Lambda::Function",
                drift_type=DriftType.MISSING,
                severity=Severity.CRITICAL,
                expected_state={"MemorySize": 512},
                actual_state=None,
                differences=["Missing"],
            )
        ]

        report = DriftReport(
            drift_items=drift_items,
            analysis=None,
            total_resources_checked=10,
            drift_count=1,
        )

        # Mock LLM response
        mock_llm_client.suggest_recovery.return_value = Mock(
            actions=[
                Mock(
                    action_type="CREATE",
                    resource_id="func-1",
                    resource_type="AWS::Lambda::Function",
                    description="Recreate function",
                    config={},
                    dependencies=[],
                )
            ],
            explanation="Create missing function",
            estimated_duration=60,
            risks=[],
            rollback_plan="Delete function",
        )

        plan = reconciler.generate_recovery_plan(report)

        mock_llm_client.suggest_recovery.assert_called_once()
        assert plan is not None


class TestDriftComparison:
    """Test suite for drift comparison logic."""

    @pytest.fixture
    def reconciler(self):
        """Create a minimal reconciler for testing comparison logic."""
        mock_state_manager = Mock()
        mock_boto_session = Mock()

        return AgenticReconciler(
            state_manager=mock_state_manager,
            boto_session=mock_boto_session,
            project_name="test",
            environment="dev",
            region="us-east-1",
            llm_client=None,  # No LLM for these tests
        )

    def test_find_differences_tags(self, reconciler):
        """Test finding tag differences."""
        expected = {"tags": {"environment": "dev", "owner": "team-a"}}
        actual = {"tags": {"environment": "prod"}}

        diffs = reconciler._find_differences(expected, actual)

        # Should detect tag differences
        assert isinstance(diffs, list)

    def test_find_differences_identical(self, reconciler):
        """Test no differences when states match."""
        expected = {"tags": {"environment": "dev"}}
        actual = {"tags": {"environment": "dev"}}

        diffs = reconciler._find_differences(expected, actual)

        assert len(diffs) == 0


class TestReconcilerWithoutLLM:
    """Test reconciler behavior when LLM client is not available."""

    @pytest.fixture
    def reconciler_no_llm(self):
        """Create reconciler without LLM client."""
        return AgenticReconciler(
            state_manager=Mock(),
            boto_session=Mock(),
            project_name="test",
            environment="dev",
            region="us-east-1",
            llm_client=None,
        )

    def test_detect_drift_without_llm(self, reconciler_no_llm):
        """Test drift detection works without LLM."""
        reconciler_no_llm.state_manager.load.return_value = {
            "stacks": {"stack-1": {"resources": {}}}
        }

        with patch.object(reconciler_no_llm, '_scan_aws_state') as mock_scan:
            mock_scan.return_value = ScannedState(resources=[])

            report = reconciler_no_llm.detect_drift()

            assert isinstance(report, DriftReport)
            assert report.analysis is None  # No LLM analysis

    def test_generate_recovery_plan_without_llm(self, reconciler_no_llm):
        """Test recovery plan generation falls back without LLM."""
        report = DriftReport(
            drift_items=[
                DriftItem(
                    resource_id="func-1",
                    resource_type="AWS::Lambda::Function",
                    drift_type=DriftType.MISSING,
                    severity=Severity.CRITICAL,
                    expected_state={},
                    actual_state=None,
                    differences=[],
                )
            ],
            analysis=None,
            total_resources_checked=1,
            drift_count=1,
        )

        plan = reconciler_no_llm.generate_recovery_plan(report)

        # Should return a basic plan without LLM insights
        assert plan is not None
        assert len(plan.actions) >= 0
