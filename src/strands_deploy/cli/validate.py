"""Validate command for checking configuration without deploying."""

import click
from rich.console import Console
from rich.table import Table
from rich.panel import Panel
from rich.text import Text
from typing import List, Dict
import json

from ..config.parser import ConfigParser
from ..config.models import ValidationError
from ..utils.logging import get_logger

logger = get_logger(__name__)
console = Console()


@click.command()
@click.option('--config', default='strands.yaml', help='Path to configuration file')
@click.option('--env', help='Validate specific environment')
@click.option('--strict', is_flag=True, help='Enable strict validation with warnings as errors')
@click.option('--json-output', is_flag=True, help='Output in JSON format')
def validate(config: str, env: str, strict: bool, json_output: bool):
    """Validate configuration file without deploying."""
    try:
        # Parse configuration
        config_parser = ConfigParser(config)
        parsed_config = config_parser.parse()
        
        # Collect validation results
        errors = []
        warnings = []
        
        # Validate configuration structure
        validation_errors = config_parser.validate()
        for error in validation_errors:
            if error.severity == 'error':
                errors.append(error)
            else:
                warnings.append(error)
        
        # Validate environment if specified
        if env:
            if env not in parsed_config.environments:
                errors.append(ValidationError(
                    field='environment',
                    message=f"Environment '{env}' not found in configuration",
                    severity='error'
                ))
            else:
                env_errors = _validate_environment(parsed_config, env)
                errors.extend([e for e in env_errors if e.severity == 'error'])
                warnings.extend([e for e in env_errors if e.severity == 'warning'])
        
        # Validate agents
        agent_errors = _validate_agents(parsed_config)
        errors.extend([e for e in agent_errors if e.severity == 'error'])
        warnings.extend([e for e in agent_errors if e.severity == 'warning'])
        
        # Validate IAM policies
        iam_errors = _validate_iam_policies(parsed_config)
        errors.extend([e for e in iam_errors if e.severity == 'error'])
        warnings.extend([e for e in iam_errors if e.severity == 'warning'])
        
        # Validate VPC configuration
        vpc_errors = _validate_vpc_config(parsed_config)
        errors.extend([e for e in vpc_errors if e.severity == 'error'])
        warnings.extend([e for e in vpc_errors if e.severity == 'warning'])
        
        # Output results
        if json_output:
            _output_json(errors, warnings, strict)
        else:
            _output_rich(config, errors, warnings, strict)
        
        # Exit with appropriate code
        if errors or (strict and warnings):
            exit(1)
        else:
            exit(0)
            
    except FileNotFoundError:
        console.print(f"[red]Error: Configuration file '{config}' not found[/red]")
        exit(1)
    except Exception as e:
        console.print(f"[red]Error: {e}[/red]")
        logger.exception("Validation failed")
        exit(1)


def _validate_environment(config, env_name: str) -> List[ValidationError]:
    """Validate environment-specific configuration."""
    errors = []
    env_config = config.environments[env_name]
    
    # Check account ID format
    if not env_config.account.isdigit() or len(env_config.account) != 12:
        errors.append(ValidationError(
            field=f'environments.{env_name}.account',
            message='AWS account ID must be 12 digits',
            severity='error'
        ))
    
    # Check region format
    valid_regions = ['us-east-1', 'us-east-2', 'us-west-1', 'us-west-2', 'eu-west-1', 'eu-central-1', 'ap-southeast-1', 'ap-northeast-1']
    if env_config.region not in valid_regions:
        errors.append(ValidationError(
            field=f'environments.{env_name}.region',
            message=f'Region should be one of: {", ".join(valid_regions)}',
            severity='warning'
        ))
    
    return errors


def _validate_agents(config) -> List[ValidationError]:
    """Validate agent configurations."""
    errors = []
    
    for agent in config.agents:
        # Check runtime
        valid_runtimes = ['python3.9', 'python3.10', 'python3.11', 'python3.12', 'nodejs18.x', 'nodejs20.x']
        if agent.runtime not in valid_runtimes:
            errors.append(ValidationError(
                field=f'agents.{agent.name}.runtime',
                message=f'Runtime should be one of: {", ".join(valid_runtimes)}',
                severity='error'
            ))
        
        # Check memory
        if agent.memory < 128 or agent.memory > 10240:
            errors.append(ValidationError(
                field=f'agents.{agent.name}.memory',
                message='Memory must be between 128 and 10240 MB',
                severity='error'
            ))
        
        if agent.memory % 64 != 0:
            errors.append(ValidationError(
                field=f'agents.{agent.name}.memory',
                message='Memory must be a multiple of 64 MB',
                severity='error'
            ))
        
        # Check timeout
        if agent.timeout < 1 or agent.timeout > 900:
            errors.append(ValidationError(
                field=f'agents.{agent.name}.timeout',
                message='Timeout must be between 1 and 900 seconds',
                severity='error'
            ))
        
        # Warn about high memory/timeout
        if agent.memory > 3008:
            errors.append(ValidationError(
                field=f'agents.{agent.name}.memory',
                message=f'High memory allocation ({agent.memory} MB) may increase costs',
                severity='warning'
            ))
        
        if agent.timeout > 300:
            errors.append(ValidationError(
                field=f'agents.{agent.name}.timeout',
                message=f'Long timeout ({agent.timeout}s) may indicate architectural issues',
                severity='warning'
            ))
    
    return errors


def _validate_iam_policies(config) -> List[ValidationError]:
    """Validate IAM policy configurations."""
    errors = []
    
    # Check for overly permissive policies
    for agent in config.agents:
        if hasattr(agent, 'permissions'):
            for permission in agent.permissions:
                if permission.get('action') == '*':
                    errors.append(ValidationError(
                        field=f'agents.{agent.name}.permissions',
                        message='Wildcard (*) permissions are not recommended',
                        severity='warning'
                    ))
                
                if permission.get('resource') == '*':
                    errors.append(ValidationError(
                        field=f'agents.{agent.name}.permissions',
                        message='Wildcard (*) resources should be avoided when possible',
                        severity='warning'
                    ))
    
    return errors


def _validate_vpc_config(config) -> List[ValidationError]:
    """Validate VPC configuration."""
    errors = []
    
    if hasattr(config, 'shared') and hasattr(config.shared, 'vpc'):
        vpc_config = config.shared.vpc
        
        if vpc_config.enabled:
            # Check CIDR format
            if hasattr(vpc_config, 'cidr'):
                cidr = vpc_config.cidr
                if not _is_valid_cidr(cidr):
                    errors.append(ValidationError(
                        field='shared.vpc.cidr',
                        message=f'Invalid CIDR format: {cidr}',
                        severity='error'
                    ))
            
            # Check IPAM configuration
            if hasattr(vpc_config, 'ipam') and vpc_config.ipam.enabled:
                if not hasattr(vpc_config.ipam, 'pool_id'):
                    errors.append(ValidationError(
                        field='shared.vpc.ipam',
                        message='IPAM pool_id is required when IPAM is enabled',
                        severity='error'
                    ))
                
                if hasattr(vpc_config.ipam, 'netmask_length'):
                    netmask = vpc_config.ipam.netmask_length
                    if netmask < 16 or netmask > 28:
                        errors.append(ValidationError(
                            field='shared.vpc.ipam.netmask_length',
                            message='Netmask length should be between 16 and 28',
                            severity='warning'
                        ))
    
    return errors


def _is_valid_cidr(cidr: str) -> bool:
    """Check if CIDR notation is valid."""
    try:
        parts = cidr.split('/')
        if len(parts) != 2:
            return False
        
        ip_parts = parts[0].split('.')
        if len(ip_parts) != 4:
            return False
        
        for part in ip_parts:
            if not 0 <= int(part) <= 255:
                return False
        
        netmask = int(parts[1])
        if not 0 <= netmask <= 32:
            return False
        
        return True
    except:
        return False


def _output_json(errors: List[ValidationError], warnings: List[ValidationError], strict: bool):
    """Output validation results in JSON format."""
    output = {
        'valid': len(errors) == 0 and (not strict or len(warnings) == 0),
        'errors': [{'field': e.field, 'message': e.message} for e in errors],
        'warnings': [{'field': w.field, 'message': w.message} for w in warnings]
    }
    console.print_json(data=output)


def _output_rich(config_file: str, errors: List[ValidationError], warnings: List[ValidationError], strict: bool):
    """Output validation results in rich formatted text."""
    console.print(Panel(f"Validating Configuration: {config_file}", style="bold blue"))
    console.print()
    
    # Show errors
    if errors:
        console.print("[bold red]Errors:[/bold red]")
        table = Table(show_header=True, header_style="bold red")
        table.add_column("Field", style="cyan")
        table.add_column("Message", style="white")
        
        for error in errors:
            table.add_row(error.field, error.message)
        
        console.print(table)
        console.print()
    
    # Show warnings
    if warnings:
        console.print("[bold yellow]Warnings:[/bold yellow]")
        table = Table(show_header=True, header_style="bold yellow")
        table.add_column("Field", style="cyan")
        table.add_column("Message", style="white")
        
        for warning in warnings:
            table.add_row(warning.field, warning.message)
        
        console.print(table)
        console.print()
    
    # Summary
    if not errors and not warnings:
        console.print("[bold green]✓ Configuration is valid[/bold green]")
    elif not errors:
        if strict:
            console.print("[bold red]✗ Validation failed (strict mode: warnings treated as errors)[/bold red]")
        else:
            console.print("[bold yellow]⚠ Configuration is valid with warnings[/bold yellow]")
    else:
        console.print(f"[bold red]✗ Validation failed with {len(errors)} error(s)[/bold red]")
