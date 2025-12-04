"""Output command for showing stack outputs."""

import click
from rich.console import Console
from rich.table import Table
from rich.panel import Panel
from rich.syntax import Syntax
import json

from ..state.manager import StateManager
from ..utils.logging import get_logger

logger = get_logger(__name__)
console = Console()


@click.command()
@click.option('--env', required=True, help='Environment name')
@click.option('--agent', help='Specific agent to show outputs for')
@click.option('--format', type=click.Choice(['table', 'json', 'env']), default='table', help='Output format')
@click.option('--output-name', help='Show specific output value')
def output(env: str, agent: str, format: str, output_name: str):
    """Show stack outputs (endpoints, ARNs, etc.)."""
    try:
        # Load state
        state_manager = StateManager(f'.strands/state/{env}.json')
        state = state_manager.load()
        
        # Collect outputs
        outputs = _collect_outputs(state, agent)
        
        if not outputs:
            console.print("[dim]No outputs found[/dim]")
            return
        
        # Filter by output name if specified
        if output_name:
            if output_name in outputs:
                console.print(outputs[output_name])
            else:
                console.print(f"[red]Output '{output_name}' not found[/red]")
            return
        
        # Display based on format
        if format == 'table':
            _output_table(outputs, env, agent)
        elif format == 'json':
            _output_json(outputs)
        elif format == 'env':
            _output_env(outputs)
            
    except FileNotFoundError:
        console.print(f"[red]Error: State file not found for environment '{env}'[/red]")
        console.print("[dim]Have you deployed to this environment yet?[/dim]")
    except Exception as e:
        console.print(f"[red]Error: {e}[/red]")
        logger.exception("Failed to show outputs")


def _collect_outputs(state, agent_filter: str) -> dict:
    """Collect outputs from state."""
    outputs = {}
    
    for stack_name, stack in state.stacks.items():
        if agent_filter and agent_filter not in stack_name:
            continue
        
        for resource_id, resource in stack.resources.items():
            # Lambda function outputs
            if resource.type == 'AWS::Lambda::Function':
                outputs[f'{resource_id}_arn'] = resource.physical_id
                outputs[f'{resource_id}_name'] = resource.properties.get('FunctionName', 'N/A')
                
                if 'function_url' in resource.properties:
                    outputs[f'{resource_id}_url'] = resource.properties['function_url']
            
            # API Gateway outputs
            elif resource.type in ['AWS::ApiGateway::RestApi', 'AWS::ApiGatewayV2::Api']:
                outputs[f'{resource_id}_id'] = resource.physical_id
                
                if 'api_endpoint' in resource.properties:
                    outputs[f'{resource_id}_endpoint'] = resource.properties['api_endpoint']
            
            # S3 bucket outputs
            elif resource.type == 'AWS::S3::Bucket':
                outputs[f'{resource_id}_name'] = resource.properties.get('BucketName', 'N/A')
                outputs[f'{resource_id}_arn'] = f"arn:aws:s3:::{resource.properties.get('BucketName', '')}"
            
            # DynamoDB table outputs
            elif resource.type == 'AWS::DynamoDB::Table':
                outputs[f'{resource_id}_name'] = resource.properties.get('TableName', 'N/A')
                outputs[f'{resource_id}_arn'] = resource.physical_id
            
            # SQS queue outputs
            elif resource.type == 'AWS::SQS::Queue':
                outputs[f'{resource_id}_url'] = resource.physical_id
                outputs[f'{resource_id}_arn'] = resource.properties.get('QueueArn', 'N/A')
            
            # SNS topic outputs
            elif resource.type == 'AWS::SNS::Topic':
                outputs[f'{resource_id}_arn'] = resource.physical_id
            
            # VPC outputs
            elif resource.type == 'AWS::EC2::VPC':
                outputs[f'{resource_id}_id'] = resource.physical_id
                outputs[f'{resource_id}_cidr'] = resource.properties.get('CidrBlock', 'N/A')
            
            # Security group outputs
            elif resource.type == 'AWS::EC2::SecurityGroup':
                outputs[f'{resource_id}_id'] = resource.physical_id
            
            # IAM role outputs
            elif resource.type == 'AWS::IAM::Role':
                outputs[f'{resource_id}_arn'] = resource.physical_id
                outputs[f'{resource_id}_name'] = resource.properties.get('RoleName', 'N/A')
    
    return outputs


def _output_table(outputs: dict, env: str, agent: str):
    """Output in table format."""
    title = f"Stack Outputs - Environment: {env}"
    if agent:
        title += f" (Agent: {agent})"
    
    console.print(Panel(title, style="bold blue"))
    console.print()
    
    table = Table(show_header=True, header_style="bold")
    table.add_column("Output Name", style="cyan")
    table.add_column("Value", style="white")
    
    for name, value in sorted(outputs.items()):
        table.add_row(name, value)
    
    console.print(table)


def _output_json(outputs: dict):
    """Output in JSON format."""
    console.print_json(data=outputs)


def _output_env(outputs: dict):
    """Output in environment variable format."""
    for name, value in sorted(outputs.items()):
        # Convert to uppercase and replace special chars
        env_name = name.upper().replace('-', '_').replace('.', '_')
        console.print(f'export {env_name}="{value}"')
