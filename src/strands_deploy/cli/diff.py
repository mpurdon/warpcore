"""Diff command for showing deployment changes without executing."""

import click
from rich.console import Console
from rich.table import Table
from rich.panel import Panel
from rich.text import Text
from typing import Dict, List, Tuple
import json

from ..config.parser import ConfigParser
from ..state.manager import StateManager
from ..orchestrator.planner import DeploymentPlanner
from ..utils.logging import get_logger

logger = get_logger(__name__)
console = Console()


@click.command()
@click.option('--env', required=True, help='Environment name')
@click.option('--agent', help='Specific agent to show diff for')
@click.option('--json-output', is_flag=True, help='Output in JSON format')
def diff(env: str, agent: str, json_output: bool):
    """Show what would change in a deployment without executing it."""
    try:
        # Load configuration
        config_parser = ConfigParser('strands.yaml')
        config = config_parser.parse()
        
        # Validate environment
        if env not in config.environments:
            console.print(f"[red]Error: Environment '{env}' not found in configuration[/red]")
            return
        
        # Load current state
        state_manager = StateManager(f'.strands/state/{env}.json')
        current_state = state_manager.load()
        
        # Create deployment plan
        planner = DeploymentPlanner(config, state_manager)
        plan = planner.plan_deployment(agent_filter=agent)
        
        if json_output:
            _output_json(plan)
        else:
            _output_rich(plan, env, agent)
            
    except FileNotFoundError as e:
        console.print(f"[red]Error: Configuration file not found: {e}[/red]")
    except Exception as e:
        console.print(f"[red]Error: {e}[/red]")
        logger.exception("Failed to generate diff")


def _output_json(plan):
    """Output diff in JSON format."""
    output = {
        'summary': {
            'to_add': len(plan.changes.get('CREATE', [])),
            'to_change': len(plan.changes.get('UPDATE', [])),
            'to_destroy': len(plan.changes.get('DELETE', []))
        },
        'changes': {
            'create': [r.id for r in plan.changes.get('CREATE', [])],
            'update': [r.id for r in plan.changes.get('UPDATE', [])],
            'delete': [r.id for r in plan.changes.get('DELETE', [])]
        },
        'resources': []
    }
    
    for change_type, resources in plan.changes.items():
        for resource in resources:
            output['resources'].append({
                'id': resource.id,
                'type': resource.type,
                'action': change_type.lower(),
                'properties': resource.properties
            })
    
    console.print_json(data=output)


def _output_rich(plan, env: str, agent: str):
    """Output diff in rich formatted text."""
    # Header
    title = f"Deployment Diff for Environment: {env}"
    if agent:
        title += f" (Agent: {agent})"
    
    console.print(Panel(title, style="bold blue"))
    console.print()
    
    # Summary
    creates = plan.changes.get('CREATE', [])
    updates = plan.changes.get('UPDATE', [])
    deletes = plan.changes.get('DELETE', [])
    
    summary = Text()
    summary.append("Plan: ", style="bold")
    
    if creates:
        summary.append(f"{len(creates)} to add", style="green")
    else:
        summary.append("0 to add", style="dim")
    
    summary.append(", ")
    
    if updates:
        summary.append(f"{len(updates)} to change", style="yellow")
    else:
        summary.append("0 to change", style="dim")
    
    summary.append(", ")
    
    if deletes:
        summary.append(f"{len(deletes)} to destroy", style="red")
    else:
        summary.append("0 to destroy", style="dim")
    
    console.print(summary)
    console.print()
    
    # No changes
    if not creates and not updates and not deletes:
        console.print("[dim]No changes. Infrastructure is up-to-date.[/dim]")
        return
    
    # Resources to create
    if creates:
        console.print("[bold green]Resources to create:[/bold green]")
        table = Table(show_header=True, header_style="bold")
        table.add_column("Resource ID", style="cyan")
        table.add_column("Type", style="magenta")
        table.add_column("Details")
        
        for resource in creates:
            details = _format_resource_details(resource)
            table.add_row(f"+ {resource.id}", resource.type, details)
        
        console.print(table)
        console.print()
    
    # Resources to update
    if updates:
        console.print("[bold yellow]Resources to update:[/bold yellow]")
        table = Table(show_header=True, header_style="bold")
        table.add_column("Resource ID", style="cyan")
        table.add_column("Type", style="magenta")
        table.add_column("Changes")
        
        for resource in updates:
            changes = _format_resource_changes(resource)
            table.add_row(f"~ {resource.id}", resource.type, changes)
        
        console.print(table)
        console.print()
    
    # Resources to delete
    if deletes:
        console.print("[bold red]Resources to destroy:[/bold red]")
        table = Table(show_header=True, header_style="bold")
        table.add_column("Resource ID", style="cyan")
        table.add_column("Type", style="magenta")
        table.add_column("Physical ID")
        
        for resource in deletes:
            table.add_row(f"- {resource.id}", resource.type, resource.physical_id or "N/A")
        
        console.print(table)
        console.print()
    
    # Deployment waves
    if plan.waves:
        console.print(f"[bold]Deployment will execute in {len(plan.waves)} wave(s):[/bold]")
        for i, wave in enumerate(plan.waves, 1):
            console.print(f"  Wave {i}: {len(wave)} resource(s) in parallel")
        console.print()
    
    # Estimated duration
    if plan.estimated_duration:
        minutes = plan.estimated_duration // 60
        seconds = plan.estimated_duration % 60
        console.print(f"[dim]Estimated duration: {minutes}m {seconds}s[/dim]")


def _format_resource_details(resource) -> str:
    """Format resource details for display."""
    details = []
    
    if 'name' in resource.properties:
        details.append(f"name={resource.properties['name']}")
    
    if 'runtime' in resource.properties:
        details.append(f"runtime={resource.properties['runtime']}")
    
    if 'memory' in resource.properties:
        details.append(f"memory={resource.properties['memory']}")
    
    return ", ".join(details) if details else "N/A"


def _format_resource_changes(resource) -> str:
    """Format resource changes for display."""
    # This would compare with current state to show specific changes
    # For now, just indicate that changes are detected
    if hasattr(resource, 'change_details'):
        return resource.change_details
    return "Configuration changed"
