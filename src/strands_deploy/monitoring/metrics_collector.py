"""Metrics collector for deployment operations."""

from typing import Dict, Any, Optional, List
from datetime import datetime
import logging

logger = logging.getLogger(__name__)


class MetricsCollector:
    """Collects and publishes metrics for deployment operations."""

    def __init__(self, cloudwatch_client, namespace: str = 'StrandsDeployment'):
        """Initialize metrics collector.
        
        Args:
            cloudwatch_client: CloudWatch client
            namespace: Metric namespace
        """
        self.cloudwatch = cloudwatch_client
        self.namespace = namespace
        self.metrics_buffer = []

    def record_deployment_start(
        self,
        project_name: str,
        environment: str,
        agent_count: int
    ) -> None:
        """Record deployment start event.
        
        Args:
            project_name: Name of the project
            environment: Environment name
            agent_count: Number of agents being deployed
        """
        self._add_metric(
            metric_name='DeploymentStarted',
            value=1.0,
            unit='Count',
            dimensions=[
                {'Name': 'Project', 'Value': project_name},
                {'Name': 'Environment', 'Value': environment},
            ]
        )
        
        self._add_metric(
            metric_name='AgentCount',
            value=float(agent_count),
            unit='Count',
            dimensions=[
                {'Name': 'Project', 'Value': project_name},
                {'Name': 'Environment', 'Value': environment},
            ]
        )

    def record_deployment_complete(
        self,
        project_name: str,
        environment: str,
        duration_seconds: float,
        success: bool,
        resource_count: int
    ) -> None:
        """Record deployment completion event.
        
        Args:
            project_name: Name of the project
            environment: Environment name
            duration_seconds: Deployment duration in seconds
            success: Whether deployment succeeded
            resource_count: Number of resources deployed
        """
        dimensions = [
            {'Name': 'Project', 'Value': project_name},
            {'Name': 'Environment', 'Value': environment},
            {'Name': 'Status', 'Value': 'Success' if success else 'Failed'},
        ]
        
        self._add_metric(
            metric_name='DeploymentCompleted',
            value=1.0,
            unit='Count',
            dimensions=dimensions
        )
        
        self._add_metric(
            metric_name='DeploymentDuration',
            value=duration_seconds,
            unit='Seconds',
            dimensions=dimensions
        )
        
        self._add_metric(
            metric_name='ResourceCount',
            value=float(resource_count),
            unit='Count',
            dimensions=dimensions
        )

    def record_resource_provisioned(
        self,
        project_name: str,
        environment: str,
        resource_type: str,
        duration_seconds: float,
        success: bool
    ) -> None:
        """Record resource provisioning event.
        
        Args:
            project_name: Name of the project
            environment: Environment name
            resource_type: Type of resource (e.g., 'AWS::Lambda::Function')
            duration_seconds: Provisioning duration in seconds
            success: Whether provisioning succeeded
        """
        dimensions = [
            {'Name': 'Project', 'Value': project_name},
            {'Name': 'Environment', 'Value': environment},
            {'Name': 'ResourceType', 'Value': resource_type},
            {'Name': 'Status', 'Value': 'Success' if success else 'Failed'},
        ]
        
        self._add_metric(
            metric_name='ResourceProvisioned',
            value=1.0,
            unit='Count',
            dimensions=dimensions
        )
        
        self._add_metric(
            metric_name='ResourceProvisioningDuration',
            value=duration_seconds,
            unit='Seconds',
            dimensions=dimensions
        )

    def record_deployment_error(
        self,
        project_name: str,
        environment: str,
        error_type: str
    ) -> None:
        """Record deployment error event.
        
        Args:
            project_name: Name of the project
            environment: Environment name
            error_type: Type of error
        """
        self._add_metric(
            metric_name='DeploymentError',
            value=1.0,
            unit='Count',
            dimensions=[
                {'Name': 'Project', 'Value': project_name},
                {'Name': 'Environment', 'Value': environment},
                {'Name': 'ErrorType', 'Value': error_type},
            ]
        )

    def record_parallel_efficiency(
        self,
        project_name: str,
        environment: str,
        efficiency_percent: float
    ) -> None:
        """Record parallel execution efficiency.
        
        Args:
            project_name: Name of the project
            environment: Environment name
            efficiency_percent: Efficiency percentage (0-100)
        """
        self._add_metric(
            metric_name='ParallelEfficiency',
            value=efficiency_percent,
            unit='Percent',
            dimensions=[
                {'Name': 'Project', 'Value': project_name},
                {'Name': 'Environment', 'Value': environment},
            ]
        )

    def record_state_operation(
        self,
        operation: str,
        duration_seconds: float
    ) -> None:
        """Record state file operation.
        
        Args:
            operation: Operation type ('load', 'save')
            duration_seconds: Operation duration in seconds
        """
        self._add_metric(
            metric_name='StateOperation',
            value=1.0,
            unit='Count',
            dimensions=[
                {'Name': 'Operation', 'Value': operation},
            ]
        )
        
        self._add_metric(
            metric_name='StateOperationDuration',
            value=duration_seconds,
            unit='Seconds',
            dimensions=[
                {'Name': 'Operation', 'Value': operation},
            ]
        )

    def flush(self) -> None:
        """Flush buffered metrics to CloudWatch."""
        if not self.metrics_buffer:
            return
        
        try:
            # CloudWatch allows up to 20 metrics per request
            batch_size = 20
            
            for i in range(0, len(self.metrics_buffer), batch_size):
                batch = self.metrics_buffer[i:i + batch_size]
                
                self.cloudwatch.put_metric_data(
                    Namespace=self.namespace,
                    MetricData=batch
                )
            
            logger.info(f"Flushed {len(self.metrics_buffer)} metrics to CloudWatch")
            self.metrics_buffer.clear()
            
        except Exception as e:
            logger.error(f"Failed to flush metrics to CloudWatch: {e}")
            # Don't raise - metrics are best-effort

    def _add_metric(
        self,
        metric_name: str,
        value: float,
        unit: str = 'None',
        dimensions: Optional[List[Dict[str, str]]] = None
    ) -> None:
        """Add a metric to the buffer.
        
        Args:
            metric_name: Name of the metric
            value: Metric value
            unit: Metric unit
            dimensions: Optional metric dimensions
        """
        metric_data = {
            'MetricName': metric_name,
            'Value': value,
            'Unit': unit,
            'Timestamp': datetime.utcnow(),
        }
        
        if dimensions:
            metric_data['Dimensions'] = dimensions
        
        self.metrics_buffer.append(metric_data)
        
        # Auto-flush if buffer is getting large
        if len(self.metrics_buffer) >= 100:
            self.flush()

    def __enter__(self):
        """Context manager entry."""
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        """Context manager exit - flush metrics."""
        self.flush()
