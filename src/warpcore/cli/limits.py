"""Resource limits management."""

import copy
import json
import os
import sys

import click
from rich.console import Console
from rich.table import Table
from rich.panel import Panel

from ..utils.logging import get_logger

logger = get_logger(__name__)
console = Console()

LIMITS_FILE = '.warpcore/limits.json'

# Warn once a value is within this fraction of its limit.
APPROACHING_LIMIT_RATIO = 0.8

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
@click.option('--config', default='warpcore.yaml', help='Path to configuration file')
@click.option('--env', help='Environment to check')
def check(config: str, env: str):
    """Check if configuration exceeds limits."""
    from ..config.parser import Config, ConfigValidationError

    try:
        parsed_config = Config(config)
        parsed_config.load()

        # A typo in --env used to pass silently; report it instead.
        if env:
            parsed_config.get_environment(env)

        limits_config = _load_limits()
        lambda_limits = limits_config['lambda']

        violations = []
        warnings = []

        for agent in parsed_config.agents:
            for value, limit_key, label, unit in (
                (agent.memory, 'max_memory_mb', 'memory', 'MB'),
                (agent.timeout, 'max_timeout_seconds', 'timeout', 's'),
            ):
                limit = lambda_limits[limit_key]
                if value > limit:
                    violations.append(
                        f"Agent '{agent.name}' {label} ({value} {unit}) exceeds limit "
                        f"({limit} {unit})"
                    )
                elif value > limit * APPROACHING_LIMIT_RATIO:
                    # Only warn when it is not already a violation; the old code
                    # reported an over-limit agent twice.
                    warnings.append(
                        f"Agent '{agent.name}' {label} ({value} {unit}) is approaching "
                        f"limit ({limit} {unit})"
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
            sys.exit(1)

    except FileNotFoundError:
        console.print(f"[red]Error: Configuration file '{config}' not found[/red]")
        console.print("\nRun [cyan]warpcore init[/cyan] to create one.")
        sys.exit(1)
    except ConfigValidationError as e:
        console.print(f"[red]Configuration error:[/red] {e}")
        sys.exit(1)
    except SystemExit:
        raise
    except Exception as e:
        console.print(f"[red]Error: {e}[/red]")
        logger.exception("Limit check failed")
        sys.exit(1)


def _load_limits() -> dict:
    """Load limits from file, filling any gaps from the defaults.

    Returns a deep copy: a shallow copy shares the nested category dicts with
    DEFAULT_LIMITS, so `limits set` would mutate the module-level defaults and
    `limits reset` would then restore the mutated values.
    """
    limits_config = copy.deepcopy(DEFAULT_LIMITS)

    if not os.path.exists(LIMITS_FILE):
        return limits_config

    try:
        with open(LIMITS_FILE, 'r') as f:
            stored = json.load(f)
    except Exception as e:
        logger.warning(f"Failed to load limits file: {e}")
        return limits_config

    # Merge per category so a file written by an older version - or one missing
    # a category entirely - cannot make `check` raise KeyError.
    for category, values in (stored or {}).items():
        if isinstance(values, dict):
            limits_config.setdefault(category, {}).update(values)
        else:
            limits_config[category] = values

    return limits_config


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
