"""Cost forecasting command."""

import sys

import click
from rich.console import Console
from rich.table import Table
from rich.panel import Panel
from typing import Dict

from ..config.parser import Config, ConfigValidationError
from ..history.cost_estimator import CostEstimator
from ..utils.logging import get_logger

logger = get_logger(__name__)
console = Console()


@click.command()
@click.option('--config', default='warpcore.yaml', help='Path to configuration file')
@click.option('--env', help='Environment to forecast for')
@click.option('--period', type=click.Choice(['daily', 'monthly', 'yearly']), default='monthly', help='Forecast period')
@click.option('--avg-duration-ms', type=int, default=1000, show_default=True,
              help='Assumed average Lambda duration. Timeout is a safety bound, not an expectation, so this cannot be derived from the config - put your real number in for a useful estimate.')
@click.option('--json-output', is_flag=True, help='Output in JSON format')
def forecast(config: str, env: str, period: str, avg_duration_ms: int, json_output: bool):
    """Predict costs before deployment based on configuration."""
    try:
        parsed_config = Config(config)
        parsed_config.load()

        # A typo in --env used to be silently ignored, producing a forecast
        # labelled for an environment that does not exist.
        if env:
            parsed_config.get_environment(env)

        # Request volume comes from the project's own cost_estimation block
        # rather than a hardcoded 1M, which is what that setting is for.
        monthly_requests = 100_000
        if parsed_config.project and parsed_config.project.cost_estimation:
            monthly_requests = parsed_config.project.cost_estimation.executions_per_month

        estimator = CostEstimator()

        total_cost = 0.0
        cost_breakdown = {}

        for agent in parsed_config.agents:
            agent_costs = _estimate_agent_costs(
                agent, estimator, period, monthly_requests, avg_duration_ms
            )
            cost_breakdown[agent.name] = agent_costs
            total_cost += sum(agent_costs.values())

        # Shared infrastructure. Config.shared always exists after load(), but
        # its individual sections can be None.
        shared_costs = _estimate_shared_costs(parsed_config.shared, estimator, period)
        if shared_costs:
            cost_breakdown['shared-infrastructure'] = shared_costs
            total_cost += sum(shared_costs.values())

        if json_output:
            _output_json(cost_breakdown, total_cost, period, monthly_requests,
                         avg_duration_ms)
        else:
            _output_rich(cost_breakdown, total_cost, period, env, monthly_requests,
                         avg_duration_ms)

    except FileNotFoundError:
        console.print(f"[red]Error: Configuration file '{config}' not found[/red]")
        console.print("\nRun [cyan]warpcore init[/cyan] to create one.")
        sys.exit(1)
    except ConfigValidationError as e:
        console.print(f"[red]Configuration error:[/red] {e}")
        sys.exit(1)
    except Exception as e:
        console.print(f"[red]Error: {e}[/red]")
        logger.exception("Cost forecasting failed")
        sys.exit(1)


def _estimate_agent_costs(
    agent,
    estimator: CostEstimator,
    period: str,
    monthly_requests: int,
    avg_duration_ms: int,
) -> Dict[str, float]:
    """Estimate costs for a single agent.

    Duration is not derivable from the config: `timeout` is the point at which
    Lambda gives up, and most functions finish far below it. Deriving duration
    from timeout would silently inflate the estimate several-fold, so it is an
    explicit input with a stated default instead.
    """
    costs = {}

    requests_per_period = _get_requests_for_period(monthly_requests, period)
    
    lambda_cost = estimator.estimate_lambda_cost(
        memory_mb=agent.memory,
        duration_ms=avg_duration_ms,
        requests=requests_per_period
    )
    costs['Lambda'] = lambda_cost
    
    # API Gateway costs (if applicable)
    api_cost = estimator.estimate_api_gateway_cost(requests=requests_per_period)
    costs['API Gateway'] = api_cost
    
    # CloudWatch Logs costs
    # Assume 1KB per log entry, 10 log entries per request
    log_data_gb = (requests_per_period * 10 * 1024) / (1024 ** 3)
    log_cost = estimator.estimate_cloudwatch_logs_cost(data_ingested_gb=log_data_gb)
    costs['CloudWatch Logs'] = log_cost
    
    # X-Ray costs
    xray_cost = estimator.estimate_xray_cost(traces=requests_per_period)
    costs['X-Ray'] = xray_cost
    
    return costs


def _estimate_shared_costs(shared_config, estimator: CostEstimator, period: str) -> Dict[str, float]:
    """Estimate costs for shared infrastructure."""
    costs = {}

    # shared.vpc is None when the config omits a `vpc:` block, so `.enabled`
    # cannot be reached unconditionally.
    if shared_config is not None and shared_config.vpc and shared_config.vpc.enabled:
        # NAT Gateway costs (assume 1 NAT gateway, 100GB data processed per month)
        data_gb = _get_data_for_period(100, period)
        nat_cost = estimator.estimate_nat_gateway_cost(
            hours=_get_hours_for_period(period),
            data_processed_gb=data_gb
        )
        costs['NAT Gateway'] = nat_cost
        
        # VPC Endpoints costs (assume 3 endpoints)
        vpc_endpoint_cost = estimator.estimate_vpc_endpoint_cost(
            endpoint_count=3,
            hours=_get_hours_for_period(period)
        )
        costs['VPC Endpoints'] = vpc_endpoint_cost
    
    return costs


def _get_requests_for_period(monthly_requests: int, period: str) -> int:
    """Convert monthly requests to period requests."""
    if period == 'daily':
        return monthly_requests // 30
    elif period == 'monthly':
        return monthly_requests
    elif period == 'yearly':
        return monthly_requests * 12
    return monthly_requests


def _get_data_for_period(monthly_gb: float, period: str) -> float:
    """Convert monthly data to period data."""
    if period == 'daily':
        return monthly_gb / 30
    elif period == 'monthly':
        return monthly_gb
    elif period == 'yearly':
        return monthly_gb * 12
    return monthly_gb


def _get_hours_for_period(period: str) -> int:
    """Get hours for period."""
    if period == 'daily':
        return 24
    elif period == 'monthly':
        return 730  # ~30.4 days
    elif period == 'yearly':
        return 8760  # 365 days
    return 730


def _output_json(
    cost_breakdown: Dict[str, Dict[str, float]],
    total: float,
    period: str,
    monthly_requests: int,
    avg_duration_ms: int,
):
    """Output in JSON format."""
    output = {
        'period': period,
        'monthly_requests': monthly_requests,
        'avg_duration_ms': avg_duration_ms,
        'total_cost': round(total, 2),
        'breakdown': {
            agent: {service: round(cost, 2) for service, cost in costs.items()}
            for agent, costs in cost_breakdown.items()
        }
    }
    console.print_json(data=output)


def _output_rich(
    cost_breakdown: Dict[str, Dict[str, float]],
    total: float,
    period: str,
    env: str,
    monthly_requests: int,
    avg_duration_ms: int,
):
    """Output in rich formatted text."""
    title = f"Cost Forecast - {period.capitalize()}"
    if env:
        title += f" (Environment: {env})"
    
    console.print(Panel(title, style="bold blue"))
    console.print()
    
    # Show breakdown by agent
    for agent_name, costs in cost_breakdown.items():
        agent_total = sum(costs.values())
        
        console.print(f"[bold cyan]{agent_name}[/bold cyan] - ${agent_total:.2f}/{period}")
        
        table = Table(show_header=False, box=None, padding=(0, 2))
        table.add_column("Service", style="white")
        table.add_column("Cost", style="green", justify="right")
        
        for service, cost in sorted(costs.items(), key=lambda x: x[1], reverse=True):
            if cost > 0:
                table.add_row(f"  {service}", f"${cost:.2f}")
        
        console.print(table)
        console.print()
    
    # Total
    console.print(Panel(
        f"[bold]Total Estimated Cost: [green]${total:.2f}[/green]/{period}[/bold]",
        style="bold blue"
    ))
    console.print()
    
    # Assumptions and notes
    console.print("[dim]Assumptions:[/dim]")
    console.print(
        f"[dim]  • {monthly_requests:,} requests/month "
        f"(project.cost_estimation.executions_per_month)[/dim]"
    )
    console.print(
        f"[dim]  • Lambda duration: {avg_duration_ms} ms average "
        f"(override with --avg-duration-ms)[/dim]"
    )
    console.print("[dim]  • CloudWatch Logs: 10 entries of 1KB per request[/dim]")
    console.print("[dim]  • NAT Gateway: 100GB data processed/month[/dim]")
    console.print("[dim]  • Actual costs may vary based on usage patterns[/dim]")
    console.print()
    console.print("[yellow]Note: This is an estimate. Monitor actual costs in AWS Cost Explorer.[/yellow]")
