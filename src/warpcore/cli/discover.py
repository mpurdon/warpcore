"""Reverse-engineer an existing AWS account into warpcore config and state."""

import json
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Optional

import click
import yaml
from rich.console import Console
from rich.panel import Panel
from rich.table import Table

from warpcore.agentic.scanner import AWSScanner, ScannedState, ScanScope
from warpcore.devmode import get_dev_mode
from warpcore.discovery.adopt import ResourceAdopter
from warpcore.discovery.config_emitter import NAME_RE, ConfigEmitter
from warpcore.discovery.project_emitter import ProjectEmitter, select_resources
from warpcore.discovery.detail import ResourceDetailReader
from warpcore.discovery.connect import ConnectAdvisor
from warpcore.discovery.findings import ProjectReviewer
from warpcore.discovery.suggest import draft_scenario, suggest_names
from warpcore.discovery.takeover import take_over
from warpcore.discovery.inventory import enabled_regions, scan_account
from warpcore.utils.progress import PHASE, RESULT, ProgressEmitter, ndjson_writer
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
@click.option("--region", "regions", multiple=True,
              help="Region to scan; repeatable. Defaults to the profile's region.")
@click.option("--all-regions", is_flag=True, help="Scan every region enabled for the account")
@click.option("--scope", type=click.Choice(["account", "project"]), default="account",
              help="account scans everything; project filters to warpcore tags")
@click.option("--project-name", default="discovered", help="Project name (project scope only)")
@click.option("--env", "environment", default="dev", help="Environment name (project scope only)")
@click.option("--hydrate/--no-hydrate", default=True,
              help="Fetch each resource's real configuration (one API call each)")
@click.option("--type", "resource_types", multiple=True,
              help="Only this CloudFormation type; repeatable")
@click.option("--max", "max_resources", type=int, default=5000, show_default=True,
              help="Stop after this many resources per region")
@click.option("--json", "as_json", is_flag=True, help="Emit JSON instead of a table")
@click.option("--progress", "stream_progress", is_flag=True,
              help="Stream newline-delimited progress events on stdout, ending with a "
                   "'result' event carrying the inventory. Implies --json.")
@click.option("--parallelism", type=int, default=6, show_default=True,
              help="Regions scanned concurrently. Clients use adaptive retries, so "
                   "raising this backs off under throttling rather than failing.")
@click.pass_context
def inventory(ctx, regions, all_regions, scope, project_name, environment, hydrate,
              resource_types, max_resources, as_json, stream_progress, parallelism):
    """List what actually exists in an AWS account."""
    first_region = regions[0] if regions else None
    scanner, credentials, resolved_region = _scanner(ctx, first_region, project_name, environment)

    if scope == "project":
        # Project scope is tag-filtered and single-region: it is what drift
        # detection uses, and it has no business crossing regions.
        status.print(
            f"Scanning [cyan]{credentials.account_id}[/cyan] in "
            f"[cyan]{resolved_region}[/cyan] (scope: project)..."
        )
        scanned = scanner.scan_resources(
            scope=ScanScope.PROJECT,
            hydrate=hydrate,
            resource_types=list(resource_types) or None,
            max_resources=max_resources,
        )
        region_summary = {resolved_region: len(scanned.resources)}
        explorer = scanned.explorer_available
    else:
        if all_regions:
            target_regions = enabled_regions(scanner.session, seed_region=resolved_region)
        else:
            target_regions = list(regions) or [resolved_region]

        status.print(
            f"Scanning [cyan]{credentials.account_id}[/cyan] across "
            f"[cyan]{len(target_regions)}[/cyan] region(s): {', '.join(target_regions)}"
        )
        account_inventory = scan_account(
            session=scanner.session,
            account=credentials.account_id,
            regions=target_regions,
            hydrate=hydrate,
            resource_types=list(resource_types) or None,
            max_per_region=max_resources,
            max_workers=parallelism,
            progress=ndjson_writer() if stream_progress else None,
        )
        scanned = account_inventory.scanned
        region_summary = account_inventory.region_summary()
        explorer = scanned.explorer_available

    if as_json or stream_progress:
        payload = {
            "account": credentials.account_id,
            "regions": region_summary,
            "scope": scope,
            "resource_explorer": explorer,
            "truncated": scanned.truncated,
            "counts": scanned.count_by_type(),
            "unhydrated_types": scanned.unhydrated,
            "resources": [
                {
                    "id": r.id,
                    "type": r.type,
                    "physical_id": r.physical_id,
                    "region": (r.metadata or {}).get("region"),
                    "sources": (r.metadata or {}).get("sources", []),
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
        if stream_progress:
            # One line, so the reader can act on it the moment it arrives.
            click.echo(json.dumps(
                {"event": RESULT, "data": payload}, default=str, separators=(",", ":")
            ))
        else:
            click.echo(json.dumps(payload, indent=2, default=str))
        return

    if not scanned.resources:
        console.print("[yellow]No resources found.[/yellow]")
        if scope == "project":
            console.print("Try [cyan]--scope account[/cyan] to see untagged resources.")
        return

    if not explorer and scope == "account":
        console.print(
            "[yellow]AWS Resource Explorer is not enabled in this account;[/yellow] "
            "coverage is limited to the services warpcore enumerates directly. "
            "Enabling Resource Explorer (free) makes discovery near-complete."
        )

    summary = Table(title=f"Resource inventory - {credentials.account_id}")
    summary.add_column("Type", style="cyan")
    summary.add_column("Count", justify="right")
    for resource_type, count in scanned.count_by_type().items():
        summary.add_row(resource_type, str(count))
    console.print(summary)

    if len(region_summary) > 1:
        by_region = Table(title="By region")
        by_region.add_column("Region", style="cyan")
        by_region.add_column("Resources", justify="right")
        for region, count in sorted(region_summary.items()):
            by_region.add_row(region, str(count))
        console.print(by_region)

    detail = Table(title="Resources")
    detail.add_column("Logical ID", style="green")
    detail.add_column("Type")
    detail.add_column("Region", style="dim")
    detail.add_column("Props", justify="right")
    detail.add_column("Tags", justify="right")
    for resource in sorted(scanned.get_all_resources(), key=lambda r: (r.type, r.id))[:200]:
        detail.add_row(
            resource.id,
            resource.type.replace("AWS::", ""),
            (resource.metadata or {}).get("region", ""),
            str(len(resource.properties or {})) if hydrate else "-",
            str(len(resource.tags or {})),
        )
    console.print(detail)

    if len(scanned.resources) > 200:
        console.print(f"[dim]... {len(scanned.resources) - 200} more; use --json for all[/dim]")

    if scanned.truncated:
        console.print(
            f"[yellow]Stopped at --max {max_resources} in at least one region; "
            f"results are incomplete.[/yellow]"
        )

    if scanned.unhydrated:
        skipped = sum(scanned.unhydrated.values())
        console.print(
            f"[dim]{skipped} resource(s) across {len(scanned.unhydrated)} type(s) have no "
            f"detail reader yet and were listed without configuration.[/dim]"
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
@click.option("--include-env-values", is_flag=True,
              help="Copy real Lambda environment variable values. These are often "
                   "live credentials; by default only the names are kept.")
@click.pass_context
def emit_config(ctx, region, scope, project_name, environment, out_path,
                resource_types, max_resources, force, include_env_values):
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
        include_env_values=include_env_values,
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


@discover.command("connect")
@click.argument("arn")
@click.option("--region", help="Region; inferred from the ARN when it carries one")
@click.option("--no-ip-check", is_flag=True, help="Do not look up this machine's public address")
@click.option("--json", "as_json", is_flag=True, help="Emit JSON instead of a checklist")
@click.pass_context
def connect(ctx, arn, region, no_ip_check, as_json):
    """How to reach an instance from here: the checks, and the command that would work.

    Advises only; never opens a session.
    """
    from warpcore.utils.arn import parse_arn

    parsed = parse_arn(arn)
    if parsed is None or parsed.service != "ec2" or "instance/" not in arn:
        console.print(f"[red]Not an EC2 instance ARN:[/red] {arn}")
        sys.exit(1)

    resolved_region = region or ctx.obj.get("region") or (parsed.region or None)
    scanner, _credentials, resolved_region = _scanner(ctx, resolved_region, "discovered", "dev")
    plan = ConnectAdvisor(
        scanner.session, resolved_region, profile=ctx.obj.get("profile"), lookup_my_ip=not no_ip_check,
    ).plan(arn)

    if as_json:
        click.echo(json.dumps(plan.to_dict(), indent=2, default=str))
        return

    console.print(f"[bold]{plan.name}[/bold] [dim]{plan.instance_id} · {plan.state or 'unknown'}[/dim]")
    for check in plan.checks:
        mark = "[green]✓[/green]" if check.ok else "[red]✗[/red]" if check.ok is False else "[yellow]?[/yellow]"
        console.print(f"  {mark} {check.label}[dim] · {check.detail}[/dim]")
    if plan.command:
        console.print(f"\n[cyan]{plan.command}[/cyan]")
    else:
        console.print("\n[yellow]No way in from here.[/yellow]")
    for note in plan.notes:
        console.print(f"[dim]{note}[/dim]")


@discover.command("findings")
@click.option("--config", "config_path", default="warpcore.yaml", show_default=True,
              help="The project whose canvas to review")
@click.option("--hours", type=int, default=24, show_default=True, help="Metric window")
@click.option("--llm-provider", type=click.Choice(["anthropic", "openai", "bedrock", "local"]),
              help="Ask a model to rank the findings and say why each matters here")
@click.option("--llm-model", help="Model name for the provider")
@click.option("--parallelism", type=int, default=6, show_default=True, help="Resources read at once")
@click.option("--include-muted", is_flag=True, help="List muted findings too")
@click.option("--json", "as_json", is_flag=True, help="Emit JSON instead of a list")
@click.pass_context
def findings(ctx, config_path, hours, llm_provider, llm_model, parallelism, include_muted, as_json):
    """What is wrong, wasteful or fragile, judged from what the resources are doing.

    Reads the canvas in warpcore.yaml, pulls each metered resource's metrics,
    runs the rules, and (with --llm-provider) has a model rank the result.
    """
    path = Path(config_path)
    if not path.exists():
        console.print(f"[red]No such file:[/red] {config_path}")
        sys.exit(1)
    data = yaml.safe_load(path.read_text()) or {}
    nodes = ((data.get("canvas") or {}).get("nodes")) or []
    if not nodes:
        console.print("[yellow]The project has no canvas to review.[/yellow]")
        sys.exit(1)

    # The environment block knows the profile and region when the operator gave none.
    envs = data.get("environments") or {}
    first_env = next(iter(envs.values()), {}) if isinstance(envs, dict) else {}
    if not ctx.obj.get("profile") and first_env.get("profile"):
        ctx.obj["profile"] = first_env["profile"]
    region = ctx.obj.get("region") or first_env.get("region") or (data.get("project") or {}).get("region")
    scanner, _credentials, resolved_region = _scanner(ctx, region, "discovered", "dev")

    llm = None
    if llm_provider:
        from warpcore.agentic.llm_client import LLMClient, LLMProvider
        llm = LLMClient(provider=LLMProvider(llm_provider), model=llm_model)
        if llm.client is None:
            console.print(f"[yellow]The {llm_provider} client could not be initialised; reviewing without a model.[/yellow]")
            llm = None

    review = ProjectReviewer(scanner.session, resolved_region, llm=llm, parallelism=parallelism,
                             project_dir=path.resolve().parent).review(nodes, hours=hours)

    if as_json:
        click.echo(json.dumps(review.to_dict(), indent=2, default=str))
        return

    if review.summary:
        console.print(f"[bold]{review.summary}[/bold]\n")
    muted = [f for f in review.findings if f.status == "muted"]
    for f in review.findings:
        if f.status == "muted" and not include_muted:
            continue
        colour = {"high": "red", "medium": "yellow", "low": "dim"}.get(f.severity, "white")
        extra = f" [dim]· {f.effort}[/dim]" + (f" [green]· saves ~${f.savings_usd_month:.0f}/mo[/green]" if f.savings_usd_month else "")
        muted_tag = f" [dim](muted: {f.mute_reason})[/dim]" if f.status == "muted" else ""
        console.print(f"[{colour}]{f.severity:6}[/{colour}] [bold]{f.title}[/bold] [dim]({f.kind})[/dim]{extra}{muted_tag}  [dim]{f.id}[/dim]")
        console.print(f"       {f.detail}")
        if f.why:
            console.print(f"       [italic]{f.why}[/italic]")
        if f.suggestion:
            console.print(f"       [dim]-> {f.suggestion}[/dim]")
    for note in review.notes:
        console.print(f"[dim]{note}[/dim]")
    if muted and not include_muted:
        console.print(f"[dim]{len(muted)} muted finding(s) not shown; --include-muted lists them.[/dim]")
    for section, err in review.errors.items():
        console.print(f"[yellow]{section}: {err}[/yellow]")


@discover.command("mute")
@click.argument("finding_id")
@click.option("--reason", required=True, help="Why this finding is accepted; kept with the mute")
@click.option("--config", "config_path", default="warpcore.yaml", show_default=True)
def mute(finding_id, reason, config_path):
    """Accept a finding: it stays in the review, out of the counts, with the reason on record."""
    from warpcore.discovery.findings import write_mute
    write_mute(Path(config_path).resolve().parent, finding_id, reason)
    console.print(f"[green]Muted[/green] {finding_id}: {reason}")


@discover.command("unmute")
@click.argument("finding_id")
@click.option("--config", "config_path", default="warpcore.yaml", show_default=True)
def unmute(finding_id, config_path):
    """Put a muted finding back in the counts."""
    from warpcore.discovery.findings import remove_mute
    if remove_mute(Path(config_path).resolve().parent, finding_id):
        console.print(f"[green]Unmuted[/green] {finding_id}")
    else:
        console.print(f"[yellow]{finding_id} was not muted.[/yellow]")


@discover.command("suggest")
@click.argument("kind", type=click.Choice(["names", "scenario"]))
@click.option("--input", "input_path", required=True, type=click.Path(exists=True, dir_okay=False),
              help="JSON describing the clusters or the graph")
@click.option("--llm-provider", type=click.Choice(["anthropic", "openai", "bedrock", "local"]), required=True)
@click.option("--llm-model", help="Model name for the provider")
@click.option("--ask", default="", help="What the operator asked for, for a scenario")
@click.pass_context
def suggest(ctx, kind, input_path, llm_provider, llm_model, ask):
    """Ask the configured model for names or a scenario draft over the canvas's facts. JSON in, JSON out.

    Makes no AWS calls; the input carries everything the model sees.
    """
    from warpcore.agentic.llm_client import LLMClient, LLMProvider

    data = json.loads(Path(input_path).read_text())
    llm = LLMClient(provider=LLMProvider(llm_provider), model=llm_model)
    if llm.client is None:
        console.print(f"[red]The {llm_provider} client could not be initialised.[/red] Is its SDK installed and a credential set?")
        sys.exit(1)
    try:
        if kind == "names":
            result = suggest_names(llm, data.get("clusters") or [], str(data.get("project_name") or "project"))
        else:
            result = draft_scenario(llm, data, ask)
    except Exception as e:  # noqa: BLE001 - the app shows the message
        console.print(f"[red]The model's answer could not be used:[/red] {e}")
        sys.exit(1)
    click.echo(json.dumps(result, indent=2, default=str))


def _attach_provenance(session, region, resources, terraform_states, pulumi_states, emitter=None) -> dict:
    """Provenance for scanned resources: tags and stacks always, state files when given."""
    from warpcore.discovery.provenance import (
        StackClassifier, attach_provenance, pulumi_index, read_state_file, sst_apps, sst_v3_index, terraform_index,
    )
    indexes = []
    notes = []
    for loc in terraform_states or ():
        try:
            indexes.append(terraform_index(read_state_file(session, loc)))
        except Exception as e:  # noqa: BLE001 - a bad path is reported, not fatal
            notes.append(f"Terraform state {loc}: {e}")
    for loc in pulumi_states or ():
        try:
            indexes.append(pulumi_index(read_state_file(session, loc)))
        except Exception as e:  # noqa: BLE001
            notes.append(f"Pulumi state {loc}: {e}")
    apps = sst_apps(resources)
    if apps:
        sst_index, sst_notes = sst_v3_index(session, region, apps)
        if sst_index:
            indexes.append(sst_index)
        notes.extend(sst_notes)
    counts = attach_provenance(list(resources), classifier=StackClassifier(session, region), indexes=indexes)
    for n in notes:
        logger.info("provenance: %s", n)
        if emitter is not None:
            emitter.emit(PHASE, phase="provenance", status="note", message=n)
    counts["_notes"] = notes
    return counts


@discover.command("provenance")
@click.option("--env", "environment", required=True, help="Environment whose state to annotate")
@click.option("--config", "config_path", default="warpcore.yaml", show_default=True)
@click.option("--terraform-state", "terraform_states", multiple=True, help="Terraform/OpenTofu state (path or s3://bucket/key); repeatable")
@click.option("--pulumi-state", "pulumi_states", multiple=True, help="Pulumi checkpoint or stack export (path or s3://bucket/key); repeatable")
@click.option("--json", "as_json", is_flag=True)
@click.pass_context
def provenance(ctx, environment, config_path, terraform_states, pulumi_states, as_json):
    """Work out who deployed the resources in the state: tags, stacks, and any state files given.

    Writes the answer onto each state entry, and lists what nothing manages.
    """
    from warpcore.cli.main import get_state_path, load_config

    config = load_config(config_path)
    env = config.get_environment(environment)
    if not ctx.obj.get("profile") and env.profile:
        ctx.obj["profile"] = env.profile
    state_path = get_state_path(environment, config.project.name)
    if not state_path.exists():
        console.print(f"[red]No deployment state for '{environment}'.[/red]")
        sys.exit(1)
    scanner, _credentials, region = _scanner(ctx, ctx.obj.get("region") or env.region, config.project.name, environment)
    manager = StateManager(str(state_path))
    state = manager.load()
    resources = [r for _stack, r in state.all_resources()]
    counts = _attach_provenance(scanner.session, region, resources, terraform_states, pulumi_states)
    notes = counts.pop("_notes", [])
    manager.save(state)
    unmanaged = [r for r in resources if not (r.metadata or {}).get("provenance") and (r.metadata or {}).get("adopted")]

    if as_json:
        click.echo(json.dumps({
            "counts": counts, "notes": notes,
            "unmanaged": [{"id": r.id, "type": r.type, "physical_id": r.physical_id} for r in unmanaged],
            "resources": [{"id": r.id, "type": r.type, "provenance": (r.metadata or {}).get("provenance")} for r in resources],
        }, indent=2, default=str))
        return
    for m, n in sorted(counts.items(), key=lambda kv: -kv[1]):
        console.print(f"  {n:4}  {m}")
    if unmanaged:
        console.print(f"\n[yellow]{len(unmanaged)} resource(s) nothing manages[/yellow] (made by hand, or by a tool whose state was not given):")
        for r in unmanaged[:40]:
            console.print(f"    {r.id} [dim]{r.type}[/dim]")
        if len(unmanaged) > 40:
            console.print(f"    [dim]... {len(unmanaged) - 40} more[/dim]")
    for n in notes:
        console.print(f"[dim]{n}[/dim]")


@discover.command("takeover")
@click.argument("resources", nargs=-1, required=True)
@click.option("--env", "environment", required=True, help="Environment whose state holds the resources")
@click.option("--config", "config_path", default="warpcore.yaml", show_default=True)
@click.option("--dry-run", is_flag=True, help="Say what would happen without writing state")
@click.option("--json", "as_json", is_flag=True, help="Emit JSON")
@click.pass_context
def takeover(ctx, resources, environment, config_path, dry_run, as_json):
    """Make adopted resources warpcore's: the canvas config is then what deploy enforces.

    RESOURCES are logical ids, ARNs, or names. Calls nothing in AWS; rewrites
    the state and prints what the previous manager (Terraform, SST, a
    CloudFormation stack) has to be told so the two tools do not fight.
    """
    from warpcore.cli.main import get_state_path, load_config

    config = load_config(config_path)
    state_path = get_state_path(environment, config.project.name)
    if not state_path.exists():
        console.print(f"[red]No deployment state for '{environment}'.[/red] Import the account with adopt, or run `warpcore discover adopt`.")
        sys.exit(1)
    result = take_over(StateManager(str(state_path)), list(resources), dry_run=dry_run)

    if as_json:
        click.echo(json.dumps(result.to_dict(), indent=2, default=str))
        return
    for item in result.items:
        mark = {"taken": "[green]✓[/green]", "already": "[dim]=[/dim]", "not-found": "[red]?[/red]"}.get(item.action, "[yellow]![/yellow]")
        what = "taken over" if item.action == "taken" else item.detail
        console.print(f"  {mark} {item.resource_id} [dim]{item.resource_type}[/dim] {what}{' (dry run)' if dry_run and item.action == 'taken' else ''}")
    if result.release:
        console.print("\n[bold]Tell the previous manager:[/bold]")
        for step in result.release:
            console.print(f"  {step}")
    if result.taken() and not dry_run:
        console.print(f"\n[green]{len(result.taken())} resource(s) are now managed.[/green] `warpcore diff --env {environment}` should propose nothing until you change them.")


@discover.command("detail")
@click.argument("arn")
@click.option("--region", help="Region; inferred from the ARN when it carries one")
@click.option("--hours", type=int, default=24, show_default=True, help="Metric and log window")
@click.option("--no-metrics", is_flag=True, help="Skip CloudWatch metrics")
@click.option("--no-logs", is_flag=True, help="Skip CloudWatch logs")
@click.option("--json", "as_json", is_flag=True, help="Emit JSON instead of panels")
@click.pass_context
def detail(ctx, arn, region, hours, no_metrics, no_logs, as_json):
    """Everything about one resource: config, network, metrics, logs, relations.

    Needs no state file - the ARN alone identifies the resource.
    """
    from warpcore.utils.arn import parse_arn

    parsed = parse_arn(arn)
    if parsed is None:
        console.print(f"[red]Not an ARN:[/red] {arn}")
        sys.exit(1)

    resolved_region = region or ctx.obj.get("region") or (parsed.region or None)
    scanner, credentials, resolved_region = _scanner(ctx, resolved_region, "discovered", "dev")

    reader = ResourceDetailReader(scanner.session, resolved_region)
    result = reader.read(
        arn, window_hours=hours,
        include_metrics=not no_metrics, include_logs=not no_logs,
    )

    if as_json:
        click.echo(json.dumps(result.to_dict(), indent=2, default=str))
        return

    console.print(Panel(
        f"[bold]{result.name}[/bold]\n"
        f"Type    {result.type}\n"
        f"Region  {result.region}\n"
        f"ARN     {result.arn}"
        + (f"\nCost    {result.cost_hint}" if result.cost_hint else ""),
        title="Resource",
    ))

    if result.tags:
        t = Table(title="Tags")
        t.add_column("Key", style="cyan")
        t.add_column("Value")
        for k, v in sorted(result.tags.items()):
            t.add_row(k, v)
        console.print(t)

    if result.configuration:
        interesting = {k: v for k, v in result.configuration.items()
                       if not isinstance(v, (dict, list)) and k not in ("Tags",)}
        t = Table(title="Configuration")
        t.add_column("Property", style="cyan")
        t.add_column("Value")
        for k, v in list(interesting.items())[:30]:
            t.add_row(k, str(v)[:80])
        console.print(t)

    net = result.network
    if net:
        lines = []
        if net.vpc_id:
            lines.append(f"VPC       {net.vpc_id}")
        if net.subnet_id:
            lines.append(f"Subnet    {net.subnet_id}  {net.availability_zone or ''}")
        if net.private_ips:
            lines.append(f"Private   {', '.join(net.private_ips)}")
        if net.public_ips:
            lines.append(f"Public    {', '.join(net.public_ips)}")
        if net.flow_logs:
            lines.append("Flow logs " + ", ".join(f"{f['id']} ({f['status']}, {f['traffic']})" for f in net.flow_logs))
        for note in net.notes:
            lines.append(f"[yellow]{note}[/yellow]")
        if lines:
            console.print(Panel("\n".join(lines), title="Network"))
        if net.rules:
            t = Table(title="Security group rules")
            for col in ("Dir", "Proto", "Ports", "Source/Dest", "Description"):
                t.add_column(col)
            for r in net.rules:
                ports = "all" if r.from_port is None else (str(r.from_port) if r.from_port == r.to_port else f"{r.from_port}-{r.to_port}")
                style = "red" if r.direction == "ingress" and r.source in ("0.0.0.0/0", "::/0") else ""
                t.add_row(r.direction, r.protocol, ports, f"[{style}]{r.source}[/{style}]" if style else r.source, r.description)
            console.print(t)
        if net.routes:
            t = Table(title="Routes")
            t.add_column("Destination")
            t.add_column("Target")
            t.add_column("State")
            for r in net.routes:
                t.add_row(str(r["destination"]), str(r["target"]), str(r["state"]))
            console.print(t)

    if result.metrics and result.metrics.has_metrics():
        t = Table(title=f"Metrics - last {result.metrics.window_hours}h")
        for col in ("Metric", "Stat", "Total", "Average", "Max", "Unit"):
            t.add_column(col, justify="right" if col in ("Total", "Average", "Max") else "left")
        for m in result.metrics.metrics:
            if not m.datapoints:
                continue
            t.add_row(m.name, m.statistic, _fmt_metric(m.total), _fmt_metric(m.average),
                      _fmt_metric(m.maximum), m.unit)
        console.print(t)

    for group in result.logs:
        header = f"{group.name}  ({group.stored_bytes:,} bytes stored, retention {group.retention_days or 'never expires'})"
        if group.recent_events:
            body = "\n".join(f"[dim]{e.timestamp[11:19]}[/dim] {e.message[:140]}" for e in group.recent_events[:15])
        else:
            body = f"[dim]no events in the last {hours}h[/dim]"
        console.print(Panel(body, title=f"Logs: {header}"))

    if result.related:
        t = Table(title="Related resources")
        t.add_column("Relation", style="cyan")
        t.add_column("Name", style="green")
        t.add_column("Type")
        t.add_column("Detail", style="dim")
        for r in result.related:
            t.add_row(r.relation, r.name, r.type.replace("AWS::", ""), r.detail)
        console.print(t)

    for note in result.notes:
        console.print(f"[dim]{note}[/dim]")
    if result.errors:
        console.print("[yellow]Sections that could not be read:[/yellow]")
        for section, why in result.errors.items():
            console.print(f"  {section}: {why}")


def _fmt_metric(value) -> str:
    """Compact number for a metrics table cell."""
    if value is None:
        return "-"
    return f"{value:,.0f}" if value >= 1000 else f"{value:.2f}"


@discover.command("project")
@click.option("--region", "regions", multiple=True,
              help="Region to include; repeatable. Default: the profile's region")
@click.option("--all-regions", is_flag=True, help="Every region enabled for the account")
@click.option("--project-name", required=True, help="Project name (^[a-z][a-z0-9-]*$)")
@click.option("--env", "environment", default="dev", show_default=True,
              help="Environment key this account becomes")
@click.option("--include", "include", multiple=True,
              help="Glob to include; repeatable. Matches type, name, ARN, region or tag=value. "
                   "Prefix with type:, name:, tag: or region: to pin a field. Default: *")
@click.option("--exclude", "exclude", multiple=True, help="Glob to exclude; repeatable")
@click.option("--lambda-as", type=click.Choice(["agent", "lambda"]), default="agent", show_default=True,
              help="Show Lambda functions as deployable agents or as plain Lambda nodes")
@click.option("--include-env-values", is_flag=True,
              help="Copy real Lambda environment variable values (often live credentials)")
@click.option("--adopt", is_flag=True,
              help="Register the included resources in this environment's deployment state so "
                   "deploy updates them instead of creating duplicates. Writes only local state.")
@click.option("--max", "max_resources", type=int, default=5000, show_default=True,
              help="Stop enumerating a region after this many resources")
@click.option("--parallelism", type=int, default=6, show_default=True, help="Regions scanned at once")
@click.option("--progress", "stream_progress", is_flag=True,
              help="Stream NDJSON progress to stdout, then a final result event")
@click.option("--terraform-state", "terraform_states", multiple=True,
              help="A Terraform/OpenTofu state file (path or s3://bucket/key) whose resources are marked as Terraform's; repeatable")
@click.option("--pulumi-state", "pulumi_states", multiple=True,
              help="A Pulumi checkpoint or stack export (path or s3://bucket/key); repeatable")
@click.option("--json", "as_json", is_flag=True, help="Emit the project as JSON")
@click.pass_context
def project(ctx, regions, all_regions, project_name, environment, include, exclude, lambda_as,
            include_env_values, adopt, max_resources, parallelism, stream_progress, terraform_states, pulumi_states, as_json):
    """Turn an account into a Visual Builder project: resources, relationships, canvas fields."""
    from warpcore.cli.main import get_state_path

    if not NAME_RE.match(project_name):
        console.print(f"[red]Project name '{project_name}' must match ^[a-z][a-z0-9-]*$[/red]")
        sys.exit(2)

    first_region = regions[0] if regions else None
    scanner, credentials, resolved_region = _scanner(ctx, first_region, project_name, environment)
    if all_regions:
        target_regions = enabled_regions(scanner.session, seed_region=resolved_region)
    else:
        target_regions = list(regions) or [resolved_region]
    progress = ndjson_writer() if stream_progress else None

    # Enumerate first, select, then hydrate only what survives: hydration is
    # one API call per resource and the selection usually drops most of them.
    account_inventory = scan_account(
        session=scanner.session,
        account=credentials.account_id,
        regions=target_regions,
        hydrate=False,
        max_per_region=max_resources,
        max_workers=parallelism,
        progress=progress,
    )
    kept, dropped = select_resources(
        account_inventory.scanned.get_all_resources(), list(include), list(exclude),
    )

    selected = ScannedState()
    selected.explorer_available = account_inventory.scanned.explorer_available
    for r in kept:
        selected.add_resource(r)
    for e in account_inventory.scanned.errors:
        selected.add_error(e)

    emitter = ProgressEmitter(progress)

    def hydrate_subset(region: str, members: list) -> None:
        """Hydrate some resources in place with a scanner bound to their region."""
        scoped = emitter.child(region=region)
        scoped.emit(PHASE, phase="hydrate", status="running", found=0)
        subset = ScannedState()
        for r in members:
            subset.add_resource(r)   # same objects: hydration fills them in place
        AWSScanner(
            boto_session=scanner.session, project_name=project_name,
            environment=environment, region=region, account=credentials.account_id,
        ).hydrate(subset)
        for e in subset.errors:
            selected.add_error(e)
        scoped.emit(PHASE, phase="hydrate", status="done", found=len(members) - len(subset.errors))

    # Regions hydrate in parallel, as they were enumerated.
    by_region: dict = {}
    for r in kept:
        by_region.setdefault((r.metadata or {}).get("region") or resolved_region, []).append(r)
    with ThreadPoolExecutor(max_workers=max(1, parallelism)) as pool:
        list(pool.map(lambda item: hydrate_subset(*item), by_region.items()))

    # Second pass: the execution roles of included functions and state
    # machines are part of the picture even when the patterns did not name
    # them, and they are only known once the functions are hydrated. Pull
    # them in from the dropped set so the canvas can show which role each
    # function runs as. Roles are global; any region's scanner can read them.
    wanted_roles = set()
    for r in kept:
        props = r.properties or {}
        for key in ("Role", "roleArn"):
            if props.get(key):
                wanted_roles.add(props[key])
    role_pass = [r for r in dropped if r.physical_id in wanted_roles and not selected.has_resource(r.physical_id or "")]
    if role_pass:
        for r in role_pass:
            selected.add_resource(r)
        hydrate_subset(target_regions[0], role_pass)
        pulled = {id(r) for r in role_pass}
        dropped = [r for r in dropped if id(r) not in pulled]

    # Who deployed each resource: tags, then the stack that built it, then any
    # state files the operator pointed at. Recorded on the resource, so it
    # reaches the canvas and, with --adopt, the deployment state.
    provenance_counts = _attach_provenance(
        scanner.session, target_regions[0], selected.get_all_resources(), terraform_states, pulumi_states, emitter,
    )

    result = ProjectEmitter(
        scanned_state=selected,
        project_name=project_name,
        environment=environment,
        account=credentials.account_id,
        region=target_regions[0],
        regions=account_inventory.region_summary(),
        lambda_as=lambda_as,
        include_env_values=include_env_values,
    ).emit()
    payload = result.payload
    payload["counts"]["excluded"] = len(dropped)
    payload["adopted"] = None
    payload["provenance"] = provenance_counts

    if adopt:
        # Local state only; never touches AWS. Keyed by the same path deploy
        # uses, so the next deploy sees these as already existing.
        state_path = get_state_path(environment, project_name)
        state_manager = StateManager(str(state_path))
        if not state_manager.exists():
            state_manager.initialize(
                environment=environment,
                region=target_regions[0],
                account=credentials.account_id,
                project_name=project_name,
            )
        adopter = ResourceAdopter(state_manager)
        plan = adopter.plan(selected)
        payload["adopted"] = adopter.apply(plan) if not plan.is_empty() else 0
        payload["state_path"] = str(state_path)
        conflicts = plan.conflicts()
        if conflicts:
            payload["notes"].append({
                "level": "warning", "physical_id": "(adopt)",
                "message": f"{len(conflicts)} resource(s) could not be adopted because another "
                           f"resource already holds their logical id",
            })

    if stream_progress:
        click.echo(json.dumps({"event": RESULT, "data": payload}, default=str, separators=(",", ":")))
        return
    if as_json:
        click.echo(json.dumps(payload, indent=2, default=str))
        return

    console.print(
        f"[green]{payload['counts']['shown']}[/green] of {payload['counts']['included']} included "
        f"resource(s) can be shown on the canvas, {payload['counts']['connections']} connection(s); "
        f"{payload['counts']['excluded']} excluded by pattern."
    )
    if payload["skipped"]:
        table = Table(title="Not representable on the canvas")
        table.add_column("Type", style="cyan")
        table.add_column("Count", justify="right")
        for rtype, count in payload["skipped"].items():
            table.add_row(rtype, str(count))
        console.print(table)
    if payload["adopted"] is not None:
        console.print(f"Adopted [green]{payload['adopted']}[/green] resource(s) into {payload['state_path']}")
    for note in result.notes:
        if note.level == "warning":
            console.print(f"  [yellow]{note.physical_id}[/yellow] {note.message}")


@discover.command("regions")
@click.option("--region", help="Region used to ask; any enabled one works")
@click.option("--json", "as_json", is_flag=True, help="Emit JSON instead of a table")
@click.pass_context
def regions_command(ctx, region, as_json):
    """List the regions this account has enabled."""
    scanner, credentials, resolved_region = _scanner(ctx, region, "discovered", "dev")
    names = enabled_regions(scanner.session, seed_region=resolved_region)

    if as_json:
        click.echo(json.dumps(names))
        return

    table = Table(title=f"Enabled regions - {credentials.account_id}")
    table.add_column("Region", style="cyan")
    for name in names:
        table.add_row(name)
    console.print(table)
