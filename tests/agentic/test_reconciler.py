"""Tests for the agentic reconciler.

Rewritten against the real API. The previous version imported a
`ScannedResource` class that has never existed and built
`ScannedState(resources=[...])` as a list; the real ScannedState is keyed on
physical id and holds warpcore.state.models Resource objects.

The LLM client is stubbed throughout: drift detection is deterministic and its
correctness must not depend on a model.
"""

from unittest.mock import Mock

import pytest

from warpcore.agentic.models import (
    DriftAnalysis,
    DriftItem,
    DriftReport,
    DriftSeverity,
    DriftType,
    FailureAnalysis,
    RecoveryPlan,
)
from warpcore.agentic.reconciler import AgenticReconciler
from warpcore.agentic.scanner import ScannedState
from warpcore.state.models import Resource, Stack, State
from warpcore.utils.errors import DeploymentError, ErrorContext

LAMBDA = "AWS::Lambda::Function"
LAMBDA_ARN = "arn:aws:lambda:us-east-1:123456789012:function:func-1"


def resource(resource_id="func-1", resource_type=LAMBDA, physical_id=LAMBDA_ARN, **kw):
    return Resource(id=resource_id, type=resource_type, physical_id=physical_id, **kw)


def state_with(*resources, stack="app") -> State:
    state = State(environment="dev", region="us-east-1",
                  account="123456789012", project_name="demo")
    state.stacks[stack] = Stack(name=stack)
    for r in resources:
        state.add_resource(stack, r)
    return state


def scanned_with(*resources) -> ScannedState:
    scanned = ScannedState()
    for r in resources:
        scanned.add_resource(r)
    return scanned


@pytest.fixture
def llm_client():
    """A stubbed LLM client. Drift detection must not depend on a model."""
    client = Mock()
    client.analyze_drift.return_value = DriftAnalysis(
        summary="stub", impact="stub", recommendations=[], confidence=0.5
    )
    client.analyze_failure.return_value = FailureAnalysis(
        root_cause="stub", explanation="stub", suggested_fixes=["fix"], confidence=0.5
    )
    client.suggest_recovery.return_value = RecoveryPlan(actions=[], explanation="stub")
    client.prioritize_missing_resources.side_effect = lambda missing: missing
    return client


@pytest.fixture
def state_manager():
    return Mock()


@pytest.fixture
def reconciler(state_manager, llm_client):
    return AgenticReconciler(
        state_manager=state_manager,
        boto_session=Mock(),
        project_name="test-project",
        environment="dev",
        region="us-east-1",
        llm_client=llm_client,
    )


class TestInitialization:
    def test_stores_its_scope(self, reconciler):
        assert reconciler.project_name == "test-project"
        assert reconciler.environment == "dev"
        assert reconciler.region == "us-east-1"

    def test_builds_a_scanner_with_the_same_scope(self, reconciler):
        assert reconciler.aws_scanner.project_name == "test-project"
        assert reconciler.aws_scanner.environment == "dev"

    def test_injected_llm_client_is_used(self, reconciler, llm_client):
        assert reconciler.llm_client is llm_client


class TestCompareStates:
    def test_resource_in_state_but_not_aws_is_missing(self, reconciler):
        drift = reconciler._compare_states(state_with(resource()), scanned_with())
        missing = [d for d in drift if d.drift_type is DriftType.MISSING]
        assert len(missing) == 1
        assert missing[0].resource_id == "func-1"
        assert missing[0].physical_id == LAMBDA_ARN

    def test_resource_in_aws_but_not_state_is_unexpected(self, reconciler):
        drift = reconciler._compare_states(state_with(), scanned_with(resource()))
        unexpected = [d for d in drift if d.drift_type is DriftType.UNEXPECTED]
        assert len(unexpected) == 1
        assert unexpected[0].severity is DriftSeverity.LOW

    def test_matching_resource_produces_no_drift(self, reconciler):
        same = resource(tags={"env": "dev"})
        drift = reconciler._compare_states(state_with(same), scanned_with(same))
        assert drift == []

    def test_differing_tags_are_reported_as_modified(self, reconciler):
        desired = resource(tags={"env": "dev", "team": "platform"})
        actual = resource(tags={"env": "prod"})
        drift = reconciler._compare_states(state_with(desired), scanned_with(actual))

        modified = [d for d in drift if d.drift_type is DriftType.MODIFIED]
        assert len(modified) == 1
        assert any("team" in d for d in modified[0].differences)
        assert any("env" in d for d in modified[0].differences)

    def test_missing_dependency_orphans_the_dependent(self, reconciler):
        role = resource("role-1", "AWS::IAM::Role", "arn:aws:iam::1:role/role-1")
        func = resource(dependencies=["role-1"])
        # Only the function exists in AWS; its role does not.
        drift = reconciler._compare_states(
            state_with(func, role), scanned_with(func)
        )
        orphaned = [d for d in drift if d.drift_type is DriftType.ORPHANED]
        assert len(orphaned) == 1
        assert orphaned[0].resource_id == "func-1"
        assert orphaned[0].severity is DriftSeverity.HIGH

    def test_resources_without_a_physical_id_are_skipped(self, reconciler):
        """Never-deployed resources cannot have drifted."""
        never_deployed = resource(physical_id=None)
        assert reconciler._compare_states(state_with(never_deployed), scanned_with()) == []


class TestAssessSeverity:
    @pytest.mark.parametrize("resource_type,expected", [
        (LAMBDA, DriftSeverity.CRITICAL),
        ("AWS::ApiGateway::RestApi", DriftSeverity.CRITICAL),
        ("AWS::IAM::Role", DriftSeverity.HIGH),
        ("AWS::EC2::VPC", DriftSeverity.HIGH),
        ("AWS::S3::Bucket", DriftSeverity.MEDIUM),
    ])
    def test_missing_severity_depends_on_how_core_the_resource_is(
        self, reconciler, resource_type, expected
    ):
        assert reconciler._assess_severity(
            resource(resource_type=resource_type), DriftType.MISSING
        ) is expected

    @pytest.mark.parametrize("drift_type,expected", [
        (DriftType.ORPHANED, DriftSeverity.HIGH),
        (DriftType.MODIFIED, DriftSeverity.MEDIUM),
        (DriftType.UNEXPECTED, DriftSeverity.LOW),
    ])
    def test_severity_by_drift_type(self, reconciler, drift_type, expected):
        assert reconciler._assess_severity(resource(), drift_type) is expected


class TestFindDifferences:
    def test_identical_resources_differ_in_nothing(self, reconciler):
        same = resource(tags={"a": "1"})
        assert reconciler._find_differences(same, same) == []

    def test_reports_missing_extra_and_changed_tags(self, reconciler):
        desired = resource(tags={"keep": "1", "gone": "2", "changed": "before"})
        actual = resource(tags={"keep": "1", "added": "3", "changed": "after"})
        differences = reconciler._find_differences(desired, actual)
        joined = " ".join(differences)
        assert "gone" in joined
        assert "added" in joined
        assert "changed" in joined


class TestDetectDrift:
    def test_no_drift_produces_an_empty_report(self, reconciler, state_manager, llm_client):
        same = resource()
        state_manager.load.return_value = state_with(same)
        reconciler.aws_scanner.scan_resources = Mock(return_value=scanned_with(same))

        report = reconciler.detect_drift()

        assert isinstance(report, DriftReport)
        assert not report.has_drift()
        assert report.drift_count == 0

    def test_no_drift_does_not_call_the_llm(self, reconciler, state_manager, llm_client):
        same = resource()
        state_manager.load.return_value = state_with(same)
        reconciler.aws_scanner.scan_resources = Mock(return_value=scanned_with(same))

        reconciler.detect_drift()
        llm_client.analyze_drift.assert_not_called()

    def test_drift_is_reported_and_analysed(self, reconciler, state_manager, llm_client):
        state_manager.load.return_value = state_with(resource())
        reconciler.aws_scanner.scan_resources = Mock(return_value=scanned_with())

        report = reconciler.detect_drift()

        assert report.has_drift()
        assert report.drift_count >= 1
        llm_client.analyze_drift.assert_called_once()
        assert report.analysis is not None

    def test_report_counts_resources_from_both_sides(self, reconciler, state_manager):
        state_manager.load.return_value = state_with(resource())
        reconciler.aws_scanner.scan_resources = Mock(return_value=scanned_with(resource()))

        assert reconciler.detect_drift().total_resources_checked == 2

    def test_critical_drift_is_retrievable(self, reconciler, state_manager):
        state_manager.load.return_value = state_with(resource())
        reconciler.aws_scanner.scan_resources = Mock(return_value=scanned_with())

        report = reconciler.detect_drift()
        assert report.get_critical_drift(), "a missing Lambda is critical"


class TestAnalyzeFailure:
    def test_builds_context_from_the_error(self, reconciler, llm_client):
        error = DeploymentError(
            message="AccessDenied: not authorized",
            context=ErrorContext(
                resource_id="func-1",
                resource_type=LAMBDA,
                operation="CREATE",
            ),
        )
        analysis = reconciler.analyze_failure(error)

        assert isinstance(analysis, FailureAnalysis)
        context = llm_client.analyze_failure.call_args.args[0]
        assert context.error_message == "AccessDenied: not authorized"
        assert context.resource_id == "func-1"
        assert context.operation == "CREATE"

    def test_error_without_context_still_analyses(self, reconciler, llm_client):
        analysis = reconciler.analyze_failure(DeploymentError(message="boom"))
        assert isinstance(analysis, FailureAnalysis)
        context = llm_client.analyze_failure.call_args.args[0]
        assert context.resource_id is None


class TestFindMissingResources:
    def test_returns_resources_absent_from_aws(self, reconciler, state_manager):
        state_manager.load.return_value = state_with(resource())
        reconciler.aws_scanner.scan_resources = Mock(return_value=scanned_with())

        missing = reconciler.find_missing_resources()
        assert [m.resource_id for m in missing] == ["func-1"]

    def test_returns_nothing_when_everything_exists(self, reconciler, state_manager):
        same = resource()
        state_manager.load.return_value = state_with(same)
        reconciler.aws_scanner.scan_resources = Mock(return_value=scanned_with(same))

        assert reconciler.find_missing_resources() == []

    def test_nothing_missing_does_not_call_the_llm(self, reconciler, state_manager, llm_client):
        same = resource()
        state_manager.load.return_value = state_with(same)
        reconciler.aws_scanner.scan_resources = Mock(return_value=scanned_with(same))

        reconciler.find_missing_resources()
        llm_client.prioritize_missing_resources.assert_not_called()

    def test_missing_resources_are_sent_for_prioritisation(
        self, reconciler, state_manager, llm_client
    ):
        state_manager.load.return_value = state_with(resource())
        reconciler.aws_scanner.scan_resources = Mock(return_value=scanned_with())

        reconciler.find_missing_resources()
        llm_client.prioritize_missing_resources.assert_called_once()

    def test_carries_the_expected_configuration_across(self, reconciler, state_manager):
        state_manager.load.return_value = state_with(
            resource(properties={"MemorySize": 512}, dependencies=["role-1"])
        )
        reconciler.aws_scanner.scan_resources = Mock(return_value=scanned_with())

        missing = reconciler.find_missing_resources()[0]
        assert missing.expected_config == {"MemorySize": 512}
        assert missing.dependencies == ["role-1"]


class TestGenerateRecoveryPlan:
    def test_empty_drift_needs_no_recovery(self, reconciler, llm_client):
        report = DriftReport(drift_items=[], total_resources_checked=1, drift_count=0)
        plan = reconciler.generate_recovery_plan(report)

        assert plan.get_action_count() == 0
        assert "No drift" in plan.explanation
        llm_client.suggest_recovery.assert_not_called()

    def test_drift_is_sent_to_the_llm(self, reconciler, llm_client):
        item = DriftItem(
            resource_id="func-1", resource_type=LAMBDA,
            drift_type=DriftType.MISSING, severity=DriftSeverity.CRITICAL,
            differences=["gone"],
        )
        report = DriftReport(drift_items=[item], total_resources_checked=1, drift_count=1)

        plan = reconciler.generate_recovery_plan(report)

        assert isinstance(plan, RecoveryPlan)
        llm_client.suggest_recovery.assert_called_once_with([item])
