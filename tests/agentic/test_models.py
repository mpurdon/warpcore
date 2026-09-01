"""Tests for agentic reconciliation data models."""

import pytest
from datetime import datetime

from warpcore.agentic.models import (
    DriftType,
    DriftSeverity,
    DriftItem,
    DriftReport,
    DriftAnalysis,
    FailureContext,
    FailureAnalysis,
    MissingResource,
    RecoveryAction,
    RecoveryPlan,
)


class TestDriftItem:
    """Test suite for DriftItem model."""

    def test_drift_item_creation(self):
        """Test creating a DriftItem."""
        item = DriftItem(
            resource_id="my-function",
            resource_type="AWS::Lambda::Function",
            drift_type=DriftType.MISSING,
            severity=DriftSeverity.CRITICAL,
            expected_state={"MemorySize": 512},
            actual_state=None,
            differences=["Resource not found in AWS"],
        )

        assert item.resource_id == "my-function"
        assert item.drift_type == DriftType.MISSING
        assert item.severity == DriftSeverity.CRITICAL
        assert len(item.differences) == 1

    def test_drift_item_modified(self):
        """Test DriftItem for modified resource."""
        item = DriftItem(
            resource_id="my-function",
            resource_type="AWS::Lambda::Function",
            drift_type=DriftType.MODIFIED,
            severity=DriftSeverity.MEDIUM,
            expected_state={"MemorySize": 512},
            actual_state={"MemorySize": 256},
            differences=["MemorySize: expected 512, got 256"],
        )

        assert item.drift_type == DriftType.MODIFIED
        assert item.severity == DriftSeverity.MEDIUM

    def test_drift_item_unexpected(self):
        """Test DriftItem for unexpected resource."""
        item = DriftItem(
            resource_id="orphan-resource",
            resource_type="AWS::S3::Bucket",
            drift_type=DriftType.UNEXPECTED,
            severity=DriftSeverity.LOW,
            expected_state=None,
            actual_state={"BucketName": "orphan-resource"},
            differences=["Resource exists in AWS but not in state"],
        )

        assert item.drift_type == DriftType.UNEXPECTED
        assert item.severity == DriftSeverity.LOW


class TestDriftReport:
    """Test suite for DriftReport model."""

    def test_empty_drift_report(self):
        """Test empty DriftReport."""
        report = DriftReport(
            drift_items=[],
            analysis=None,
            total_resources_checked=10,
            drift_count=0,
        )

        assert not report.has_drift()
        assert report.total_resources_checked == 10
        assert len(report.drift_items) == 0

    def test_drift_report_with_items(self):
        """Test DriftReport with drift items."""
        items = [
            DriftItem(
                resource_id="func-1",
                resource_type="AWS::Lambda::Function",
                drift_type=DriftType.MISSING,
                severity=DriftSeverity.CRITICAL,
                expected_state={},
                actual_state=None,
                differences=[],
            ),
            DriftItem(
                resource_id="func-2",
                resource_type="AWS::Lambda::Function",
                drift_type=DriftType.MODIFIED,
                severity=DriftSeverity.MEDIUM,
                expected_state={},
                actual_state={},
                differences=[],
            ),
        ]

        report = DriftReport(
            drift_items=items,
            analysis=None,
            total_resources_checked=10,
            drift_count=2,
        )

        assert report.has_drift()
        assert len(report.drift_items) == 2

    def test_drift_report_get_critical(self):
        """Test filtering critical drift items."""
        items = [
            DriftItem(
                resource_id="critical-1",
                resource_type="AWS::Lambda::Function",
                drift_type=DriftType.MISSING,
                severity=DriftSeverity.CRITICAL,
                expected_state={},
                actual_state=None,
                differences=[],
            ),
            DriftItem(
                resource_id="low-1",
                resource_type="AWS::S3::Bucket",
                drift_type=DriftType.UNEXPECTED,
                severity=DriftSeverity.LOW,
                expected_state=None,
                actual_state={},
                differences=[],
            ),
        ]

        report = DriftReport(
            drift_items=items,
            analysis=None,
            total_resources_checked=10,
            drift_count=2,
        )

        critical = report.get_critical_drift()
        assert len(critical) == 1
        assert critical[0].resource_id == "critical-1"

    def test_drift_report_get_by_type(self):
        """Test filtering drift items by type."""
        items = [
            DriftItem(
                resource_id="missing-1",
                resource_type="AWS::Lambda::Function",
                drift_type=DriftType.MISSING,
                severity=DriftSeverity.CRITICAL,
                expected_state={},
                actual_state=None,
                differences=[],
            ),
            DriftItem(
                resource_id="modified-1",
                resource_type="AWS::Lambda::Function",
                drift_type=DriftType.MODIFIED,
                severity=DriftSeverity.MEDIUM,
                expected_state={},
                actual_state={},
                differences=[],
            ),
            DriftItem(
                resource_id="missing-2",
                resource_type="AWS::IAM::Role",
                drift_type=DriftType.MISSING,
                severity=DriftSeverity.HIGH,
                expected_state={},
                actual_state=None,
                differences=[],
            ),
        ]

        report = DriftReport(
            drift_items=items,
            analysis=None,
            total_resources_checked=10,
            drift_count=3,
        )

        missing = report.get_by_type(DriftType.MISSING)
        assert len(missing) == 2

        modified = report.get_by_type(DriftType.MODIFIED)
        assert len(modified) == 1


class TestDriftAnalysis:
    """Test suite for DriftAnalysis model."""

    def test_drift_analysis_creation(self):
        """Test creating a DriftAnalysis."""
        analysis = DriftAnalysis(
            summary="Found 3 drift items requiring attention",
            root_cause="Manual changes made directly in AWS console",
            impact="Application may have inconsistent behavior",
            recommendations=["Run reconciliation", "Update state file"],
            confidence=0.85,
        )

        assert "3 drift items" in analysis.summary
        assert analysis.confidence == 0.85
        assert len(analysis.recommendations) == 2


class TestFailureContext:
    """Test suite for FailureContext model."""

    def test_failure_context_creation(self):
        """Test creating a FailureContext."""
        context = FailureContext(
            error_message="AccessDenied: User not authorized to perform lambda:CreateFunction",
            error_type="AccessDeniedException",
            resource_id="my-function",
            resource_type="AWS::Lambda::Function",
            resource_config={"MemorySize": 512, "Runtime": "python3.11"},
            operation="CREATE",
            aws_request_id="abc-123",
            logs=["Starting deployment", "Creating function...", "Access denied"],
        )

        assert "AccessDenied" in context.error_message
        assert context.error_type == "AccessDeniedException"
        assert context.operation == "CREATE"
        assert len(context.logs) == 3


class TestFailureAnalysis:
    """Test suite for FailureAnalysis model."""

    def test_failure_analysis_creation(self):
        """Test creating a FailureAnalysis."""
        analysis = FailureAnalysis(
            root_cause="Missing IAM permissions for Lambda creation",
            explanation="The IAM role used for deployment doesn't have lambda:CreateFunction permission",
            suggested_fixes=[
                "Add lambda:CreateFunction to the deployment role",
                "Use an admin role temporarily"
            ],
            related_issues=["IAM role may also be missing logs:CreateLogGroup"],
            prevention_tips=["Use IAM Access Analyzer to verify permissions before deployment"],
            confidence=0.92,
        )

        assert "IAM permissions" in analysis.root_cause
        assert analysis.confidence == 0.92
        assert len(analysis.suggested_fixes) == 2


class TestMissingResource:
    """Test suite for MissingResource model."""

    def test_missing_resource_creation(self):
        """Test creating a MissingResource."""
        resource = MissingResource(
            resource_id="my-function",
            resource_type="AWS::Lambda::Function",
            expected_config={"MemorySize": 512},
            dependencies=["execution-role", "log-group"],
            priority=1,
            impact="API will return 500 errors without this function",
            reason="Resource was deleted manually in AWS console",
        )

        assert resource.resource_id == "my-function"
        assert resource.priority == 1
        assert len(resource.dependencies) == 2


class TestRecoveryAction:
    """Test suite for RecoveryAction model."""

    def test_recovery_action_create(self):
        """Test creating a CREATE recovery action."""
        action = RecoveryAction(
            action_type="CREATE",
            resource_id="my-function",
            resource_type="AWS::Lambda::Function",
            description="Recreate Lambda function with original configuration",
            config={"MemorySize": 512, "Runtime": "python3.11"},
            dependencies=["execution-role"],
        )

        assert action.action_type == "CREATE"
        assert action.resource_id == "my-function"
        assert len(action.dependencies) == 1

    def test_recovery_action_update(self):
        """Test creating an UPDATE recovery action."""
        action = RecoveryAction(
            action_type="UPDATE",
            resource_id="my-function",
            resource_type="AWS::Lambda::Function",
            description="Update Lambda memory configuration",
            config={"MemorySize": 1024},
            dependencies=[],
        )

        assert action.action_type == "UPDATE"

    def test_recovery_action_delete(self):
        """Test creating a DELETE recovery action."""
        action = RecoveryAction(
            action_type="DELETE",
            resource_id="orphan-bucket",
            resource_type="AWS::S3::Bucket",
            description="Remove unexpected bucket not in state",
            config=None,
            dependencies=[],
        )

        assert action.action_type == "DELETE"


class TestRecoveryPlan:
    """Test suite for RecoveryPlan model."""

    def test_recovery_plan_creation(self):
        """Test creating a RecoveryPlan."""
        actions = [
            RecoveryAction(
                action_type="CREATE",
                resource_id="role-1",
                resource_type="AWS::IAM::Role",
                description="Create IAM role first",
                config={},
                dependencies=[],
            ),
            RecoveryAction(
                action_type="CREATE",
                resource_id="func-1",
                resource_type="AWS::Lambda::Function",
                description="Create Lambda function",
                config={},
                dependencies=["role-1"],
            ),
        ]

        plan = RecoveryPlan(
            actions=actions,
            explanation="Create role first, then Lambda function that depends on it",
            estimated_duration=120,
            risks=["IAM propagation delay may cause temporary failures"],
            rollback_plan="Delete Lambda function first, then IAM role",
        )

        assert len(plan.actions) == 2
        assert plan.estimated_duration == 120
        assert len(plan.risks) == 1

    def test_recovery_plan_empty(self):
        """Test empty RecoveryPlan."""
        plan = RecoveryPlan(
            actions=[],
            explanation="No recovery actions needed",
            estimated_duration=0,
            risks=[],
            rollback_plan="N/A",
        )

        assert len(plan.actions) == 0
        assert plan.estimated_duration == 0
