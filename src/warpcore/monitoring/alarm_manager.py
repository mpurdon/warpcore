"""Alarm manager for creating and managing CloudWatch alarms."""

from typing import List, Dict, Any, Optional
import logging

from ..provisioners.cloudwatch import CloudWatchProvisioner
from ..provisioners.base import Resource
from ..config.models import AgentConfig

logger = logging.getLogger(__name__)


class AlarmManager:
    """Manages CloudWatch alarms for deployed resources."""

    def __init__(self, cloudwatch_provisioner: CloudWatchProvisioner):
        """Initialize alarm manager.
        
        Args:
            cloudwatch_provisioner: CloudWatch provisioner instance
        """
        self.provisioner = cloudwatch_provisioner

    def create_lambda_alarms(
        self,
        function_name: str,
        agent_config: AgentConfig,
        sns_topic_arn: Optional[str] = None,
        tags: Optional[Dict[str, str]] = None
    ) -> List[Resource]:
        """Create standard alarms for a Lambda function.
        
        Args:
            function_name: Name of the Lambda function
            agent_config: Agent configuration
            sns_topic_arn: Optional SNS topic ARN for notifications
            tags: Optional tags to apply to alarms
            
        Returns:
            List of created alarm resources
        """
        alarms = []
        
        # Error alarm
        error_alarm_config = CloudWatchProvisioner.build_lambda_error_alarm(
            function_name=function_name,
            alarm_name=f"{function_name}-errors",
            threshold=1.0,
            evaluation_periods=1,
            sns_topic_arn=sns_topic_arn
        )
        
        error_alarm = Resource(
            id=f"alarm-{function_name}-errors",
            type='AWS::CloudWatch::Alarm',
            physical_id=None,
            properties={
                'ResourceType': 'Alarm',
                **error_alarm_config
            },
            dependencies=[],
            tags=tags or {}
        )
        alarms.append(error_alarm)
        
        # Throttle alarm
        throttle_alarm_config = CloudWatchProvisioner.build_lambda_throttle_alarm(
            function_name=function_name,
            alarm_name=f"{function_name}-throttles",
            threshold=1.0,
            evaluation_periods=2,
            sns_topic_arn=sns_topic_arn
        )
        
        throttle_alarm = Resource(
            id=f"alarm-{function_name}-throttles",
            type='AWS::CloudWatch::Alarm',
            physical_id=None,
            properties={
                'ResourceType': 'Alarm',
                **throttle_alarm_config
            },
            dependencies=[],
            tags=tags or {}
        )
        alarms.append(throttle_alarm)
        
        # Duration alarm (80% of timeout)
        timeout_ms = agent_config.timeout * 1000
        duration_threshold = timeout_ms * 0.8
        
        duration_alarm_config = CloudWatchProvisioner.build_lambda_duration_alarm(
            function_name=function_name,
            alarm_name=f"{function_name}-duration",
            threshold=duration_threshold,
            evaluation_periods=2,
            sns_topic_arn=sns_topic_arn
        )
        
        duration_alarm = Resource(
            id=f"alarm-{function_name}-duration",
            type='AWS::CloudWatch::Alarm',
            physical_id=None,
            properties={
                'ResourceType': 'Alarm',
                **duration_alarm_config
            },
            dependencies=[],
            tags=tags or {}
        )
        alarms.append(duration_alarm)
        
        logger.info(f"Created {len(alarms)} alarms for Lambda function {function_name}")
        
        return alarms

    def create_api_gateway_alarms(
        self,
        api_name: str,
        sns_topic_arn: Optional[str] = None,
        tags: Optional[Dict[str, str]] = None
    ) -> List[Resource]:
        """Create standard alarms for an API Gateway.
        
        Args:
            api_name: Name of the API Gateway
            sns_topic_arn: Optional SNS topic ARN for notifications
            tags: Optional tags to apply to alarms
            
        Returns:
            List of created alarm resources
        """
        alarms = []
        
        # 5XX error alarm
        error_alarm_config = CloudWatchProvisioner.build_api_gateway_5xx_alarm(
            api_name=api_name,
            alarm_name=f"{api_name}-5xx-errors",
            threshold=5.0,
            evaluation_periods=2,
            sns_topic_arn=sns_topic_arn
        )
        
        error_alarm = Resource(
            id=f"alarm-{api_name}-5xx-errors",
            type='AWS::CloudWatch::Alarm',
            physical_id=None,
            properties={
                'ResourceType': 'Alarm',
                **error_alarm_config
            },
            dependencies=[],
            tags=tags or {}
        )
        alarms.append(error_alarm)
        
        logger.info(f"Created {len(alarms)} alarms for API Gateway {api_name}")
        
        return alarms

    def create_dynamodb_alarms(
        self,
        table_name: str,
        sns_topic_arn: Optional[str] = None,
        tags: Optional[Dict[str, str]] = None
    ) -> List[Resource]:
        """Create standard alarms for a DynamoDB table.
        
        Args:
            table_name: Name of the DynamoDB table
            sns_topic_arn: Optional SNS topic ARN for notifications
            tags: Optional tags to apply to alarms
            
        Returns:
            List of created alarm resources
        """
        alarms = []
        
        # Throttle alarm
        throttle_alarm_config = CloudWatchProvisioner.build_dynamodb_throttle_alarm(
            table_name=table_name,
            alarm_name=f"{table_name}-throttles",
            threshold=5.0,
            evaluation_periods=2,
            sns_topic_arn=sns_topic_arn
        )
        
        throttle_alarm = Resource(
            id=f"alarm-{table_name}-throttles",
            type='AWS::CloudWatch::Alarm',
            physical_id=None,
            properties={
                'ResourceType': 'Alarm',
                **throttle_alarm_config
            },
            dependencies=[],
            tags=tags or {}
        )
        alarms.append(throttle_alarm)
        
        logger.info(f"Created {len(alarms)} alarms for DynamoDB table {table_name}")
        
        return alarms

    def create_log_group(
        self,
        log_group_name: str,
        retention_days: int = 7,
        tags: Optional[Dict[str, str]] = None
    ) -> Resource:
        """Create a CloudWatch log group.
        
        Args:
            log_group_name: Name of the log group
            retention_days: Number of days to retain logs
            tags: Optional tags to apply to log group
            
        Returns:
            Created log group resource
        """
        log_group_config = CloudWatchProvisioner.build_log_group_config(
            log_group_name=log_group_name,
            retention_days=retention_days
        )
        
        log_group = Resource(
            id=f"loggroup-{log_group_name.replace('/', '-')}",
            type='AWS::Logs::LogGroup',
            physical_id=None,
            properties={
                'ResourceType': 'LogGroup',
                **log_group_config
            },
            dependencies=[],
            tags=tags or {}
        )
        
        logger.info(f"Created log group {log_group_name} with {retention_days} days retention")
        
        return log_group

    def provision_alarms(self, alarms: List[Resource]) -> List[Resource]:
        """Provision a list of alarms.
        
        Args:
            alarms: List of alarm resources to provision
            
        Returns:
            List of provisioned alarm resources
        """
        provisioned = []
        
        for alarm in alarms:
            try:
                # Get current state
                current = self.provisioner.get_current_state(alarm.id)
                
                # Plan changes
                plan = self.provisioner.plan(alarm, current)
                
                # Provision
                result = self.provisioner.provision(plan)
                provisioned.append(result)
                
                logger.info(f"Provisioned alarm {alarm.id}")
                
            except Exception as e:
                logger.error(f"Failed to provision alarm {alarm.id}: {e}")
                raise
        
        return provisioned

    def delete_alarms(self, alarms: List[Resource]) -> None:
        """Delete a list of alarms.
        
        Args:
            alarms: List of alarm resources to delete
        """
        for alarm in alarms:
            try:
                self.provisioner.destroy(alarm)
                logger.info(f"Deleted alarm {alarm.id}")
            except Exception as e:
                logger.error(f"Failed to delete alarm {alarm.id}: {e}")
                raise
