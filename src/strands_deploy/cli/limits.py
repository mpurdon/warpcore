"""Resource limits management."""

import click
from rich.console import Console
from rich.table import Table
from rich.panel import Panel
import json
import os

from ..utils.logging import get_logger

logger = get_logger(__name__)
console = Console()

LIMITS_FILE = '.strands/limits.json'

DEFAULT_LIMITS = {
    'lambda': {
        'max_memory_mb': 3008,
        'max_timeout_seconds': 300,
        'max_concurrent_executions': 100
    },
    'dynamodb': {
        'max_read_capacity': 1000,
        'max_write_capacity': 1000
    },
    'api_gateway': {
        'max_throttle_rate': 10000,
        'max_throttle_burst': 5000
    },
    'vpc': {
        'max_nat_gateways': 3,
        'max_vpcs_per_region': 5
    },
    'cost': {
        'max_monthly_cost_usd': 1000,
        'alert_threshold_percent': 80
    }
}


@click.group()
def limits():
    """Manage organizational resource limits."""
    pass


@limits.command()
@click.option('--json-output', is_flag=True, help='Output in JSON format')
def show(json_output: bool):
    """Show current resource limits."""
    limits_config = _load_limits()
    
    if json_output:
        console.print_json(data=limits_config)
    else:
        _display_limits(limits_config)


@limits.command()
@click.argument('category')
@click.argument('limit_name')
@click.argument('value', type=int)
def set(category: str, limit_name: str, value: int):
    """Set a resource limit."""
    limits_config = _load_limits()
    
    if category not in limits_config:
        console.print(f"[red]Error: Unknown category '{category}'[/red]")
        console.print(f"[dim]Valid categories: {', '.join(limits_config.keys())}[/dim]")
        return
    
    if limit_name not in limits_config[category]:
        console.print(f"[red]Error: Unknown limit '{limit_name}' in category '{category}'[/red]")
        console.print(f"[dim]Valid limits: {', '.join(limits_config[category].keys())}[/dim]")
        return
    
    limits_config[category][limit_name] = value
    _save_limits(limits_config)
    
    console.print(f"[green]✓ Set {category}.{limit_name} = {value}[/green]")


@limits.command()
def reset():
    """Reset limits to defaults."""
    if click.confirm('Reset all limits to defaults?'):
        _save_limits(DEFAULT_LIMITS)
        console.print("[green]✓ Limits reset to defaults[/green]")


@limits.command()
@click.option('--config', default='strands.yaml', help='Path to configuration file')
@click.option('--env', help='Environment to check')
def check(config: str, env: str):
    """Check if configuration exceeds limits."""
    from ..config.parser import ConfigParser
    
    try:
        # Load configuration
        config_parser = ConfigParser(config)
        parsed_config = config_parser.parse()
        
        # Load limits
        limits_config = _load_limits()
        
        # Check limits
        violations = []
        warnings = []
        
        # Check Lambda limits
        for agent in parsed_config.agents:
            if agent.memory > limits_config['lambda']['max_memory_mb']:
                violations.append(
                    f"Agent '{agent.name}' memory ({agent.memory} MB) exceeds limit "
                    f"({limits_config['lambda']['max_memory_mb']} MB)"
                )
            
            if agent.timeout > limits_config['lambda']['max_timeout_seconds']:
                violations.append(
                    f"Agent '{agent.name}' timeout ({agent.timeout}s) exceeds limit "
                    f"({limits_config['lambda']['max_timeout_seconds']}s)"
                )
            
            # Warnings for approaching limits
            if agent.memory > limits_config['lambda']['max_memory_mb'] * 0.8:
                warnings.append(
                    f"Agent '{agent.name}' memory ({agent.memory} MB) is approaching limit "
                    f"({limits_config['lambda']['max_memory_mb']} MB)"
                )
        
        # Display results
        if violations:
            console.print("[bold red]Limit Violations:[/bold red]")
            for violation in violations:
                console.print(f"  [red]✗[/red] {violation}")
            console.print()
        
        if warnings:
            console.print("[bold yellow]Warnings:[/bold yellow]")
            for warning in warnings:
                console.print(f"  [yellow]⚠[/yellow] {warning}")
            console.print()
        
        if not violations and not warnings:
            console.print("[green]✓ Configuration is within all limits[/green]")
        
        # Exit with error if violations
        if violations:
            exit(1)
            
    except FileNotFoundError:
        console.print(f"[red]Error: Configuration file '{config}' not found[/red]")
        exit(1)
    except Exception as e:
        console.print(f"[red]Error: {e}[/red]")
        logger.exception("Limit check failed")
        exit(1)


def _load_limits() -> dict:
    """Load limits from file or return defaults."""
    if os.path.exists(LIMITS_FILE):
        try:
            with open(LIMITS_FILE, 'r') as f:
                return json.load(f)
        except Exception as e:
            logger.warning(f"Failed to load limits file: {e}")
    
    return DEFAULT_LIMITS.copy()


def _save_limits(limits: dict):
    """Save limits to file."""
    os.makedirs(os.path.dirname(LIMITS_FILE), exist_ok=True)
    
    with open(LIMITS_FILE, 'w') as f:
        json.dump(limits, f, indent=2)


def _display_limits(limits: dict):
    """Display limits in rich format."""
    console.print(Panel("Organizational Resource Limits", style="bold blue"))
    console.print()
    
    for category, category_limits in limits.items():
        console.print(f"[bold cyan]{category.upper()}[/bold cyan]")
        
        table = Table(show_header=False, box=None, padding=(0, 2))
        table.add_column("Limit", style="white")
        table.add_column("Value", style="green", justify="right")
        
        for limit_name, value in category_limits.items():
            display_name = limit_name.replace('_', ' ').title()
            
            # Format value based on type
            if 'cost' in limit_name or 'usd' in limit_name:
                display_value = f"${value:,}"
            elif 'percent' in limit_name:
                display_value = f"{value}%"
            else:
                display_value = f"{value:,}"
            
            table.add_row(f"  {display_name}", display_value)
        
        console.print(table)
        console.print()
    
    console.print(f"[dim]Limits file: {LIMITS_FILE}[/dim]")
