"""Main CLI entry point."""

import sys
from pathlib import Path
from typing import Optional

import boto3
import click
from rich.console import Console
from rich.progress import Progress, SpinnerColumn, TextColumn, BarColumn, TaskProgressColumn
from rich.table import Table
from rich.panel import Panel

from strands_deploy.utils.logging import setup_logging, get_logger
from strands_deploy.cli.costs import costs
from strands_deploy.cli.agentic import agentic
from strands_deploy.config.parser import Config, ConfigValidationError
from strands_deploy.state.manager import StateManager, StateNotFoundError
from strands_deploy.state.checkpoint import CheckpointManager
from strands_deploy.orchestrator.orchestrator import DeploymentOrchestrator
from strands_deploy.orchestrator.rollback import RollbackStrategy
from strands_deploy.orchestrator.executor import ExecutionStatus, ProgressCallback
from strands_deploy.utils.aws_client import AWSClientManager
from strands_deploy.utils.errors import DeploymentError
from strands_deploy.provisioners import (
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
    """Strands AWS Deployment System."""
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


def load_config(config_path: str = "strands.yaml") -> Config:
    """Load and validate configuration file."""
    try:
        config = Config(config_path)
        config.load()
        return config
    except FileNotFoundError:
        console.print(f"[red]Error:[/red] Configuration file not found: {config_path}")
        console.print("\nRun [cyan]strands init[/cyan] to create a new configuration file.")
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
    state_dir = Path.cwd() / ".strands" / "state"
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
@click.option('--config', default='strands.yaml', help='Path to configuration file')
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
@click.option('--config', default='strands.yaml', help='Path to configuration file')
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
@click.option('--config', default='strands.yaml', help='Path to configuration file')
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
@click.option('--config', default='strands.yaml', help='Path to configuration file')
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
@click.option('--config', default='strands.yaml', help='Path to configuration file')
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
@click.option('--config', default='strands.yaml', help='Path to configuration file')
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
@click.option('--config', default='strands.yaml', help='Path to configuration file')
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


@cli.group()
def history():
    """View deployment history and logs."""
    pass


@history.command('list')
@click.option('--env', required=True, help='Environment name')
@click.option('--config', default='strands.yaml', help='Path to configuration file')
@click.option('--limit', default=10, help='Number of deployments to show')
def history_list(env, config, limit):
    """List deployment history."""
    try:
        # Load configuration
        cfg = load_config(config)
        
        # Check for log files
        log_dir = Path.cwd() / "src" / ".strands" / "logs"
        if not log_dir.exists():
            console.print("[yellow]No deployment history found[/yellow]")
            console.print("\n[dim]Note: Full S3-based deployment history will be available in a future release[/dim]")
            return
        
        # Find log files
        log_files = sorted(log_dir.glob("strands-*.jsonl"), reverse=True)
        
        if not log_files:
            console.print("[yellow]No deployment history found[/yellow]")
            return
        
        console.print(f"\n[bold]Recent Deployments for {env}[/bold]\n")
        
        # Create table
        table = Table(show_header=True, header_style="bold cyan")
        table.add_column("Date", style="cyan")
        table.add_column("Log File", style="magenta")
        table.add_column("Size", style="green")
        
        for log_file in log_files[:limit]:
            # Get file info
            stat = log_file.stat()
            size_kb = stat.st_size / 1024
            
            table.add_row(
                log_file.stem.replace("strands-", ""),
                log_file.name,
                f"{size_kb:.1f} KB"
            )
        
        console.print(table)
        console.print("\n[dim]Note: Full S3-based deployment history with metadata will be available in a future release[/dim]")
    
    except Exception as e:
        logger.exception("Error listing history")
        console.print(f"[red]Error:[/red] {e}")
        sys.exit(1)


@history.command('show')
@click.argument('deployment_id')
@click.option('--env', required=True, help='Environment name')
@click.option('--config', default='strands.yaml', help='Path to configuration file')
def history_show(deployment_id, env, config):
    """Show details of a specific deployment."""
    console.print("[yellow]This command will be fully implemented with S3-based deployment history (task 10)[/yellow]")
    console.print(f"\nDeployment ID: {deployment_id}")
    console.print(f"Environment: {env}")
    console.print("\n[dim]Full deployment history with metadata, logs, and state snapshots will be available in a future release[/dim]")


@history.command('logs')
@click.option('--env', required=True, help='Environment name')
@click.option('--config', default='strands.yaml', help='Path to configuration file')
@click.option('--lines', default=50, help='Number of log lines to show')
@click.option('--follow', '-f', is_flag=True, help='Follow log output')
def history_logs(env, config, lines, follow):
    """View deployment logs."""
    try:
        # Find most recent log file
        log_dir = Path.cwd() / "src" / ".strands" / "logs"
        if not log_dir.exists():
            console.print("[yellow]No logs found[/yellow]")
            return
        
        log_files = sorted(log_dir.glob("strands-*.jsonl"), reverse=True)
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
@click.option('--config', default='strands.yaml', help='Path to configuration file')
def history_compare(deployment1, deployment2, env, config):
    """Compare two deployments."""
    console.print("[yellow]This command will be fully implemented with S3-based deployment history (task 10)[/yellow]")
    console.print(f"\nComparing:")
    console.print(f"  Deployment 1: {deployment1}")
    console.print(f"  Deployment 2: {deployment2}")
    console.print(f"  Environment: {env}")
    console.print("\n[dim]Full deployment comparison with configuration diffs, state changes, and cost analysis will be available in a future release[/dim]")


@history.command('rollback')
@click.argument('deployment_id')
@click.option('--env', required=True, help='Environment name')
@click.option('--yes', '-y', is_flag=True, help='Skip confirmation prompt')
@click.option('--config', default='strands.yaml', help='Path to configuration file')
def history_rollback(deployment_id, env, yes, config):
    """Rollback to a previous deployment."""
    try:
        # Load configuration
        cfg = load_config(config)
        
        console.print(Panel.fit(
            f"[bold yellow]⚠ WARNING: Rollback operation[/bold yellow]\n\n"
            f"This will rollback to deployment: {deployment_id}\n"
            f"Environment: {env}\n\n"
            f"[dim]Note: Full rollback with S3-based history will be available in task 10.\n"
            f"Current implementation uses state-based rollback.[/dim]",
            title="Rollback Confirmation",
            border_style="yellow"
        ))
        
        # Confirmation prompt
        if not yes:
            confirm = click.confirm(
                "Are you sure you want to rollback?",
                default=False
            )
            if not confirm:
                console.print("[yellow]Rollback cancelled[/yellow]")
                return
        
        console.print("\n[yellow]Full rollback functionality will be implemented with S3-based deployment history (task 10)[/yellow]")
        console.print("\nFor now, use the [cyan]destroy[/cyan] command to remove resources and redeploy.")
    
    except Exception as e:
        logger.exception("Error during rollback")
        console.print(f"[red]Error:[/red] {e}")
        sys.exit(1)


@cli.command()
@click.option('--env', required=True, help='Environment name')
@click.option('--agent', required=True, help='Agent name to run locally')
@click.option('--config', default='strands.yaml', help='Path to configuration file')
@click.pass_context
def dev(ctx, env, agent, config):
    """Start local development server for an agent."""
    try:
        from strands_deploy.local_dev.server import LocalDevServer
        from strands_deploy.local_dev.connectivity import AWSConnectivityValidator
        
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
            console.print(f"\nDeploy first using: [cyan]strands deploy --env {env}[/cyan]")
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
    """Initialize a new Strands project configuration."""
    try:
        config_path = Path.cwd() / "strands.yaml"
        
        # Check if config already exists
        if config_path.exists() and not force:
            console.print(f"[yellow]Configuration file already exists:[/yellow] {config_path}")
            console.print("Use [cyan]--force[/cyan] to overwrite")
            sys.exit(1)
        
        # Prompt for additional information
        console.print("\n[bold]Creating Strands project configuration[/bold]\n")
        
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
        config_content = f"""# Strands AWS Deployment Configuration
project:
  name: {name}
  region: {region}
  tags:
    team: platform
    managed-by: strands

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
    enabled: {str(enable_vpc).lower()}
    cidr: 10.0.0.0/16
  
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
        
        # Create .strands directory
        strands_dir = Path.cwd() / ".strands"
        strands_dir.mkdir(exist_ok=True)
        
        # Create .gitignore entry
        gitignore_path = Path.cwd() / ".gitignore"
        gitignore_entry = "\n# Strands deployment system\n.strands/\n"
        
        if gitignore_path.exists():
            with open(gitignore_path, 'r') as f:
                content = f.read()
            
            if '.strands/' not in content:
                with open(gitignore_path, 'a') as f:
                    f.write(gitignore_entry)
                console.print(f"[green]✓ Updated .gitignore[/green]")
        else:
            with open(gitignore_path, 'w') as f:
                f.write(gitignore_entry)
            console.print(f"[green]✓ Created .gitignore[/green]")
        
        # Display next steps
        console.print("\n[bold]Next steps:[/bold]")
        console.print("  1. Review and customize [cyan]strands.yaml[/cyan]")
        console.print(f"  2. Implement your agent logic in [cyan]{agent_path}/main.py[/cyan]")
        console.print("  3. Deploy to dev: [cyan]strands deploy --env dev[/cyan]")
        console.print("  4. Test locally: [cyan]strands dev --env dev --agent {agent_name}[/cyan]")
        console.print("\n[dim]For more information, visit: https://docs.strands.dev[/dim]")
    
    except Exception as e:
        logger.exception("Error initializing project")
        console.print(f"[red]Error:[/red] {e}")
        sys.exit(1)


if __name__ == '__main__':
    cli()
