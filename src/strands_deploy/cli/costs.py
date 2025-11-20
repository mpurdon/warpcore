"""CLI commands for cost management and viewing."""

import click
from datetime import datetime, timedelta
from rich.console import Console
from rich.table import Table
from strands_deploy.utils.aws_client import AWSClientManager
from strands_deploy.tagging.cost_manager import CostManager
from strands_deploy.utils.logging import get_logger

logger = get_logger(__name__)
console = Console()


@click.group()
def costs():
    """Cost management and reporting commands."""
    pass


@costs.command(name="by-environment")
@click.option("--period", default="last-month", help="Time period (last-week, last-month, last-quarter)")
@click.option("--format", "output_format", default="table", type=click.Choice(["table", "json"]))
@click.pass_context
def by_environment(ctx, period, output_format):
    """View costs grouped by environment."""
    try:
        # Parse period
        start_date, end_date = _parse_period(period)

        # Initialize AWS client and cost manager
        aws_client = AWSClientManager(
            profile=ctx.obj.get("profile"), region=ctx.obj.get("region")
        )
        cost_manager = CostManager(aws_client.session)

        # Get costs by environment
        costs = cost_manager.get_costs_by_tag("strands:environment", start_date, end_date)

        if output_format == "json":
            import json
            click.echo(json.dumps(costs, indent=2))
        else:
            _display_costs_table(costs, "Environment", period)

    except Exception as e:
        logger.error(f"Failed to retrieve costs by environment: {e}")
        click.echo(f"Error: {e}", err=True)
        raise click.Abort()


@costs.command(name="by-agent")
@click.option("--period", default="last-month", help="Time period (last-week, last-month, last-quarter)")
@click.option("--format", "output_format", default="table", type=click.Choice(["table", "json"]))
@click.pass_context
def by_agent(ctx, period, output_format):
    """View costs grouped by agent."""
    try:
        # Parse period
        start_date, end_date = _parse_period(period)

        # Initialize AWS client and cost manager
        aws_client = AWSClientManager(
            profile=ctx.obj.get("profile"), region=ctx.obj.get("region")
        )
        cost_manager = CostManager(aws_client.session)

        # Get costs by agent
        costs = cost_manager.get_costs_by_tag("strands:agent", start_date, end_date)

        if output_format == "json":
            import json
            click.echo(json.dumps(costs, indent=2))
        else:
            _display_costs_table(costs, "Agent", period)

    except Exception as e:
        logger.error(f"Failed to retrieve costs by agent: {e}")
        click.echo(f"Error: {e}", err=True)
        raise click.Abort()


@costs.command(name="by-project")
@click.option("--period", default="last-month", help="Time period (last-week, last-month, last-quarter)")
@click.option("--format", "output_format", default="table", type=click.Choice(["table", "json"]))
@click.pass_context
def by_project(ctx, period, output_format):
    """View costs grouped by project."""
    try:
        # Parse period
        start_date, end_date = _parse_period(period)

        # Initialize AWS client and cost manager
        aws_client = AWSClientManager(
            profile=ctx.obj.get("profile"), region=ctx.obj.get("region")
        )
        cost_manager = CostManager(aws_client.session)

        # Get costs by project
        costs = cost_manager.get_costs_by_tag("strands:project", start_date, end_date)

        if output_format == "json":
            import json
            click.echo(json.dumps(costs, indent=2))
        else:
            _display_costs_table(costs, "Project", period)

    except Exception as e:
        logger.error(f"Failed to retrieve costs by project: {e}")
        click.echo(f"Error: {e}", err=True)
        raise click.Abort()


@costs.command(name="breakdown")
@click.option("--project", help="Filter by project name")
@click.option("--environment", help="Filter by environment")
@click.option("--period", default="last-month", help="Time period (last-week, last-month, last-quarter)")
@click.option("--format", "output_format", default="table", type=click.Choice(["table", "json"]))
@click.pass_context
def breakdown(ctx, project, environment, period, output_format):
    """View detailed cost breakdown by service."""
    try:
        # Parse period
        start_date, end_date = _parse_period(period)

        # Initialize AWS client and cost manager
        aws_client = AWSClientManager(
            profile=ctx.obj.get("profile"), region=ctx.obj.get("region")
        )
        cost_manager = CostManager(aws_client.session)

        # Get cost breakdown
        breakdown_data = cost_manager.get_cost_breakdown(project, environment, start_date, end_date)

        if output_format == "json":
            import json
            click.echo(json.dumps(breakdown_data, indent=2))
        else:
            _display_breakdown_table(breakdown_data, project, environment, period)

    except Exception as e:
        logger.error(f"Failed to retrieve cost breakdown: {e}")
        click.echo(f"Error: {e}", err=True)
        raise click.Abort()


@costs.command(name="forecast")
@click.option("--days", default=30, help="Number of days to forecast")
@click.option("--project", help="Filter by project name")
@click.option("--environment", help="Filter by environment")
@click.pass_context
def forecast(ctx, days, project, environment):
    """View cost forecast for the next N days."""
    try:
        # Initialize AWS client and cost manager
        aws_client = AWSClientManager(
            profile=ctx.obj.get("profile"), region=ctx.obj.get("region")
        )
        cost_manager = CostManager(aws_client.session)

        # Build tag filters
        tag_filters = {}
        if project:
            tag_filters["strands:project"] = project
        if environment:
            tag_filters["strands:environment"] = environment

        # Get forecast
        forecast_amount = cost_manager.get_cost_forecast(days, tag_filters or None)

        # Display forecast
        console.print(f"\n[bold]Cost Forecast[/bold]")
        if project:
            console.print(f"Project: {project}")
        if environment:
            console.print(f"Environment: {environment}")
        console.print(f"Period: Next {days} days")
        console.print(f"\n[bold green]Forecasted Cost: ${forecast_amount:.2f}[/bold green]\n")

    except Exception as e:
        logger.error(f"Failed to retrieve cost forecast: {e}")
        click.echo(f"Error: {e}", err=True)
        raise click.Abort()


@costs.command(name="activate-tags")
@click.pass_context
def activate_tags(ctx):
    """Activate cost allocation tags in AWS Cost Explorer."""
    try:
        # Initialize AWS client and cost manager
        aws_client = AWSClientManager(
            profile=ctx.obj.get("profile"), region=ctx.obj.get("region")
        )
        cost_manager = CostManager(aws_client.session)

        # Get standard cost allocation tags
        tag_keys = [
            "strands:project",
            "strands:environment",
            "strands:agent",
            "team",
            "cost-center",
            "owner",
        ]

        console.print("\n[bold]Activating Cost Allocation Tags[/bold]\n")

        # Activate tags
        results = cost_manager.activate_cost_allocation_tags(tag_keys)

        # Display results
        table = Table(title="Cost Allocation Tag Activation")
        table.add_column("Tag Key", style="cyan")
        table.add_column("Status", style="green")

        for key, success in results.items():
            status = "✓ Activated" if success else "✗ Failed"
            table.add_row(key, status)

        console.print(table)
        console.print(
            "\n[yellow]Note: It may take up to 24 hours for activated tags to appear in Cost Explorer.[/yellow]\n"
        )

    except Exception as e:
        logger.error(f"Failed to activate cost allocation tags: {e}")
        click.echo(f"Error: {e}", err=True)
        raise click.Abort()


@costs.command(name="set-budget")
@click.option("--name", required=True, help="Budget name")
@click.option("--limit", "limit_amount", required=True, type=float, help="Budget limit in USD")
@click.option("--threshold", default=80, type=int, help="Alert threshold percentage (default: 80)")
@click.option("--email", multiple=True, help="Email addresses for alerts (can specify multiple)")
@click.option("--environment", help="Filter by environment")
@click.option("--project", help="Filter by project")
@click.pass_context
def set_budget(ctx, name, limit_amount, threshold, email, environment, project):
    """Create a budget alert for cost monitoring."""
    try:
        # Initialize AWS client and cost manager
        aws_client = AWSClientManager(
            profile=ctx.obj.get("profile"), region=ctx.obj.get("region")
        )
        cost_manager = CostManager(aws_client.session)

        # Build tag filters
        tag_filters = {}
        if project:
            tag_filters["strands:project"] = project
        if environment:
            tag_filters["strands:environment"] = environment

        # Create budget
        success = cost_manager.set_budget_alert(
            budget_name=name,
            limit_amount=limit_amount,
            alert_threshold=threshold,
            email_addresses=list(email) if email else None,
            tag_filters=tag_filters or None,
        )

        if success:
            console.print(f"\n[bold green]✓[/bold green] Budget '{name}' created successfully")
            console.print(f"  Limit: ${limit_amount:.2f}/month")
            console.print(f"  Alert Threshold: {threshold}%")
            if email:
                console.print(f"  Notifications: {', '.join(email)}")
            if tag_filters:
                console.print(f"  Filters: {tag_filters}")
            console.print()
        else:
            console.print(f"\n[bold red]✗[/bold red] Failed to create budget '{name}'\n", err=True)
            raise click.Abort()

    except Exception as e:
        logger.error(f"Failed to create budget: {e}")
        click.echo(f"Error: {e}", err=True)
        raise click.Abort()


def _parse_period(period: str) -> tuple[datetime, datetime]:
    """Parse period string into start and end dates.

    Args:
        period: Period string (last-week, last-month, last-quarter, or YYYY-MM-DD:YYYY-MM-DD)

    Returns:
        Tuple of (start_date, end_date)
    """
    end_date = datetime.utcnow()

    if period == "last-week":
        start_date = end_date - timedelta(days=7)
    elif period == "last-month":
        start_date = end_date - timedelta(days=30)
    elif period == "last-quarter":
        start_date = end_date - timedelta(days=90)
    elif ":" in period:
        # Custom date range: YYYY-MM-DD:YYYY-MM-DD
        start_str, end_str = period.split(":")
        start_date = datetime.strptime(start_str, "%Y-%m-%d")
        end_date = datetime.strptime(end_str, "%Y-%m-%d")
    else:
        raise ValueError(f"Invalid period: {period}")

    return start_date, end_date


def _display_costs_table(costs: dict, category: str, period: str):
    """Display costs in a formatted table.

    Args:
        costs: Dictionary mapping category values to costs
        category: Category name (e.g., "Environment", "Agent")
        period: Time period string
    """
    table = Table(title=f"Costs by {category} ({period})")
    table.add_column(category, style="cyan")
    table.add_column("Cost (USD)", justify="right", style="green")

    # Sort by cost descending
    sorted_costs = sorted(costs.items(), key=lambda x: x[1], reverse=True)

    total = 0.0
    for name, cost in sorted_costs:
        table.add_row(name, f"${cost:.2f}")
        total += cost

    # Add total row
    table.add_row("[bold]TOTAL[/bold]", f"[bold]${total:.2f}[/bold]")

    console.print()
    console.print(table)
    console.print()


def _display_breakdown_table(breakdown: dict, project: str, environment: str, period: str):
    """Display cost breakdown in a formatted table.

    Args:
        breakdown: Cost breakdown dictionary
        project: Optional project filter
        environment: Optional environment filter
        period: Time period string
    """
    title = f"Cost Breakdown by Service ({period})"
    if project:
        title += f" - Project: {project}"
    if environment:
        title += f" - Environment: {environment}"

    table = Table(title=title)
    table.add_column("Service", style="cyan")
    table.add_column("Cost (USD)", justify="right", style="green")
    table.add_column("% of Total", justify="right", style="yellow")

    # Sort by cost descending
    sorted_services = sorted(
        breakdown["by_service"].items(), key=lambda x: x[1], reverse=True
    )

    total = breakdown["total"]

    for service, cost in sorted_services:
        percentage = (cost / total * 100) if total > 0 else 0
        table.add_row(service, f"${cost:.2f}", f"{percentage:.1f}%")

    # Add total row
    table.add_row("[bold]TOTAL[/bold]", f"[bold]${total:.2f}[/bold]", "[bold]100.0%[/bold]")

    console.print()
    console.print(table)
    console.print()
