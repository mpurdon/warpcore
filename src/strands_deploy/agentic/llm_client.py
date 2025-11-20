"""LLM client for agentic analysis."""

import json
import os
from enum import Enum
from typing import Any, Dict, List, Optional

from strands_deploy.agentic.models import (
    DriftAnalysis,
    DriftItem,
    FailureAnalysis,
    FailureContext,
    MissingResource,
    RecoveryPlan,
    RecoveryAction,
)
from strands_deploy.utils.logging import get_logger

logger = get_logger(__name__)


class LLMProvider(Enum):
    """Supported LLM providers."""
    OPENAI = "openai"
    ANTHROPIC = "anthropic"
    BEDROCK = "bedrock"
    LOCAL = "local"


class LLMClient:
    """Client for interacting with LLM for infrastructure analysis."""
    
    def __init__(
        self,
        provider: LLMProvider = LLMProvider.OPENAI,
        api_key: Optional[str] = None,
        model: Optional[str] = None,
        endpoint: Optional[str] = None
    ):
        """Initialize LLM client.
        
        Args:
            provider: LLM provider to use
            api_key: API key (if not provided, will use environment variable)
            model: Model name (provider-specific)
            endpoint: Custom endpoint URL (for local models)
        """
        self.provider = provider
        self.api_key = api_key or self._get_api_key_from_env()
        self.model = model or self._get_default_model()
        self.endpoint = endpoint
        self.logger = get_logger(__name__)
        
        # Initialize provider-specific client
        self.client = self._initialize_client()
    
    def _get_api_key_from_env(self) -> Optional[str]:
        """Get API key from environment variable."""
        if self.provider == LLMProvider.OPENAI:
            return os.getenv('OPENAI_API_KEY')
        elif self.provider == LLMProvider.ANTHROPIC:
            return os.getenv('ANTHROPIC_API_KEY')
        elif self.provider == LLMProvider.BEDROCK:
            return None  # Bedrock uses AWS credentials
        return None
    
    def _get_default_model(self) -> str:
        """Get default model for provider."""
        defaults = {
            LLMProvider.OPENAI: "gpt-4",
            LLMProvider.ANTHROPIC: "claude-3-sonnet-20240229",
            LLMProvider.BEDROCK: "anthropic.claude-3-sonnet-20240229-v1:0",
            LLMProvider.LOCAL: "llama2"
        }
        return defaults.get(self.provider, "gpt-4")
    
    def _initialize_client(self) -> Any:
        """Initialize provider-specific client."""
        try:
            if self.provider == LLMProvider.OPENAI:
                # Only initialize if API key is available
                if not self.api_key:
                    self.logger.warning("OpenAI API key not found - using fallback analysis")
                    return None
                import openai
                return openai.OpenAI(api_key=self.api_key)
            elif self.provider == LLMProvider.ANTHROPIC:
                # Only initialize if API key is available
                if not self.api_key:
                    self.logger.warning("Anthropic API key not found - using fallback analysis")
                    return None
                import anthropic
                return anthropic.Anthropic(api_key=self.api_key)
            elif self.provider == LLMProvider.BEDROCK:
                import boto3
                return boto3.client('bedrock-runtime')
            elif self.provider == LLMProvider.LOCAL:
                # For local models, could use ollama or similar
                return None
        except ImportError as e:
            self.logger.warning(f"Failed to import LLM client library: {e}")
            return None
        except Exception as e:
            self.logger.warning(f"Failed to initialize LLM client: {e}")
            return None
    
    def analyze_drift(self, drift_items: List[DriftItem]) -> DriftAnalysis:
        """Analyze infrastructure drift using LLM.
        
        Args:
            drift_items: List of detected drift items
            
        Returns:
            DriftAnalysis with LLM insights
        """
        if not self.client:
            return self._fallback_drift_analysis(drift_items)
        
        # Build prompt
        prompt = self._build_drift_analysis_prompt(drift_items)
        
        # Call LLM
        try:
            response = self._call_llm(prompt)
            return self._parse_drift_analysis(response)
        except Exception as e:
            self.logger.error(f"Error calling LLM for drift analysis: {e}")
            return self._fallback_drift_analysis(drift_items)
    
    def analyze_failure(self, context: FailureContext) -> FailureAnalysis:
        """Analyze deployment failure using LLM.
        
        Args:
            context: Failure context information
            
        Returns:
            FailureAnalysis with root cause and suggestions
        """
        if not self.client:
            return self._fallback_failure_analysis(context)
        
        # Build prompt
        prompt = self._build_failure_analysis_prompt(context)
        
        # Call LLM
        try:
            response = self._call_llm(prompt)
            return self._parse_failure_analysis(response)
        except Exception as e:
            self.logger.error(f"Error calling LLM for failure analysis: {e}")
            return self._fallback_failure_analysis(context)
    
    def prioritize_missing_resources(
        self,
        missing: List[MissingResource]
    ) -> List[MissingResource]:
        """Prioritize missing resources using LLM.
        
        Args:
            missing: List of missing resources
            
        Returns:
            Prioritized list of missing resources
        """
        if not self.client or not missing:
            return missing
        
        # Build prompt
        prompt = self._build_prioritization_prompt(missing)
        
        # Call LLM
        try:
            response = self._call_llm(prompt)
            return self._parse_prioritization(response, missing)
        except Exception as e:
            self.logger.error(f"Error calling LLM for prioritization: {e}")
            return missing
    
    def suggest_recovery(self, drift_items: List[DriftItem]) -> RecoveryPlan:
        """Generate recovery plan for drift using LLM.
        
        Args:
            drift_items: List of drift items to recover from
            
        Returns:
            RecoveryPlan with suggested actions
        """
        if not self.client:
            return self._fallback_recovery_plan(drift_items)
        
        # Build prompt
        prompt = self._build_recovery_prompt(drift_items)
        
        # Call LLM
        try:
            response = self._call_llm(prompt)
            return self._parse_recovery_plan(response)
        except Exception as e:
            self.logger.error(f"Error calling LLM for recovery plan: {e}")
            return self._fallback_recovery_plan(drift_items)
    
    def _call_llm(self, prompt: str) -> str:
        """Call LLM with prompt.
        
        Args:
            prompt: Prompt text
            
        Returns:
            LLM response text
        """
        if self.provider == LLMProvider.OPENAI:
            response = self.client.chat.completions.create(
                model=self.model,
                messages=[
                    {"role": "system", "content": "You are an AWS infrastructure expert helping analyze and fix deployment issues."},
                    {"role": "user", "content": prompt}
                ],
                temperature=0.3
            )
            return response.choices[0].message.content
        
        elif self.provider == LLMProvider.ANTHROPIC:
            response = self.client.messages.create(
                model=self.model,
                max_tokens=2000,
                messages=[
                    {"role": "user", "content": prompt}
                ]
            )
            return response.content[0].text
        
        elif self.provider == LLMProvider.BEDROCK:
            import json
            body = json.dumps({
                "anthropic_version": "bedrock-2023-05-31",
                "max_tokens": 2000,
                "messages": [
                    {"role": "user", "content": prompt}
                ]
            })
            response = self.client.invoke_model(
                modelId=self.model,
                body=body
            )
            response_body = json.loads(response['body'].read())
            return response_body['content'][0]['text']
        
        return ""
    
    def _build_drift_analysis_prompt(self, drift_items: List[DriftItem]) -> str:
        """Build prompt for drift analysis."""
        drift_summary = "\n".join([
            f"- {item.resource_id} ({item.resource_type}): {item.drift_type.value} - {', '.join(item.differences)}"
            for item in drift_items
        ])
        
        return f"""Analyze the following infrastructure drift detected in an AWS deployment:

{drift_summary}

Please provide:
1. A concise summary of the drift (2-3 sentences)
2. The likely root cause
3. Impact assessment
4. Recommended actions to resolve the drift
5. Your confidence level (0.0-1.0)

Format your response as JSON with keys: summary, root_cause, impact, recommendations (array), confidence"""
    
    def _build_failure_analysis_prompt(self, context: FailureContext) -> str:
        """Build prompt for failure analysis."""
        logs_text = "\n".join(context.logs[-10:]) if context.logs else "No logs available"
        
        return f"""Analyze this AWS deployment failure:

Error: {context.error_message}
Error Type: {context.error_type}
Resource: {context.resource_id} ({context.resource_type})
Operation: {context.operation}

Recent logs:
{logs_text}

Resource configuration:
{json.dumps(context.resource_config, indent=2) if context.resource_config else "Not available"}

Please provide:
1. Root cause of the failure
2. Detailed explanation
3. Suggested fixes (array of specific actions)
4. Related known issues
5. Prevention tips for the future
6. Your confidence level (0.0-1.0)

Format your response as JSON with keys: root_cause, explanation, suggested_fixes (array), related_issues (array), prevention_tips (array), confidence"""
    
    def _build_prioritization_prompt(self, missing: List[MissingResource]) -> str:
        """Build prompt for resource prioritization."""
        resources_text = "\n".join([
            f"- {r.resource_id} ({r.resource_type}): {r.impact}"
            for r in missing
        ])
        
        return f"""Prioritize these missing AWS resources by criticality:

{resources_text}

Assign each resource a priority from 1 (most critical) to 10 (least critical) and explain the impact.

Format your response as JSON array with objects containing: resource_id, priority, impact, reason"""
    
    def _build_recovery_prompt(self, drift_items: List[DriftItem]) -> str:
        """Build prompt for recovery plan generation."""
        drift_summary = "\n".join([
            f"- {item.resource_id} ({item.resource_type}): {item.drift_type.value}"
            for item in drift_items
        ])
        
        return f"""Generate a recovery plan for this infrastructure drift:

{drift_summary}

Provide a step-by-step recovery plan with:
1. Actions to take (create, update, or delete resources)
2. Dependencies between actions
3. Overall explanation
4. Estimated duration
5. Potential risks
6. Rollback plan

Format your response as JSON with keys: actions (array of objects with action_type, resource_id, resource_type, configuration, dependencies, rationale), explanation, estimated_duration, risks (array), rollback_plan"""
    
    def _parse_drift_analysis(self, response: str) -> DriftAnalysis:
        """Parse LLM response into DriftAnalysis."""
        try:
            data = json.loads(response)
            return DriftAnalysis(
                summary=data.get('summary', ''),
                root_cause=data.get('root_cause'),
                impact=data.get('impact', ''),
                recommendations=data.get('recommendations', []),
                confidence=float(data.get('confidence', 0.5))
            )
        except (json.JSONDecodeError, KeyError, ValueError) as e:
            self.logger.error(f"Error parsing drift analysis: {e}")
            return DriftAnalysis(
                summary="Unable to parse LLM response",
                impact="Unknown",
                recommendations=[],
                confidence=0.0
            )
    
    def _parse_failure_analysis(self, response: str) -> FailureAnalysis:
        """Parse LLM response into FailureAnalysis."""
        try:
            data = json.loads(response)
            return FailureAnalysis(
                root_cause=data.get('root_cause', 'Unknown'),
                explanation=data.get('explanation', ''),
                suggested_fixes=data.get('suggested_fixes', []),
                confidence=float(data.get('confidence', 0.5)),
                related_issues=data.get('related_issues', []),
                prevention_tips=data.get('prevention_tips', [])
            )
        except (json.JSONDecodeError, KeyError, ValueError) as e:
            self.logger.error(f"Error parsing failure analysis: {e}")
            return FailureAnalysis(
                root_cause="Unable to parse LLM response",
                explanation="",
                suggested_fixes=[],
                confidence=0.0
            )
    
    def _parse_prioritization(
        self,
        response: str,
        original: List[MissingResource]
    ) -> List[MissingResource]:
        """Parse LLM prioritization response."""
        try:
            data = json.loads(response)
            # Update priorities based on LLM response
            priority_map = {item['resource_id']: item for item in data}
            
            for resource in original:
                if resource.resource_id in priority_map:
                    llm_data = priority_map[resource.resource_id]
                    resource.priority = llm_data.get('priority', resource.priority)
                    resource.impact = llm_data.get('impact', resource.impact)
                    resource.reason = llm_data.get('reason', resource.reason)
            
            # Sort by priority
            return sorted(original, key=lambda r: r.priority)
        except (json.JSONDecodeError, KeyError) as e:
            self.logger.error(f"Error parsing prioritization: {e}")
            return original
    
    def _parse_recovery_plan(self, response: str) -> RecoveryPlan:
        """Parse LLM response into RecoveryPlan."""
        try:
            data = json.loads(response)
            actions = [
                RecoveryAction(
                    action_type=action.get('action_type', 'update'),
                    resource_id=action.get('resource_id', ''),
                    resource_type=action.get('resource_type', ''),
                    configuration=action.get('configuration', {}),
                    dependencies=action.get('dependencies', []),
                    rationale=action.get('rationale', '')
                )
                for action in data.get('actions', [])
            ]
            
            return RecoveryPlan(
                actions=actions,
                explanation=data.get('explanation', ''),
                estimated_duration=data.get('estimated_duration'),
                risks=data.get('risks', []),
                rollback_plan=data.get('rollback_plan')
            )
        except (json.JSONDecodeError, KeyError) as e:
            self.logger.error(f"Error parsing recovery plan: {e}")
            return RecoveryPlan(
                actions=[],
                explanation="Unable to parse LLM response",
                risks=["Failed to generate recovery plan"]
            )
    
    def _fallback_drift_analysis(self, drift_items: List[DriftItem]) -> DriftAnalysis:
        """Fallback drift analysis without LLM."""
        return DriftAnalysis(
            summary=f"Detected {len(drift_items)} drift items",
            impact="Manual review required",
            recommendations=["Review each drift item manually", "Determine appropriate remediation"],
            confidence=0.0
        )
    
    def _fallback_failure_analysis(self, context: FailureContext) -> FailureAnalysis:
        """Fallback failure analysis without LLM."""
        return FailureAnalysis(
            root_cause=context.error_type,
            explanation=context.error_message,
            suggested_fixes=["Review error message and logs", "Check AWS documentation"],
            confidence=0.0
        )
    
    def _fallback_recovery_plan(self, drift_items: List[DriftItem]) -> RecoveryPlan:
        """Fallback recovery plan without LLM."""
        return RecoveryPlan(
            actions=[],
            explanation="LLM unavailable - manual recovery plan required",
            risks=["Manual intervention needed"]
        )
