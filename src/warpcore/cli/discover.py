"""Reverse-engineer an existing AWS account into warpcore config and state."""

import json
import sys
from pathlib import Path
from typing import Optional

import click
import yaml
from rich.console import Console
from rich.panel import Panel
from rich.table import Table

from warpcore.agentic.scanner import AWSScanner, ScanScope
from warpcore.devmode import get_dev_mode
from warpcore.discovery.adopt import ResourceAdopter
from warpcore.discovery.config_emitter import ConfigEmitter
from warpcore.state.manager import StateManager
from warpcore.utils.aws_client import AWSClientManager
from warpcore.utils.logging import get_logger

console = Console()
# Progress and status go to stderr so `--json` output on stdout stays
# pipeable into jq.
status = Console(stderr=True)
logger = get_logger(__name__)


def _scanner(ctx, region: Optional[str], project_name: str, environment: str):
    """Build a scanner plus the resolved account/region, without needing a config."""
    profile = ctx.obj.get("profile")
    manager = AWSClientManager(profile=profile, region=region or ctx.obj.get("region"))

    try:
        credentials = manager.validate_credentials()
    except Exception as e:
        console.print(f"[red]Could not authenticate to AWS:[/red] {e}")
        console.print("\nCheck your profile with [cyan]aws sts get-caller-identity[/cyan].")
        sys.exit(1)

    session = get_dev_mode().attach_session(manager.session)
    resolved_region = region or credentials.region
    scanner = AWSScanner(
        boto_session=session,
        project_name=project_name,
        environment=environment,
        region=resolved_region,
    )
    return scanner, credentials, resolved_region


@click.group()
def discover():
    """Discover and adopt AWS resources this project did not create."""
    pass


@discover.command("inventory")
@click.option("--region", help="AWS region to scan (defaults to the profile's region)")
@click.option("--scope", type=click.Choice(["account", "project"]), default="account",
              help="account scans everything; project filters to warpcore tags")
@click.option("--project-name", default="discovered", help="Project name (project scope only)")
@click.option("--env", "environment", default="dev", help="Environment name (project scope only)")
@click.option("--hydrate/--no-hydrate", default=True,
              help="Fetch each resource's real configuration (one API call each)")
@click.option("--type", "resource_types", multiple=True,
              help="Only this CloudFormation type; repeatable")
@click.option("--max", "max_resources", type=int, default=2000, show_default=True,
              help="Stop after this many resources")
@click.option("--json", "as_json", is_flag=True, help="Emit JSON instead of a table")
@click.pass_context
def inventory(ctx, region, scope, project_name, environment, hydrate,
              resource_types, max_resources, as_json):
    """List what actually exists in an AWS account."""
    scanner, credentials, resolved_region = _scanner(ctx, region, project_name, environment)

    status.print(
        f"Scanning [cyan]{credentials.account_id}[/cyan] in "
        f"[cyan]{resolved_region}[/cyan] (scope: {scope})..."
    )

    scanned = scanner.scan_resources(
        scope=ScanScope(scope),
        hydrate=hydrate,
        resource_types=list(resource_types) or None,
        max_resources=max_resources,
    )

    if as_json:
        payload = {
            "account": credentials.account_id,
            "region": resolved_region,
            "scope": scope,
            "truncated": scanned.truncated,
            "counts": scanned.count_by_type(),
            "resources": [
                {
                    "id": r.id,
                    "type": r.type,
                    "physical_id": r.physical_id,
                    "tags": r.tags,
                    "properties": r.properties,
                }
                for r in scanned.get_all_resources()
            ],
            "errors": [
                {"physical_id": e.physical_id, "type": e.resource_type,
                 "stage": e.stage, "message": e.message}
                for e in scanned.errors
            ],
        }
        click.echo(json.dumps(payload, indent=2, default=str))
        return

    if not scanned.resources:
        console.print("[yellow]No resources found.[/yellow]")
        if scope == "project":
            console.print("Try [cyan]--scope account[/cyan] to see untagged resources.")
        return

    summary = Table(title=f"Resource inventory - {credentials.account_id} / {resolved_region}")
    summary.add_column("Type", style="cyan")
    summary.add_column("Count", justify="right")
    for resource_type, count in scanned.count_by_type().items():
        summary.add_row(resource_type, str(count))
    console.print(summary)

    detail = Table(title="Resources")
    detail.add_column("Logical ID", style="green")
    detail.add_column("Type")
    detail.add_column("Properties", justify="right")
    detail.add_column("Tags", justify="right")
    for resource in sorted(scanned.get_all_resources(), key=lambda r: (r.type, r.id))[:200]:
        detail.add_row(
            resource.id,
            resource.type.replace("AWS::", ""),
            str(len(resource.properties or {})) if hydrate else "-",
            str(len(resource.tags or {})),
        )
    console.print(detail)

    if len(scanned.resources) > 200:
        console.print(f"[dim]... {len(scanned.resources) - 200} more; use --json for all[/dim]")

    if scanned.truncated:
        console.print(
            f"[yellow]Stopped at --max {max_resources}; results are incomplete.[/yellow]"
        )

    if scanned.errors:
        console.print(
            f"\n[yellow]{len(scanned.errors)} resource(s) could not be read "
            f"(usually missing read permission):[/yellow]"
        )
        for error in scanned.errors[:10]:
            console.print(f"  [dim]{error.resource_type}[/dim] {error.physical_id}: {error.message}")
        if len(scanned.errors) > 10:
            console.print(f"  [dim]... and {len(scanned.errors) - 10} more[/dim]")


@discover.command("config")
@click.option("--region", help="AWS region to scan")
@click.option("--scope", type=click.Choice(["account", "project"]), default="account")
@click.option("--project-name", required=True, help="Project name for the generated config")
@click.option("--env", "environment", default="dev", show_default=True,
              help="Environment name for the generated config")
@click.option("--out", "out_path", default="warpcore.yaml", show_default=True,
              help="Where to write the config ('-' for stdout)")
@click.option("--type", "resource_types", multiple=True, help="Only this type; repeatable")
@click.option("--max", "max_resources", type=int, default=2000, show_default=True)
@click.option("--force", is_flag=True, help="Overwrite an existing file")
@click.pass_context
def emit_config(ctx, region, scope, project_name, environment, out_path,
                resource_types, max_resources, force):
    """Generate a warpcore.yaml from what is deployed in an account."""
    scanner, credentials, resolved_region = _scanner(ctx, region, project_name, environment)

    target = None if out_path == "-" else Path(out_path)
    if target and target.exists() and not force:
        console.print(f"[red]{target} already exists.[/red] Re-run with --force to overwrite.")
        sys.exit(1)

    status.print(f"Scanning [cyan]{credentials.account_id}[/cyan] / [cyan]{resolved_region}[/cyan]...")
    scanned = scanner.scan_resources(
        scope=ScanScope(scope),
        hydrate=True,  # emitting config without real properties is pointless
        resource_types=list(resource_types) or None,
        max_resources=max_resources,
    )

    result = ConfigEmitter(
        scanned_state=scanned,
        project_name=project_name,
        environment=environment,
        account=credentials.account_id,
        region=resolved_region,
    ).emit()

    rendered = yaml.safe_dump(result.config, sort_keys=False, default_flow_style=False)

    if target is None:
        click.echo(rendered)
    else:
        target.write_text(rendered)
        console.print(f"[green]Wrote[/green] {target}")

    console.print(
        f"\n{result.agent_count} agent(s), {result.resource_count} resource(s), "
        f"{result.skipped_count} not representable in config."
    )

    warnings = result.warnings()
    if warnings:
        console.print(f"\n[yellow]{len(warnings)} thing(s) need your review:[/yellow]")
        for note in warnings:
            console.print(f"  [dim]{note.physical_id}[/dim]\n    {note.message}")

    console.print(Panel(
        "This config describes what is [bold]already deployed[/bold]. It is a starting "
        "point, not a drop-in replacement:\n\n"
        "  - agent [cyan]path[/cyan] values are guesses; point them at your real source\n"
        "  - deploying it will [bold]create new resources[/bold] unless you first run\n"
        "    [cyan]warpcore discover adopt[/cyan] so warpcore knows they already exist\n"
        "  - review any copied environment variables before committing",
        title="Before you deploy this",
        border_style="yellow",
    ))


@discover.command("adopt")
@click.option("--env", "environment", required=True, help="Environment to adopt into")
@click.option("--config", "config_path", default="warpcore.yaml", show_default=True)
@click.option("--region", help="AWS region to scan")
@click.option("--scope", type=click.Choice(["account", "project"]), default="project",
              show_default=True)
@click.option("--stack", help="Stack to file adopted resources under")
@click.option("--type", "resource_types", multiple=True, help="Only this type; repeatable")
@click.option("--max", "max_resources", type=int, default=2000, show_default=True)
@click.option("--dry-run", is_flag=True, help="Show the plan without writing state")
@click.option("--yes", is_flag=True, help="Skip confirmation")
@click.pass_context
def adopt(ctx, environment, config_path, region, scope, stack,
          resource_types, max_resources, dry_run, yes):
    """Import existing AWS resources into warpcore state so it manages them."""
    from warpcore.cli.main import get_state_path, load_config

    config = load_config(config_path)
    env_config = config.get_environment(environment)
    resolved_region = region or env_config.region

    scanner, credentials, resolved_region = _scanner(
        ctx, resolved_region, config.project.name, environment
    )

    state_path = get_state_path(environment, config.project.name)
    state_manager = StateManager(str(state_path))
    if not state_manager.exists():
        state_manager.initialize(
            environment=environment,
            region=resolved_region,
            account=env_config.account,
            project_name=config.project.name,
        )

    status.print(f"Scanning [cyan]{credentials.account_id}[/cyan] / [cyan]{resolved_region}[/cyan]...")
    scanned = scanner.scan_resources(
        scope=ScanScope(scope),
        hydrate=True,
        resource_types=list(resource_types) or None,
        max_resources=max_resources,
    )

    adopter = ResourceAdopter(state_manager)
    plan = adopter.plan(scanned, stack=stack)

    table = Table(title=f"Adoption plan - {environment}")
    table.add_column("Action", style="cyan")
    table.add_column("Logical ID", style="green")
    table.add_column("Type")
    table.add_column("Stack")
    table.add_column("Note", style="dim")

    for item in plan.items:
        style = {"adopt": "green", "already-managed": "dim", "conflict": "red"}[item.action]
        table.add_row(
            f"[{style}]{item.action}[/{style}]",
            item.resource.id,
            item.resource.type.replace("AWS::", ""),
            item.stack,
            item.detail,
        )
    console.print(table)

    conflicts = plan.conflicts()
    if conflicts:
        console.print(
            f"[red]{len(conflicts)} conflict(s)[/red] will be skipped. Rename the "
            f"resource or its Name tag, then re-run."
        )

    if plan.is_empty():
        console.print("[yellow]Nothing to adopt.[/yellow]")
        return

    if dry_run:
        console.print(f"\n[cyan]Dry run:[/cyan] {len(plan.to_adopt())} resource(s) would be adopted.")
        return

    if not yes:
        click.confirm(
            f"\nAdopt {len(plan.to_adopt())} resource(s) into {state_path}?",
            abort=True,
        )

    adopted = adopter.apply(plan)
    console.print(f"[green]Adopted {adopted} resource(s)[/green] into {state_path}")
    console.print(
        "\nRun [cyan]warpcore diff --env "
        f"{environment}[/cyan] to see how they compare to your config."
    )
