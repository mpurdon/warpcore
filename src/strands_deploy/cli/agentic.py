"""CLI commands for agentic reconciliation features."""

import sys
from pathlib import Path
from typing import Optional

import boto3
import click
from rich.console import Console
from rich.table import Table
from rich.panel import Panel
from rich.syntax import Syntax

from strands_deploy.agentic.reconciler import AgenticReconciler
from strands_deploy.agentic.llm_client import LLMClient, LLMProvider
from strands_deploy.agentic.models import DriftSeverity, DriftType
from strands_deploy.config.parser import Config
from strands_deploy.state.manager import StateManager
from strands_deploy.utils.aws_client import AWSClientManager
from strands_deploy.utils.logging import get_logger
from strands_deploy.utils.errors import DeploymentError

console = Console()
logger = get_logger(__name__)


def get_state_path(environment: str, project_name: str) -> Path:
    """Get state file path for environment."""
    state_dir = Path.cwd() / ".strands" / "state"
    return state_dir / f"{project_name}-{environment}.json"


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
    except Exception as e:
        console.print(f"[red]Error loading configuration:[/red] {e}")
        sys.exit(1)


def create_reconciler(
    config: Config,
    environment: str,
    profile: Optional[str] = None,
    region: Optional[str] = None,
    llm_provider: Optional[str] = None,
    llm_model: Optional[str] = None
) -> AgenticReconciler:
    """Create agentic reconciler."""
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
    if not state_path.exists():
        console.print(f"[red]Error:[/red] No deployment found for environment: {environment}")
        console.print(f"\nDeploy first using: [cyan]strands deploy --env {environment}[/cyan]")
        sys.exit(1)
    
    state_manager = StateManager(str(state_path))
    
    # Create LLM client if provider specified
    llm_client = None
    if llm_provider:
        try:
            provider_enum = LLMProvider(llm_provider)
            llm_client = LLMClient(provider=provider_enum, model=llm_model)
            console.print(f"[dim]Using LLM provider: {llm_provider}[/dim]")
        except ValueError:
            console.print(f"[yellow]Warning:[/yellow] Invalid LLM provider: {llm_provider}")
            console.print(f"Valid providers: {', '.join(p.value for p in LLMProvider)}")
            console.print("Continuing without LLM analysis...")
    
    # Create reconciler
    reconciler = AgenticReconciler(
        state_manager=state_manager,
        boto_session=boto_session,
        project_name=config.project.name,
        environment=environment,
        region=aws_region,
        llm_client=llm_client
    )
    
    return reconciler


@click.group()
def agentic():
    """Agentic infrastructure reconciliation and analysis."""
    pass


@agentic.command('drift')
@click.option('--env', required=True, help='Environment name')
@click.option('--config', default='strands.yaml', help='Path to configuration file')
@click.option('--llm-provider', type=click.Choice(['openai', 'anthropic', 'bedrock', 'local']), 
              help='LLM provider for analysis')
@click.option('--llm-model', help='LLM model name')
@click.option('--severity', type=click.Choice(['critical', 'high', 'medium', 'low']),
              help='Filter by severity level')
@click.option('--type', 'drift_type', type=click.Choice(['missing', 'unexpected', 'modified', 'orphaned']),
              help='Filter by drift type')
@click.pass_context
def drift_detect(ctx, env, config, llm_provider, llm_model, severity, drift_type):
    """Detect infrastructure drift between state and AWS."""
    try:
        # Load configuration
        cfg = load_config(config)
        
        console.print(Panel.fit(
            f"[bold]Drift Detection[/bold]\n\n"
            f"Environment: {env}\n"
            f"Project: {cfg.project.name}\n"
            f"LLM Analysis: {'enabled' if llm_provider else 'disabled'}",
            title="Configuration",
            border_style="cyan"
        ))
        
        # Create reconciler
        reconciler = create_reconciler(
            cfg,
            env,
            profile=ctx.obj.get('profile'),
            region=ctx.obj.get('region'),
            llm_provider=llm_provider,
            llm_model=llm_model
        )
        
        # Detect drift
        console.print("\n[cyan]Scanning AWS resources and comparing with state...[/cyan]\n")
        
        with console.status("[cyan]Detecting drift..."):
            drift_report = reconciler.detect_drift()
        
        # Filter results
        drift_items = drift_report.drift_items
        if severity:
            severity_enum = DriftSeverity(severity)
            drift_items = [d for d in drift_items if d.severity == severity_enum]
        if drift_type:
            type_enum = DriftType(drift_type)
            drift_items = [d for d in drift_items if d.drift_type == type_enum]
        
        # Display results
        if not drift_items:
            console.print(Panel.fit(
                "[green]✓ No drift detected[/green]\n\n"
                f"Total resources checked: {drift_report.total_resources_checked}\n"
                "Infrastructure matches state file",
                title="Drift Report",
                border_style="green"
            ))
            return
        
        # Display drift summary
        console.print(Panel.fit(
            f"[yellow]⚠ Drift detected[/yellow]\n\n"
            f"Total resources checked: {drift_report.total_resources_checked}\n"
            f"Drift items found: {len(drift_items)}",
            title="Drift Summary",
            border_style="yellow"
        ))
        
        # Display drift items in table
        console.print("\n[bold]Drift Details:[/bold]\n")
        
        table = Table(show_header=True, header_style="bold cyan")
        table.add_column("Resource", style="cyan")
        table.add_column("Type", style="magenta")
        table.add_column("Drift Type", style="yellow")
        table.add_column("Severity", style="red")
        table.add_column("Differences", style="white")
        
        for item in drift_items:
            # Color code severity
            severity_colors = {
                DriftSeverity.CRITICAL: "bold red",
                DriftSeverity.HIGH: "red",
                DriftSeverity.MEDIUM: "yellow",
                DriftSeverity.LOW: "dim"
            }
            severity_style = severity_colors.get(item.severity, "white")
            
            # Truncate differences
            diff_text = ", ".join(item.differences[:2])
            if len(item.differences) > 2:
                diff_text += f" (+{len(item.differences) - 2} more)"
            
            table.add_row(
                item.resource_id,
                item.resource_type,
                item.drift_type.value,
                f"[{severity_style}]{item.severity.value}[/{severity_style}]",
                diff_text
            )
        
        console.print(table)
        
        # Display LLM analysis if available
        if drift_report.analysis:
            console.print("\n[bold]AI Analysis:[/bold]\n")
            
            analysis_text = f"""[bold]Summary:[/bold]
{drift_report.analysis.summary}

[bold]Impact:[/bold]
{drift_report.analysis.impact}
"""
            if drift_report.analysis.root_cause:
                analysis_text += f"""
[bold]Root Cause:[/bold]
{drift_report.analysis.root_cause}
"""
            
            console.print(Panel(analysis_text, border_style="blue"))
            
            if drift_report.analysis.recommendations:
                console.print("\n[bold]Recommendations:[/bold]")
                for i, rec in enumerate(drift_report.analysis.recommendations, 1):
                    console.print(f"  {i}. {rec}")
            
            console.print(f"\n[dim]Confidence: {drift_report.analysis.confidence:.0%}[/dim]")
        
        # Suggest next steps
        console.print("\n[bold]Next Steps:[/bold]")
        console.print("  • Review drift items above")
        console.print("  • Generate recovery plan: [cyan]strands agentic reconcile --env {env}[/cyan]")
        console.print("  • Or manually fix drift and redeploy")
    
    except Exception as e:
        logger.exception("Error detecting drift")
        console.print(f"[red]Error:[/red] {e}")
        sys.exit(1)


@agentic.command('analyze-failure')
@click.argument('error_message')
@click.option('--env', required=True, help='Environment name')
@click.option('--config', default='strands.yaml', help='Path to configuration file')
@click.option('--llm-provider', type=click.Choice(['openai', 'anthropic', 'bedrock', 'local']),
              help='LLM provider for analysis')
@click.option('--llm-model', help='LLM model name')
@click.option('--resource-id', help='Resource that failed')
@click.option('--resource-type', help='Type of resource')
@click.pass_context
def analyze_failure(ctx, error_message, env, config, llm_provider, llm_model, resource_id, resource_type):
    """Analyze a deployment failure using AI."""
    try:
        # Load configuration
        cfg = load_config(config)
        
        console.print(Panel.fit(
            f"[bold]Failure Analysis[/bold]\n\n"
            f"Environment: {env}\n"
            f"Error: {error_message[:100]}{'...' if len(error_message) > 100 else ''}",
            title="Configuration",
            border_style="cyan"
        ))
        
        # Create reconciler
        reconciler = create_reconciler(
            cfg,
            env,
            profile=ctx.obj.get('profile'),
            region=ctx.obj.get('region'),
            llm_provider=llm_provider or 'openai',  # Default to OpenAI
            llm_model=llm_model
        )
        
        # Create deployment error for analysis
        from strands_deploy.utils.errors import DeploymentError, ErrorCategory, ErrorContext
        
        error_context = ErrorContext(
            resource_id=resource_id,
            resource_type=resource_type
        )
        
        error = DeploymentError(
            message=error_message,
            category=ErrorCategory.PROVISIONING,
            context=error_context
        )
        
        # Analyze failure
        console.print("\n[cyan]Analyzing failure with AI...[/cyan]\n")
        
        with console.status("[cyan]Analyzing..."):
            analysis = reconciler.analyze_failure(error)
        
        # Display analysis
        console.print(Panel.fit(
            f"[bold]Root Cause:[/bold]\n{analysis.root_cause}\n\n"
            f"[bold]Explanation:[/bold]\n{analysis.explanation}",
            title="Failure Analysis",
            border_style="yellow"
        ))
        
        # Display suggested fixes
        if analysis.suggested_fixes:
            console.print("\n[bold]Suggested Fixes:[/bold]")
            for i, fix in enumerate(analysis.suggested_fixes, 1):
                console.print(f"  {i}. {fix}")
        
        # Display related issues
        if analysis.related_issues:
            console.print("\n[bold]Related Known Issues:[/bold]")
            for issue in analysis.related_issues:
                console.print(f"  • {issue}")
        
        # Display prevention tips
        if analysis.prevention_tips:
            console.print("\n[bold]Prevention Tips:[/bold]")
            for tip in analysis.prevention_tips:
                console.print(f"  • {tip}")
        
        console.print(f"\n[dim]Confidence: {analysis.confidence:.0%}[/dim]")
    
    except Exception as e:
        logger.exception("Error analyzing failure")
        console.print(f"[red]Error:[/red] {e}")
        sys.exit(1)


@agentic.command('reconcile')
@click.option('--env', required=True, help='Environment name')
@click.option('--config', default='strands.yaml', help='Path to configuration file')
@click.option('--llm-provider', type=click.Choice(['openai', 'anthropic', 'bedrock', 'local']),
              help='LLM provider for analysis')
@click.option('--llm-model', help='LLM model name')
@click.option('--check-only', is_flag=True, help='Only check for issues, do not generate plan')
@click.option('--execute', is_flag=True, help='Execute recovery plan (requires confirmation)')
@click.pass_context
def reconcile(ctx, env, config, llm_provider, llm_model, check_only, execute):
    """Generate and optionally execute a recovery plan for drift."""
    try:
        # Load configuration
        cfg = load_config(config)
        
        console.print(Panel.fit(
            f"[bold]Infrastructure Reconciliation[/bold]\n\n"
            f"Environment: {env}\n"
            f"Project: {cfg.project.name}\n"
            f"Mode: {'check only' if check_only else 'generate plan'}",
            title="Configuration",
            border_style="cyan"
        ))
        
        # Create reconciler
        reconciler = create_reconciler(
            cfg,
            env,
            profile=ctx.obj.get('profile'),
            region=ctx.obj.get('region'),
            llm_provider=llm_provider or 'openai',
            llm_model=llm_model
        )
        
        # Detect drift first
        console.print("\n[cyan]Step 1: Detecting drift...[/cyan]\n")
        
        with console.status("[cyan]Scanning..."):
            drift_report = reconciler.detect_drift()
        
        if not drift_report.has_drift():
            console.print(Panel.fit(
                "[green]✓ No drift detected[/green]\n\n"
                "Infrastructure matches state file\n"
                "No reconciliation needed",
                title="Reconciliation Status",
                border_style="green"
            ))
            return
        
        console.print(f"[yellow]Found {len(drift_report.drift_items)} drift items[/yellow]")
        
        # Check for missing resources
        console.print("\n[cyan]Step 2: Checking for missing resources...[/cyan]\n")
        
        with console.status("[cyan]Scanning..."):
            missing_resources = reconciler.find_missing_resources()
        
        if missing_resources:
            console.print(f"[yellow]Found {len(missing_resources)} missing resources[/yellow]")
            
            # Display top missing resources
            console.print("\n[bold]Top Missing Resources:[/bold]")
            for resource in missing_resources[:5]:
                console.print(f"  • {resource.resource_id} ({resource.resource_type}) - Priority: {resource.priority}")
        else:
            console.print("[green]No missing resources[/green]")
        
        if check_only:
            console.print("\n[yellow]Check-only mode - stopping here[/yellow]")
            console.print("\nRun without [cyan]--check-only[/cyan] to generate recovery plan")
            return
        
        # Generate recovery plan
        console.print("\n[cyan]Step 3: Generating recovery plan with AI...[/cyan]\n")
        
        with console.status("[cyan]Generating plan..."):
            recovery_plan = reconciler.generate_recovery_plan(drift_report)
        
        # Display recovery plan
        console.print(Panel.fit(
            f"[bold]Recovery Plan[/bold]\n\n"
            f"{recovery_plan.explanation}\n\n"
            f"Total actions: {recovery_plan.get_action_count()}\n"
            f"Estimated duration: {recovery_plan.estimated_duration or 'Unknown'}s",
            title="AI-Generated Plan",
            border_style="blue"
        ))
        
        # Display actions
        if recovery_plan.actions:
            console.print("\n[bold]Recovery Actions:[/bold]\n")
            
            table = Table(show_header=True, header_style="bold cyan")
            table.add_column("#", style="dim")
            table.add_column("Action", style="cyan")
            table.add_column("Resource", style="magenta")
            table.add_column("Type", style="yellow")
            table.add_column("Rationale", style="white")
            
            for i, action in enumerate(recovery_plan.actions, 1):
                table.add_row(
                    str(i),
                    action.action_type,
                    action.resource_id,
                    action.resource_type,
                    action.rationale[:50] + "..." if len(action.rationale) > 50 else action.rationale
                )
            
            console.print(table)
        
        # Display risks
        if recovery_plan.risks:
            console.print("\n[bold yellow]⚠ Risks:[/bold yellow]")
            for risk in recovery_plan.risks:
                console.print(f"  • {risk}")
        
        # Display rollback plan
        if recovery_plan.rollback_plan:
            console.print(f"\n[bold]Rollback Plan:[/bold]\n{recovery_plan.rollback_plan}")
        
        # Execute if requested
        if execute:
            console.print("\n[bold red]⚠ WARNING: Execution not yet implemented[/bold red]")
            console.print("\nThe recovery plan above is AI-generated and should be:")
            console.print("  1. Carefully reviewed by a human")
            console.print("  2. Tested in a non-production environment")
            console.print("  3. Executed manually or through the standard deployment process")
            console.print("\n[dim]Automatic execution will be available in a future release[/dim]")
        else:
            console.print("\n[bold]Next Steps:[/bold]")
            console.print("  • Review the recovery plan above")
            console.print("  • Verify the suggested actions are appropriate")
            console.print("  • Execute manually or through standard deployment")
            console.print("\n[dim]Note: Add --execute flag for automatic execution (when available)[/dim]")
    
    except Exception as e:
        logger.exception("Error during reconciliation")
        console.print(f"[red]Error:[/red] {e}")
        sys.exit(1)


@agentic.command('missing')
@click.option('--env', required=True, help='Environment name')
@click.option('--config', default='strands.yaml', help='Path to configuration file')
@click.option('--llm-provider', type=click.Choice(['openai', 'anthropic', 'bedrock', 'local']),
              help='LLM provider for analysis')
@click.option('--llm-model', help='LLM model name')
@click.pass_context
def find_missing(ctx, env, config, llm_provider, llm_model):
    """Find resources that should exist but don't."""
    try:
        # Load configuration
        cfg = load_config(config)
        
        console.print(Panel.fit(
            f"[bold]Missing Resource Detection[/bold]\n\n"
            f"Environment: {env}\n"
            f"Project: {cfg.project.name}",
            title="Configuration",
            border_style="cyan"
        ))
        
        # Create reconciler
        reconciler = create_reconciler(
            cfg,
            env,
            profile=ctx.obj.get('profile'),
            region=ctx.obj.get('region'),
            llm_provider=llm_provider,
            llm_model=llm_model
        )
        
        # Find missing resources
        console.print("\n[cyan]Scanning for missing resources...[/cyan]\n")
        
        with console.status("[cyan]Scanning..."):
            missing_resources = reconciler.find_missing_resources()
        
        # Display results
        if not missing_resources:
            console.print(Panel.fit(
                "[green]✓ No missing resources[/green]\n\n"
                "All resources in state file exist in AWS",
                title="Missing Resources",
                border_style="green"
            ))
            return
        
        console.print(Panel.fit(
            f"[yellow]⚠ Missing resources detected[/yellow]\n\n"
            f"Found {len(missing_resources)} missing resources",
            title="Missing Resources",
            border_style="yellow"
        ))
        
        # Display missing resources in table
        console.print("\n[bold]Missing Resources (prioritized):[/bold]\n")
        
        table = Table(show_header=True, header_style="bold cyan")
        table.add_column("Priority", style="red")
        table.add_column("Resource", style="cyan")
        table.add_column("Type", style="magenta")
        table.add_column("Impact", style="yellow")
        table.add_column("Reason", style="white")
        
        for resource in missing_resources:
            # Color code priority
            priority_style = "bold red" if resource.priority <= 3 else "yellow" if resource.priority <= 6 else "dim"
            
            table.add_row(
                f"[{priority_style}]{resource.priority}[/{priority_style}]",
                resource.resource_id,
                resource.resource_type,
                resource.impact[:40] + "..." if len(resource.impact) > 40 else resource.impact,
                resource.reason[:40] + "..." if resource.reason and len(resource.reason) > 40 else resource.reason or "Unknown"
            )
        
        console.print(table)
        
        # Suggest next steps
        console.print("\n[bold]Next Steps:[/bold]")
        console.print("  • Review missing resources above")
        console.print("  • Generate recovery plan: [cyan]strands agentic reconcile --env {env}[/cyan]")
        console.print("  • Or redeploy: [cyan]strands deploy --env {env}[/cyan]")
    
    except Exception as e:
        logger.exception("Error finding missing resources")
        console.print(f"[red]Error:[/red] {e}")
        sys.exit(1)


if __name__ == '__main__':
    agentic()
