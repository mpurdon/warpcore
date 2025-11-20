"""CloudWatch provisioner for alarms and metrics."""

from typing import Optional, Dict, Any, List
from botocore.exceptions import ClientError

from .base import BaseProvisioner, Resource, ProvisionPlan, ChangeType


class CloudWatchProvisioner(BaseProvisioner):
    """Provisioner for CloudWatch alarms and log groups."""

    def __init__(self, boto_session):
        """Initialize CloudWatch provisioner.
        
        Args:
            boto_session: Configured boto3 session
        """
        super().__init__(boto_session)
        self.cloudwatch_client = boto_session.client('cloudwatch')
        self.logs_client = boto_session.client('logs')

    def plan(self, desired: Resource, current: Optional[Resource]) -> ProvisionPlan:
        """Determine what changes are needed for the CloudWatch resource.
        
        Args:
            desired: Desired CloudWatch resource state
            current: Current CloudWatch resource state (None if doesn't exist)
            
        Returns:
            ProvisionPlan with change type
        """
        if current is None:
            return ProvisionPlan(
                resource=desired,
                change_type=ChangeType.CREATE,
                current_state=None
            )
        
        if self._needs_update(desired, current):
            return ProvisionPlan(
                resource=desired,
                change_type=ChangeType.UPDATE,
                current_state=current
            )
        
        return ProvisionPlan(
            resource=desired,
            change_type=ChangeType.NO_CHANGE,
            current_state=current
        )

    def provision(self, plan: ProvisionPlan) -> Resource:
        """Execute the CloudWatch resource provisioning plan.
        
        Args:
            plan: Provisioning plan to execute
            
        Returns:
            Resource with physical_id set
        """
        resource_type = plan.resource.properties.get('ResourceType', 'Alarm')
        
        if resource_type == 'Alarm':
            if plan.change_type == ChangeType.CREATE:
                return self._create_alarm(plan.resource)
            elif plan.change_type == ChangeType.UPDATE:
                return self._update_alarm(plan.resource)
        elif resource_type == 'LogGroup':
            if plan.change_type == ChangeType.CREATE:
                return self._create_log_group(plan.resource)
            elif plan.change_type == ChangeType.UPDATE:
                return self._update_log_group(plan.resource)
        
        return plan.resource

    def destroy(self, resource: Resource) -> None:
        """Destroy the CloudWatch resource.
        
        Args:
            resource: CloudWatch resource to destroy
        """
        resource_type = resource.properties.get('ResourceType', 'Alarm')
        
        if resource_type == 'Alarm':
            alarm_name = resource.properties.get('AlarmName')
            if alarm_name:
                try:
                    self.cloudwatch_client.delete_alarms(AlarmNames=[alarm_name])
                except ClientError as e:
                    if e.response['Error']['Code'] != 'ResourceNotFoundException':
                        raise
        elif resource_type == 'LogGroup':
            log_group_name = resource.properties.get('LogGroupName')
            if log_group_name:
                try:
                    self.logs_client.delete_log_group(logGroupName=log_group_name)
                except ClientError as e:
                    if e.response['Error']['Code'] != 'ResourceNotFoundException':
                        raise

    def get_current_state(self, resource_id: str) -> Optional[Resource]:
        """Fetch current CloudWatch resource state from AWS.
        
        Args:
            resource_id: Logical resource ID
            
        Returns:
            Current resource state or None if doesn't exist
        """
        # Determine resource type from ID
        if 'alarm' in resource_id.lower():
            return self._get_alarm_state(resource_id)
        elif 'loggroup' in resource_id.lower():
            return self._get_log_group_state(resource_id)
        
        return None

    def _create_alarm(self, resource: Resource) -> Resource:
        """Create a CloudWatch alarm.
        
        Args:
            resource: Resource definition
            
        Returns:
            Resource with physical_id set
        """
        alarm_params = {
            'AlarmName': resource.properties['AlarmName'],
            'ComparisonOperator': resource.properties['ComparisonOperator'],
            'EvaluationPeriods': resource.properties['EvaluationPeriods'],
            'MetricName': resource.properties['MetricName'],
            'Namespace': resource.properties['Namespace'],
            'Period': resource.properties['Period'],
            'Statistic': resource.properties.get('Statistic', 'Average'),
            'Threshold': resource.properties['Threshold'],
        }
        
        # Optional parameters
        if 'AlarmDescription' in resource.properties:
            alarm_params['AlarmDescription'] = resource.properties['AlarmDescription']
        
        if 'ActionsEnabled' in resource.properties:
            alarm_params['ActionsEnabled'] = resource.properties['ActionsEnabled']
        
        if 'AlarmActions' in resource.properties:
            alarm_params['AlarmActions'] = resource.properties['AlarmActions']
        
        if 'Dimensions' in resource.properties:
            alarm_params['Dimensions'] = resource.properties['Dimensions']
        
        if 'TreatMissingData' in resource.properties:
            alarm_params['TreatMissingData'] = resource.properties['TreatMissingData']
        
        if 'DatapointsToAlarm' in resource.properties:
            alarm_params['DatapointsToAlarm'] = resource.properties['DatapointsToAlarm']
        
        if 'Unit' in resource.properties:
            alarm_params['Unit'] = resource.properties['Unit']
        
        # Add tags
        if resource.tags:
            alarm_params['Tags'] = [
                {'Key': k, 'Value': v} for k, v in resource.tags.items()
            ]
        
        self.cloudwatch_client.put_metric_alarm(**alarm_params)
        
        alarm_arn = f"arn:aws:cloudwatch:{self.session.region_name}:{self._get_account_id()}:alarm:{resource.properties['AlarmName']}"
        resource.physical_id = alarm_arn
        
        return resource

    def _update_alarm(self, resource: Resource) -> Resource:
        """Update an existing CloudWatch alarm.
        
        Args:
            resource: Resource definition with updates
            
        Returns:
            Updated resource
        """
        # CloudWatch alarms are updated using the same put_metric_alarm call
        return self._create_alarm(resource)

    def _create_log_group(self, resource: Resource) -> Resource:
        """Create a CloudWatch log group.
        
        Args:
            resource: Resource definition
            
        Returns:
            Resource with physical_id set
        """
        log_group_name = resource.properties['LogGroupName']
        
        create_params = {
            'logGroupName': log_group_name,
        }
        
        # Optional parameters
        if 'RetentionInDays' in resource.properties:
            # Create log group first, then set retention
            self.logs_client.create_log_group(**create_params)
            self.logs_client.put_retention_policy(
                logGroupName=log_group_name,
                retentionInDays=resource.properties['RetentionInDays']
            )
        else:
            self.logs_client.create_log_group(**create_params)
        
        # Add tags
        if resource.tags:
            log_group_arn = f"arn:aws:logs:{self.session.region_name}:{self._get_account_id()}:log-group:{log_group_name}"
            self.logs_client.tag_log_group(
                logGroupName=log_group_name,
                tags=resource.tags
            )
            resource.physical_id = log_group_arn
        else:
            resource.physical_id = f"arn:aws:logs:{self.session.region_name}:{self._get_account_id()}:log-group:{log_group_name}"
        
        return resource

    def _update_log_group(self, resource: Resource) -> Resource:
        """Update an existing CloudWatch log group.
        
        Args:
            resource: Resource definition with updates
            
        Returns:
            Updated resource
        """
        log_group_name = resource.properties['LogGroupName']
        
        # Update retention policy if specified
        if 'RetentionInDays' in resource.properties:
            self.logs_client.put_retention_policy(
                logGroupName=log_group_name,
                retentionInDays=resource.properties['RetentionInDays']
            )
        
        # Update tags
        if resource.tags:
            self.logs_client.tag_log_group(
                logGroupName=log_group_name,
                tags=resource.tags
            )
        
        return resource

    def _get_alarm_state(self, resource_id: str) -> Optional[Resource]:
        """Get current state of a CloudWatch alarm.
        
        Args:
            resource_id: Logical resource ID
            
        Returns:
            Current resource state or None
        """
        alarm_name = resource_id.replace('alarm-', '')
        
        try:
            response = self.cloudwatch_client.describe_alarms(AlarmNames=[alarm_name])
            
            if not response['MetricAlarms']:
                return None
            
            alarm = response['MetricAlarms'][0]
            
            # Get tags
            alarm_arn = alarm['AlarmArn']
            tags_response = self.cloudwatch_client.list_tags_for_resource(ResourceARN=alarm_arn)
            tags = {tag['Key']: tag['Value'] for tag in tags_response.get('Tags', [])}
            
            return Resource(
                id=resource_id,
                type='AWS::CloudWatch::Alarm',
                physical_id=alarm_arn,
                properties={
                    'ResourceType': 'Alarm',
                    'AlarmName': alarm['AlarmName'],
                    'AlarmDescription': alarm.get('AlarmDescription'),
                    'ComparisonOperator': alarm['ComparisonOperator'],
                    'EvaluationPeriods': alarm['EvaluationPeriods'],
                    'MetricName': alarm['MetricName'],
                    'Namespace': alarm['Namespace'],
                    'Period': alarm['Period'],
                    'Statistic': alarm.get('Statistic'),
                    'Threshold': alarm['Threshold'],
                    'ActionsEnabled': alarm.get('ActionsEnabled'),
                    'AlarmActions': alarm.get('AlarmActions', []),
                    'Dimensions': alarm.get('Dimensions', []),
                    'TreatMissingData': alarm.get('TreatMissingData'),
                    'DatapointsToAlarm': alarm.get('DatapointsToAlarm'),
                },
                dependencies=[],
                tags=tags
            )
            
        except ClientError as e:
            if e.response['Error']['Code'] == 'ResourceNotFoundException':
                return None
            raise

    def _get_log_group_state(self, resource_id: str) -> Optional[Resource]:
        """Get current state of a CloudWatch log group.
        
        Args:
            resource_id: Logical resource ID
            
        Returns:
            Current resource state or None
        """
        log_group_name = resource_id.replace('loggroup-', '')
        
        try:
            response = self.logs_client.describe_log_groups(
                logGroupNamePrefix=log_group_name,
                limit=1
            )
            
            if not response['logGroups']:
                return None
            
            log_group = response['logGroups'][0]
            
            # Verify exact match
            if log_group['logGroupName'] != log_group_name:
                return None
            
            # Get tags
            tags_response = self.logs_client.list_tags_log_group(logGroupName=log_group_name)
            tags = tags_response.get('tags', {})
            
            return Resource(
                id=resource_id,
                type='AWS::Logs::LogGroup',
                physical_id=log_group['arn'],
                properties={
                    'ResourceType': 'LogGroup',
                    'LogGroupName': log_group['logGroupName'],
                    'RetentionInDays': log_group.get('retentionInDays'),
                },
                dependencies=[],
                tags=tags
            )
            
        except ClientError as e:
            if e.response['Error']['Code'] == 'ResourceNotFoundException':
                return None
            raise

    def _needs_update(self, desired: Resource, current: Resource) -> bool:
        """Check if CloudWatch resource needs updates.
        
        Args:
            desired: Desired state
            current: Current state
            
        Returns:
            True if updates are needed
        """
        resource_type = desired.properties.get('ResourceType', 'Alarm')
        
        if resource_type == 'Alarm':
            # Check alarm configuration changes
            alarm_fields = [
                'ComparisonOperator', 'EvaluationPeriods', 'MetricName',
                'Namespace', 'Period', 'Statistic', 'Threshold',
                'AlarmDescription', 'ActionsEnabled', 'AlarmActions',
                'Dimensions', 'TreatMissingData', 'DatapointsToAlarm'
            ]
            
            for field in alarm_fields:
                if field in desired.properties:
                    if desired.properties[field] != current.properties.get(field):
                        return True
        
        elif resource_type == 'LogGroup':
            # Check log group configuration changes
            if 'RetentionInDays' in desired.properties:
                if desired.properties['RetentionInDays'] != current.properties.get('RetentionInDays'):
                    return True
        
        # Check tags
        if desired.tags != current.tags:
            return True
        
        return False

    def _get_account_id(self) -> str:
        """Get AWS account ID.
        
        Returns:
            AWS account ID
        """
        sts_client = self.session.client('sts')
        return sts_client.get_caller_identity()['Account']

    @staticmethod
    def build_lambda_error_alarm(
        function_name: str,
        alarm_name: str,
        threshold: float = 1.0,
        evaluation_periods: int = 1,
        sns_topic_arn: Optional[str] = None
    ) -> Dict[str, Any]:
        """Build CloudWatch alarm for Lambda function errors.
        
        Args:
            function_name: Name of the Lambda function
            alarm_name: Name for the alarm
            threshold: Error count threshold
            evaluation_periods: Number of periods to evaluate
            sns_topic_arn: Optional SNS topic ARN for notifications
            
        Returns:
            Alarm configuration dictionary
        """
        alarm_config = {
            'AlarmName': alarm_name,
            'AlarmDescription': f'Alarm for errors in Lambda function {function_name}',
            'MetricName': 'Errors',
            'Namespace': 'AWS/Lambda',
            'Statistic': 'Sum',
            'Period': 300,  # 5 minutes
            'EvaluationPeriods': evaluation_periods,
            'Threshold': threshold,
            'ComparisonOperator': 'GreaterThanOrEqualToThreshold',
            'Dimensions': [
                {
                    'Name': 'FunctionName',
                    'Value': function_name
                }
            ],
            'TreatMissingData': 'notBreaching',
            'ActionsEnabled': True,
        }
        
        if sns_topic_arn:
            alarm_config['AlarmActions'] = [sns_topic_arn]
        
        return alarm_config

    @staticmethod
    def build_lambda_throttle_alarm(
        function_name: str,
        alarm_name: str,
        threshold: float = 1.0,
        evaluation_periods: int = 2,
        sns_topic_arn: Optional[str] = None
    ) -> Dict[str, Any]:
        """Build CloudWatch alarm for Lambda function throttles.
        
        Args:
            function_name: Name of the Lambda function
            alarm_name: Name for the alarm
            threshold: Throttle count threshold
            evaluation_periods: Number of periods to evaluate
            sns_topic_arn: Optional SNS topic ARN for notifications
            
        Returns:
            Alarm configuration dictionary
        """
        alarm_config = {
            'AlarmName': alarm_name,
            'AlarmDescription': f'Alarm for throttles in Lambda function {function_name}',
            'MetricName': 'Throttles',
            'Namespace': 'AWS/Lambda',
            'Statistic': 'Sum',
            'Period': 300,  # 5 minutes
            'EvaluationPeriods': evaluation_periods,
            'Threshold': threshold,
            'ComparisonOperator': 'GreaterThanOrEqualToThreshold',
            'Dimensions': [
                {
                    'Name': 'FunctionName',
                    'Value': function_name
                }
            ],
            'TreatMissingData': 'notBreaching',
            'ActionsEnabled': True,
        }
        
        if sns_topic_arn:
            alarm_config['AlarmActions'] = [sns_topic_arn]
        
        return alarm_config

    @staticmethod
    def build_lambda_duration_alarm(
        function_name: str,
        alarm_name: str,
        threshold: float,
        evaluation_periods: int = 2,
        sns_topic_arn: Optional[str] = None
    ) -> Dict[str, Any]:
        """Build CloudWatch alarm for Lambda function duration.
        
        Args:
            function_name: Name of the Lambda function
            alarm_name: Name for the alarm
            threshold: Duration threshold in milliseconds
            evaluation_periods: Number of periods to evaluate
            sns_topic_arn: Optional SNS topic ARN for notifications
            
        Returns:
            Alarm configuration dictionary
        """
        alarm_config = {
            'AlarmName': alarm_name,
            'AlarmDescription': f'Alarm for high duration in Lambda function {function_name}',
            'MetricName': 'Duration',
            'Namespace': 'AWS/Lambda',
            'Statistic': 'Average',
            'Period': 300,  # 5 minutes
            'EvaluationPeriods': evaluation_periods,
            'Threshold': threshold,
            'ComparisonOperator': 'GreaterThanOrEqualToThreshold',
            'Dimensions': [
                {
                    'Name': 'FunctionName',
                    'Value': function_name
                }
            ],
            'TreatMissingData': 'notBreaching',
            'ActionsEnabled': True,
            'Unit': 'Milliseconds',
        }
        
        if sns_topic_arn:
            alarm_config['AlarmActions'] = [sns_topic_arn]
        
        return alarm_config

    @staticmethod
    def build_api_gateway_5xx_alarm(
        api_name: str,
        alarm_name: str,
        threshold: float = 5.0,
        evaluation_periods: int = 2,
        sns_topic_arn: Optional[str] = None
    ) -> Dict[str, Any]:
        """Build CloudWatch alarm for API Gateway 5XX errors.
        
        Args:
            api_name: Name of the API Gateway
            alarm_name: Name for the alarm
            threshold: Error count threshold
            evaluation_periods: Number of periods to evaluate
            sns_topic_arn: Optional SNS topic ARN for notifications
            
        Returns:
            Alarm configuration dictionary
        """
        alarm_config = {
            'AlarmName': alarm_name,
            'AlarmDescription': f'Alarm for 5XX errors in API Gateway {api_name}',
            'MetricName': '5XXError',
            'Namespace': 'AWS/ApiGateway',
            'Statistic': 'Sum',
            'Period': 300,  # 5 minutes
            'EvaluationPeriods': evaluation_periods,
            'Threshold': threshold,
            'ComparisonOperator': 'GreaterThanOrEqualToThreshold',
            'Dimensions': [
                {
                    'Name': 'ApiName',
                    'Value': api_name
                }
            ],
            'TreatMissingData': 'notBreaching',
            'ActionsEnabled': True,
        }
        
        if sns_topic_arn:
            alarm_config['AlarmActions'] = [sns_topic_arn]
        
        return alarm_config

    @staticmethod
    def build_dynamodb_throttle_alarm(
        table_name: str,
        alarm_name: str,
        threshold: float = 5.0,
        evaluation_periods: int = 2,
        sns_topic_arn: Optional[str] = None
    ) -> Dict[str, Any]:
        """Build CloudWatch alarm for DynamoDB throttled requests.
        
        Args:
            table_name: Name of the DynamoDB table
            alarm_name: Name for the alarm
            threshold: Throttle count threshold
            evaluation_periods: Number of periods to evaluate
            sns_topic_arn: Optional SNS topic ARN for notifications
            
        Returns:
            Alarm configuration dictionary
        """
        alarm_config = {
            'AlarmName': alarm_name,
            'AlarmDescription': f'Alarm for throttled requests in DynamoDB table {table_name}',
            'MetricName': 'UserErrors',
            'Namespace': 'AWS/DynamoDB',
            'Statistic': 'Sum',
            'Period': 300,  # 5 minutes
            'EvaluationPeriods': evaluation_periods,
            'Threshold': threshold,
            'ComparisonOperator': 'GreaterThanOrEqualToThreshold',
            'Dimensions': [
                {
                    'Name': 'TableName',
                    'Value': table_name
                }
            ],
            'TreatMissingData': 'notBreaching',
            'ActionsEnabled': True,
        }
        
        if sns_topic_arn:
            alarm_config['AlarmActions'] = [sns_topic_arn]
        
        return alarm_config

    @staticmethod
    def build_log_group_config(
        log_group_name: str,
        retention_days: int = 7
    ) -> Dict[str, Any]:
        """Build CloudWatch log group configuration.
        
        Args:
            log_group_name: Name of the log group
            retention_days: Number of days to retain logs (1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1827, 3653)
            
        Returns:
            Log group configuration dictionary
        """
        return {
            'LogGroupName': log_group_name,
            'RetentionInDays': retention_days,
        }

    @staticmethod
    def put_deployment_metric(
        cloudwatch_client,
        namespace: str,
        metric_name: str,
        value: float,
        unit: str = 'None',
        dimensions: Optional[List[Dict[str, str]]] = None
    ) -> None:
        """Put a custom metric for deployment operations.
        
        Args:
            cloudwatch_client: CloudWatch client
            namespace: Metric namespace (e.g., 'StrandsDeployment')
            metric_name: Name of the metric
            value: Metric value
            unit: Metric unit
            dimensions: Optional metric dimensions
        """
        metric_data = {
            'MetricName': metric_name,
            'Value': value,
            'Unit': unit,
        }
        
        if dimensions:
            metric_data['Dimensions'] = dimensions
        
        cloudwatch_client.put_metric_data(
            Namespace=namespace,
            MetricData=[metric_data]
        )
