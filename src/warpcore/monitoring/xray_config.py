"""X-Ray tracing configuration and management."""

from typing import Dict, Any, Optional, List
import logging

from ..config.models import AgentConfig

logger = logging.getLogger(__name__)


class XRayConfig:
    """Manages X-Ray tracing configuration for deployed resources."""

    @staticmethod
    def build_lambda_tracing_config(
        mode: str = 'Active',
        enable_tracing: bool = True
    ) -> Dict[str, Any]:
        """Build X-Ray tracing configuration for Lambda functions.
        
        Args:
            mode: Tracing mode ('Active' or 'PassThrough')
                - Active: Lambda samples and traces requests
                - PassThrough: Lambda only traces if upstream service traced the request
            enable_tracing: Whether to enable tracing
            
        Returns:
            Tracing configuration dictionary
        """
        if not enable_tracing:
            return {'Mode': 'PassThrough'}
        
        return {'Mode': mode}

    @staticmethod
    def build_api_gateway_tracing_config(
        enable_tracing: bool = True,
        sampling_rate: float = 1.0
    ) -> Dict[str, Any]:
        """Build X-Ray tracing configuration for API Gateway.
        
        Args:
            enable_tracing: Whether to enable tracing
            sampling_rate: Sampling rate (0.0 to 1.0)
            
        Returns:
            Tracing configuration dictionary
        """
        return {
            'TracingEnabled': enable_tracing,
            'SamplingRate': sampling_rate
        }

    @staticmethod
    def get_required_iam_permissions() -> List[str]:
        """Get IAM permissions required for X-Ray tracing.
        
        Returns:
            List of IAM action strings
        """
        return [
            'xray:PutTraceSegments',
            'xray:PutTelemetryRecords',
        ]

    @staticmethod
    def build_xray_daemon_config(
        region: Optional[str] = None,
        role_arn: Optional[str] = None
    ) -> Dict[str, Any]:
        """Build X-Ray daemon configuration.
        
        Args:
            region: AWS region for X-Ray daemon
            role_arn: IAM role ARN for X-Ray daemon
            
        Returns:
            X-Ray daemon configuration
        """
        config = {}
        
        if region:
            config['AWS_XRAY_DAEMON_ADDRESS'] = f'xray.{region}.amazonaws.com:2000'
        
        if role_arn:
            config['AWS_XRAY_ROLE_ARN'] = role_arn
        
        return config

    @staticmethod
    def get_environment_variables(
        service_name: str,
        enable_plugins: bool = True
    ) -> Dict[str, str]:
        """Get environment variables for X-Ray SDK.
        
        Args:
            service_name: Name of the service for X-Ray segments
            enable_plugins: Whether to enable X-Ray plugins (EC2, ECS, etc.)
            
        Returns:
            Dictionary of environment variables
        """
        env_vars = {
            'AWS_XRAY_TRACING_NAME': service_name,
            'AWS_XRAY_CONTEXT_MISSING': 'LOG_ERROR',  # Don't fail if context is missing
        }
        
        if enable_plugins:
            # Enable AWS plugins for better metadata
            env_vars['AWS_XRAY_PLUGINS'] = 'EC2Plugin,ECSPlugin'
        
        return env_vars

    @staticmethod
    def build_sampling_rule(
        rule_name: str,
        service_name: str,
        http_method: str = '*',
        url_path: str = '*',
        fixed_rate: float = 0.05,
        reservoir_size: int = 1
    ) -> Dict[str, Any]:
        """Build X-Ray sampling rule.
        
        Args:
            rule_name: Name of the sampling rule
            service_name: Service name to match
            http_method: HTTP method to match (* for all)
            url_path: URL path to match (* for all)
            fixed_rate: Fixed sampling rate (0.0 to 1.0)
            reservoir_size: Number of requests per second to sample
            
        Returns:
            Sampling rule configuration
        """
        return {
            'RuleName': rule_name,
            'Priority': 1000,
            'Version': 1,
            'ReservoirSize': reservoir_size,
            'FixedRate': fixed_rate,
            'ServiceName': service_name,
            'ServiceType': '*',
            'Host': '*',
            'HTTPMethod': http_method,
            'URLPath': url_path,
            'ResourceARN': '*',
        }

    @staticmethod
    def create_sampling_rules_for_agents(
        agents: List[AgentConfig],
        default_fixed_rate: float = 0.05,
        production_fixed_rate: float = 0.01
    ) -> List[Dict[str, Any]]:
        """Create X-Ray sampling rules for agents.
        
        Args:
            agents: List of agent configurations
            default_fixed_rate: Default sampling rate for non-production
            production_fixed_rate: Sampling rate for production
            
        Returns:
            List of sampling rule configurations
        """
        rules = []
        
        for agent in agents:
            # Use lower sampling rate for production
            fixed_rate = production_fixed_rate if agent.environment == 'prod' else default_fixed_rate
            
            rule = XRayConfig.build_sampling_rule(
                rule_name=f"{agent.name}-sampling",
                service_name=agent.name,
                fixed_rate=fixed_rate,
                reservoir_size=1
            )
            rules.append(rule)
        
        return rules

    @staticmethod
    def get_trace_query_filter(
        service_name: Optional[str] = None,
        error_only: bool = False,
        min_duration_seconds: Optional[float] = None
    ) -> str:
        """Build X-Ray trace query filter.
        
        Args:
            service_name: Filter by service name
            error_only: Only return traces with errors
            min_duration_seconds: Minimum trace duration
            
        Returns:
            X-Ray filter expression
        """
        filters = []
        
        if service_name:
            filters.append(f'service("{service_name}")')
        
        if error_only:
            filters.append('error = true')
        
        if min_duration_seconds:
            filters.append(f'duration >= {min_duration_seconds}')
        
        return ' AND '.join(filters) if filters else ''

    @staticmethod
    def configure_lambda_for_xray(
        lambda_config: Dict[str, Any],
        agent_name: str,
        enable_tracing: bool = True
    ) -> Dict[str, Any]:
        """Configure Lambda function for X-Ray tracing.
        
        Args:
            lambda_config: Lambda function configuration
            agent_name: Name of the agent
            enable_tracing: Whether to enable tracing
            
        Returns:
            Updated Lambda configuration with X-Ray settings
        """
        # Add tracing configuration
        lambda_config['TracingConfig'] = XRayConfig.build_lambda_tracing_config(
            mode='Active' if enable_tracing else 'PassThrough',
            enable_tracing=enable_tracing
        )
        
        # Add X-Ray environment variables
        if 'Environment' not in lambda_config:
            lambda_config['Environment'] = {}
        
        if 'Variables' not in lambda_config['Environment']:
            lambda_config['Environment']['Variables'] = {}
        
        xray_env_vars = XRayConfig.get_environment_variables(
            service_name=agent_name,
            enable_plugins=True
        )
        
        lambda_config['Environment']['Variables'].update(xray_env_vars)
        
        logger.info(f"Configured X-Ray tracing for Lambda function {agent_name}")
        
        return lambda_config

    @staticmethod
    def get_xray_insights_query(
        service_name: str,
        time_range_minutes: int = 60
    ) -> Dict[str, Any]:
        """Build X-Ray Insights query for service analysis.
        
        Args:
            service_name: Name of the service
            time_range_minutes: Time range for analysis in minutes
            
        Returns:
            X-Ray Insights query configuration
        """
        return {
            'ServiceName': service_name,
            'TimeRangeMinutes': time_range_minutes,
            'Metrics': [
                'ResponseTime',
                'ErrorRate',
                'ThrottleRate',
                'FaultRate',
            ]
        }


class XRayManager:
    """Manages X-Ray tracing for deployed resources."""

    def __init__(self, xray_client):
        """Initialize X-Ray manager.
        
        Args:
            xray_client: X-Ray client
        """
        self.xray_client = xray_client

    def create_sampling_rule(self, rule_config: Dict[str, Any]) -> str:
        """Create an X-Ray sampling rule.
        
        Args:
            rule_config: Sampling rule configuration
            
        Returns:
            ARN of created sampling rule
        """
        try:
            response = self.xray_client.create_sampling_rule(
                SamplingRule=rule_config
            )
            
            rule_arn = response['SamplingRuleRecord']['SamplingRule']['RuleARN']
            logger.info(f"Created X-Ray sampling rule: {rule_config['RuleName']}")
            
            return rule_arn
            
        except Exception as e:
            logger.error(f"Failed to create X-Ray sampling rule: {e}")
            raise

    def update_sampling_rule(self, rule_config: Dict[str, Any]) -> None:
        """Update an X-Ray sampling rule.
        
        Args:
            rule_config: Updated sampling rule configuration
        """
        try:
            self.xray_client.update_sampling_rule(
                SamplingRuleUpdate=rule_config
            )
            
            logger.info(f"Updated X-Ray sampling rule: {rule_config['RuleName']}")
            
        except Exception as e:
            logger.error(f"Failed to update X-Ray sampling rule: {e}")
            raise

    def delete_sampling_rule(self, rule_name: str) -> None:
        """Delete an X-Ray sampling rule.
        
        Args:
            rule_name: Name of the sampling rule to delete
        """
        try:
            self.xray_client.delete_sampling_rule(
                RuleName=rule_name
            )
            
            logger.info(f"Deleted X-Ray sampling rule: {rule_name}")
            
        except Exception as e:
            logger.error(f"Failed to delete X-Ray sampling rule: {e}")
            raise

    def get_trace_summaries(
        self,
        start_time,
        end_time,
        filter_expression: Optional[str] = None
    ) -> List[Dict[str, Any]]:
        """Get X-Ray trace summaries.
        
        Args:
            start_time: Start time for traces
            end_time: End time for traces
            filter_expression: Optional filter expression
            
        Returns:
            List of trace summaries
        """
        try:
            params = {
                'StartTime': start_time,
                'EndTime': end_time,
            }
            
            if filter_expression:
                params['FilterExpression'] = filter_expression
            
            response = self.xray_client.get_trace_summaries(**params)
            
            return response.get('TraceSummaries', [])
            
        except Exception as e:
            logger.error(f"Failed to get trace summaries: {e}")
            raise

    def get_service_graph(
        self,
        start_time,
        end_time
    ) -> Dict[str, Any]:
        """Get X-Ray service graph.
        
        Args:
            start_time: Start time for graph
            end_time: End time for graph
            
        Returns:
            Service graph data
        """
        try:
            response = self.xray_client.get_service_graph(
                StartTime=start_time,
                EndTime=end_time
            )
            
            return {
                'Services': response.get('Services', []),
                'StartTime': response.get('StartTime'),
                'EndTime': response.get('EndTime'),
            }
            
        except Exception as e:
            logger.error(f"Failed to get service graph: {e}")
            raise
