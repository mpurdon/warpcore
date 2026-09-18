"""Diff command for showing deployment changes without executing."""

import json
import sys

import click
from rich.console import Console
from rich.panel import Panel
from rich.table import Table
from rich.text import Text

from ..orchestrator.planner import DeploymentPlan, ResourceChange
from ..orchestrator.plan_detail import detail_plan
from ..provisioners.base import ChangeType
from ..utils.logging import get_logger

logger = get_logger(__name__)
console = Console()

_STYLES = {
    ChangeType.CREATE: ("green", "+", "create"),
    ChangeType.UPDATE: ("yellow", "~", "update"),
    ChangeType.DELETE: ("red", "-", "destroy"),
}


@click.command()
@click.option('--env', required=True, help='Environment name')
@click.option('--agent', help='Specific agent to show diff for')
@click.option('--config', 'config_path', default='warpcore.yaml', show_default=True,
              help='Path to configuration file')
@click.option('--json-output', is_flag=True, help='Output in JSON format')
@click.pass_context
def diff(ctx, env: str, agent: str, config_path: str, json_output: bool):
    """Show what would change in a deployment without executing it."""
    # cli.main imports this module, so these have to be imported lazily.
    from ..cli.main import create_orchestrator, load_config

    try:
        config = load_config(config_path)
        config.get_environment(env)  # raises with the available names on a typo

        # Build the plan through the orchestrator, exactly as `deploy` does.
        # Reimplementing the config-to-resources step here is what let this
        # command drift into calling a planner API that never existed.
        orchestrator = create_orchestrator(
            config=config,
            environment=env,
            profile=ctx.obj.get('profile') if ctx.obj else None,
            region=ctx.obj.get('region') if ctx.obj else None,
        )
        plan = orchestrator.plan_deployment(agent_filter=agent)

        if json_output:
            _output_json(plan, orchestrator)
        else:
            _output_rich(plan, env, agent, orchestrator)

    except SystemExit:
        raise
    except Exception as e:
        console.print(f"[red]Error: {e}[/red]")
        logger.exception("Failed to generate diff")
        sys.exit(1)


def _changes(plan: DeploymentPlan, change_type: ChangeType):
    """Planned changes of one kind, in a stable order."""
    return sorted(plan.get_changes_by_type(change_type), key=lambda c: c.resource_id)


def _resource_of(change: ResourceChange):
    """The resource a change refers to.

    A delete has only a current resource; everything else has a desired one.
    """
    return change.desired_resource or change.current_resource


def _output_json(plan: DeploymentPlan, orchestrator=None):
    """Output diff in JSON format."""
    buckets = {ct: _changes(plan, ct) for ct in _STYLES}

    output = {
        'summary': {
            'to_add': len(buckets[ChangeType.CREATE]),
            'to_change': len(buckets[ChangeType.UPDATE]),
            'to_destroy': len(buckets[ChangeType.DELETE]),
        },
        'changes': {
            label: [c.resource_id for c in buckets[ct]]
            for ct, (_, _, label) in _STYLES.items()
        },
        'waves': [
            {'wave': wave.wave_number, 'resources': sorted(wave.resource_ids)}
            for wave in plan.waves
        ],
        'estimated_duration_seconds': plan.estimated_duration,
        'resources': [],
        'detail': [d.to_dict() for d in detail_plan(plan)],
        'notes': list(getattr(orchestrator, 'compile_notes', []) or []),
        'skipped': list(getattr(orchestrator, 'compile_skipped', []) or []),
    }

    for change_type, changes in buckets.items():
        for change in changes:
            resource = _resource_of(change)
            output['resources'].append({
                'id': change.resource_id,
                'type': resource.type if resource else None,
                'action': _STYLES[change_type][2],
                'reason': change.reason,
                'properties': resource.properties if resource else {},
            })

    console.print_json(data=output)


def _output_rich(plan: DeploymentPlan, env: str, agent: str, orchestrator=None):
    """Output diff in rich formatted text."""
    title = f"Deployment Diff for Environment: {env}"
    if agent:
        title += f" (Agent: {agent})"

    console.print(Panel(title, style="bold blue"))
    console.print()

    for note in getattr(orchestrator, 'compile_notes', []) or []:
        console.print(f"[yellow]note:[/yellow] {note}")
    skipped = getattr(orchestrator, 'compile_skipped', []) or []
    discovered = sum(1 for x in skipped if 'discovered' in x.get('reason', ''))
    if discovered:
        console.print(f"[dim]{discovered} discovered resource(s) are observed, not managed.[/dim]")
    for x in skipped:
        if 'discovered' not in x.get('reason', ''):
            console.print(f"[yellow]left out:[/yellow] {x['id']} ({x['type']}): {x['reason']}")
    if skipped or getattr(orchestrator, 'compile_notes', None):
        console.print()

    buckets = {ct: _changes(plan, ct) for ct in _STYLES}
    counts = [
        (len(buckets[ChangeType.CREATE]), "to add", "green"),
        (len(buckets[ChangeType.UPDATE]), "to change", "yellow"),
        (len(buckets[ChangeType.DELETE]), "to destroy", "red"),
    ]

    summary = Text()
    summary.append("Plan: ", style="bold")
    for index, (count, label, style) in enumerate(counts):
        if index:
            summary.append(", ")
        summary.append(f"{count} {label}", style=style if count else "dim")
    console.print(summary)
    console.print()

    if not any(count for count, _, _ in counts):
        console.print("[dim]No changes. Infrastructure is up-to-date.[/dim]")
        return

    for change_type, (style, marker, label) in _STYLES.items():
        changes = buckets[change_type]
        if not changes:
            continue

        console.print(f"[bold {style}]Resources to {label}:[/bold {style}]")
        table = Table(show_header=True, header_style="bold")
        table.add_column("Resource ID", style="cyan")
        table.add_column("Type", style="magenta")
        table.add_column("Detail")

        for change in changes:
            resource = _resource_of(change)
            table.add_row(
                f"{marker} {change.resource_id}",
                resource.type if resource else "-",
                _detail(change),
            )

        console.print(table)
        console.print()

    # Property by property, and what it means for code and permissions.
    details = [d for d in detail_plan(plan) if d.properties or d.code or (d.iam and (d.iam.added or d.iam.removed))]
    if details:
        console.print("[bold]What changes:[/bold]")
        for d in details:
            style, marker, _ = _STYLES.get(ChangeType(d.action), ("white", " ", d.action))
            console.print(f"[{style}]{marker} {d.resource_id}[/{style}] [dim]{d.resource_type or ''}[/dim]")
            if d.code:
                word = {"redeploys": "[yellow]code redeploys[/yellow] (package hash differs from the deployed one)",
                        "unchanged": "[dim]code unchanged[/dim]",
                        "stub": "[yellow]stub handler[/yellow] (no code path set)"}[d.code]
                console.print(f"    {word}")
            for pc in d.properties[:12]:
                after = _short(pc.after)
                if d.action == "create":
                    console.print(f"    [dim]{pc.key}[/dim] = {after}")
                else:
                    console.print(f"    [dim]{pc.key}[/dim]: {_short(pc.before)} [dim]->[/dim] {after}")
            if len(d.properties) > 12:
                console.print(f"    [dim]... {len(d.properties) - 12} more[/dim]")
            if d.iam:
                for actions, resources in d.iam.added:
                    console.print(f"    [green]+ allow[/green] {', '.join(actions)} [dim]on[/dim] {', '.join(resources)}")
                for actions, resources in d.iam.removed:
                    console.print(f"    [red]- allow[/red] {', '.join(actions)} [dim]on[/dim] {', '.join(resources)}")
        console.print()

    if plan.waves:
        console.print(f"[bold]Deployment will execute in {len(plan.waves)} wave(s):[/bold]")
        for wave in plan.waves:
            console.print(
                f"  Wave {wave.wave_number}: {wave.size()} resource(s) in parallel"
            )
        console.print()

    if plan.estimated_duration:
        minutes, seconds = divmod(plan.estimated_duration, 60)
        console.print(f"[dim]Estimated duration: {minutes}m {seconds}s[/dim]")


def _short(value) -> str:
    text = json.dumps(value, default=str, separators=(",", ":")) if isinstance(value, (dict, list)) else str(value)
    return text if len(text) <= 80 else text[:77] + "..."


def _detail(change: ResourceChange) -> str:
    """One-line description of what is changing."""
    if change.reason:
        return change.reason

    if change.change_type is ChangeType.DELETE:
        current = change.current_resource
        return (current.physical_id or "not yet created") if current else "-"

    resource = _resource_of(change)
    if resource is None:
        return "-"

    # Surface the handful of properties a person scans for, rather than
    # dumping the whole configuration into a table cell.
    interesting = ("MemorySize", "Timeout", "Runtime", "Handler", "name")
    details = [
        f"{key}={resource.properties[key]}"
        for key in interesting
        if key in resource.properties
    ]
    return ", ".join(details) if details else resource.type
