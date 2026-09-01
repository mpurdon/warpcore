"""Developer-mode introspection: what happened, what exists, what is it doing."""

import json
import sys
from pathlib import Path
from typing import Any, Dict, Optional

import click
from rich.console import Console
from rich.panel import Panel
from rich.table import Table

from warpcore.agentic.scanner import AWSScanner
from warpcore.audit.recorder import DEFAULT_AUDIT_DIR, AuditRecorder
from warpcore.devmode import DEV_DIR, get_dev_mode, latest_session_manifest
from warpcore.monitoring.usage import ResourceUsageReader
from warpcore.state.manager import StateManager
from warpcore.utils.aws_client import AWSClientManager
from warpcore.utils.logging import get_logger

console = Console()
logger = get_logger(__name__)


@click.group()
def debug():
    """Inspect a deployment: sessions, state, live resources, API traffic."""
    pass


@debug.command("session")
@click.option("--dev-dir", help="Override the dev session directory")
@click.option("--json", "as_json", is_flag=True)
def debug_session(dev_dir, as_json):
    """Show the most recent developer-mode session.

    Sessions are only recorded when a command ran with --dev (or WARPCORE_DEV=1).
    """
    manifest = latest_session_manifest(Path(dev_dir) if dev_dir else DEV_DIR)
    if manifest is None:
        console.print(
            "[yellow]No developer sessions recorded.[/yellow]\n"
            "Run a command with [cyan]--dev[/cyan] to capture one, e.g. "
            "[cyan]warpcore --dev deploy --env dev[/cyan]."
        )
        return

    if as_json:
        click.echo(json.dumps(manifest, indent=2))
        return

    runtime = manifest.get("runtime", {})
    console.print(Panel(
        f"Session     {manifest['session_id']}\n"
        f"Command     {manifest.get('command') or '-'}\n"
        f"Started     {manifest.get('started_at')}\n"
        f"Finished    {manifest.get('finished_at')}\n"
        f"Environment {manifest.get('environment') or '-'}\n"
        f"Region      {manifest.get('region') or '-'}\n"
        f"Profile     {manifest.get('profile') or 'default'}\n"
        f"Actor       {manifest.get('actor') or '-'}\n\n"
        f"warpcore    {runtime.get('warpcore')}\n"
        f"python      {runtime.get('python')}\n"
        f"boto3       {runtime.get('boto3')}\n"
        f"platform    {runtime.get('platform')}\n"
        f"cwd         {runtime.get('cwd')}",
        title="Developer session",
    ))

    api = manifest.get("api")
    if not api or not api.get("total_calls"):
        console.print("[dim]No AWS API calls were traced in this session.[/dim]")
        return

    console.print(
        f"\n[bold]{api['total_calls']} AWS API call(s)[/bold], "
        f"{api['errors']} error(s), "
        f"{api['total_duration_ms']:.0f} ms total, "
        f"{api['average_duration_ms']:.0f} ms average"
    )
    if api.get("dropped"):
        console.print(f"[yellow]{api['dropped']} call(s) dropped past the trace cap.[/yellow]")

    by_operation = api.get("by_operation") or {}
    if by_operation:
        table = Table(title="Calls by operation")
        table.add_column("Operation", style="cyan")
        table.add_column("Count", justify="right")
        for operation, count in list(by_operation.items())[:20]:
            table.add_row(operation, str(count))
        console.print(table)

    slowest = api.get("slowest") or []
    if slowest:
        table = Table(title="Slowest calls")
        table.add_column("Operation", style="cyan")
        table.add_column("ms", justify="right")
        table.add_column("Error", style="red")
        for call in slowest:
            table.add_row(
                f"{call['service']}.{call['operation']}",
                f"{call['duration_ms']:.0f}",
                call.get("error_code") or "",
            )
        console.print(table)

    errors = api.get("by_error_code") or {}
    if errors:
        table = Table(title="Errors by code")
        table.add_column("Code", style="red")
        table.add_column("Count", justify="right")
        for code, count in errors.items():
            table.add_row(code, str(count))
        console.print(table)


@debug.command("state")
@click.option("--env", "environment", required=True)
@click.option("--config", "config_path", default="warpcore.yaml", show_default=True)
@click.option("--json", "as_json", is_flag=True)
def debug_state(environment, config_path, as_json):
    """Inspect the state file and check it for integrity problems."""
    from warpcore.cli.main import get_state_path, load_config

    config = load_config(config_path)
    state_path = get_state_path(environment, config.project.name)
    state_manager = StateManager(str(state_path))

    if not state_manager.exists():
        console.print(f"[yellow]No state file at[/yellow] {state_path}")
        return

    state = state_manager.load()
    resources = state.all_resources()

    dangling = state_manager.validate_dependencies()
    circular = state_manager.detect_circular_dependencies()

    if as_json:
        click.echo(json.dumps({
            "path": str(state_path),
            "environment": state.environment,
            "account": state.account,
            "region": state.region,
            "project_name": state.project_name,
            "timestamp": state.timestamp.isoformat(),
            "stacks": {n: len(s.resources) for n, s in state.stacks.items()},
            "resource_count": len(resources),
            "dangling_dependencies": [list(d) for d in dangling],
            "circular_dependencies": circular,
        }, indent=2, default=str))
        return

    console.print(Panel(
        f"Path        {state_path}\n"
        f"Project     {state.project_name}\n"
        f"Environment {state.environment}\n"
        f"Account     {state.account}\n"
        f"Region      {state.region}\n"
        f"Updated     {state.timestamp:%Y-%m-%d %H:%M:%S} UTC\n"
        f"Stacks      {len(state.stacks)}\n"
        f"Resources   {len(resources)}",
        title="State",
    ))

    if resources:
        table = Table(title="Resources")
        table.add_column("Stack", style="dim")
        table.add_column("Logical ID", style="green")
        table.add_column("Type", style="cyan")
        table.add_column("Physical ID")
        table.add_column("Deps", justify="right")
        table.add_column("Adopted", justify="center")
        for stack_name, resource in sorted(resources, key=lambda r: (r[0], r[1].id)):
            table.add_row(
                stack_name,
                resource.id,
                resource.type.replace("AWS::", ""),
                (resource.physical_id or "-")[:60],
                str(len(resource.dependencies)),
                "yes" if (resource.metadata or {}).get("adopted") else "",
            )
        console.print(table)

    if dangling:
        console.print(f"\n[red]{len(dangling)} dangling dependency reference(s):[/red]")
        for resource_id, missing in dangling:
            console.print(f"  {resource_id} -> {missing} [dim](not in state)[/dim]")

    if circular:
        console.print(f"\n[red]Circular dependency:[/red] {' -> '.join(circular)}")

    if not dangling and not circular:
        console.print("\n[green]No integrity problems found.[/green]")


@debug.command("resource")
@click.argument("resource_id")
@click.option("--env", "environment", required=True)
@click.option("--config", "config_path", default="warpcore.yaml", show_default=True)
@click.option("--hours", type=int, default=24, show_default=True,
              help="Usage metric window")
@click.option("--no-live", is_flag=True, help="Skip the live AWS lookup")
@click.option("--no-metrics", is_flag=True, help="Skip CloudWatch metrics")
@click.option("--json", "as_json", is_flag=True)
@click.pass_context
def debug_resource(ctx, resource_id, environment, config_path, hours,
                   no_live, no_metrics, as_json):
    """Everything known about one resource: state, live config, drift, usage, history."""
    from warpcore.cli.main import get_state_path, load_config

    config = load_config(config_path)
    env_config = config.get_environment(environment)
    region = ctx.obj.get("region") or env_config.region

    state_manager = StateManager(str(get_state_path(environment, config.project.name)))
    if not state_manager.exists():
        console.print(f"[red]No state file for environment '{environment}'[/red]")
        sys.exit(1)

    state = state_manager.load()
    located = state.get_resource_with_stack(resource_id)
    if located is None:
        console.print(f"[red]No resource '{resource_id}' in state.[/red]")
        console.print(
            f"[dim]Run `warpcore debug state --env {environment}` to list what is there.[/dim]"
        )
        sys.exit(1)

    stack_name, resource = located
    report: Dict[str, Any] = {
        "resource_id": resource.id,
        "stack": stack_name,
        "type": resource.type,
        "physical_id": resource.physical_id,
        "dependencies": resource.dependencies,
        "dependents": state.get_dependents(resource.id),
        "tags": resource.tags,
        "metadata": resource.metadata,
        "state_properties": resource.properties,
    }

    manager = AWSClientManager(profile=ctx.obj.get("profile"), region=region)
    session = get_dev_mode().attach_session(manager.session)

    live: Optional[Dict[str, Any]] = None
    if not no_live and resource.physical_id:
        scanner = AWSScanner(
            boto_session=session,
            project_name=config.project.name,
            environment=environment,
            region=region,
        )
        try:
            live = scanner.get_resource_details(resource.type, resource.physical_id)
        except Exception as e:  # noqa: BLE001 - surfaced, not fatal
            report["live_error"] = str(e)
        report["live_properties"] = live

    usage = None
    if not no_metrics:
        usage = ResourceUsageReader(session, region).read(
            resource_id=resource.id,
            resource_type=resource.type,
            physical_id=resource.physical_id,
            window_hours=hours,
        )
        report["usage"] = {
            "window_hours": usage.window_hours,
            "metrics": [
                {"name": m.name, "statistic": m.statistic, "unit": m.unit,
                 "total": m.total, "average": m.average, "maximum": m.maximum,
                 "datapoints": m.datapoints, "error": m.error}
                for m in usage.metrics
            ],
            "recent_errors": [
                {"timestamp": e.timestamp.isoformat(), "message": e.message}
                for e in usage.recent_errors
            ],
            "notes": usage.notes,
        }

    recorder = AuditRecorder(environment=environment, audit_dir=DEFAULT_AUDIT_DIR)
    history = recorder.entries(resource_id=resource.id, limit=10)
    report["audit_history"] = [e.model_dump(mode="json") for e in history]

    if as_json:
        click.echo(json.dumps(report, indent=2, default=str))
        return

    console.print(Panel(
        f"Logical ID  {resource.id}\n"
        f"Type        {resource.type}\n"
        f"Physical    {resource.physical_id or '-'}\n"
        f"Stack       {stack_name}\n"
        f"Depends on  {', '.join(resource.dependencies) or '-'}\n"
        f"Depended on {', '.join(report['dependents']) or '-'}\n"
        f"Adopted     {'yes' if (resource.metadata or {}).get('adopted') else 'no'}",
        title=f"Resource: {resource.id}",
    ))

    if resource.tags:
        table = Table(title="Tags")
        table.add_column("Key", style="cyan")
        table.add_column("Value")
        for key, value in sorted(resource.tags.items()):
            table.add_row(key, value)
        console.print(table)

    if live is not None:
        drift = _diff_properties(resource.properties or {}, live)
        if drift:
            table = Table(title="Drift: state vs live AWS")
            table.add_column("Property", style="cyan")
            table.add_column("In state", style="yellow")
            table.add_column("In AWS", style="green")
            for key, (in_state, in_aws) in drift.items():
                table.add_row(
                    key,
                    json.dumps(in_state, default=str)[:70],
                    json.dumps(in_aws, default=str)[:70],
                )
            console.print(table)
        else:
            console.print("[green]No drift between state and live AWS configuration.[/green]")
    elif report.get("live_error"):
        console.print(f"[yellow]Could not read live config:[/yellow] {report['live_error']}")

    if usage is not None:
        if usage.has_metrics():
            table = Table(title=f"Usage - last {usage.window_hours}h")
            table.add_column("Metric", style="cyan")
            table.add_column("Stat", style="dim")
            table.add_column("Total", justify="right")
            table.add_column("Average", justify="right")
            table.add_column("Max", justify="right")
            table.add_column("Unit", style="dim")
            for metric in usage.metrics:
                if not metric.datapoints:
                    continue
                table.add_row(
                    metric.name, metric.statistic,
                    _fmt(metric.total), _fmt(metric.average), _fmt(metric.maximum),
                    metric.unit,
                )
            console.print(table)
        else:
            console.print(
                f"[dim]No CloudWatch datapoints in the last {usage.window_hours}h.[/dim]"
            )
        for note in usage.notes:
            console.print(f"[dim]{note}[/dim]")

        if usage.recent_errors:
            console.print(f"\n[red]Recent errors in {usage.log_group}:[/red]")
            for event in usage.recent_errors[:10]:
                console.print(f"  [dim]{event.timestamp:%m-%d %H:%M:%S}[/dim] {event.message[:160]}")

    if history:
        table = Table(title="Audit history")
        table.add_column("ID", style="cyan")
        table.add_column("When", style="dim")
        table.add_column("Op")
        table.add_column("Status")
        for entry in history:
            table.add_row(
                entry.id,
                entry.timestamp.strftime("%m-%d %H:%M:%S"),
                entry.operation.value,
                entry.status.value,
            )
        console.print(table)


@debug.command("doctor")
@click.option("--config", "config_path", default="warpcore.yaml", show_default=True)
@click.option("--env", "environment", help="Also check this environment")
@click.pass_context
def debug_doctor(ctx, config_path, environment):
    """Check credentials, config and local state for common problems."""
    checks = []

    config_file = Path(config_path)
    if config_file.exists():
        try:
            from warpcore.config.parser import Config
            config = Config(str(config_file))
            config.load()
            checks.append(("ok", "config", f"{config_path} parses; "
                                           f"{len(config.agents)} agent(s), "
                                           f"{len(config.environments)} environment(s)"))
        except Exception as e:
            config = None
            checks.append(("fail", "config", f"{config_path} failed to load: {e}"))
    else:
        config = None
        checks.append(("warn", "config", f"{config_path} not found "
                                         f"(run `warpcore init` or `warpcore discover config`)"))

    try:
        manager = AWSClientManager(profile=ctx.obj.get("profile"), region=ctx.obj.get("region"))
        credentials = manager.validate_credentials()
        get_dev_mode().attach_session(manager.session)
        checks.append(("ok", "credentials",
                       f"account {credentials.account_id} as {credentials.user_arn}"))
        checks.append(("ok", "region", credentials.region or "not set"))
    except Exception as e:
        credentials = None
        checks.append(("fail", "credentials", str(e)))

    if config and environment:
        try:
            env_config = config.get_environment(environment)
            checks.append(("ok", f"env:{environment}",
                           f"account {env_config.account}, region {env_config.region}"))
            if credentials and credentials.account_id != env_config.account:
                checks.append(("fail", "account match",
                               f"credentials are for {credentials.account_id} but "
                               f"'{environment}' targets {env_config.account}"))
            else:
                if credentials:
                    checks.append(("ok", "account match", "credentials match the environment"))

            state_path = Path(".warpcore") / "state" / f"{config.project.name}-{environment}.json"
            if state_path.exists():
                state_manager = StateManager(str(state_path))
                state = state_manager.load()
                checks.append(("ok", "state",
                               f"{len(state.all_resources())} resource(s) at {state_path}"))
                dangling = state_manager.validate_dependencies()
                if dangling:
                    checks.append(("fail", "state integrity",
                                   f"{len(dangling)} dangling dependency reference(s)"))
            else:
                checks.append(("warn", "state", f"no state file at {state_path}"))
        except Exception as e:
            checks.append(("fail", f"env:{environment}", str(e)))

    audit_path = DEFAULT_AUDIT_DIR / f"{environment}.jsonl" if environment else None
    if audit_path:
        if audit_path.exists():
            count = len(AuditRecorder(environment=environment).entries())
            checks.append(("ok", "audit", f"{count} entries at {audit_path}"))
        else:
            checks.append(("warn", "audit", f"no audit log yet at {audit_path}"))

    table = Table(title="warpcore doctor")
    table.add_column("", width=4)
    table.add_column("Check", style="cyan")
    table.add_column("Detail")
    marks = {"ok": "[green]OK[/green]", "warn": "[yellow]!![/yellow]", "fail": "[red]XX[/red]"}
    for status, name, detail in checks:
        table.add_row(marks[status], name, detail)
    console.print(table)

    failures = sum(1 for status, _, _ in checks if status == "fail")
    if failures:
        console.print(f"\n[red]{failures} check(s) failed.[/red]")
        sys.exit(1)
    console.print("\n[green]No blocking problems found.[/green]")


def _diff_properties(state_props: Dict[str, Any], live_props: Dict[str, Any]) -> Dict[str, tuple]:
    """Compare state properties against live AWS, keyed on what state claims.

    Only keys present in state are compared: a live describe_* response carries
    dozens of AWS-managed fields that state never sets, and reporting all of
    them as drift would bury the real differences.
    """
    drift: Dict[str, tuple] = {}
    for key, expected in state_props.items():
        if key not in live_props:
            continue
        actual = live_props[key]
        if expected != actual:
            drift[key] = (expected, actual)
    return drift


def _fmt(value: Optional[float]) -> str:
    if value is None:
        return "-"
    if value >= 1000:
        return f"{value:,.0f}"
    if value == int(value):
        return str(int(value))
    return f"{value:.2f}"
