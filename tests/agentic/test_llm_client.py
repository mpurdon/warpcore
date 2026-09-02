"""Tests for the LLM client.

Rewritten against the real API. The previous version asserted a client that
never existed: it patched a module-level `openai` attribute (the import happens
inside _initialize_client), and called _call_openai, _build_drift_prompt and
_build_failure_prompt, none of which are defined.

The mocks here stand in for the provider SDK object rather than the module, so
_call_llm and the response parsers are exercised for real.
"""

import json
from unittest.mock import Mock, patch

import pytest

from warpcore.agentic.llm_client import LLMClient, LLMProvider
from warpcore.agentic.models import (
    DriftAnalysis,
    DriftItem,
    DriftSeverity,
    DriftType,
    FailureAnalysis,
    FailureContext,
    MissingResource,
    RecoveryPlan,
)


def openai_stub(payload) -> Mock:
    """A stand-in for the openai SDK client, shaped as _call_llm expects."""
    content = payload if isinstance(payload, str) else json.dumps(payload)
    stub = Mock()
    stub.chat.completions.create.return_value = Mock(
        choices=[Mock(message=Mock(content=content))]
    )
    return stub


def make_client(payload=None, provider: LLMProvider = LLMProvider.OPENAI) -> LLMClient:
    """Build a client whose provider SDK is a stub.

    _initialize_client imports the provider package lazily and returns None when
    it is absent, so the stub is attached afterwards.
    """
    with patch.dict("os.environ", {"OPENAI_API_KEY": "test-key"}):
        client = LLMClient(provider=provider)
    client.client = openai_stub(payload) if payload is not None else None
    return client


def drift_item(**overrides) -> DriftItem:
    defaults = dict(
        resource_id="func-1",
        resource_type="AWS::Lambda::Function",
        drift_type=DriftType.MISSING,
        severity=DriftSeverity.CRITICAL,
        expected_state={"MemorySize": 512},
        actual_state=None,
        differences=["Resource not found"],
    )
    defaults.update(overrides)
    return DriftItem(**defaults)


def failure_context(**overrides) -> FailureContext:
    defaults = dict(
        error_message="AccessDenied: User not authorized",
        error_type="AccessDeniedException",
        resource_id="func-1",
        resource_type="AWS::Lambda::Function",
        resource_config={"MemorySize": 512},
        operation="CREATE",
        aws_request_id="123",
        logs=["Starting deployment", "Error occurred"],
    )
    defaults.update(overrides)
    return FailureContext(**defaults)


class TestLLMProvider:
    def test_provider_values(self):
        assert LLMProvider.OPENAI.value == "openai"
        assert LLMProvider.ANTHROPIC.value == "anthropic"
        assert LLMProvider.BEDROCK.value == "bedrock"
        assert LLMProvider.LOCAL.value == "local"


class TestInitialization:
    def test_openai(self):
        with patch.dict("os.environ", {"OPENAI_API_KEY": "test-key"}):
            client = LLMClient(provider=LLMProvider.OPENAI)
        assert client.provider is LLMProvider.OPENAI
        assert client.api_key == "test-key"

    def test_anthropic(self):
        with patch.dict("os.environ", {"ANTHROPIC_API_KEY": "test-key"}):
            client = LLMClient(provider=LLMProvider.ANTHROPIC)
        assert client.provider is LLMProvider.ANTHROPIC

    def test_bedrock_uses_aws_credentials_not_an_api_key(self):
        """Bedrock takes no api_key; the client comes from boto3."""
        with patch("boto3.client") as boto_client:
            client = LLMClient(provider=LLMProvider.BEDROCK)
        assert client.provider is LLMProvider.BEDROCK
        assert client.api_key is None
        boto_client.assert_called_once_with("bedrock-runtime")

    def test_custom_model_overrides_the_default(self):
        with patch.dict("os.environ", {"OPENAI_API_KEY": "test-key"}):
            client = LLMClient(provider=LLMProvider.OPENAI, model="gpt-4-turbo")
        assert client.model == "gpt-4-turbo"

    @pytest.mark.parametrize("provider,expected", [
        (LLMProvider.OPENAI, "gpt-4"),
        (LLMProvider.ANTHROPIC, "claude-3-sonnet-20240229"),
        (LLMProvider.LOCAL, "llama2"),
    ])
    def test_default_model_per_provider(self, provider, expected):
        with patch.dict("os.environ", {"OPENAI_API_KEY": "k", "ANTHROPIC_API_KEY": "k"}):
            assert LLMClient(provider=provider).model == expected

    def test_missing_api_key_leaves_no_client(self):
        """Without a key the client is None, which is what triggers fallbacks."""
        with patch.dict("os.environ", {}, clear=True):
            assert LLMClient(provider=LLMProvider.OPENAI).client is None


class TestAnalyzeDrift:
    PAYLOAD = {
        "summary": "One Lambda function is missing",
        "root_cause": "Manual deletion in the console",
        "impact": "API endpoint returns 502",
        "recommendations": ["Redeploy the function", "Enable CloudTrail alerting"],
        "confidence": 0.85,
    }

    def test_parses_the_llm_response(self):
        analysis = make_client(self.PAYLOAD).analyze_drift([drift_item()])
        assert isinstance(analysis, DriftAnalysis)
        assert analysis.summary == "One Lambda function is missing"
        assert analysis.root_cause == "Manual deletion in the console"
        assert analysis.recommendations == [
            "Redeploy the function", "Enable CloudTrail alerting"
        ]
        assert analysis.confidence == pytest.approx(0.85)

    def test_sends_the_drift_to_the_model(self):
        client = make_client(self.PAYLOAD)
        client.analyze_drift([drift_item()])

        prompt = client.client.chat.completions.create.call_args.kwargs["messages"][1]["content"]
        assert "func-1" in prompt
        assert "missing" in prompt

    def test_empty_drift_does_not_call_the_model(self):
        client = make_client(self.PAYLOAD)
        analysis = client.analyze_drift([])

        client.client.chat.completions.create.assert_not_called()
        assert analysis.summary == "No drift detected"
        assert analysis.confidence == 1.0

    def test_malformed_json_falls_back(self):
        analysis = make_client("this is not json").analyze_drift([drift_item()])
        assert analysis.confidence == 0.0
        assert "parse" in analysis.summary.lower()

    def test_valid_json_of_the_wrong_shape_falls_back(self):
        """An LLM returning an array where an object was asked for."""
        analysis = make_client(["not", "an", "object"]).analyze_drift([drift_item()])
        assert isinstance(analysis, DriftAnalysis)
        assert analysis.confidence == 0.0


class TestAnalyzeFailure:
    PAYLOAD = {
        "root_cause": "Missing IAM permissions",
        "explanation": "The execution role lacks lambda:CreateFunction",
        "suggested_fixes": ["Attach lambda:CreateFunction to the role"],
        "related_issues": [],
        "prevention_tips": ["Use IAM Access Analyzer"],
        "confidence": 0.9,
    }

    def test_parses_the_llm_response(self):
        analysis = make_client(self.PAYLOAD).analyze_failure(failure_context())
        assert isinstance(analysis, FailureAnalysis)
        assert analysis.root_cause == "Missing IAM permissions"
        assert analysis.suggested_fixes == ["Attach lambda:CreateFunction to the role"]
        assert analysis.confidence == pytest.approx(0.9)

    def test_sends_the_error_details_to_the_model(self):
        client = make_client(self.PAYLOAD)
        client.analyze_failure(failure_context())

        prompt = client.client.chat.completions.create.call_args.kwargs["messages"][1]["content"]
        assert "AccessDenied" in prompt
        assert "func-1" in prompt
        assert "CREATE" in prompt

    def test_malformed_json_falls_back(self):
        analysis = make_client("nope").analyze_failure(failure_context())
        assert analysis.confidence == 0.0


class TestPrioritizeMissingResources:
    def _resources(self):
        return [
            MissingResource(
                resource_id="func-1", resource_type="AWS::Lambda::Function",
                expected_config={}, dependencies=[], priority=5, impact="Unknown",
            ),
            MissingResource(
                resource_id="role-1", resource_type="AWS::IAM::Role",
                expected_config={}, dependencies=[], priority=5, impact="Unknown",
            ),
        ]

    def test_applies_and_sorts_by_llm_priority(self):
        # _parse_prioritization expects a bare JSON array.
        client = make_client([
            {"resource_id": "func-1", "priority": 7, "impact": "API degraded",
             "reason": "Fronted by API Gateway"},
            {"resource_id": "role-1", "priority": 2, "impact": "Blocks the function",
             "reason": "Function cannot be created without it"},
        ])
        prioritized = client.prioritize_missing_resources(self._resources())

        assert [r.resource_id for r in prioritized] == ["role-1", "func-1"]
        assert prioritized[0].priority == 2
        assert prioritized[0].reason == "Function cannot be created without it"

    def test_empty_input_short_circuits(self):
        client = make_client([])
        assert client.prioritize_missing_resources([]) == []
        client.client.chat.completions.create.assert_not_called()

    def test_wrong_shape_returns_the_input_unchanged(self):
        """An object where an array was asked for used to raise TypeError."""
        client = make_client({"prioritized_resources": []})
        resources = self._resources()
        result = client.prioritize_missing_resources(resources)
        assert [r.resource_id for r in result] == ["func-1", "role-1"]

    def test_no_client_returns_the_input_unchanged(self):
        client = make_client(None)
        resources = self._resources()
        assert client.prioritize_missing_resources(resources) == resources


class TestSuggestRecovery:
    PAYLOAD = {
        "actions": [
            {
                "action_type": "create",
                "resource_id": "func-1",
                "resource_type": "AWS::Lambda::Function",
                "configuration": {"MemorySize": 512},
                "dependencies": ["role-1"],
                "rationale": "Function was deleted outside warpcore",
            }
        ],
        "explanation": "Recreate the missing function",
        "estimated_duration": 60,
        "risks": ["Brief downtime during creation"],
        "rollback_plan": "Delete the recreated function",
    }

    def test_parses_actions(self):
        plan = make_client(self.PAYLOAD).suggest_recovery([drift_item()])
        assert isinstance(plan, RecoveryPlan)
        assert plan.get_action_count() == 1

        action = plan.actions[0]
        assert action.action_type == "create"
        assert action.configuration == {"MemorySize": 512}
        assert action.rationale == "Function was deleted outside warpcore"
        assert action.dependencies == ["role-1"]

    def test_parses_plan_metadata(self):
        plan = make_client(self.PAYLOAD).suggest_recovery([drift_item()])
        assert plan.estimated_duration == 60
        assert plan.risks == ["Brief downtime during creation"]
        assert plan.rollback_plan == "Delete the recreated function"

    def test_empty_drift_does_not_call_the_model(self):
        client = make_client(self.PAYLOAD)
        plan = client.suggest_recovery([])
        client.client.chat.completions.create.assert_not_called()
        assert plan.get_action_count() == 0

    def test_malformed_json_falls_back_to_an_empty_plan(self):
        plan = make_client("nope").suggest_recovery([drift_item()])
        assert plan.get_action_count() == 0
        assert plan.risks


class TestFallbackWhenTheModelIsUnavailable:
    def test_no_client_falls_back_for_drift(self):
        analysis = make_client(None).analyze_drift([drift_item()])
        assert isinstance(analysis, DriftAnalysis)
        assert analysis.confidence == 0.0
        assert "1 drift" in analysis.summary

    def test_no_client_falls_back_for_failure(self):
        analysis = make_client(None).analyze_failure(failure_context())
        assert analysis.confidence == 0.0
        assert analysis.root_cause == "AccessDeniedException"
        assert analysis.explanation == "AccessDenied: User not authorized"

    def test_no_client_falls_back_for_recovery(self):
        plan = make_client(None).suggest_recovery([drift_item()])
        assert plan.get_action_count() == 0
        assert "manual" in plan.explanation.lower()

    def test_a_raising_sdk_falls_back_rather_than_propagating(self):
        client = make_client({})
        client.client.chat.completions.create.side_effect = Exception("API Error")

        analysis = client.analyze_drift([drift_item()])
        assert isinstance(analysis, DriftAnalysis)
        assert analysis.confidence == 0.0

    def test_a_raising_sdk_falls_back_for_failure_analysis(self):
        client = make_client({})
        client.client.chat.completions.create.side_effect = Exception("API Error")

        analysis = client.analyze_failure(failure_context())
        assert isinstance(analysis, FailureAnalysis)
        assert analysis.confidence == 0.0


class TestPromptConstruction:
    def test_drift_prompt_includes_the_resource_and_drift_type(self):
        prompt = make_client(None)._build_drift_analysis_prompt([drift_item()])
        assert "func-1" in prompt
        assert "Lambda" in prompt
        assert "missing" in prompt
        assert "Resource not found" in prompt

    def test_failure_prompt_includes_the_error_and_operation(self):
        prompt = make_client(None)._build_failure_analysis_prompt(failure_context())
        assert "AccessDenied" in prompt
        assert "func-1" in prompt
        assert "CREATE" in prompt

    def test_failure_prompt_tolerates_absent_logs_and_config(self):
        prompt = make_client(None)._build_failure_analysis_prompt(
            failure_context(logs=[], resource_config=None)
        )
        assert "No logs available" in prompt
        assert "Not available" in prompt

    def test_recovery_prompt_lists_every_drift_item(self):
        items = [drift_item(resource_id="a"), drift_item(resource_id="b")]
        prompt = make_client(None)._build_recovery_prompt(items)
        assert "a" in prompt and "b" in prompt

    def test_prioritization_prompt_includes_impact(self):
        resource = MissingResource(
            resource_id="func-1", resource_type="AWS::Lambda::Function",
            expected_config={}, dependencies=[], priority=5,
            impact="API endpoint is down",
        )
        prompt = make_client(None)._build_prioritization_prompt([resource])
        assert "func-1" in prompt
        assert "API endpoint is down" in prompt
