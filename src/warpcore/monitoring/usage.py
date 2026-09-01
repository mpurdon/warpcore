"""Read live usage metrics for a deployed resource.

MetricsCollector emits warpcore's own deployment metrics. This reads the
other direction: what a deployed resource is actually doing in AWS right now,
which is the first thing you want when debugging "it deployed fine but it is
not working".
"""

from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Dict, List, Optional

import boto3
from botocore.exceptions import ClientError

from warpcore.utils.arn import parse_arn, service_identifier
from warpcore.utils.logging import get_logger

logger = get_logger(__name__)


@dataclass
class MetricSeries:
    """One CloudWatch metric summarised over the requested window."""

    name: str
    namespace: str
    statistic: str
    unit: str = ""
    total: Optional[float] = None
    average: Optional[float] = None
    maximum: Optional[float] = None
    latest: Optional[float] = None
    datapoints: int = 0
    error: Optional[str] = None


@dataclass
class LogEvent:
    """A recent log line."""

    timestamp: datetime
    message: str
    stream: str = ""


@dataclass
class ResourceUsage:
    """Everything the debug view knows about a resource's live behaviour."""

    resource_id: str
    resource_type: str
    physical_id: Optional[str]
    window_hours: int
    metrics: List[MetricSeries] = field(default_factory=list)
    recent_errors: List[LogEvent] = field(default_factory=list)
    log_group: Optional[str] = None
    notes: List[str] = field(default_factory=list)

    def has_metrics(self) -> bool:
        return any(m.datapoints for m in self.metrics)


# (metric name, statistic, namespace-relative dimension) per resource type.
_METRIC_SPECS: Dict[str, List[tuple]] = {
    "AWS::Lambda::Function": [
        ("AWS/Lambda", "Invocations", "Sum", "Count"),
        ("AWS/Lambda", "Errors", "Sum", "Count"),
        ("AWS/Lambda", "Throttles", "Sum", "Count"),
        ("AWS/Lambda", "Duration", "Average", "Milliseconds"),
        ("AWS/Lambda", "Duration", "Maximum", "Milliseconds"),
        ("AWS/Lambda", "ConcurrentExecutions", "Maximum", "Count"),
    ],
    "AWS::DynamoDB::Table": [
        ("AWS/DynamoDB", "ConsumedReadCapacityUnits", "Sum", "Count"),
        ("AWS/DynamoDB", "ConsumedWriteCapacityUnits", "Sum", "Count"),
        ("AWS/DynamoDB", "ThrottledRequests", "Sum", "Count"),
        ("AWS/DynamoDB", "UserErrors", "Sum", "Count"),
    ],
    "AWS::SQS::Queue": [
        ("AWS/SQS", "ApproximateNumberOfMessagesVisible", "Maximum", "Count"),
        ("AWS/SQS", "ApproximateAgeOfOldestMessage", "Maximum", "Seconds"),
        ("AWS/SQS", "NumberOfMessagesSent", "Sum", "Count"),
        ("AWS/SQS", "NumberOfMessagesDeleted", "Sum", "Count"),
    ],
    "AWS::SNS::Topic": [
        ("AWS/SNS", "NumberOfMessagesPublished", "Sum", "Count"),
        ("AWS/SNS", "NumberOfNotificationsFailed", "Sum", "Count"),
    ],
    "AWS::ApiGatewayV2::Api": [
        ("AWS/ApiGateway", "Count", "Sum", "Count"),
        ("AWS/ApiGateway", "4XXError", "Sum", "Count"),
        ("AWS/ApiGateway", "5XXError", "Sum", "Count"),
        ("AWS/ApiGateway", "Latency", "Average", "Milliseconds"),
    ],
}

# The CloudWatch dimension name each service keys its metrics by.
_DIMENSION_NAMES = {
    "AWS::Lambda::Function": "FunctionName",
    "AWS::DynamoDB::Table": "TableName",
    "AWS::SQS::Queue": "QueueName",
    "AWS::SNS::Topic": "TopicName",
    "AWS::ApiGatewayV2::Api": "ApiId",
}


class ResourceUsageReader:
    """Queries CloudWatch metrics and logs for one resource."""

    def __init__(self, boto_session: boto3.Session, region: str):
        self.session = boto_session
        self.region = region
        self.logger = get_logger(__name__)

    def read(
        self,
        resource_id: str,
        resource_type: str,
        physical_id: Optional[str],
        window_hours: int = 24,
        error_log_limit: int = 20,
    ) -> ResourceUsage:
        """Collect metrics and recent errors for a resource."""
        usage = ResourceUsage(
            resource_id=resource_id,
            resource_type=resource_type,
            physical_id=physical_id,
            window_hours=window_hours,
        )

        specs = _METRIC_SPECS.get(resource_type)
        if not specs:
            usage.notes.append(f"No usage metrics are defined for {resource_type}")
            return usage

        dimension_name = _DIMENSION_NAMES.get(resource_type)
        dimension_value = self._dimension_value(resource_type, resource_id, physical_id)
        if not dimension_value:
            usage.notes.append("Could not determine the CloudWatch dimension for this resource")
            return usage

        cloudwatch = self.session.client("cloudwatch", region_name=self.region)
        end = datetime.utcnow()
        start = end - timedelta(hours=window_hours)
        # One datapoint per hour keeps the response small while still showing shape.
        period = max(300, (window_hours * 3600) // 24)

        for namespace, metric_name, statistic, unit in specs:
            usage.metrics.append(self._read_metric(
                cloudwatch=cloudwatch,
                namespace=namespace,
                metric_name=metric_name,
                statistic=statistic,
                unit=unit,
                dimensions=[{"Name": dimension_name, "Value": dimension_value}],
                start=start,
                end=end,
                period=period,
            ))

        if resource_type == "AWS::Lambda::Function":
            usage.log_group = f"/aws/lambda/{dimension_value}"
            usage.recent_errors = self._read_recent_errors(
                usage.log_group, start, error_log_limit
            )

        return usage

    def _dimension_value(
        self, resource_type: str, resource_id: str, physical_id: Optional[str]
    ) -> Optional[str]:
        """The identifier CloudWatch keys this resource's metrics by."""
        if not physical_id:
            return resource_id
        parsed = parse_arn(physical_id)
        if parsed is None:
            return physical_id
        if resource_type == "AWS::SQS::Queue":
            # SQS metrics use the bare queue name, not the URL that the SQS
            # API itself wants.
            return parsed.resource_id
        return service_identifier(physical_id)

    def _read_metric(
        self,
        cloudwatch,
        namespace: str,
        metric_name: str,
        statistic: str,
        unit: str,
        dimensions: List[Dict[str, str]],
        start: datetime,
        end: datetime,
        period: int,
    ) -> MetricSeries:
        """Fetch and summarise a single metric."""
        series = MetricSeries(
            name=metric_name, namespace=namespace, statistic=statistic, unit=unit
        )
        try:
            response = cloudwatch.get_metric_statistics(
                Namespace=namespace,
                MetricName=metric_name,
                Dimensions=dimensions,
                StartTime=start,
                EndTime=end,
                Period=period,
                Statistics=[statistic],
            )
        except ClientError as e:
            series.error = str(e)
            return series

        datapoints = sorted(
            response.get("Datapoints", []), key=lambda d: d["Timestamp"]
        )
        series.datapoints = len(datapoints)
        if not datapoints:
            return series

        values = [d[statistic] for d in datapoints]
        series.total = sum(values)
        series.average = sum(values) / len(values)
        series.maximum = max(values)
        series.latest = values[-1]
        return series

    def _read_recent_errors(
        self, log_group: str, start: datetime, limit: int
    ) -> List[LogEvent]:
        """Pull recent ERROR/Exception lines out of a log group."""
        logs = self.session.client("logs", region_name=self.region)
        try:
            response = logs.filter_log_events(
                logGroupName=log_group,
                startTime=int(start.timestamp() * 1000),
                filterPattern="?ERROR ?Error ?Exception ?Traceback ?CRITICAL",
                limit=limit,
            )
        except ClientError as e:
            code = e.response.get("Error", {}).get("Code")
            if code == "ResourceNotFoundException":
                return []
            self.logger.debug(f"Could not read log group {log_group}: {e}")
            return []

        return [
            LogEvent(
                timestamp=datetime.utcfromtimestamp(event["timestamp"] / 1000),
                message=event.get("message", "").rstrip(),
                stream=event.get("logStreamName", ""),
            )
            for event in response.get("events", [])
        ]
