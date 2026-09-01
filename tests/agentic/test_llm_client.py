"""Tests for the LLM Client component."""

import pytest
from unittest.mock import Mock, MagicMock, patch
import json

from warpcore.agentic.llm_client import LLMClient, LLMProvider
from warpcore.agentic.models import (
    DriftType,
    Severity,
    DriftItem,
    DriftAnalysis,
    FailureContext,
    FailureAnalysis,
    MissingResource,
    RecoveryPlan,
)


class TestLLMProvider:
    """Test suite for LLMProvider enum."""

    def test_provider_values(self):
        """Test LLMProvider enum values exist."""
        assert LLMProvider.OPENAI is not None
        assert LLMProvider.ANTHROPIC is not None
        assert LLMProvider.BEDROCK is not None
        assert LLMProvider.LOCAL is not None


class TestLLMClientInitialization:
    """Test suite for LLMClient initialization."""

    def test_init_with_openai(self):
        """Test initializing with OpenAI provider."""
        with patch.dict('os.environ', {'OPENAI_API_KEY': 'test-key'}):
            client = LLMClient(provider=LLMProvider.OPENAI)
            assert client.provider == LLMProvider.OPENAI

    def test_init_with_anthropic(self):
        """Test initializing with Anthropic provider."""
        with patch.dict('os.environ', {'ANTHROPIC_API_KEY': 'test-key'}):
            client = LLMClient(provider=LLMProvider.ANTHROPIC)
            assert client.provider == LLMProvider.ANTHROPIC

    def test_init_with_bedrock(self):
        """Test initializing with Bedrock provider."""
        mock_session = Mock()
        client = LLMClient(provider=LLMProvider.BEDROCK, boto_session=mock_session)
        assert client.provider == LLMProvider.BEDROCK

    def test_init_with_custom_model(self):
        """Test initializing with custom model."""
        with patch.dict('os.environ', {'OPENAI_API_KEY': 'test-key'}):
            client = LLMClient(provider=LLMProvider.OPENAI, model="gpt-4-turbo")
            assert client.model == "gpt-4-turbo"


class TestLLMClientAnalyzeDrift:
    """Test suite for LLMClient.analyze_drift."""

    @pytest.fixture
    def mock_openai_client(self):
        """Create a mock OpenAI client."""
        with patch('warpcore.agentic.llm_client.openai') as mock:
            mock_response = Mock()
            mock_response.choices = [
                Mock(
                    message=Mock(
                        content=json.dumps({
                            "summary": "Test summary",
                            "root_cause": "Test root cause",
                            "impact": "Test impact",
                            "recommendations": ["Fix 1", "Fix 2"],
                            "confidence": 0.85
                        })
                    )
                )
            ]
            mock.OpenAI.return_value.chat.completions.create.return_value = mock_response
            yield mock

    @pytest.fixture
    def client(self, mock_openai_client):
        """Create an LLMClient with mocked OpenAI."""
        with patch.dict('os.environ', {'OPENAI_API_KEY': 'test-key'}):
            return LLMClient(provider=LLMProvider.OPENAI)

    def test_analyze_drift_returns_analysis(self, client):
        """Test analyze_drift returns DriftAnalysis."""
        drift_items = [
            DriftItem(
                resource_id="func-1",
                resource_type="AWS::Lambda::Function",
                drift_type=DriftType.MISSING,
                severity=Severity.CRITICAL,
                expected_state={},
                actual_state=None,
                differences=["Missing"],
            )
        ]

        analysis = client.analyze_drift(drift_items)

        assert isinstance(analysis, DriftAnalysis)
        assert analysis.confidence >= 0
        assert analysis.confidence <= 1

    def test_analyze_drift_empty_items(self, client):
        """Test analyze_drift with empty drift items."""
        analysis = client.analyze_drift([])

        assert isinstance(analysis, DriftAnalysis)
        assert "no drift" in analysis.summary.lower() or analysis.summary == ""


class TestLLMClientAnalyzeFailure:
    """Test suite for LLMClient.analyze_failure."""

    @pytest.fixture
    def mock_openai_client(self):
        """Create a mock OpenAI client."""
        with patch('warpcore.agentic.llm_client.openai') as mock:
            mock_response = Mock()
            mock_response.choices = [
                Mock(
                    message=Mock(
                        content=json.dumps({
                            "root_cause": "Missing permissions",
                            "explanation": "IAM role lacks required permissions",
                            "suggested_fixes": ["Add lambda:CreateFunction permission"],
                            "related_issues": [],
                            "prevention_tips": ["Use IAM Access Analyzer"],
                            "confidence": 0.9
                        })
                    )
                )
            ]
            mock.OpenAI.return_value.chat.completions.create.return_value = mock_response
            yield mock

    @pytest.fixture
    def client(self, mock_openai_client):
        """Create an LLMClient with mocked OpenAI."""
        with patch.dict('os.environ', {'OPENAI_API_KEY': 'test-key'}):
            return LLMClient(provider=LLMProvider.OPENAI)

    def test_analyze_failure_returns_analysis(self, client):
        """Test analyze_failure returns FailureAnalysis."""
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

        analysis = client.analyze_failure(context)

        assert isinstance(analysis, FailureAnalysis)
        assert len(analysis.suggested_fixes) > 0


class TestLLMClientPrioritizeMissing:
    """Test suite for LLMClient.prioritize_missing_resources."""

    @pytest.fixture
    def mock_openai_client(self):
        """Create a mock OpenAI client."""
        with patch('warpcore.agentic.llm_client.openai') as mock:
            mock_response = Mock()
            mock_response.choices = [
                Mock(
                    message=Mock(
                        content=json.dumps({
                            "prioritized_resources": [
                                {
                                    "resource_id": "func-1",
                                    "priority": 1,
                                    "impact": "Critical for API",
                                    "reasoning": "API endpoint depends on this"
                                }
                            ]
                        })
                    )
                )
            ]
            mock.OpenAI.return_value.chat.completions.create.return_value = mock_response
            yield mock

    @pytest.fixture
    def client(self, mock_openai_client):
        """Create an LLMClient with mocked OpenAI."""
        with patch.dict('os.environ', {'OPENAI_API_KEY': 'test-key'}):
            return LLMClient(provider=LLMProvider.OPENAI)

    def test_prioritize_returns_sorted_list(self, client):
        """Test prioritize_missing_resources returns sorted list."""
        resources = [
            MissingResource(
                resource_id="func-1",
                resource_type="AWS::Lambda::Function",
                expected_config={},
                dependencies=[],
                priority=5,
                impact="Unknown",
                reason="Missing from AWS",
            ),
            MissingResource(
                resource_id="role-1",
                resource_type="AWS::IAM::Role",
                expected_config={},
                dependencies=[],
                priority=5,
                impact="Unknown",
                reason="Missing from AWS",
            ),
        ]

        prioritized = client.prioritize_missing_resources(resources)

        assert isinstance(prioritized, list)
        assert len(prioritized) <= len(resources)


class TestLLMClientSuggestRecovery:
    """Test suite for LLMClient.suggest_recovery."""

    @pytest.fixture
    def mock_openai_client(self):
        """Create a mock OpenAI client."""
        with patch('warpcore.agentic.llm_client.openai') as mock:
            mock_response = Mock()
            mock_response.choices = [
                Mock(
                    message=Mock(
                        content=json.dumps({
                            "actions": [
                                {
                                    "action_type": "CREATE",
                                    "resource_id": "func-1",
                                    "resource_type": "AWS::Lambda::Function",
                                    "description": "Recreate function",
                                    "config": {},
                                    "dependencies": []
                                }
                            ],
                            "explanation": "Create missing resources",
                            "estimated_duration": 60,
                            "risks": ["Downtime during creation"],
                            "rollback_plan": "Delete created resources"
                        })
                    )
                )
            ]
            mock.OpenAI.return_value.chat.completions.create.return_value = mock_response
            yield mock

    @pytest.fixture
    def client(self, mock_openai_client):
        """Create an LLMClient with mocked OpenAI."""
        with patch.dict('os.environ', {'OPENAI_API_KEY': 'test-key'}):
            return LLMClient(provider=LLMProvider.OPENAI)

    def test_suggest_recovery_returns_plan(self, client):
        """Test suggest_recovery returns RecoveryPlan."""
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

        plan = client.suggest_recovery(drift_items)

        assert isinstance(plan, RecoveryPlan)
        assert len(plan.actions) > 0


class TestLLMClientFallback:
    """Test suite for LLMClient fallback behavior."""

    def test_fallback_analyze_drift(self):
        """Test fallback analysis when API fails."""
        with patch.dict('os.environ', {'OPENAI_API_KEY': 'test-key'}):
            client = LLMClient(provider=LLMProvider.OPENAI)

            # Force API failure
            with patch.object(client, '_call_openai', side_effect=Exception("API Error")):
                drift_items = [
                    DriftItem(
                        resource_id="func-1",
                        resource_type="AWS::Lambda::Function",
                        drift_type=DriftType.MISSING,
                        severity=Severity.CRITICAL,
                        expected_state={},
                        actual_state=None,
                        differences=[],
                    )
                ]

                analysis = client.analyze_drift(drift_items)

                # Should return fallback analysis
                assert isinstance(analysis, DriftAnalysis)
                assert analysis.confidence == 0.0

    def test_fallback_analyze_failure(self):
        """Test fallback analysis when API fails."""
        with patch.dict('os.environ', {'OPENAI_API_KEY': 'test-key'}):
            client = LLMClient(provider=LLMProvider.OPENAI)

            # Force API failure
            with patch.object(client, '_call_openai', side_effect=Exception("API Error")):
                context = FailureContext(
                    error_message="Error",
                    error_type="Error",
                    resource_id="func-1",
                    resource_type="AWS::Lambda::Function",
                    resource_config={},
                    operation="CREATE",
                    aws_request_id="123",
                    logs=[],
                )

                analysis = client.analyze_failure(context)

                # Should return fallback analysis
                assert isinstance(analysis, FailureAnalysis)
                assert analysis.confidence == 0.0


class TestLLMClientPromptConstruction:
    """Test suite for LLM prompt construction."""

    def test_drift_prompt_includes_context(self):
        """Test drift analysis prompt includes relevant context."""
        with patch.dict('os.environ', {'OPENAI_API_KEY': 'test-key'}):
            client = LLMClient(provider=LLMProvider.OPENAI)

            drift_items = [
                DriftItem(
                    resource_id="func-1",
                    resource_type="AWS::Lambda::Function",
                    drift_type=DriftType.MISSING,
                    severity=Severity.CRITICAL,
                    expected_state={"MemorySize": 512},
                    actual_state=None,
                    differences=["Resource not found"],
                )
            ]

            prompt = client._build_drift_prompt(drift_items)

            assert "func-1" in prompt
            assert "Lambda" in prompt or "lambda" in prompt
            assert "MISSING" in prompt or "missing" in prompt

    def test_failure_prompt_includes_error(self):
        """Test failure analysis prompt includes error details."""
        with patch.dict('os.environ', {'OPENAI_API_KEY': 'test-key'}):
            client = LLMClient(provider=LLMProvider.OPENAI)

            context = FailureContext(
                error_message="AccessDenied: User not authorized",
                error_type="AccessDeniedException",
                resource_id="func-1",
                resource_type="AWS::Lambda::Function",
                resource_config={},
                operation="CREATE",
                aws_request_id="123",
                logs=["Starting deployment", "Error occurred"],
            )

            prompt = client._build_failure_prompt(context)

            assert "AccessDenied" in prompt
            assert "func-1" in prompt
            assert "CREATE" in prompt
