"""Main CLI entry point."""

import click
from strands_deploy.utils.logging import setup_logging


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


@cli.command()
@click.option('--env', required=True, help='Environment name')
@click.option('--agent', help='Specific agent to deploy')
@click.option('--parallel/--sequential', default=True)
@click.pass_context
def deploy(ctx, env, agent, parallel):
    """Deploy infrastructure to AWS."""
    click.echo(f"Deploy command - Environment: {env}, Agent: {agent}, Parallel: {parallel}")
    # Implementation will be added in later tasks


@cli.command()
@click.option('--env', required=True, help='Environment name')
@click.pass_context
def destroy(ctx, env):
    """Remove deployed infrastructure."""
    click.echo(f"Destroy command - Environment: {env}")
    # Implementation will be added in later tasks


@cli.command()
@click.option('--env', required=True, help='Environment name')
@click.pass_context
def list(ctx, env):
    """Show deployed resources."""
    click.echo(f"List command - Environment: {env}")
    # Implementation will be added in later tasks


if __name__ == '__main__':
    cli()
