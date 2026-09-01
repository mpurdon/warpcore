"""Inspect and reverse recorded operations."""

import json
import sys
from pathlib import Path
from typing import Optional

import click
from rich.console import Console
from rich.panel import Panel
from rich.table import Table

from warpcore.audit.models import AuditOperation, AuditStatus
from warpcore.audit.recorder import DEFAULT_AUDIT_DIR, AuditRecorder
from warpcore.audit.undo import UndoExecutor
from warpcore.utils.logging import get_logger

console = Console()
logger = get_logger(__name__)

_STATUS_STYLES = {
    AuditStatus.SUCCESS: "green",
    AuditStatus.FAILED: "red",
    AuditStatus.UNDONE: "yellow",
}


def _recorder(environment: str, audit_dir: Optional[str] = None) -> AuditRecorder:
    return AuditRecorder(
        environment=environment,
        audit_dir=Path(audit_dir) if audit_dir else DEFAULT_AUDIT_DIR,
    )


def _require_entry(recorder: AuditRecorder, entry_id: str):
    try:
        entry = recorder.get(entry_id)
    except ValueError as e:
        console.print(f"[red]{e}[/red]")
        sys.exit(1)
    if entry is None:
        console.print(f"[red]No audit entry matching '{entry_id}'[/red] in {recorder.path}")
        sys.exit(1)
    return entry


@click.group()
def audit():
    """Inspect the audit trail and undo recorded operations."""
    pass


@audit.command("list")
@click.option("--env", "environment", required=True, help="Environment name")
@click.option("--limit", type=int, default=30, show_default=True)
@click.option("--operation", type=click.Choice([o.value for o in AuditOperation]),
              help="Filter by operation type")
@click.option("--resource", help="Filter by logical resource ID")
@click.option("--session", help="Filter by CLI session ID")
@click.option("--undoable", is_flag=True, help="Only entries that can still be undone")
@click.option("--audit-dir", help="Override the audit log directory")
@click.option("--json", "as_json", is_flag=True)
def audit_list(environment, limit, operation, resource, session, undoable, audit_dir, as_json):
    """Show recorded operations, newest first."""
    recorder = _recorder(environment, audit_dir)
    entries = recorder.entries(
        limit=None,
        operation=AuditOperation(operation) if operation else None,
        resource_id=resource,
        session_id=session,
    )

    if undoable:
        entries = [e for e in entries if e.is_undoable()]
    entries = entries[:limit]

    if as_json:
        click.echo(json.dumps([e.model_dump(mode="json") for e in entries], indent=2))
        return

    if not entries:
        console.print(f"[yellow]No audit entries[/yellow] in {recorder.path}")
        return

    table = Table(title=f"Audit trail - {environment}")
    table.add_column("ID", style="cyan")
    table.add_column("When", style="dim")
    table.add_column("Op")
    table.add_column("Resource", style="green")
    table.add_column("Type")
    table.add_column("Status")
    table.add_column("ms", justify="right")
    table.add_column("Undo")

    for entry in entries:
        style = _STATUS_STYLES[entry.status]
        undo_kind = entry.undo_kind()
        undo_label = (
            "-" if not entry.is_undoable()
            else undo_kind.value
        )
        table.add_row(
            entry.id,
            entry.timestamp.strftime("%m-%d %H:%M:%S"),
            entry.operation.value,
            entry.resource_id,
            entry.resource_type.replace("AWS::", ""),
            f"[{style}]{entry.status.value}[/{style}]",
            f"{entry.duration_ms:.0f}",
            undo_label,
        )

    console.print(table)
    console.print(
        f"[dim]{len(entries)} shown. "
        f"warpcore audit show <id> for detail, undo <id> to reverse.[/dim]"
    )


@audit.command("sessions")
@click.option("--env", "environment", required=True)
@click.option("--limit", type=int, default=20, show_default=True)
@click.option("--audit-dir", help="Override the audit log directory")
def audit_sessions(environment, limit, audit_dir):
    """Group the trail into CLI invocations."""
    recorder = _recorder(environment, audit_dir)
    sessions = recorder.sessions(limit=limit)

    if not sessions:
        console.print(f"[yellow]No audit entries[/yellow] in {recorder.path}")
        return

    table = Table(title=f"Audit sessions - {environment}")
    table.add_column("Session", style="cyan")
    table.add_column("Started", style="dim")
    table.add_column("Command")
    table.add_column("Ops", justify="right")
    table.add_column("Failed", justify="right")
    table.add_column("Actor", style="dim")

    for entry in sessions:
        failed = entry["failed"]
        table.add_row(
            entry["session_id"],
            entry["started"].strftime("%Y-%m-%d %H:%M:%S"),
            entry["command"] or "-",
            str(entry["count"]),
            f"[red]{failed}[/red]" if failed else "0",
            entry["actor"] or "-",
        )
    console.print(table)


@audit.command("show")
@click.argument("entry_id")
@click.option("--env", "environment", required=True)
@click.option("--audit-dir", help="Override the audit log directory")
@click.option("--json", "as_json", is_flag=True)
def audit_show(entry_id, environment, audit_dir, as_json):
    """Show one entry in full, including its property diff."""
    recorder = _recorder(environment, audit_dir)
    entry = _require_entry(recorder, entry_id)

    if as_json:
        click.echo(json.dumps(entry.model_dump(mode="json"), indent=2))
        return

    style = _STATUS_STYLES[entry.status]
    console.print(Panel(
        f"[bold]{entry.summary()}[/bold]\n\n"
        f"ID          {entry.id}\n"
        f"When        {entry.timestamp:%Y-%m-%d %H:%M:%S} UTC\n"
        f"Status      [{style}]{entry.status.value}[/{style}]\n"
        f"Operation   {entry.operation.value}\n"
        f"Resource    {entry.resource_id} ({entry.resource_type})\n"
        f"Physical    {entry.physical_id or '-'}\n"
        f"Stack       {entry.stack or '-'}\n"
        f"Duration    {entry.duration_ms:.0f} ms\n"
        f"Session     {entry.session_id}\n"
        f"Command     {entry.command or '-'}\n"
        f"Actor       {entry.actor or '-'}",
        title="Audit entry",
    ))

    if entry.error:
        console.print(Panel(entry.error, title="Error", border_style="red"))

    changes = entry.changed_properties()
    if changes:
        table = Table(title="Property changes")
        table.add_column("Property", style="cyan")
        table.add_column("Before", style="red")
        table.add_column("After", style="green")
        for key, change in changes.items():
            table.add_row(
                key,
                json.dumps(change["before"], default=str)[:80],
                json.dumps(change["after"], default=str)[:80],
            )
        console.print(table)

    if entry.api_calls:
        table = Table(title=f"AWS API calls ({len(entry.api_calls)})")
        table.add_column("Service", style="cyan")
        table.add_column("Operation")
        table.add_column("ms", justify="right")
        table.add_column("Status", justify="right")
        table.add_column("Error", style="red")
        for call in entry.api_calls:
            table.add_row(
                call.service, call.operation, f"{call.duration_ms:.0f}",
                str(call.status_code or "-"), call.error_code or "",
            )
        console.print(table)

    if entry.is_undone():
        console.print(
            f"[yellow]Undone[/yellow] at {entry.undone_at:%Y-%m-%d %H:%M:%S} "
            f"by entry {entry.undone_by_entry}"
        )
    elif entry.undoes_entry:
        console.print(f"[dim]This entry undoes {entry.undoes_entry}[/dim]")
    elif entry.is_undoable():
        console.print(
            f"[dim]Reversible via[/dim] [cyan]warpcore audit undo {entry.id} "
            f"--env {environment}[/cyan] [dim]({entry.undo_kind().value})[/dim]"
        )


@audit.command("undo")
@click.argument("entry_id")
@click.option("--env", "environment", required=True)
@click.option("--config", "config_path", default="warpcore.yaml", show_default=True)
@click.option("--dry-run", is_flag=True, help="Show the undo plan without executing it")
@click.option("--force", is_flag=True,
              help="Undo even if the resource has changed since, or has dependents")
@click.option("--yes", is_flag=True, help="Skip confirmation")
@click.option("--audit-dir", help="Override the audit log directory")
@click.pass_context
def audit_undo(ctx, entry_id, environment, config_path, dry_run, force, yes, audit_dir):
    """Reverse a recorded operation."""
    from warpcore.cli.main import build_provisioners, get_state_path, load_config

    recorder = _recorder(environment, audit_dir)
    entry = _require_entry(recorder, entry_id)

    config = load_config(config_path)
    env_config = config.get_environment(environment)
    state_path = get_state_path(environment, config.project.name)

    from warpcore.state.manager import StateManager
    state_manager = StateManager(str(state_path))
    if not state_manager.exists():
        console.print(f"[red]No state file at {state_path}[/red]")
        sys.exit(1)

    provisioners, _session = build_provisioners(
        profile=ctx.obj.get("profile"),
        region=ctx.obj.get("region") or env_config.region,
    )

    executor = UndoExecutor(
        provisioners=provisioners,
        state_manager=state_manager,
        recorder=recorder,
    )

    plan = executor.plan(entry, force=force)

    console.print(Panel(
        f"[bold]{entry.summary()}[/bold]\n"
        f"recorded {entry.timestamp:%Y-%m-%d %H:%M:%S} UTC (entry {entry.id})",
        title="Undoing",
    ))

    if plan.blocked_reason:
        console.print(f"[red]Cannot undo:[/red] {plan.blocked_reason}")
        sys.exit(1)

    for step in plan.steps:
        marker = "[red]destructive[/red]" if step.destructive else "[green]safe[/green]"
        console.print(f"  {marker}  {step.description}")

    if dry_run:
        console.print("\n[cyan]Dry run:[/cyan] nothing was changed.")
        return

    if plan.has_destructive_steps() and not yes:
        console.print(
            "\n[yellow]This will delete a real AWS resource.[/yellow]"
        )
    if not yes:
        click.confirm("\nProceed?", abort=True)

    try:
        executor.execute(entry, plan)
    except Exception as e:
        console.print(f"[red]Undo failed:[/red] {e}")
        console.print(
            "[dim]The audit trail records the attempt; "
            "run `warpcore audit list` to see what happened.[/dim]"
        )
        sys.exit(1)

    console.print(f"[green]Undid[/green] {entry.id}: {entry.summary()}")
    console.print(f"[dim]The undo itself is recorded as a new entry in {recorder.path}[/dim]")
