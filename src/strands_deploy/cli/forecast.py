"""Cost forecasting command."""

import click
from rich.console import Console
from rich.table import Table
from rich.panel import Panel
from typing import Dict, List
import json

from ..config.parser import ConfigParser
from ..history.cost_estimator import CostEstimator
from ..utils.logging import get_logger

logger = get_logger(__name__)
console = Console()


@click.command()
@click.option('--config', default='strands.yaml', help='Path to configuration file')
@click.option('--env', help='Environment to forecast for')
@click.option('--period', type=click.Choice(['daily', 'monthly', 'yearly']), default='monthly', help='Forecast period')
@click.option('--json-output', is_flag=True, help='Output in JSON format')
def forecast(config: str, env: str, period: str, json_output: bool):
    """Predict costs before deployment based on configuration."""
    try:
        # Load configuration
        config_parser = ConfigParser(config)
        parsed_config = config_parser.parse()
        
        # Create cost estimator
        estimator = CostEstimator()
        
        # Estimate costs for each agent
        total_cost = 0.0
        cost_breakdown = {}
        
        for agent in parsed_config.agents:
            agent_costs = _estimate_agent_costs(agent, estimator, period)
            cost_breakdown[agent.name] = agent_costs
            total_cost += sum(agent_costs.values())
        
        # Add shared infrastructure costs
        if hasattr(parsed_config, 'shared'):
            shared_costs = _estimate_shared_costs(parsed_config.shared, estimator, period)
            cost_breakdown['shared-infrastructure'] = shared_costs
            total_cost += sum(shared_costs.values())
        
        # Output results
        if json_output:
            _output_json(cost_breakdown, total_cost, period)
        else:
            _output_rich(cost_breakdown, total_cost, period, env)
            
    except FileNotFoundError:
        console.print(f"[red]Error: Configuration file '{config}' not found[/red]")
    except Exception as e:
        console.print(f"[red]Error: {e}[/red]")
        logger.exception("Cost forecasting failed")


def _estimate_agent_costs(agent, estimator: CostEstimator, period: str) -> Dict[str, float]:
    """Estimate costs for a single agent."""
    costs = {}
    
    # Lambda costs
    # Assumptions: 1M requests/month, 1s average duration
    requests_per_period = _get_requests_for_period(1_000_000, period)
    avg_duration_ms = 1000
    
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
    
    # VPC costs
    if hasattr(shared_config, 'vpc') and shared_config.vpc.enabled:
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


def _output_json(cost_breakdown: Dict[str, Dict[str, float]], total: float, period: str):
    """Output in JSON format."""
    output = {
        'period': period,
        'total_cost': round(total, 2),
        'breakdown': {
            agent: {service: round(cost, 2) for service, cost in costs.items()}
            for agent, costs in cost_breakdown.items()
        }
    }
    console.print_json(data=output)


def _output_rich(cost_breakdown: Dict[str, Dict[str, float]], total: float, period: str, env: str):
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
    console.print("[dim]  • Lambda: 1M requests/month, 1s avg duration[/dim]")
    console.print("[dim]  • API Gateway: 1M requests/month[/dim]")
    console.print("[dim]  • NAT Gateway: 100GB data processed/month[/dim]")
    console.print("[dim]  • Actual costs may vary based on usage patterns[/dim]")
    console.print()
    console.print("[yellow]Note: This is an estimate. Monitor actual costs in AWS Cost Explorer.[/yellow]")
