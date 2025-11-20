"""Example of using monitoring and observability features."""

import boto3
from datetime import datetime, timedelta

from strands_deploy.monitoring import AlarmManager, MetricsCollector, XRayConfig, XRayManager
from strands_deploy.provisioners.cloudwatch import CloudWatchProvisioner
from strands_deploy.config.models import AgentConfig


def setup_monitoring_for_agent():
    """Example: Set up monitoring for a deployed agent."""
    
    # Initialize AWS session
    session = boto3.Session(region_name='us-east-1')
    
    # Create provisioners and managers
    cloudwatch_provisioner = CloudWatchProvisioner(session)
    alarm_manager = AlarmManager(cloudwatch_provisioner)
    
    # Agent configuration
    agent_config = AgentConfig(
        name='customer-support-agent',
        path='./apps/customer-support',
        runtime='python3.11',
        memory=1024,
        timeout=60,
        environment={'MODEL': 'claude-3-sonnet'},
        handler='main.handler'
    )
    
    # Create CloudWatch alarms for Lambda function
    print("Creating CloudWatch alarms...")
    alarms = alarm_manager.create_lambda_alarms(
        function_name=agent_config.name,
        agent_config=agent_config,
        sns_topic_arn='arn:aws:sns:us-east-1:123456789012:alerts',
        tags={
            'Project': 'my-project',
            'Environment': 'prod',
            'Agent': agent_config.name
        }
    )
    
    # Provision the alarms
    provisioned_alarms = alarm_manager.provision_alarms(alarms)
    print(f"Created {len(provisioned_alarms)} alarms")
    
    # Create log group with retention
    log_group = alarm_manager.create_log_group(
        log_group_name=f'/aws/lambda/{agent_config.name}',
        retention_days=7,
        tags={
            'Project': 'my-project',
            'Environment': 'prod'
        }
    )
    print(f"Created log group: {log_group.properties['LogGroupName']}")


def configure_xray_tracing():
    """Example: Configure X-Ray tracing for agents."""
    
    # Build Lambda configuration with X-Ray
    lambda_config = {
        'FunctionName': 'customer-support-agent',
        'Runtime': 'python3.11',
        'Role': 'arn:aws:iam::123456789012:role/lambda-execution',
        'Handler': 'main.handler',
        'MemorySize': 1024,
        'Timeout': 60,
    }
    
    # Configure X-Ray tracing
    lambda_config = XRayConfig.configure_lambda_for_xray(
        lambda_config=lambda_config,
        agent_name='customer-support-agent',
        enable_tracing=True
    )
    
    print("Lambda configuration with X-Ray:")
    print(f"  TracingConfig: {lambda_config['TracingConfig']}")
    print(f"  X-Ray Environment Variables: {lambda_config['Environment']['Variables']}")
    
    # Create sampling rules for multiple agents
    agents = [
        AgentConfig(
            name='customer-support-agent',
            path='./apps/customer-support',
            runtime='python3.11',
            memory=1024,
            timeout=60,
            environment={'ENV': 'prod'},
            handler='main.handler'
        ),
        AgentConfig(
            name='data-analysis-agent',
            path='./apps/data-analysis',
            runtime='python3.11',
            memory=2048,
            timeout=120,
            environment={'ENV': 'prod'},
            handler='main.handler'
        ),
    ]
    
    sampling_rules = XRayConfig.create_sampling_rules_for_agents(
        agents=agents,
        default_fixed_rate=0.05,
        production_fixed_rate=0.01
    )
    
    print(f"\nCreated {len(sampling_rules)} X-Ray sampling rules")
    for rule in sampling_rules:
        print(f"  - {rule['RuleName']}: {rule['FixedRate']} fixed rate")


def collect_deployment_metrics():
    """Example: Collect metrics during deployment."""
    
    # Initialize metrics collector
    session = boto3.Session(region_name='us-east-1')
    cloudwatch_client = session.client('cloudwatch')
    
    with MetricsCollector(cloudwatch_client, namespace='StrandsDeployment') as metrics:
        # Record deployment start
        metrics.record_deployment_start(
            project_name='my-project',
            environment='prod',
            agent_count=3
        )
        
        # Simulate deployment
        start_time = datetime.utcnow()
        
        # Record resource provisioning
        metrics.record_resource_provisioned(
            project_name='my-project',
            environment='prod',
            resource_type='AWS::Lambda::Function',
            duration_seconds=12.5,
            success=True
        )
        
        metrics.record_resource_provisioned(
            project_name='my-project',
            environment='prod',
            resource_type='AWS::IAM::Role',
            duration_seconds=3.2,
            success=True
        )
        
        # Record deployment completion
        end_time = datetime.utcnow()
        duration = (end_time - start_time).total_seconds()
        
        metrics.record_deployment_complete(
            project_name='my-project',
            environment='prod',
            duration_seconds=duration,
            success=True,
            resource_count=15
        )
        
        # Record parallel efficiency
        metrics.record_parallel_efficiency(
            project_name='my-project',
            environment='prod',
            efficiency_percent=67.5
        )
        
        print("Recorded deployment metrics")
        # Metrics are automatically flushed when exiting context manager


def query_xray_traces():
    """Example: Query X-Ray traces for analysis."""
    
    # Initialize X-Ray manager
    session = boto3.Session(region_name='us-east-1')
    xray_client = session.client('xray')
    xray_manager = XRayManager(xray_client)
    
    # Get traces from last hour
    end_time = datetime.utcnow()
    start_time = end_time - timedelta(hours=1)
    
    # Query traces with errors
    filter_expression = XRayConfig.get_trace_query_filter(
        service_name='customer-support-agent',
        error_only=True
    )
    
    print(f"Querying X-Ray traces with filter: {filter_expression}")
    
    traces = xray_manager.get_trace_summaries(
        start_time=start_time,
        end_time=end_time,
        filter_expression=filter_expression
    )
    
    print(f"Found {len(traces)} traces with errors")
    
    for trace in traces[:5]:  # Show first 5
        print(f"  - Trace ID: {trace['Id']}")
        print(f"    Duration: {trace.get('Duration', 0):.2f}s")
        print(f"    Response Time: {trace.get('ResponseTime', 0):.2f}s")
        if trace.get('HasError'):
            print(f"    Error: Yes")
    
    # Get service graph
    service_graph = xray_manager.get_service_graph(
        start_time=start_time,
        end_time=end_time
    )
    
    print(f"\nService Graph:")
    print(f"  Services: {len(service_graph['Services'])}")
    for service in service_graph['Services']:
        print(f"    - {service.get('Name', 'Unknown')}")


def create_custom_alarms():
    """Example: Create custom CloudWatch alarms."""
    
    session = boto3.Session(region_name='us-east-1')
    cloudwatch_provisioner = CloudWatchProvisioner(session)
    
    # Build custom alarm configuration
    alarm_config = {
        'AlarmName': 'high-memory-usage',
        'AlarmDescription': 'Alert when Lambda memory usage is high',
        'MetricName': 'MemoryUtilization',
        'Namespace': 'AWS/Lambda',
        'Statistic': 'Average',
        'Period': 300,
        'EvaluationPeriods': 2,
        'Threshold': 80.0,
        'ComparisonOperator': 'GreaterThanThreshold',
        'Dimensions': [
            {
                'Name': 'FunctionName',
                'Value': 'customer-support-agent'
            }
        ],
        'TreatMissingData': 'notBreaching',
        'ActionsEnabled': True,
        'AlarmActions': ['arn:aws:sns:us-east-1:123456789012:alerts']
    }
    
    from strands_deploy.provisioners.base import Resource
    
    alarm_resource = Resource(
        id='alarm-high-memory',
        type='AWS::CloudWatch::Alarm',
        physical_id=None,
        properties={
            'ResourceType': 'Alarm',
            **alarm_config
        },
        dependencies=[],
        tags={'Project': 'my-project'}
    )
    
    # Provision the alarm
    plan = cloudwatch_provisioner.plan(alarm_resource, None)
    result = cloudwatch_provisioner.provision(plan)
    
    print(f"Created custom alarm: {result.physical_id}")


if __name__ == '__main__':
    print("=== Monitoring and Observability Examples ===\n")
    
    print("1. Setting up monitoring for agent...")
    # setup_monitoring_for_agent()  # Uncomment to run
    
    print("\n2. Configuring X-Ray tracing...")
    configure_xray_tracing()
    
    print("\n3. Collecting deployment metrics...")
    # collect_deployment_metrics()  # Uncomment to run
    
    print("\n4. Querying X-Ray traces...")
    # query_xray_traces()  # Uncomment to run
    
    print("\n5. Creating custom alarms...")
    # create_custom_alarms()  # Uncomment to run
    
    print("\nExamples completed!")
