"""Main CLI entry point."""

import sys
import yaml
from pathlib import Path
from typing import Optional

import boto3
import click
from rich.console import Console
from rich.progress import Progress, SpinnerColumn, TextColumn, BarColumn, TaskProgressColumn
from rich.table import Table
from rich.panel import Panel

from warpcore.utils.logging import setup_logging, get_logger
from warpcore.cli.costs import costs
from warpcore.cli.agentic import agentic
from warpcore.cli.diff import diff
from warpcore.cli.validate import validate
from warpcore.cli.graph import graph
from warpcore.cli.output import output
from warpcore.cli.forecast import forecast
from warpcore.cli.limits import limits
from warpcore.cli.notifications import notifications
from warpcore.config.parser import Config, ConfigValidationError
from warpcore.state.manager import StateManager, StateNotFoundError
from warpcore.state.checkpoint import CheckpointManager
from warpcore.orchestrator.orchestrator import DeploymentOrchestrator
from warpcore.orchestrator.rollback import RollbackStrategy
from warpcore.orchestrator.executor import ExecutionStatus, ProgressCallback
from warpcore.utils.aws_client import AWSClientManager
from warpcore.utils.errors import DeploymentError
from warpcore.provisioners import (
    IAMRoleProvisioner,
    LambdaProvisioner,
    APIGatewayProvisioner,
    VPCProvisioner,
    SecurityGroupProvisioner,
    S3Provisioner,
    DynamoDBProvisioner,
    SQSProvisioner,
    SNSProvisioner
)

console = Console()
logger = get_logger(__name__)


@click.group()
@click.option('--profile', help='AWS profile to use')
@click.option('--region', help='AWS region')
@click.option('--log-level', default='info', type=click.Choice(['debug', 'info', 'warning', 'error']))
@click.pass_context
def cli(ctx, profile, region, log_level):
    """Warpcore."""
    ctx.ensure_object(dict)
    ctx.obj['profile'] = profile
    ctx.obj['region'] = region
    ctx.obj['log_level'] = log_level
    
    # Setup logging
    setup_logging(log_level)


# Add cost management commands
cli.add_command(costs)

# Add agentic reconciliation commands
cli.add_command(agentic)

# Add quick win commands
cli.add_command(diff)
cli.add_command(validate)
cli.add_command(graph)
cli.add_command(output)
cli.add_command(forecast)
cli.add_command(limits)
cli.add_command(notifications)


def load_config(config_path: str = "warpcore.yaml") -> Config:
    """Load and validate configuration file."""
    try:
        config = Config(config_path)
        config.load()
        return config
    except FileNotFoundError:
        console.print(f"[red]Error:[/red] Configuration file not found: {config_path}")
        console.print("\nRun [cyan]warpcore init[/cyan] to create a new configuration file.")
        sys.exit(1)
    except ConfigValidationError as e:
        console.print(f"[red]Configuration validation failed:[/red]\n")
        console.print(str(e))
        sys.exit(1)
    except Exception as e:
        console.print(f"[red]Error loading configuration:[/red] {e}")
        sys.exit(1)


def get_state_path(environment: str, project_name: str) -> Path:
    """Get state file path for environment."""
    state_dir = Path.cwd() / ".warpcore" / "state"
    return state_dir / f"{project_name}-{environment}.json"


def create_orchestrator(
    config: Config,
    environment: str,
    profile: Optional[str] = None,
    region: Optional[str] = None
) -> DeploymentOrchestrator:
    """Create deployment orchestrator with all dependencies."""
    # Get environment configuration
    env_config = config.get_environment(environment)
    
    # Use environment region if not overridden
    aws_region = region or env_config.region
    
    # Create boto3 session
    try:
        client_manager = AWSClientManager(profile=profile, region=aws_region)
        boto_session = client_manager.session
    except Exception as e:
        console.print(f"[red]Error creating AWS session:[/red] {e}")
        sys.exit(1)
    
    # Create state manager
    state_path = get_state_path(environment, config.project.name)
    state_manager = StateManager(str(state_path))
    
    # Initialize state if it doesn't exist
    if not state_manager.exists():
        console.print(f"[yellow]Initializing new state file:[/yellow] {state_path}")
        state_manager.initialize(
            environment=environment,
            region=aws_region,
            account=env_config.account,
            project_name=config.project.name
        )
    
    # Create checkpoint manager
    checkpoint_path = state_path.parent / f"{config.project.name}-{environment}.checkpoint"
    checkpoint_manager = CheckpointManager(str(checkpoint_path))
    
    # Create provisioners
    provisioners = {
        "AWS::IAM::Role": IAMRoleProvisioner(boto_session),
        "AWS::Lambda::Function": LambdaProvisioner(boto_session),
        "AWS::ApiGatewayV2::Api": APIGatewayProvisioner(boto_session),
        "AWS::EC2::VPC": VPCProvisioner(boto_session),
        "AWS::EC2::SecurityGroup": SecurityGroupProvisioner(boto_session),
        "AWS::S3::Bucket": S3Provisioner(boto_session),
        "AWS::DynamoDB::Table": DynamoDBProvisioner(boto_session),
        "AWS::SQS::Queue": SQSProvisioner(boto_session),
        "AWS::SNS::Topic": SNSProvisioner(boto_session),
    }
    
    # Create orchestrator
    orchestrator = DeploymentOrchestrator(
        config=config,
        state_manager=state_manager,
        provisioners=provisioners,
        boto_session=boto_session,
        checkpoint_manager=checkpoint_manager
    )
    
    return orchestrator


class RichProgressCallback(ProgressCallback):
    """Progress callback that displays updates using Rich."""
    
    def __init__(self, progress: Progress, task_id):
        self.progress = progress
        self.task_id = task_id
        self.total = 0
        self.completed = 0
    
    def on_start(self, total_resources: int):
        """Called when execution starts."""
        self.total = total_resources
        self.progress.update(self.task_id, total=total_resources)
    
    def on_resource_start(self, resource_id: str, resource_type: str):
        """Called when a resource starts provisioning."""
        self.progress.update(
            self.task_id,
            description=f"[cyan]Provisioning:[/cyan] {resource_id}"
        )
    
    def on_resource_complete(self, resource_id: str, resource_type: str, success: bool):
        """Called when a resource completes."""
        self.completed += 1
        status = "[green]✓[/green]" if success else "[red]✗[/red]"
        self.progress.update(
            self.task_id,
            completed=self.completed,
            description=f"{status} {resource_id}"
        )
    
    def on_complete(self, success: bool):
        """Called when execution completes."""
        status = "[green]Complete[/green]" if success else "[red]Failed[/red]"
        self.progress.update(self.task_id, description=status)


@cli.command()
@click.option('--env', required=True, help='Environment name')
@click.option('--agent', help='Specific agent to deploy')
@click.option('--parallel/--sequential', default=True, help='Execute in parallel or sequential mode')
@click.option('--auto-rollback/--no-auto-rollback', default=False, help='Automatically rollback on failure')
@click.option('--config', default='warpcore.yaml', help='Path to configuration file')
@click.pass_context
def deploy(ctx, env, agent, parallel, auto_rollback, config):
    """Deploy infrastructure to AWS."""
    try:
        # Load configuration
        cfg = load_config(config)
        
        # Display deployment info
        console.print(Panel.fit(
            f"[bold]Deploying to {env}[/bold]\n"
            f"Project: {cfg.project.name}\n"
            f"Agent: {agent or 'all'}\n"
            f"Mode: {'parallel' if parallel else 'sequential'}\n"
            f"Auto-rollback: {'enabled' if auto_rollback else 'disabled'}",
            title="Deployment Configuration",
            border_style="cyan"
        ))
        
        # Create orchestrator
        orchestrator = create_orchestrator(
            cfg,
            env,
            profile=ctx.obj.get('profile'),
            region=ctx.obj.get('region')
        )
        
        # Determine rollback strategy
        rollback_strategy = RollbackStrategy.AUTOMATIC if auto_rollback else RollbackStrategy.NONE
        
        # Execute deployment with progress display
        with Progress(
            SpinnerColumn(),
            TextColumn("[progress.description]{task.description}"),
            BarColumn(),
            TaskProgressColumn(),
            console=console
        ) as progress:
            task_id = progress.add_task("[cyan]Starting deployment...", total=None)
            progress_callback = RichProgressCallback(progress, task_id)
            
            result, rollback_result = orchestrator.deploy(
                agent_filter=agent,
                parallel=parallel,
                rollback_strategy=rollback_strategy,
                progress_callback=progress_callback
            )
        
        # Display results
        console.print()
        if result.status == ExecutionStatus.SUCCESS:
            console.print(Panel.fit(
                f"[green]✓ Deployment successful[/green]\n\n"
                f"Total resources: {result.total_resources}\n"
                f"Successful: {result.successful_resources}\n"
                f"Duration: {result.duration:.2f}s",
                title="Deployment Complete",
                border_style="green"
            ))
        elif result.status == ExecutionStatus.PARTIAL:
            console.print(Panel.fit(
                f"[yellow]⚠ Deployment partially successful[/yellow]\n\n"
                f"Total resources: {result.total_resources}\n"
                f"Successful: {result.successful_resources}\n"
                f"Failed: {result.failed_resources}\n"
                f"Duration: {result.duration:.2f}s",
                title="Deployment Partial",
                border_style="yellow"
            ))
            
            # Show failed resources
            if result.failed_resources_details:
                console.print("\n[bold]Failed Resources:[/bold]")
                for resource_id, error in result.failed_resources_details.items():
                    console.print(f"  [red]✗[/red] {resource_id}: {error}")
            
            # Show rollback result if applicable
            if rollback_result:
                console.print(f"\n[bold]Rollback Status:[/bold] {rollback_result.status.value}")
                console.print(f"Rolled back: {rollback_result.successful_resources}/{rollback_result.total_resources}")
        else:
            console.print(Panel.fit(
                f"[red]✗ Deployment failed[/red]\n\n"
                f"Total resources: {result.total_resources}\n"
                f"Successful: {result.successful_resources}\n"
                f"Failed: {result.failed_resources}\n"
                f"Duration: {result.duration:.2f}s",
                title="Deployment Failed",
                border_style="red"
            ))
            
            # Show failed resources
            if result.failed_resources_details:
                console.print("\n[bold]Failed Resources:[/bold]")
                for resource_id, error in result.failed_resources_details.items():
                    console.print(f"  [red]✗[/red] {resource_id}: {error}")
            
            # Show rollback result if applicable
            if rollback_result:
                console.print(f"\n[bold]Rollback Status:[/bold] {rollback_result.status.value}")
                console.print(f"Rolled back: {rollback_result.successful_resources}/{rollback_result.total_resources}")
            
            sys.exit(1)
    
    except DeploymentError as e:
        console.print(f"[red]Deployment error:[/red] {e}")
        sys.exit(1)
    except Exception as e:
        logger.exception("Unexpected error during deployment")
        console.print(f"[red]Unexpected error:[/red] {e}")
        sys.exit(1)


@cli.command()
@click.option('--env', required=True, help='Environment name')
@click.option('--agent', help='Specific agent to destroy')
@click.option('--yes', '-y', is_flag=True, help='Skip confirmation prompt')
@click.option('--config', default='warpcore.yaml', help='Path to configuration file')
@click.pass_context
def destroy(ctx, env, agent, yes, config):
    """Remove deployed infrastructure."""
    try:
        # Load configuration
        cfg = load_config(config)
        
        # Check if state exists
        state_path = get_state_path(env, cfg.project.name)
        if not state_path.exists():
            console.print(f"[yellow]No deployment found for environment:[/yellow] {env}")
            return
        
        # Display destruction info
        console.print(Panel.fit(
            f"[bold red]⚠ WARNING: This will destroy resources[/bold red]\n\n"
            f"Environment: {env}\n"
            f"Project: {cfg.project.name}\n"
            f"Agent: {agent or 'all'}\n",
            title="Destruction Plan",
            border_style="red"
        ))
        
        # Confirmation prompt
        if not yes:
            confirm = click.confirm(
                "Are you sure you want to destroy these resources?",
                default=False
            )
            if not confirm:
                console.print("[yellow]Destruction cancelled[/yellow]")
                return
        
        # Create orchestrator
        orchestrator = create_orchestrator(
            cfg,
            env,
            profile=ctx.obj.get('profile'),
            region=ctx.obj.get('region')
        )
        
        # Execute destruction with progress display
        with Progress(
            SpinnerColumn(),
            TextColumn("[progress.description]{task.description}"),
            BarColumn(),
            TaskProgressColumn(),
            console=console
        ) as progress:
            task_id = progress.add_task("[cyan]Starting destruction...", total=None)
            progress_callback = RichProgressCallback(progress, task_id)
            
            result = orchestrator.destroy(
                agent_filter=agent,
                progress_callback=progress_callback
            )
        
        # Display results
        console.print()
        if result.status == ExecutionStatus.SUCCESS:
            console.print(Panel.fit(
                f"[green]✓ Destruction successful[/green]\n\n"
                f"Total resources: {result.total_resources}\n"
                f"Destroyed: {result.successful_resources}\n"
                f"Duration: {result.duration:.2f}s",
                title="Destruction Complete",
                border_style="green"
            ))
        elif result.status == ExecutionStatus.PARTIAL:
            console.print(Panel.fit(
                f"[yellow]⚠ Destruction partially successful[/yellow]\n\n"
                f"Total resources: {result.total_resources}\n"
                f"Destroyed: {result.successful_resources}\n"
                f"Failed: {result.failed_resources}\n"
                f"Duration: {result.duration:.2f}s",
                title="Destruction Partial",
                border_style="yellow"
            ))
            
            # Show failed resources
            if result.failed_resources_details:
                console.print("\n[bold]Failed to Destroy:[/bold]")
                for resource_id, error in result.failed_resources_details.items():
                    console.print(f"  [red]✗[/red] {resource_id}: {error}")
            
            console.print("\n[yellow]Some resources may need manual cleanup[/yellow]")
        else:
            console.print(Panel.fit(
                f"[red]✗ Destruction failed[/red]\n\n"
                f"Total resources: {result.total_resources}\n"
                f"Destroyed: {result.successful_resources}\n"
                f"Failed: {result.failed_resources}\n"
                f"Duration: {result.duration:.2f}s",
                title="Destruction Failed",
                border_style="red"
            ))
            
            # Show failed resources
            if result.failed_resources_details:
                console.print("\n[bold]Failed to Destroy:[/bold]")
                for resource_id, error in result.failed_resources_details.items():
                    console.print(f"  [red]✗[/red] {resource_id}: {error}")
            
            console.print("\n[red]Resources may need manual cleanup[/red]")
            sys.exit(1)
    
    except DeploymentError as e:
        console.print(f"[red]Destruction error:[/red] {e}")
        sys.exit(1)
    except Exception as e:
        logger.exception("Unexpected error during destruction")
        console.print(f"[red]Unexpected error:[/red] {e}")
        sys.exit(1)


@cli.command()
@click.option('--env', required=True, help='Environment name')
@click.option('--agent', help='Filter by agent name')
@click.option('--type', 'resource_type', help='Filter by resource type')
@click.option('--tag', multiple=True, help='Filter by tag (format: key=value)')
@click.option('--config', default='warpcore.yaml', help='Path to configuration file')
@click.pass_context
def list(ctx, env, agent, resource_type, tag, config):
    """Show deployed resources."""
    try:
        # Load configuration
        cfg = load_config(config)
        
        # Check if state exists
        state_path = get_state_path(env, cfg.project.name)
        if not state_path.exists():
            console.print(f"[yellow]No deployment found for environment:[/yellow] {env}")
            return
        
        # Load state
        state_manager = StateManager(str(state_path))
        state = state_manager.load()
        
        # Parse tag filters
        tag_filters = {}
        for tag_str in tag:
            if '=' in tag_str:
                key, value = tag_str.split('=', 1)
                tag_filters[key] = value
        
        # Group resources by stack
        stacks = {}
        for stack_name, stack in state.stacks.items():
            # Filter by agent if specified
            if agent and agent not in stack_name:
                continue
            
            filtered_resources = []
            for resource in stack.resources.values():
                # Filter by type
                if resource_type and resource.type != resource_type:
                    continue
                
                # Filter by tags
                if tag_filters:
                    match = all(
                        resource.tags.get(k) == v
                        for k, v in tag_filters.items()
                    )
                    if not match:
                        continue
                
                filtered_resources.append(resource)
            
            if filtered_resources:
                stacks[stack_name] = filtered_resources
        
        # Display resources
        if not stacks:
            console.print("[yellow]No resources found matching filters[/yellow]")
            return
        
        console.print(f"\n[bold]Resources in {env}[/bold]\n")
        
        for stack_name, resources in stacks.items():
            # Create table for stack
            table = Table(title=f"Stack: {stack_name}", show_header=True, header_style="bold cyan")
            table.add_column("Resource ID", style="cyan")
            table.add_column("Type", style="magenta")
            table.add_column("Physical ID", style="green")
            table.add_column("Status", style="yellow")
            
            for resource in resources:
                # Truncate long physical IDs
                physical_id = resource.physical_id or "N/A"
                if len(physical_id) > 50:
                    physical_id = physical_id[:47] + "..."
                
                table.add_row(
                    resource.id,
                    resource.type,
                    physical_id,
                    "Deployed"
                )
            
            console.print(table)
            console.print()
        
        # Summary
        total_resources = sum(len(resources) for resources in stacks.values())
        console.print(f"[bold]Total resources:[/bold] {total_resources}")
    
    except StateNotFoundError:
        console.print(f"[yellow]No deployment found for environment:[/yellow] {env}")
    except Exception as e:
        logger.exception("Error listing resources")
        console.print(f"[red]Error:[/red] {e}")
        sys.exit(1)


@cli.command()
@click.argument('resource_id')
@click.option('--env', required=True, help='Environment name')
@click.option('--config', default='warpcore.yaml', help='Path to configuration file')
@click.pass_context
def describe(ctx, resource_id, env, config):
    """Show detailed information for a specific resource."""
    try:
        # Load configuration
        cfg = load_config(config)
        
        # Check if state exists
        state_path = get_state_path(env, cfg.project.name)
        if not state_path.exists():
            console.print(f"[yellow]No deployment found for environment:[/yellow] {env}")
            return
        
        # Load state
        state_manager = StateManager(str(state_path))
        state = state_manager.load()
        
        # Find resource
        resource = state.get_resource(resource_id)
        if not resource:
            console.print(f"[red]Resource not found:[/red] {resource_id}")
            sys.exit(1)
        
        # Display resource details
        console.print(f"\n[bold]Resource Details[/bold]\n")
        
        # Basic info table
        info_table = Table(show_header=False, box=None)
        info_table.add_column("Field", style="cyan")
        info_table.add_column("Value", style="white")
        
        info_table.add_row("ID", resource.id)
        info_table.add_row("Type", resource.type)
        info_table.add_row("Physical ID", resource.physical_id or "N/A")
        info_table.add_row("Dependencies", ", ".join(resource.dependencies) if resource.dependencies else "None")
        
        console.print(Panel(info_table, title="Basic Information", border_style="cyan"))
        
        # Properties
        if resource.properties:
            console.print("\n[bold]Properties:[/bold]")
            props_table = Table(show_header=False, box=None)
            props_table.add_column("Key", style="cyan")
            props_table.add_column("Value", style="white")
            
            for key, value in resource.properties.items():
                # Format value
                if isinstance(value, (dict, list)):
                    import json
                    value_str = json.dumps(value, indent=2)
                else:
                    value_str = str(value)
                
                # Truncate long values
                if len(value_str) > 100:
                    value_str = value_str[:97] + "..."
                
                props_table.add_row(key, value_str)
            
            console.print(Panel(props_table, border_style="blue"))
        
        # Tags
        if resource.tags:
            console.print("\n[bold]Tags:[/bold]")
            tags_table = Table(show_header=False, box=None)
            tags_table.add_column("Key", style="cyan")
            tags_table.add_column("Value", style="white")
            
            for key, value in resource.tags.items():
                tags_table.add_row(key, value)
            
            console.print(Panel(tags_table, border_style="green"))
    
    except StateNotFoundError:
        console.print(f"[yellow]No deployment found for environment:[/yellow] {env}")
    except Exception as e:
        logger.exception("Error describing resource")
        console.print(f"[red]Error:[/red] {e}")
        sys.exit(1)


@cli.group()
def env():
    """Manage deployment environments."""
    pass


@env.command('list')
@click.option('--config', default='warpcore.yaml', help='Path to configuration file')
def env_list(config):
    """List all configured environments."""
    try:
        # Load configuration
        cfg = load_config(config)
        
        if not cfg.environments:
            console.print("[yellow]No environments configured[/yellow]")
            return
        
        # Create table
        table = Table(title="Configured Environments", show_header=True, header_style="bold cyan")
        table.add_column("Environment", style="cyan")
        table.add_column("Account", style="magenta")
        table.add_column("Region", style="green")
        table.add_column("Status", style="yellow")
        
        # Check which environments have deployments
        for env_name, env_config in cfg.environments.items():
            state_path = get_state_path(env_name, cfg.project.name)
            status = "Deployed" if state_path.exists() else "Not deployed"
            
            table.add_row(
                env_name,
                env_config.account,
                env_config.region,
                status
            )
        
        console.print(table)
    
    except Exception as e:
        logger.exception("Error listing environments")
        console.print(f"[red]Error:[/red] {e}")
        sys.exit(1)


@env.command('show')
@click.argument('environment')
@click.option('--config', default='warpcore.yaml', help='Path to configuration file')
def env_show(environment, config):
    """Show detailed information about an environment."""
    try:
        # Load configuration
        cfg = load_config(config)
        
        # Get environment config
        try:
            env_config = cfg.get_environment(environment)
        except ConfigValidationError as e:
            console.print(f"[red]Error:[/red] {e}")
            sys.exit(1)
        
        # Display environment details
        console.print(f"\n[bold]Environment: {environment}[/bold]\n")
        
        # Basic info
        info_table = Table(show_header=False, box=None)
        info_table.add_column("Field", style="cyan")
        info_table.add_column("Value", style="white")
        
        info_table.add_row("Name", env_config.name)
        info_table.add_row("Account", env_config.account)
        info_table.add_row("Region", env_config.region)
        
        console.print(Panel(info_table, title="Configuration", border_style="cyan"))
        
        # Check deployment status
        state_path = get_state_path(environment, cfg.project.name)
        if state_path.exists():
            state_manager = StateManager(str(state_path))
            state = state_manager.load()
            
            console.print("\n[bold]Deployment Status:[/bold]")
            status_table = Table(show_header=False, box=None)
            status_table.add_column("Field", style="cyan")
            status_table.add_column("Value", style="white")
            
            status_table.add_row("Status", "[green]Deployed[/green]")
            status_table.add_row("Last Updated", state.timestamp.isoformat())
            
            # Count resources
            total_resources = sum(len(stack.resources) for stack in state.stacks.values())
            status_table.add_row("Total Resources", str(total_resources))
            status_table.add_row("Stacks", str(len(state.stacks)))
            
            console.print(Panel(status_table, border_style="green"))
        else:
            console.print("\n[yellow]Status: Not deployed[/yellow]")
        
        # VPC overrides
        if env_config.vpc:
            console.print("\n[bold]VPC Configuration:[/bold]")
            vpc_table = Table(show_header=False, box=None)
            vpc_table.add_column("Field", style="cyan")
            vpc_table.add_column("Value", style="white")
            
            vpc_table.add_row("Enabled", str(env_config.vpc.enabled))
            if env_config.vpc.cidr:
                vpc_table.add_row("CIDR", env_config.vpc.cidr)
            if env_config.vpc.ipam:
                vpc_table.add_row("IPAM Enabled", str(env_config.vpc.ipam.enabled))
                if env_config.vpc.ipam.pool_id:
                    vpc_table.add_row("IPAM Pool ID", env_config.vpc.ipam.pool_id)
                if env_config.vpc.ipam.netmask_length:
                    vpc_table.add_row("Netmask Length", str(env_config.vpc.ipam.netmask_length))
            
            console.print(Panel(vpc_table, border_style="blue"))
    
    except Exception as e:
        logger.exception("Error showing environment")
        console.print(f"[red]Error:[/red] {e}")
        sys.exit(1)


@env.command('diff')
@click.argument('env1')
@click.argument('env2')
@click.option('--config', default='warpcore.yaml', help='Path to configuration file')
def env_diff(env1, env2, config):
    """Compare two environments."""
    try:
        # Load configuration
        cfg = load_config(config)
        
        # Get environment configs
        try:
            env1_config = cfg.get_environment(env1)
            env2_config = cfg.get_environment(env2)
        except ConfigValidationError as e:
            console.print(f"[red]Error:[/red] {e}")
            sys.exit(1)
        
        console.print(f"\n[bold]Comparing {env1} vs {env2}[/bold]\n")
        
        # Compare configurations
        table = Table(show_header=True, header_style="bold cyan")
        table.add_column("Field", style="cyan")
        table.add_column(env1, style="magenta")
        table.add_column(env2, style="green")
        table.add_column("Match", style="yellow")
        
        # Account
        account_match = "✓" if env1_config.account == env2_config.account else "✗"
        table.add_row("Account", env1_config.account, env2_config.account, account_match)
        
        # Region
        region_match = "✓" if env1_config.region == env2_config.region else "✗"
        table.add_row("Region", env1_config.region, env2_config.region, region_match)
        
        # VPC
        vpc1_enabled = env1_config.vpc.enabled if env1_config.vpc else False
        vpc2_enabled = env2_config.vpc.enabled if env2_config.vpc else False
        vpc_match = "✓" if vpc1_enabled == vpc2_enabled else "✗"
        table.add_row("VPC Enabled", str(vpc1_enabled), str(vpc2_enabled), vpc_match)
        
        console.print(table)
        
        # Compare deployments
        state1_path = get_state_path(env1, cfg.project.name)
        state2_path = get_state_path(env2, cfg.project.name)
        
        if state1_path.exists() and state2_path.exists():
            state1_manager = StateManager(str(state1_path))
            state2_manager = StateManager(str(state2_path))
            
            state1 = state1_manager.load()
            state2 = state2_manager.load()
            
            console.print("\n[bold]Deployment Comparison:[/bold]")
            
            deploy_table = Table(show_header=True, header_style="bold cyan")
            deploy_table.add_column("Metric", style="cyan")
            deploy_table.add_column(env1, style="magenta")
            deploy_table.add_column(env2, style="green")
            
            # Resource counts
            resources1 = sum(len(stack.resources) for stack in state1.stacks.values())
            resources2 = sum(len(stack.resources) for stack in state2.stacks.values())
            deploy_table.add_row("Total Resources", str(resources1), str(resources2))
            
            # Stack counts
            deploy_table.add_row("Stacks", str(len(state1.stacks)), str(len(state2.stacks)))
            
            # Last updated
            deploy_table.add_row("Last Updated", state1.timestamp.isoformat(), state2.timestamp.isoformat())
            
            console.print(deploy_table)
    
    except Exception as e:
        logger.exception("Error comparing environments")
        console.print(f"[red]Error:[/red] {e}")
        sys.exit(1)


@env.command('add')
@click.argument('environment')
@click.option('--account', required=True, help='AWS account ID (12 digits)')
@click.option('--region', required=True, help='AWS region')
@click.option('--vpc-enabled', is_flag=True, help='Enable VPC for this environment')
@click.option('--vpc-cidr', help='VPC CIDR block (e.g., 10.0.0.0/16)')
@click.option('--config', default='warpcore.yaml', help='Path to configuration file')
def env_add(environment, account, region, vpc_enabled, vpc_cidr, config):
    """Add a new environment to the configuration."""
    try:
        config_path = Path(config)
        
        if not config_path.exists():
            console.print(f"[red]Error:[/red] Configuration file not found: {config}")
            console.print("Run [cyan]warpcore init[/cyan] to create a configuration file first.")
            sys.exit(1)
        
        # Validate account ID format
        if not account.isdigit() or len(account) != 12:
            console.print(f"[red]Error:[/red] AWS account ID must be a 12-digit number")
            sys.exit(1)
        
        # Validate region
        valid_regions = [
            "us-east-1", "us-east-2", "us-west-1", "us-west-2",
            "eu-west-1", "eu-west-2", "eu-west-3", "eu-central-1", "eu-north-1",
            "ap-northeast-1", "ap-northeast-2", "ap-northeast-3",
            "ap-southeast-1", "ap-southeast-2", "ap-south-1",
            "sa-east-1", "ca-central-1"
        ]
        if region not in valid_regions:
            console.print(f"[red]Error:[/red] Invalid AWS region: {region}")
            console.print(f"Valid regions: {', '.join(valid_regions)}")
            sys.exit(1)
        
        # Validate VPC configuration
        if vpc_enabled and not vpc_cidr:
            console.print(f"[red]Error:[/red] --vpc-cidr is required when --vpc-enabled is set")
            sys.exit(1)
        
        # Load existing configuration
        with open(config_path, 'r') as f:
            data = yaml.safe_load(f) or {}
        
        # Check if environment already exists
        if 'environments' not in data:
            data['environments'] = {}
        
        if environment in data['environments']:
            console.print(f"[yellow]Warning:[/yellow] Environment '{environment}' already exists")
            if not click.confirm("Overwrite existing environment?", default=False):
                console.print("[yellow]Cancelled[/yellow]")
                return
        
        # Create environment configuration
        env_config = {
            'account': account,
            'region': region
        }
        
        # Add VPC configuration if enabled
        if vpc_enabled:
            env_config['vpc'] = {
                'enabled': True,
                'cidr': vpc_cidr
            }
        
        # Add environment to configuration
        data['environments'][environment] = env_config
        
        # Write updated configuration
        with open(config_path, 'w') as f:
            yaml.dump(data, f, default_flow_style=False, sort_keys=False)
        
        console.print(f"\n[green]✓ Added environment:[/green] {environment}")
        console.print(f"  Account: {account}")
        console.print(f"  Region: {region}")
        if vpc_enabled:
            console.print(f"  VPC: {vpc_cidr}")
        
        console.print(f"\n[dim]Deploy to this environment with:[/dim]")
        console.print(f"  [cyan]warpcore deploy --env {environment}[/cyan]")
    
    except Exception as e:
        logger.exception("Error adding environment")
        console.print(f"[red]Error:[/red] {e}")
        sys.exit(1)


@env.command('remove')
@click.argument('environment')
@click.option('--yes', '-y', is_flag=True, help='Skip confirmation prompt')
@click.option('--config', default='warpcore.yaml', help='Path to configuration file')
def env_remove(environment, yes, config):
    """Remove an environment from the configuration."""
    try:
        config_path = Path(config)
        
        if not config_path.exists():
            console.print(f"[red]Error:[/red] Configuration file not found: {config}")
            sys.exit(1)
        
        # Load existing configuration
        with open(config_path, 'r') as f:
            data = yaml.safe_load(f) or {}
        
        # Check if environment exists
        if 'environments' not in data or environment not in data['environments']:
            console.print(f"[red]Error:[/red] Environment '{environment}' not found")
            available = list(data.get('environments', {}).keys())
            if available:
                console.print(f"Available environments: {', '.join(available)}")
            sys.exit(1)
        
        # Check if environment has active deployment
        cfg = Config(config)
        cfg.load()
        state_path = get_state_path(environment, cfg.project.name)
        
        if state_path.exists():
            console.print(f"[yellow]⚠ Warning:[/yellow] Environment '{environment}' has an active deployment")
            console.print(f"State file: {state_path}")
            console.print("\nRemoving the environment from config will not destroy deployed resources.")
            console.print(f"Run [cyan]warpcore destroy --env {environment}[/cyan] first to clean up resources.")
            console.print()
        
        # Confirmation prompt
        if not yes:
            console.print(f"[bold]Remove environment '{environment}'?[/bold]")
            console.print(f"  Account: {data['environments'][environment].get('account', 'N/A')}")
            console.print(f"  Region: {data['environments'][environment].get('region', 'N/A')}")
            console.print()
            
            if not click.confirm("Are you sure?", default=False):
                console.print("[yellow]Cancelled[/yellow]")
                return
        
        # Remove environment
        del data['environments'][environment]
        
        # Write updated configuration
        with open(config_path, 'w') as f:
            yaml.dump(data, f, default_flow_style=False, sort_keys=False)
        
        console.print(f"\n[green]✓ Removed environment:[/green] {environment}")
        
        if state_path.exists():
            console.print(f"\n[yellow]Note:[/yellow] State file still exists at: {state_path}")
            console.print("Resources may still be deployed in AWS.")
    
    except Exception as e:
        logger.exception("Error removing environment")
        console.print(f"[red]Error:[/red] {e}")
        sys.exit(1)


@cli.group()
def history():
    """View deployment history and logs."""
    pass


def get_history_manager(cfg: Config, env: str, profile: Optional[str] = None, region: Optional[str] = None):
    """Create a DeploymentHistoryManager instance."""
    from warpcore.history import DeploymentHistoryManager

    env_config = cfg.get_environment(env)
    aws_region = region or env_config.region

    # Create boto3 session
    session_kwargs = {}
    if profile:
        session_kwargs['profile_name'] = profile
    if aws_region:
        session_kwargs['region_name'] = aws_region

    import boto3
    session = boto3.Session(**session_kwargs)
    s3_client = session.client('s3')

    # History bucket name follows convention: {project}-{account}-history
    bucket_name = f"{cfg.project.name}-{env_config.account}-history"

    return DeploymentHistoryManager(
        s3_client=s3_client,
        bucket_name=bucket_name,
        project_name=cfg.project.name,
        environment=env,
        region=aws_region,
        account=env_config.account,
    )


@history.command('list')
@click.option('--env', required=True, help='Environment name')
@click.option('--config', default='warpcore.yaml', help='Path to configuration file')
@click.option('--limit', default=10, help='Number of deployments to show')
@click.pass_context
def history_list(ctx, env, config, limit):
    """List deployment history."""
    try:
        # Load configuration
        cfg = load_config(config)

        try:
            # Try S3-based history first
            history_manager = get_history_manager(
                cfg, env,
                profile=ctx.obj.get('profile'),
                region=ctx.obj.get('region')
            )

            deployments = history_manager.list_deployments(limit=limit)

            if not deployments:
                console.print(f"[yellow]No deployment history found for {env}[/yellow]")
                console.print("\n[dim]Deploy using 'warpcore deploy --env {env}' to create history[/dim]")
                return

            console.print(f"\n[bold]Deployment History for {env}[/bold]\n")

            # Create table
            table = Table(show_header=True, header_style="bold cyan")
            table.add_column("Deployment ID", style="cyan")
            table.add_column("Status", style="magenta")
            table.add_column("Started", style="green")
            table.add_column("Duration", style="yellow")
            table.add_column("Resources", style="blue")
            table.add_column("Est. Cost", style="white")

            for deployment in deployments:
                # Format status with color
                status_colors = {
                    "success": "[green]✓ success[/green]",
                    "failed": "[red]✗ failed[/red]",
                    "in_progress": "[yellow]⋯ in progress[/yellow]",
                    "cancelled": "[dim]⊘ cancelled[/dim]",
                }
                status_display = status_colors.get(
                    deployment.status.value,
                    deployment.status.value
                )

                # Format duration
                if deployment.duration:
                    if deployment.duration < 60:
                        duration_str = f"{deployment.duration:.1f}s"
                    else:
                        minutes = int(deployment.duration // 60)
                        seconds = int(deployment.duration % 60)
                        duration_str = f"{minutes}m {seconds}s"
                else:
                    duration_str = "-"

                # Format cost
                cost_str = f"${deployment.estimated_cost:.2f}/mo" if deployment.estimated_cost else "-"

                table.add_row(
                    deployment.deployment_id,
                    status_display,
                    deployment.start_time.strftime("%Y-%m-%d %H:%M"),
                    duration_str,
                    str(deployment.resource_count),
                    cost_str,
                )

            console.print(table)
            console.print(f"\n[dim]Showing {len(deployments)} of {limit} max deployments[/dim]")
            console.print("[dim]Use 'warpcore history show <deployment_id> --env {env}' for details[/dim]")

        except Exception as s3_error:
            # Fall back to local log files
            logger.debug(f"S3 history not available: {s3_error}")

            log_dir = Path.cwd() / ".warpcore" / "logs"
            if not log_dir.exists():
                console.print("[yellow]No deployment history found[/yellow]")
                console.print("\n[dim]Deploy using 'warpcore deploy' to create history[/dim]")
                return

            log_files = sorted(log_dir.glob("*.jsonl"), reverse=True)

            if not log_files:
                console.print("[yellow]No deployment history found[/yellow]")
                return

            console.print(f"\n[bold]Local Deployment Logs for {env}[/bold]\n")
            console.print("[dim]Note: S3-based history not available. Showing local logs.[/dim]\n")

            table = Table(show_header=True, header_style="bold cyan")
            table.add_column("Date", style="cyan")
            table.add_column("Log File", style="magenta")
            table.add_column("Size", style="green")

            for log_file in log_files[:limit]:
                stat = log_file.stat()
                size_kb = stat.st_size / 1024

                table.add_row(
                    log_file.stem,
                    log_file.name,
                    f"{size_kb:.1f} KB"
                )

            console.print(table)

    except Exception as e:
        logger.exception("Error listing history")
        console.print(f"[red]Error:[/red] {e}")
        sys.exit(1)


@history.command('show')
@click.argument('deployment_id')
@click.option('--env', required=True, help='Environment name')
@click.option('--config', default='warpcore.yaml', help='Path to configuration file')
@click.option('--logs', is_flag=True, help='Show execution logs')
@click.option('--api-calls', is_flag=True, help='Show AWS API calls')
@click.option('--costs', is_flag=True, help='Show cost breakdown')
@click.pass_context
def history_show(ctx, deployment_id, env, config, logs, api_calls, costs):
    """Show details of a specific deployment."""
    try:
        # Load configuration
        cfg = load_config(config)

        # Get history manager
        history_manager = get_history_manager(
            cfg, env,
            profile=ctx.obj.get('profile'),
            region=ctx.obj.get('region')
        )

        # Get deployment record
        try:
            record = history_manager.get_deployment(deployment_id)
        except Exception as e:
            console.print(f"[red]Error:[/red] {e}")
            sys.exit(1)

        metadata = record.metadata

        # Display header
        status_colors = {
            "success": "green",
            "failed": "red",
            "in_progress": "yellow",
            "cancelled": "dim",
        }
        status_color = status_colors.get(metadata.status.value, "white")

        console.print(Panel.fit(
            f"[bold]Deployment: {deployment_id}[/bold]\n\n"
            f"Status: [{status_color}]{metadata.status.value.upper()}[/{status_color}]\n"
            f"Environment: {metadata.environment}\n"
            f"Project: {metadata.project_name}\n"
            f"Deployed by: {metadata.deployed_by}\n"
            f"Version: {metadata.version}",
            title="Deployment Details",
            border_style=status_color
        ))

        # Timing info
        console.print("\n[bold]Timing:[/bold]")
        timing_table = Table(show_header=False, box=None)
        timing_table.add_column("Field", style="cyan")
        timing_table.add_column("Value", style="white")

        timing_table.add_row("Started", metadata.start_time.strftime("%Y-%m-%d %H:%M:%S UTC"))
        if metadata.end_time:
            timing_table.add_row("Completed", metadata.end_time.strftime("%Y-%m-%d %H:%M:%S UTC"))
        if metadata.duration:
            if metadata.duration < 60:
                duration_str = f"{metadata.duration:.1f} seconds"
            else:
                minutes = int(metadata.duration // 60)
                seconds = int(metadata.duration % 60)
                duration_str = f"{minutes}m {seconds}s"
            timing_table.add_row("Duration", duration_str)

        console.print(Panel(timing_table, border_style="cyan"))

        # Resource changes
        if metadata.changes:
            console.print("\n[bold]Resource Changes:[/bold]")
            changes_table = Table(show_header=True, header_style="bold cyan")
            changes_table.add_column("Action", style="cyan")
            changes_table.add_column("Count", style="white")
            changes_table.add_column("Resources", style="dim")

            for change_type, resources in metadata.changes.items():
                if resources:
                    action_colors = {"created": "green", "updated": "yellow", "deleted": "red"}
                    color = action_colors.get(change_type, "white")
                    resources_preview = ", ".join(resources[:3])
                    if len(resources) > 3:
                        resources_preview += f" (+{len(resources) - 3} more)"
                    changes_table.add_row(
                        f"[{color}]{change_type.capitalize()}[/{color}]",
                        str(len(resources)),
                        resources_preview
                    )

            console.print(changes_table)

        # Resource summary
        console.print("\n[bold]Resources:[/bold]")
        console.print(f"  Total: {metadata.resource_count}")
        if metadata.estimated_cost:
            console.print(f"  Estimated Cost: ${metadata.estimated_cost:.2f}/month")

        # Show error if failed
        if metadata.error_message:
            console.print(f"\n[bold red]Error:[/bold red]")
            console.print(Panel(metadata.error_message, border_style="red"))

        # Show execution logs if requested
        if logs and record.execution_log:
            console.print("\n[bold]Execution Logs:[/bold]")
            for entry in record.execution_log[-50:]:  # Last 50 entries
                level_colors = {
                    "DEBUG": "dim",
                    "INFO": "cyan",
                    "WARNING": "yellow",
                    "ERROR": "red",
                }
                level_style = level_colors.get(entry.level.value if hasattr(entry.level, 'value') else entry.level, "white")
                timestamp = entry.timestamp.strftime("%H:%M:%S")
                console.print(f"[dim]{timestamp}[/dim] [{level_style}]{entry.level.value if hasattr(entry.level, 'value') else entry.level:8}[/{level_style}] {entry.message}")

        # Show API calls if requested
        if api_calls and record.api_calls:
            console.print("\n[bold]AWS API Calls:[/bold]")
            api_table = Table(show_header=True, header_style="bold cyan")
            api_table.add_column("Service", style="cyan")
            api_table.add_column("Operation", style="magenta")
            api_table.add_column("Duration", style="yellow")
            api_table.add_column("Status", style="green")

            for call in record.api_calls[:20]:  # First 20 calls
                status = f"[green]{call.status_code}[/green]" if call.status_code < 400 else f"[red]{call.status_code}[/red]"
                api_table.add_row(
                    call.service,
                    call.operation,
                    f"{call.duration:.3f}s",
                    status
                )

            console.print(api_table)
            if len(record.api_calls) > 20:
                console.print(f"[dim]...and {len(record.api_calls) - 20} more API calls[/dim]")

        # Show cost breakdown if requested
        if costs:
            console.print("\n[bold]Cost Breakdown:[/bold]")
            try:
                cost_breakdown = history_manager.get_cost_breakdown(deployment_id)
                if "error" in cost_breakdown:
                    console.print(f"[yellow]{cost_breakdown['error']}[/yellow]")
                else:
                    cost_table = Table(show_header=True, header_style="bold cyan")
                    cost_table.add_column("Resource Type", style="cyan")
                    cost_table.add_column("Count", style="white")
                    cost_table.add_column("Monthly Cost", style="green")

                    for resource_type, details in cost_breakdown.items():
                        if isinstance(details, dict) and "cost" in details:
                            cost_table.add_row(
                                resource_type,
                                str(details.get("count", "-")),
                                f"${details['cost']:.2f}"
                            )

                    console.print(cost_table)
            except Exception as e:
                console.print(f"[yellow]Could not load cost breakdown: {e}[/yellow]")

        # Hint for more options
        if not (logs or api_calls or costs):
            console.print("\n[dim]Use --logs, --api-calls, or --costs for more details[/dim]")

    except Exception as e:
        logger.exception("Error showing deployment")
        console.print(f"[red]Error:[/red] {e}")
        sys.exit(1)


@history.command('logs')
@click.option('--env', required=True, help='Environment name')
@click.option('--config', default='warpcore.yaml', help='Path to configuration file')
@click.option('--lines', default=50, help='Number of log lines to show')
@click.option('--follow', '-f', is_flag=True, help='Follow log output')
def history_logs(env, config, lines, follow):
    """View deployment logs."""
    try:
        # Find most recent log file
        log_dir = Path.cwd() / "src" / ".warpcore" / "logs"
        if not log_dir.exists():
            console.print("[yellow]No logs found[/yellow]")
            return
        
        log_files = sorted(log_dir.glob("warpcore-*.jsonl"), reverse=True)
        if not log_files:
            console.print("[yellow]No logs found[/yellow]")
            return
        
        log_file = log_files[0]
        console.print(f"[bold]Showing logs from:[/bold] {log_file.name}\n")
        
        # Read and display log lines
        import json
        with open(log_file, 'r') as f:
            all_lines = f.readlines()
            
        # Show last N lines
        for line in all_lines[-lines:]:
            try:
                log_entry = json.loads(line)
                timestamp = log_entry.get('timestamp', '')
                level = log_entry.get('level', 'INFO')
                message = log_entry.get('message', '')
                
                # Color code by level
                level_colors = {
                    'DEBUG': 'dim',
                    'INFO': 'cyan',
                    'WARNING': 'yellow',
                    'ERROR': 'red',
                    'CRITICAL': 'bold red'
                }
                level_style = level_colors.get(level, 'white')
                
                console.print(f"[dim]{timestamp}[/dim] [{level_style}]{level:8}[/{level_style}] {message}")
            except json.JSONDecodeError:
                console.print(line.strip())
        
        if follow:
            console.print("\n[yellow]Follow mode not yet implemented[/yellow]")
    
    except Exception as e:
        logger.exception("Error viewing logs")
        console.print(f"[red]Error:[/red] {e}")
        sys.exit(1)


@history.command('compare')
@click.argument('deployment1')
@click.argument('deployment2')
@click.option('--env', required=True, help='Environment name')
@click.option('--config', default='warpcore.yaml', help='Path to configuration file')
@click.pass_context
def history_compare(ctx, deployment1, deployment2, env, config):
    """Compare two deployments."""
    try:
        from warpcore.history import DeploymentComparator

        # Load configuration
        cfg = load_config(config)

        # Get history manager
        history_manager = get_history_manager(
            cfg, env,
            profile=ctx.obj.get('profile'),
            region=ctx.obj.get('region')
        )

        console.print(f"\n[bold]Comparing Deployments[/bold]")
        console.print(f"  [cyan]{deployment1}[/cyan] → [cyan]{deployment2}[/cyan]\n")

        # Compare deployments
        try:
            diff = history_manager.compare_deployments(deployment1, deployment2)
        except Exception as e:
            console.print(f"[red]Error:[/red] {e}")
            sys.exit(1)

        comparator = DeploymentComparator()

        # Configuration differences
        console.print("[bold]Configuration Changes:[/bold]")
        config_diff_text = comparator.format_config_diff(diff.config_diff)
        if config_diff_text == "No configuration changes":
            console.print("  [dim]No configuration changes[/dim]")
        else:
            for line in config_diff_text.split("\n"):
                if line.startswith("  +"):
                    console.print(f"  [green]{line}[/green]")
                elif line.startswith("  -"):
                    console.print(f"  [red]{line}[/red]")
                elif line.startswith("  ~"):
                    console.print(f"  [yellow]{line}[/yellow]")
                else:
                    console.print(f"  {line}")

        # State differences
        console.print("\n[bold]Resource Changes:[/bold]")
        state_diff = diff.state_diff

        if state_diff.added_resources:
            console.print(f"  [green]Added ({len(state_diff.added_resources)}):[/green]")
            for resource in state_diff.added_resources[:10]:
                console.print(f"    [green]+ {resource}[/green]")
            if len(state_diff.added_resources) > 10:
                console.print(f"    [dim]...and {len(state_diff.added_resources) - 10} more[/dim]")

        if state_diff.removed_resources:
            console.print(f"  [red]Removed ({len(state_diff.removed_resources)}):[/red]")
            for resource in state_diff.removed_resources[:10]:
                console.print(f"    [red]- {resource}[/red]")
            if len(state_diff.removed_resources) > 10:
                console.print(f"    [dim]...and {len(state_diff.removed_resources) - 10} more[/dim]")

        if state_diff.modified_resources:
            console.print(f"  [yellow]Modified ({len(state_diff.modified_resources)}):[/yellow]")
            for resource in state_diff.modified_resources[:10]:
                console.print(f"    [yellow]~ {resource}[/yellow]")
            if len(state_diff.modified_resources) > 10:
                console.print(f"    [dim]...and {len(state_diff.modified_resources) - 10} more[/dim]")

        if not (state_diff.added_resources or state_diff.removed_resources or state_diff.modified_resources):
            console.print("  [dim]No resource changes[/dim]")

        # Metrics comparison
        console.print("\n[bold]Metrics Comparison:[/bold]")
        metrics_table = Table(show_header=True, header_style="bold cyan")
        metrics_table.add_column("Metric", style="cyan")
        metrics_table.add_column(deployment1[:20], style="magenta")
        metrics_table.add_column(deployment2[:20], style="green")
        metrics_table.add_column("Difference", style="yellow")

        # Duration
        if diff.duration_diff != 0:
            sign = "+" if diff.duration_diff > 0 else ""
            metrics_table.add_row(
                "Duration",
                "-",
                "-",
                f"{sign}{diff.duration_diff:.1f}s"
            )

        # Cost
        if diff.cost_diff != 0:
            sign = "+" if diff.cost_diff > 0 else ""
            color = "red" if diff.cost_diff > 0 else "green"
            metrics_table.add_row(
                "Est. Cost/mo",
                "-",
                "-",
                f"[{color}]{sign}${diff.cost_diff:.2f}[/{color}]"
            )

        console.print(metrics_table)

        # Summary
        total_changes = (
            len(state_diff.added_resources) +
            len(state_diff.removed_resources) +
            len(state_diff.modified_resources)
        )
        console.print(f"\n[bold]Summary:[/bold] {total_changes} resource change(s)")

    except Exception as e:
        logger.exception("Error comparing deployments")
        console.print(f"[red]Error:[/red] {e}")
        sys.exit(1)


@history.command('rollback')
@click.argument('deployment_id')
@click.option('--env', required=True, help='Environment name')
@click.option('--yes', '-y', is_flag=True, help='Skip confirmation prompt')
@click.option('--dry-run', is_flag=True, help='Show what would be changed without making changes')
@click.option('--config', default='warpcore.yaml', help='Path to configuration file')
@click.pass_context
def history_rollback(ctx, deployment_id, env, yes, dry_run, config):
    """Rollback to a previous deployment."""
    try:
        # Load configuration
        cfg = load_config(config)

        # Get history manager
        history_manager = get_history_manager(
            cfg, env,
            profile=ctx.obj.get('profile'),
            region=ctx.obj.get('region')
        )

        # Get deployment details for rollback
        try:
            rollback_data = history_manager.get_deployment_for_rollback(deployment_id)
        except Exception as e:
            console.print(f"[red]Error:[/red] {e}")
            sys.exit(1)

        target_metadata = rollback_data["metadata"]

        # Get current deployment for comparison
        current_deployments = history_manager.list_deployments(limit=1)
        current_id = current_deployments[0].deployment_id if current_deployments else "none"

        console.print(Panel.fit(
            f"[bold yellow]⚠ ROLLBACK OPERATION[/bold yellow]\n\n"
            f"Rolling back from: [red]{current_id}[/red]\n"
            f"Rolling back to:   [green]{deployment_id}[/green]\n\n"
            f"Target deployment details:\n"
            f"  • Date: {target_metadata.get('startTime', 'unknown')}\n"
            f"  • Status: {target_metadata.get('status', 'unknown')}\n"
            f"  • Resources: {target_metadata.get('resourceCount', 'unknown')}\n"
            f"  • Deployed by: {target_metadata.get('deployedBy', 'unknown')}\n\n"
            f"Environment: {env}",
            title="Rollback Confirmation",
            border_style="yellow"
        ))

        if dry_run:
            console.print("\n[bold cyan]DRY RUN - No changes will be made[/bold cyan]\n")

            # Compare current vs target
            if current_deployments:
                try:
                    diff = history_manager.compare_deployments(current_id, deployment_id)

                    console.print("[bold]Changes that would be made:[/bold]")

                    if diff.state_diff.added_resources:
                        console.print(f"\n  [red]Resources to REMOVE ({len(diff.state_diff.added_resources)}):[/red]")
                        for r in diff.state_diff.added_resources[:5]:
                            console.print(f"    - {r}")
                        if len(diff.state_diff.added_resources) > 5:
                            console.print(f"    ...and {len(diff.state_diff.added_resources) - 5} more")

                    if diff.state_diff.removed_resources:
                        console.print(f"\n  [green]Resources to RECREATE ({len(diff.state_diff.removed_resources)}):[/green]")
                        for r in diff.state_diff.removed_resources[:5]:
                            console.print(f"    + {r}")
                        if len(diff.state_diff.removed_resources) > 5:
                            console.print(f"    ...and {len(diff.state_diff.removed_resources) - 5} more")

                    if diff.state_diff.modified_resources:
                        console.print(f"\n  [yellow]Resources to REVERT ({len(diff.state_diff.modified_resources)}):[/yellow]")
                        for r in diff.state_diff.modified_resources[:5]:
                            console.print(f"    ~ {r}")
                        if len(diff.state_diff.modified_resources) > 5:
                            console.print(f"    ...and {len(diff.state_diff.modified_resources) - 5} more")

                    if diff.cost_diff != 0:
                        sign = "+" if diff.cost_diff < 0 else "-"  # Reversed since we're going back
                        color = "green" if diff.cost_diff < 0 else "red"
                        console.print(f"\n  [bold]Cost impact:[/bold] [{color}]{sign}${abs(diff.cost_diff):.2f}/mo[/{color}]")

                except Exception as e:
                    console.print(f"\n[yellow]Could not calculate diff: {e}[/yellow]")

            console.print("\n[dim]Run without --dry-run to execute the rollback[/dim]")
            return

        # Confirmation prompt
        if not yes:
            console.print("\n[bold red]This operation will:[/bold red]")
            console.print("  1. Restore the configuration from the target deployment")
            console.print("  2. Re-deploy infrastructure to match the target state")
            console.print("  3. Remove any resources added after the target deployment")
            console.print()

            confirm = click.confirm(
                "Are you sure you want to rollback?",
                default=False
            )
            if not confirm:
                console.print("[yellow]Rollback cancelled[/yellow]")
                return

        # Execute rollback
        console.print("\n[cyan]Starting rollback...[/cyan]\n")

        # Write the target config to a temporary file
        import tempfile
        import yaml as pyyaml

        with tempfile.NamedTemporaryFile(mode='w', suffix='.yaml', delete=False) as f:
            pyyaml.dump(rollback_data["config"], f, default_flow_style=False)
            temp_config_path = f.name

        try:
            # Load the target configuration
            target_cfg = load_config(temp_config_path)

            # Create orchestrator with target config
            orchestrator = create_orchestrator(
                target_cfg,
                env,
                profile=ctx.obj.get('profile'),
                region=ctx.obj.get('region')
            )

            # Execute deployment with progress display
            with Progress(
                SpinnerColumn(),
                TextColumn("[progress.description]{task.description}"),
                BarColumn(),
                TaskProgressColumn(),
                console=console
            ) as progress:
                task_id = progress.add_task("[cyan]Rolling back...", total=None)
                progress_callback = RichProgressCallback(progress, task_id)

                result, rollback_result = orchestrator.deploy(
                    parallel=True,
                    rollback_strategy=RollbackStrategy.AUTOMATIC,
                    progress_callback=progress_callback
                )

            # Display results
            console.print()
            if result.status == ExecutionStatus.SUCCESS:
                console.print(Panel.fit(
                    f"[green]✓ Rollback successful[/green]\n\n"
                    f"Rolled back to: {deployment_id}\n"
                    f"Total resources: {result.total_resources}\n"
                    f"Duration: {result.duration:.2f}s",
                    title="Rollback Complete",
                    border_style="green"
                ))
            elif result.status == ExecutionStatus.PARTIAL:
                console.print(Panel.fit(
                    f"[yellow]⚠ Rollback partially successful[/yellow]\n\n"
                    f"Some resources may not have been restored.\n"
                    f"Successful: {result.successful_resources}/{result.total_resources}\n"
                    f"Duration: {result.duration:.2f}s",
                    title="Rollback Partial",
                    border_style="yellow"
                ))

                if result.failed_resources_details:
                    console.print("\n[bold]Failed Resources:[/bold]")
                    for resource_id, error in result.failed_resources_details.items():
                        console.print(f"  [red]✗[/red] {resource_id}: {error}")
            else:
                console.print(Panel.fit(
                    f"[red]✗ Rollback failed[/red]\n\n"
                    f"Failed: {result.failed_resources}/{result.total_resources}\n"
                    f"Duration: {result.duration:.2f}s",
                    title="Rollback Failed",
                    border_style="red"
                ))

                if result.failed_resources_details:
                    console.print("\n[bold]Failed Resources:[/bold]")
                    for resource_id, error in result.failed_resources_details.items():
                        console.print(f"  [red]✗[/red] {resource_id}: {error}")

                sys.exit(1)

        finally:
            # Clean up temp file
            import os
            os.unlink(temp_config_path)

    except Exception as e:
        logger.exception("Error during rollback")
        console.print(f"[red]Error:[/red] {e}")
        sys.exit(1)


@cli.command()
@click.option('--env', required=True, help='Environment name')
@click.option('--agent', required=True, help='Agent name to run locally')
@click.option('--config', default='warpcore.yaml', help='Path to configuration file')
@click.pass_context
def dev(ctx, env, agent, config):
    """Start local development server for an agent."""
    try:
        from warpcore.local_dev.server import LocalDevServer
        from warpcore.local_dev.connectivity import AWSConnectivityValidator
        
        # Load configuration
        cfg = load_config(config)
        
        # Get agent configuration
        agent_config = None
        for a in cfg.agents:
            if a.name == agent:
                agent_config = a
                break
        
        if not agent_config:
            console.print(f"[red]Error:[/red] Agent not found: {agent}")
            console.print(f"\nAvailable agents: {', '.join(a.name for a in cfg.agents)}")
            sys.exit(1)
        
        # Check if state exists
        state_path = get_state_path(env, cfg.project.name)
        if not state_path.exists():
            console.print(f"[red]Error:[/red] No deployment found for environment: {env}")
            console.print(f"\nDeploy first using: [cyan]warpcore deploy --env {env}[/cyan]")
            sys.exit(1)
        
        # Load state
        state_manager = StateManager(str(state_path))
        state = state_manager.load()
        
        # Display startup info
        console.print(Panel.fit(
            f"[bold]Starting Local Development Server[/bold]\n\n"
            f"Agent: {agent_config.name}\n"
            f"Environment: {env}\n"
            f"Path: {agent_config.path}\n"
            f"Runtime: {agent_config.runtime}\n"
            f"Region: {state.region}",
            title="Local Development Mode",
            border_style="cyan"
        ))
        
        # Validate AWS connectivity
        console.print("\n[cyan]Validating AWS connectivity...[/cyan]")
        validator = AWSConnectivityValidator(
            state=state,
            aws_profile=ctx.obj.get('profile')
        )
        
        all_accessible, errors = validator.validate_for_agent(agent_config.name)
        
        if not all_accessible:
            console.print("\n[yellow]⚠ Some resources are not accessible:[/yellow]")
            for error in errors:
                console.print(f"  [red]✗[/red] {error}")
            
            console.print("\n[yellow]The agent may not function correctly.[/yellow]")
            
            if not click.confirm("Continue anyway?", default=False):
                console.print("[yellow]Cancelled[/yellow]")
                sys.exit(1)
        else:
            console.print("[green]✓ All resources are accessible[/green]")
        
        # Get connectivity report for display
        report = validator.get_connectivity_report(agent_name=agent_config.name)
        
        console.print(f"\n[bold]Resource Status:[/bold]")
        console.print(f"  Total resources: {report['resources']['total']}")
        console.print(f"  Accessible: [green]{report['resources']['accessible']}[/green]")
        if report['resources']['inaccessible'] > 0:
            console.print(f"  Inaccessible: [red]{report['resources']['inaccessible']}[/red]")
        
        # Start local development server
        console.print(f"\n[cyan]Starting development server...[/cyan]\n")
        
        try:
            with LocalDevServer(
                agent_config=agent_config,
                state=state,
                aws_profile=ctx.obj.get('profile')
            ) as server:
                console.print(Panel.fit(
                    f"[green]✓ Development server running[/green]\n\n"
                    f"Agent: {agent_config.name}\n"
                    f"PID: {server.agent_process.pid if server.agent_process else 'N/A'}\n"
                    f"Watching: {agent_config.path}\n\n"
                    f"[dim]Code changes will trigger automatic reload[/dim]\n"
                    f"[dim]Press Ctrl+C to stop[/dim]",
                    title="Server Status",
                    border_style="green"
                ))
                
                # Display environment variables being injected
                console.print("\n[bold]Injected Environment Variables:[/bold]")
                env_vars = server._extract_resource_environment()
                
                if env_vars:
                    env_table = Table(show_header=True, header_style="bold cyan")
                    env_table.add_column("Variable", style="cyan")
                    env_table.add_column("Value", style="green")
                    
                    for key, value in sorted(env_vars.items()):
                        # Truncate long values
                        display_value = value
                        if len(display_value) > 60:
                            display_value = display_value[:57] + "..."
                        env_table.add_row(key, display_value)
                    
                    console.print(env_table)
                else:
                    console.print("[dim]No resource-specific environment variables[/dim]")
                
                console.print("\n[bold cyan]Logs:[/bold cyan]\n")
                
                # Keep running until interrupted
                try:
                    import signal
                    import time
                    
                    def signal_handler(sig, frame):
                        console.print("\n\n[yellow]Shutting down...[/yellow]")
                        raise KeyboardInterrupt
                    
                    signal.signal(signal.SIGINT, signal_handler)
                    
                    # Monitor process
                    while server.is_running:
                        if server.agent_process:
                            poll_result = server.agent_process.poll()
                            if poll_result is not None:
                                console.print(f"\n[red]Agent process exited with code: {poll_result}[/red]")
                                break
                        time.sleep(1)
                
                except KeyboardInterrupt:
                    pass
        
        except Exception as e:
            logger.exception("Error running development server")
            console.print(f"\n[red]Error:[/red] {e}")
            sys.exit(1)
        
        console.print("\n[green]Development server stopped[/green]")
    
    except Exception as e:
        logger.exception("Error starting development mode")
        console.print(f"[red]Error:[/red] {e}")
        sys.exit(1)


@cli.command()
@click.option('--name', prompt='Project name', help='Project name')
@click.option('--region', prompt='AWS region', default='us-east-1', help='Default AWS region')
@click.option('--force', is_flag=True, help='Overwrite existing configuration')
def init(name, region, force):
    """Initialize a new Warpcore project configuration."""
    try:
        config_path = Path.cwd() / "warpcore.yaml"
        
        # Check if config already exists
        if config_path.exists() and not force:
            console.print(f"[yellow]Configuration file already exists:[/yellow] {config_path}")
            console.print("Use [cyan]--force[/cyan] to overwrite")
            sys.exit(1)
        
        # Prompt for additional information
        console.print("\n[bold]Creating Warpcore project configuration[/bold]\n")
        
        # Agent configuration
        agent_name = click.prompt("Agent name", default="my-agent")
        agent_path = click.prompt("Agent code path", default="./agent")
        agent_runtime = click.prompt("Runtime", default="python3.11", 
                                    type=click.Choice(['python3.11', 'python3.12', 'nodejs18.x', 'nodejs20.x']))
        agent_memory = click.prompt("Memory (MB)", default=512, type=int)
        agent_timeout = click.prompt("Timeout (seconds)", default=30, type=int)
        
        # VPC configuration
        enable_vpc = click.confirm("Enable VPC?", default=False)
        
        # Environment configuration
        dev_account = click.prompt("Dev AWS account ID", default="123456789012")
        prod_account = click.prompt("Prod AWS account ID", default="987654321098")
        
        # Generate configuration
        vpc_config = ""
        if enable_vpc:
            vpc_config = "\n    cidr: 10.0.0.0/16"
        
        config_content = f"""# Warpcore Deployment Configuration
project:
  name: {name}
  region: {region}
  tags:
    team: platform
    managed-by: warpcore

agents:
  - name: {agent_name}
    path: {agent_path}
    runtime: {agent_runtime}
    memory: {agent_memory}
    timeout: {agent_timeout}
    environment:
      LOG_LEVEL: info
    handler: main.handler

shared:
  vpc:
    enabled: {str(enable_vpc).lower()}{vpc_config}
  
  api_gateway:
    type: http
    cors: true
  
  monitoring:
    xray: true
    alarms: true

environments:
  dev:
    account: "{dev_account}"
    region: {region}
  
  prod:
    account: "{prod_account}"
    region: {region}
    vpc:
      enabled: true
      cidr: 10.1.0.0/16
"""
        
        # Write configuration file
        with open(config_path, 'w') as f:
            f.write(config_content)
        
        console.print(f"\n[green]✓ Created configuration file:[/green] {config_path}")
        
        # Create agent directory structure
        agent_dir = Path.cwd() / agent_path
        if not agent_dir.exists():
            agent_dir.mkdir(parents=True, exist_ok=True)
            
            # Create sample handler
            handler_file = agent_dir / "main.py"
            handler_content = '''"""Sample Strands agent handler."""

import json
import logging

logger = logging.getLogger()
logger.setLevel(logging.INFO)


def handler(event, context):
    """Lambda handler function.
    
    Args:
        event: Lambda event
        context: Lambda context
        
    Returns:
        Response dictionary
    """
    logger.info(f"Received event: {json.dumps(event)}")
    
    return {
        'statusCode': 200,
        'body': json.dumps({
            'message': 'Hello from Strands agent!',
            'agent': '%(agent_name)s'
        })
    }
''' % {'agent_name': agent_name}
            
            with open(handler_file, 'w') as f:
                f.write(handler_content)
            
            console.print(f"[green]✓ Created agent directory:[/green] {agent_dir}")
            console.print(f"[green]✓ Created sample handler:[/green] {handler_file}")
        
        # Create .warpcore directory
        warpcore_dir = Path.cwd() / ".warpcore"
        warpcore_dir.mkdir(exist_ok=True)
        
        # Create .gitignore entry
        gitignore_path = Path.cwd() / ".gitignore"
        gitignore_entry = "\n# Warpcore deployment system\n.warpcore/\n"
        
        if gitignore_path.exists():
            with open(gitignore_path, 'r') as f:
                content = f.read()
            
            if '.warpcore/' not in content:
                with open(gitignore_path, 'a') as f:
                    f.write(gitignore_entry)
                console.print(f"[green]✓ Updated .gitignore[/green]")
        else:
            with open(gitignore_path, 'w') as f:
                f.write(gitignore_entry)
            console.print(f"[green]✓ Created .gitignore[/green]")
        
        # Display next steps
        console.print("\n[bold]Next steps:[/bold]")
        console.print("  1. Review and customize [cyan]warpcore.yaml[/cyan]")
        console.print(f"  2. Implement your agent logic in [cyan]{agent_path}/main.py[/cyan]")
        console.print("  3. Deploy to dev: [cyan]warpcore deploy --env dev[/cyan]")
        console.print("  4. Test locally: [cyan]warpcore dev --env dev --agent {agent_name}[/cyan]")
        console.print("\n[dim]For more information, visit: https://docs.warpcore.dev[/dim]")
    
    except Exception as e:
        logger.exception("Error initializing project")
        console.print(f"[red]Error:[/red] {e}")
        sys.exit(1)


if __name__ == '__main__':
    cli()
