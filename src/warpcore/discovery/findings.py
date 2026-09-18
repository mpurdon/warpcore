"""What is wrong, or wasteful, or fragile in an account, judged from what it
is actually doing.

A finding is a fact-backed claim about one or more resources: an instance
that has been idle for a day, a NAT gateway nobody sends traffic through, a
port open to the world on a host the bastion already reaches. Every finding
carries its evidence, so the canvas can answer "why" without a model.

Two layers. The rules here are deterministic and run on their own. A model,
when one is configured, ranks the findings for this account and writes the
sentence a template cannot; it never invents a finding, and when it is
absent or fails, the rules' output stands unchanged.
"""

import json
import re
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import boto3
import yaml

from warpcore.monitoring.usage import ResourceUsage, ResourceUsageReader
from warpcore.utils.arn import resource_type_from_arn
from warpcore.utils.logging import get_logger

logger = get_logger(__name__)

Severity = str   # high | medium | low
Kind = str       # cost | security | reliability | operability


# What acting on a finding costs the operator, in the order a person would
# rank them: a rule change, a config change, a restart, or code.
Effort = str     # none | config | restart | code


@dataclass
class Finding:
    id: str
    kind: Kind
    severity: Severity
    title: str
    detail: str
    arns: List[str] = field(default_factory=list)
    evidence: Dict[str, Any] = field(default_factory=dict)
    suggestion: str = ""
    effort: Effort = "config"
    """Monthly dollars the fix returns, only when it follows from a known rate; else None."""
    savings_usd_month: Optional[float] = None
    # Every rule is advisory: a finding informs, it never blocks a deploy.
    level: str = "advisory"
    # open, or muted by the operator with a reason (.warpcore/findings-mutes.yaml).
    status: str = "open"
    mute_reason: Optional[str] = None
    # Filled by the model, when there is one.
    why: Optional[str] = None
    rank: Optional[int] = None

    def to_dict(self) -> Dict[str, Any]:
        from dataclasses import asdict
        return asdict(self)


@dataclass
class Group:
    """One resource and everything found about it: one card, traits attached."""

    arn: str
    node_id: Optional[str]
    name: str
    type: Optional[str]
    severity: Severity
    finding_ids: List[str] = field(default_factory=list)
    savings_usd_month: Optional[float] = None
    """The least effort among the open findings: what the cheapest first step is."""
    effort: Effort = "config"


@dataclass
class Review:
    window_hours: int
    findings: List[Finding] = field(default_factory=list)
    groups: List[Group] = field(default_factory=list)
    summary: Optional[str] = None
    model: Optional[str] = None
    notes: List[str] = field(default_factory=list)
    errors: Dict[str, str] = field(default_factory=dict)

    def open(self) -> List[Finding]:
        return [f for f in self.findings if f.status == "open"]

    def to_dict(self) -> Dict[str, Any]:
        return {
            "window_hours": self.window_hours,
            "findings": [f.to_dict() for f in self.findings],
            "groups": [g.__dict__ for g in self.groups],
            "summary": self.summary,
            "model": self.model,
            "notes": self.notes,
            "errors": self.errors,
        }


# --------------------------------------------------------------- the rules

# Thresholds. Named so the sentence and the number agree.
IDLE_CPU_MAX = 5.0          # percent, peak over the window
IDLE_CPU_AVG = 2.0          # percent, average over the window
QUIET_BYTES = 1_000_000     # a NAT gateway or host moving less than this in the window is quiet
OLD_SNAPSHOT_DAYS = 90
NAT_MONTHLY_USD = 32.0      # hourly rate alone, us-east-1
EIP_MONTHLY_USD = 3.6       # an unattached address
GP2_USD_PER_GIB_MONTH = 0.10
SNAPSHOT_USD_PER_GIB_MONTH = 0.05


def _gib(detail: Any) -> float:
    """The size in a folded volume's detail ("8 GiB · gp2"), else 0."""
    m = re.match(r"\s*(\d+(?:\.\d+)?)\s*GiB", str(detail or ""))
    return float(m.group(1)) if m else 0.0


# --------------------------------------------------------------- mutes

MUTES_FILE = ".warpcore/findings-mutes.yaml"


def read_mutes(project_dir: Optional[Path]) -> Dict[str, Dict[str, Any]]:
    """Finding id -> {reason, at}. A file the team can version."""
    if not project_dir:
        return {}
    path = Path(project_dir) / MUTES_FILE
    if not path.exists():
        return {}
    try:
        data = yaml.safe_load(path.read_text()) or {}
    except yaml.YAMLError:
        return {}
    out: Dict[str, Dict[str, Any]] = {}
    for item in data.get("mutes") or []:
        if isinstance(item, dict) and item.get("id"):
            out[str(item["id"])] = {"reason": str(item.get("reason") or ""), "at": item.get("at")}
    return out


def write_mute(project_dir: Path, finding_id: str, reason: str) -> None:
    mutes = read_mutes(project_dir)
    mutes[finding_id] = {"reason": reason, "at": datetime.now(timezone.utc).isoformat(timespec="seconds")}
    _save_mutes(project_dir, mutes)


def remove_mute(project_dir: Path, finding_id: str) -> bool:
    mutes = read_mutes(project_dir)
    if finding_id not in mutes:
        return False
    del mutes[finding_id]
    _save_mutes(project_dir, mutes)
    return True


def _save_mutes(project_dir: Path, mutes: Dict[str, Dict[str, Any]]) -> None:
    path = Path(project_dir) / MUTES_FILE
    path.parent.mkdir(parents=True, exist_ok=True)
    body = {"mutes": [{"id": k, **v} for k, v in sorted(mutes.items())]}
    path.write_text("# Findings this team has decided not to act on, each with its reason.\n# Written by `warpcore discover mute`; safe to edit and commit.\n" + yaml.safe_dump(body, sort_keys=False))


def _metric(usage: Optional[ResourceUsage], name: str, statistic: str) -> Optional[Dict[str, Any]]:
    if not usage:
        return None
    for m in usage.metrics:
        if m.name == name and m.statistic == statistic and m.datapoints:
            return {"average": m.average, "maximum": m.maximum, "total": m.total, "latest": m.latest}
    return None


def _label(node: Dict[str, Any]) -> str:
    return str(node.get("label") or (node.get("config") or {}).get("name") or node.get("id"))


def review_instance(node: Dict[str, Any], usage: Optional[ResourceUsage], hours: int,
                    open_ports: Dict[str, List[str]]) -> List[Finding]:
    """Findings for one EC2 instance from its canvas config, its metrics and
    the security groups' open ports (group id -> port descriptions)."""
    out: List[Finding] = []
    cfg = node.get("config") or {}
    arn = node.get("arn") or ""
    name = _label(node)
    state = cfg.get("state")
    meta = node.get("meta") or {}
    groups = meta.get("securityGroups") or []
    attachments = meta.get("attachments") or []
    volumes = [a for a in attachments if a.get("type") == "ebs-volume"]

    if state == "stopped":
        out.append(Finding(
            id=f"stopped:{node['id']}", kind="cost", severity="low",
            title=f"{name} is stopped",
            detail=f"A stopped {cfg.get('instanceType', 'instance')} costs nothing to run, but its "
                   f"{len(volumes) or 'attached'} volume{'s' if len(volumes) != 1 else ''} still bill every month.",
            arns=[arn], evidence={"state": state, "instanceType": cfg.get("instanceType"), "volumes": [a.get("detail") for a in volumes]},
            suggestion="Terminate it and snapshot the volumes if it is not coming back; start it if it is.",
            effort="none", savings_usd_month=round(sum(_gib(a.get("detail")) for a in volumes) * GP2_USD_PER_GIB_MONTH, 2) if volumes else None,
        ))

    cpu_avg = _metric(usage, "CPUUtilization", "Average")
    cpu_max = _metric(usage, "CPUUtilization", "Maximum")
    net_in = _metric(usage, "NetworkIn", "Sum")
    net_out = _metric(usage, "NetworkOut", "Sum")
    if state == "running" and cpu_max and cpu_avg and (cpu_max["maximum"] or 0) < IDLE_CPU_MAX and (cpu_avg["average"] or 0) < IDLE_CPU_AVG:
        out.append(Finding(
            id=f"idle:{node['id']}", kind="cost", severity="medium",
            title=f"{name} is idle",
            detail=f"CPU peaked at {cpu_max['maximum']:.1f}% and averaged {cpu_avg['average']:.1f}% over {hours}h on a {cfg.get('instanceType', 'instance')}.",
            arns=[arn],
            evidence={"cpuPeak": cpu_max["maximum"], "cpuAverage": cpu_avg["average"],
                      "networkInBytes": (net_in or {}).get("total"), "networkOutBytes": (net_out or {}).get("total"),
                      "instanceType": cfg.get("instanceType"), "windowHours": hours},
            suggestion="Move to a smaller instance type, schedule it off when unused, or stop it if nothing depends on it.",
            effort="restart",
        ))

    status = _metric(usage, "StatusCheckFailed", "Maximum")
    if status and (status["maximum"] or 0) > 0:
        out.append(Finding(
            id=f"status:{node['id']}", kind="reliability", severity="high",
            title=f"{name} failed a status check",
            detail=f"StatusCheckFailed reached {status['maximum']:.0f} in the last {hours}h; the instance or its host had a problem.",
            arns=[arn], evidence={"statusCheckFailedMax": status["maximum"], "windowHours": hours},
            suggestion="Check the system log and consider a reboot or a stop/start to move hosts.",
            effort="restart",
        ))

    if state == "running" and not cfg.get("instanceProfile"):
        out.append(Finding(
            id=f"no-ssm:{node['id']}", kind="operability", severity="low",
            title=f"{name} cannot be reached by Session Manager",
            detail="It has no instance profile, so the SSM agent cannot register. The only way in is a key pair through an open port.",
            arns=[arn], evidence={"instanceProfile": None, "keyName": cfg.get("keyName")},
            suggestion="Attach an instance profile with AmazonSSMManagedInstanceCore; then close port 22 to the world.",
            effort="config",
        ))

    if state == "running" and cfg.get("imdsv2") is False:
        out.append(Finding(
            id=f"imdsv1:{node['id']}", kind="security", severity="low",
            title=f"{name} allows IMDSv1",
            detail="The instance metadata service accepts unsigned requests, which is how credentials leak through SSRF.",
            arns=[arn], evidence={"httpTokens": "optional"},
            suggestion="Require IMDSv2 (HttpTokens=required) on the instance.",
            effort="config",
        ))

    # Ports open to the world on this host's groups, weighed against traffic.
    exposed: List[str] = []
    for g in groups:
        exposed += open_ports.get(g.get("id") or "", [])
    if exposed and state == "running":
        quiet = net_in is not None and (net_in.get("total") or 0) < QUIET_BYTES
        out.append(Finding(
            id=f"exposed:{node['id']}", kind="security", severity="high" if cfg.get("publicIp") else "medium",
            title=f"{name} admits the internet on {', '.join(sorted(set(exposed)))}",
            detail=(f"Its security group{'s' if len(groups) > 1 else ''} open {', '.join(sorted(set(exposed)))} to 0.0.0.0/0"
                    + (f" and the host has a public address ({cfg.get('publicIp')})." if cfg.get("publicIp") else ", though the host has no public address.")
                    + (f" It received {_fmt_bytes(net_in['total'])} in {hours}h, so little or nothing is using those ports." if quiet and net_in else "")),
            arns=[arn] + [g.get("arn") for g in groups if g.get("arn")],
            evidence={"ports": sorted(set(exposed)), "publicIp": cfg.get("publicIp"), "networkInBytes": (net_in or {}).get("total"), "windowHours": hours},
            suggestion="Restrict the rules to the addresses or groups that need them; a bastion or Session Manager covers admin access.",
            effort="none",
        ))

    return out


def review_security_group(node: Dict[str, Any]) -> List[Finding]:
    cfg = node.get("config") or {}
    if not cfg.get("openToWorld") or not cfg.get("memberCount"):
        return []
    rules = [r for r in cfg.get("inboundRules") or [] if "0.0.0.0/0" in r or "::/0" in r]
    if cfg.get("isDefault"):
        return [Finding(
            id=f"default-open:{node['id']}", kind="security", severity="high",
            title=f"The default security group admits the internet and has {cfg['memberCount']} member{'s' if cfg['memberCount'] != 1 else ''}",
            detail="; ".join(rules) or "Open inbound rules on the default group.",
            arns=[node.get("arn") or ""], evidence={"rules": rules, "members": cfg["memberCount"]},
            suggestion="Move the members to a purpose-built group and empty the default group's rules.",
            effort="config",
        )]
    return []


def review_nat_gateway(node: Dict[str, Any], usage: Optional[ResourceUsage], hours: int) -> List[Finding]:
    out_bytes = _metric(usage, "BytesOutToDestination", "Sum")
    if not out_bytes:
        return []
    total = out_bytes.get("total") or 0
    if total >= QUIET_BYTES:
        return []
    return [Finding(
        id=f"quiet-nat:{node['id']}", kind="cost", severity="medium",
        title=f"{_label(node)} carried {_fmt_bytes(total)} in {hours}h",
        detail=f"A NAT gateway bills about ${NAT_MONTHLY_USD:.0f} a month before traffic; this one moved almost nothing outbound.",
        arns=[node.get("arn") or ""], evidence={"bytesOut": total, "windowHours": hours, "monthlyUsd": NAT_MONTHLY_USD},
        suggestion="If the private subnets behind it do not need egress, delete it; if two gateways serve one workload, one may do.",
        effort="config", savings_usd_month=NAT_MONTHLY_USD,
    )]


def review_elastic_ip(node: Dict[str, Any]) -> List[Finding]:
    # An address that folded into an instance or NAT gateway is not a node
    # on the canvas; the ones that are here are unattached.
    if node.get("parent") and str(node.get("parent")).startswith(("ec2-instance", "nat-gateway")):
        return []
    return [Finding(
        id=f"loose-eip:{node['id']}", kind="cost", severity="low",
        title=f"Elastic IP {_label(node)} is not attached to anything",
        detail=f"An unattached address bills about ${EIP_MONTHLY_USD:.2f} a month and serves nothing.",
        arns=[node.get("arn") or ""], evidence={"monthlyUsd": EIP_MONTHLY_USD},
        suggestion="Release it, or attach it to the instance it was reserved for.",
        effort="none", savings_usd_month=EIP_MONTHLY_USD,
    )]


def review_snapshot(node: Dict[str, Any], today: Optional[datetime] = None) -> List[Finding]:
    cfg = node.get("config") or {}
    taken = cfg.get("taken")
    if not taken:
        return []
    try:
        when = datetime.fromisoformat(str(taken)[:10]).replace(tzinfo=timezone.utc)
    except ValueError:
        return []
    age = ((today or datetime.now(timezone.utc)) - when).days
    if age < OLD_SNAPSHOT_DAYS:
        return []
    return [Finding(
        id=f"old-snapshot:{node['id']}", kind="cost", severity="low",
        title=f"Snapshot {_label(node)} is {age} days old",
        detail=f"{cfg.get('size', '?')} GiB taken {taken}" + (f": {cfg['description']}" if cfg.get("description") else "") + ".",
        arns=[node.get("arn") or ""], evidence={"ageDays": age, "sizeGiB": cfg.get("size"), "taken": taken},
        suggestion="Delete it if the volume it protected is gone or has a newer snapshot.",
        effort="none", savings_usd_month=round(float(cfg.get("size") or 0) * SNAPSHOT_USD_PER_GIB_MONTH, 2) if cfg.get("size") else None,
    )]


def review_log_group(node: Dict[str, Any]) -> List[Finding]:
    cfg = node.get("config") or {}
    if cfg.get("retentionDays"):
        return []
    return [Finding(
        id=f"no-retention:{node['id']}", kind="cost", severity="low",
        title=f"Log group {_label(node)} never expires",
        detail="Without a retention policy, every line ever written is stored and billed forever.",
        arns=[node.get("arn") or ""], evidence={"storedBytes": cfg.get("storedBytes")},
        suggestion="Set a retention of 30 to 90 days unless the logs are evidence.",
        effort="config",
    )]


def review_lambda(node: Dict[str, Any], usage: Optional[ResourceUsage], hours: int) -> List[Finding]:
    out: List[Finding] = []
    errors = _metric(usage, "Errors", "Sum")
    invocations = _metric(usage, "Invocations", "Sum")
    if errors and (errors.get("total") or 0) > 0:
        total_invocations = (invocations or {}).get("total")
        rate = (errors["total"] / total_invocations * 100) if total_invocations else None
        out.append(Finding(
            id=f"errors:{node['id']}", kind="reliability", severity="high" if (rate or 0) >= 5 else "medium",
            title=f"{_label(node)} failed {errors['total']:.0f} time{'s' if errors['total'] != 1 else ''} in {hours}h",
            detail=(f"{rate:.1f}% of {invocations['total']:.0f} invocations errored." if rate is not None else "Errors were recorded."),
            arns=[node.get("arn") or ""], evidence={"errors": errors["total"], "invocations": (invocations or {}).get("total"), "windowHours": hours},
            suggestion="Read the recent errors in the Live section's logs; a dead-letter queue keeps failed events.",
            effort="code",
        ))
    throttles = _metric(usage, "Throttles", "Sum")
    if throttles and (throttles.get("total") or 0) > 0:
        out.append(Finding(
            id=f"throttled:{node['id']}", kind="reliability", severity="medium",
            title=f"{_label(node)} was throttled {throttles['total']:.0f} time{'s' if throttles['total'] != 1 else ''}",
            detail="Invocations were refused for lack of concurrency.",
            arns=[node.get("arn") or ""], evidence={"throttles": throttles["total"], "windowHours": hours},
            suggestion="Raise reserved concurrency, or smooth the source with a queue.",
            effort="config",
        ))
    return out


def review_rds(node: Dict[str, Any], usage: Optional[ResourceUsage], hours: int) -> List[Finding]:
    out: List[Finding] = []
    conns = _metric(usage, "DatabaseConnections", "Maximum")
    if conns and (conns.get("maximum") or 0) == 0:
        out.append(Finding(
            id=f"no-connections:{node['id']}", kind="cost", severity="medium",
            title=f"{_label(node)} had no connections in {hours}h",
            detail="Nothing connected to the database over the window.",
            arns=[node.get("arn") or ""], evidence={"connectionsMax": 0, "windowHours": hours},
            suggestion="Stop it (up to seven days at a time) or snapshot and delete it.",
            effort="none",
        ))
    storage = _metric(usage, "FreeStorageSpace", "Minimum")
    if storage and storage.get("latest") is not None and storage["latest"] < 2 * 1024 ** 3:
        out.append(Finding(
            id=f"low-storage:{node['id']}", kind="reliability", severity="high",
            title=f"{_label(node)} has {_fmt_bytes(storage['latest'])} of storage left",
            detail="A database that runs out of storage stops accepting writes.",
            arns=[node.get("arn") or ""], evidence={"freeStorageBytes": storage["latest"]},
            suggestion="Enable storage autoscaling or grow the allocated storage.",
            effort="config",
        ))
    return out


def _fmt_bytes(n: Optional[float]) -> str:
    if n is None:
        return "?"
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if n < 1024:
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1024
    return f"{n:.1f} PB"


# --------------------------------------------------------------- the review

# Canvas types whose metrics the rules read.
_METERED = {"ec2-instance", "nat-gateway", "agent", "lambda", "rds-instance"}
_AWS_TYPE = {
    "ec2-instance": "AWS::EC2::Instance", "nat-gateway": "AWS::EC2::NatGateway",
    "agent": "AWS::Lambda::Function", "lambda": "AWS::Lambda::Function", "rds-instance": "AWS::RDS::DBInstance",
}


def open_ports_by_group(nodes: List[Dict[str, Any]]) -> Dict[str, List[str]]:
    """Security group node id -> the ports its rules open to the world."""
    out: Dict[str, List[str]] = {}
    for n in nodes:
        if n.get("type") != "security-group":
            continue
        cfg = n.get("config") or {}
        ports: List[str] = []
        for rule in cfg.get("inboundRules") or []:
            if "0.0.0.0/0" not in rule and "::/0" not in rule:
                continue
            m = re.match(r"(\w+)\s+(\S+)\s+from", rule)
            ports.append(f"{m.group(1)} {m.group(2)}" if m else rule)
        if ports:
            out[n["id"]] = ports
    return out


def review_nodes(nodes: List[Dict[str, Any]], usage_by_arn: Dict[str, ResourceUsage], hours: int) -> List[Finding]:
    """The rules over a canvas: pure, given the metrics already read."""
    findings: List[Finding] = []
    open_ports = open_ports_by_group(nodes)
    for n in nodes:
        if n.get("hidden") and n.get("type") != "security-group":
            continue
        t = n.get("type")
        usage = usage_by_arn.get(n.get("arn") or "")
        if t == "ec2-instance":
            findings += review_instance(n, usage, hours, open_ports)
        elif t == "security-group":
            findings += review_security_group(n)
        elif t == "nat-gateway":
            findings += review_nat_gateway(n, usage, hours)
        elif t == "elastic-ip":
            findings += review_elastic_ip(n)
        elif t == "ebs-snapshot":
            findings += review_snapshot(n)
        elif t == "log-group":
            findings += review_log_group(n)
        elif t in ("agent", "lambda"):
            findings += review_lambda(n, usage, hours)
        elif t == "rds-instance":
            findings += review_rds(n, usage, hours)
    order = {"high": 0, "medium": 1, "low": 2}
    findings.sort(key=lambda f: (order.get(f.severity, 3), f.kind, f.title))
    return findings


def apply_mutes(review: Review, mutes: Dict[str, Dict[str, Any]]) -> None:
    """Mark muted findings; they stay in the list, out of the counts and the ranking."""
    for f in review.findings:
        m = mutes.get(f.id)
        if m:
            f.status = "muted"
            f.mute_reason = m.get("reason") or "muted"


_EFFORT_RANK = {"none": 0, "config": 1, "restart": 2, "code": 3}
_SEV_RANK = {"high": 0, "medium": 1, "low": 2}


def group_by_resource(findings: List[Finding], nodes: List[Dict[str, Any]]) -> List[Group]:
    """One group per resource, from its open findings: the card the drawer
    shows, with the findings as traits rather than as separate alerts.
    Overlapping savings are counted once per resource (the larger)."""
    by_arn = {n.get("arn"): n for n in nodes if n.get("arn")}
    groups: Dict[str, Group] = {}
    for f in findings:
        if f.status != "open" or not f.arns:
            continue
        arn = f.arns[0]
        node = by_arn.get(arn)
        g = groups.get(arn)
        if g is None:
            g = Group(arn=arn, node_id=node.get("id") if node else None, name=_label(node) if node else arn.rsplit("/", 1)[-1],
                      type=node.get("type") if node else None, severity=f.severity, effort=f.effort)
            groups[arn] = g
        g.finding_ids.append(f.id)
        if _SEV_RANK.get(f.severity, 9) < _SEV_RANK.get(g.severity, 9):
            g.severity = f.severity
        if _EFFORT_RANK.get(f.effort, 9) < _EFFORT_RANK.get(g.effort, 9):
            g.effort = f.effort
        if f.savings_usd_month is not None:
            g.savings_usd_month = max(g.savings_usd_month or 0.0, f.savings_usd_month)
    return sorted(groups.values(), key=lambda g: (_SEV_RANK.get(g.severity, 9), -(g.savings_usd_month or 0), g.name))


class ProjectReviewer:
    """Reads the metrics a review needs, runs the rules, and asks the model to rank."""

    def __init__(self, session: boto3.Session, region: str, llm: Any = None, parallelism: int = 6,
                 project_dir: Optional[Path] = None):
        self.session = session
        self.region = region
        self.llm = llm
        self.parallelism = parallelism
        self.project_dir = project_dir

    def review(self, nodes: List[Dict[str, Any]], hours: int = 24) -> Review:
        review = Review(window_hours=hours)
        metered = [n for n in nodes if n.get("type") in _METERED and n.get("arn") and not n.get("hidden")]
        usage_by_arn: Dict[str, ResourceUsage] = {}

        def read(n: Dict[str, Any]) -> Tuple[str, Optional[ResourceUsage], Optional[str]]:
            arn = n["arn"]
            region = arn.split(":")[3] or self.region
            try:
                aws_type = _AWS_TYPE.get(n["type"]) or resource_type_from_arn(arn)
                return arn, ResourceUsageReader(self.session, region).read(n["id"], aws_type, arn, window_hours=hours), None
            except Exception as e:  # noqa: BLE001 - one resource's failure is a note, not the end
                return arn, None, str(e)

        with ThreadPoolExecutor(max_workers=max(1, self.parallelism)) as pool:
            for arn, usage, err in pool.map(read, metered):
                if usage:
                    usage_by_arn[arn] = usage
                if err:
                    review.errors[arn] = err

        review.findings = review_nodes(nodes, usage_by_arn, hours)
        apply_mutes(review, read_mutes(self.project_dir))
        review.groups = group_by_resource(review.findings, nodes)
        if not review.findings:
            review.notes.append("Nothing stood out in the rules' review.")
        elif not review.open():
            review.notes.append("Everything found is muted.")
        if self.llm is not None and review.open():
            self._rank_with_model(review, nodes)
        return review

    # ------------------------------------------------------------ the model

    def _rank_with_model(self, review: Review, nodes: List[Dict[str, Any]]) -> None:
        """Ask the model to order the findings for this account and say why each matters here."""
        summary_nodes = [
            {"id": n["id"], "type": n.get("type"), "name": _label(n),
             **({"application": (n.get("meta") or {}).get("application", {}).get("name")} if (n.get("meta") or {}).get("application") else {})}
            for n in nodes if not n.get("hidden") and n.get("type") not in ("application", "band")
        ]
        prompt = (
            "You are reviewing one AWS account for its operator. Below are the resources on their canvas and a list of "
            "findings produced by deterministic rules, each with its evidence. Do not add findings and do not drop any. "
            "Rank them for this account: what should the operator look at first, given how the resources relate. "
            "For each finding write one or two plain sentences saying why it matters here, referring to other resources "
            "by name where that is the point (for example a port open to the world on a host that a bastion already reaches). "
            "Then write a two-sentence summary of the account's state.\n\n"
            "Answer with JSON only, no prose around it, in this shape:\n"
            '{"summary": "...", "findings": [{"id": "<finding id>", "rank": 1, "why": "..."}, ...]}\n\n'
            f"Resources:\n{json.dumps(summary_nodes, separators=(',', ':'))}\n\n"
            f"Findings:\n{json.dumps([f.to_dict() for f in review.open()], separators=(',', ':'), default=str)}\n"
        )
        try:
            raw = self.llm._call_llm(prompt)  # noqa: SLF001 - the client's one provider-agnostic entry point
            parsed = _parse_json(raw)
        except Exception as e:  # noqa: BLE001 - the rules' output stands
            review.errors["model"] = str(e)
            return
        by_id = {f.id: f for f in review.findings}
        ranked = parsed.get("findings") or []
        for item in ranked:
            f = by_id.get(item.get("id"))
            if f is None:
                continue
            f.rank = item.get("rank")
            f.why = item.get("why")
        if any(f.rank is not None for f in review.findings):
            review.findings.sort(key=lambda f: (f.rank is None, f.rank or 0))
        review.summary = parsed.get("summary")
        review.model = getattr(self.llm, "model", None)


def _parse_json(text: str) -> Dict[str, Any]:
    """The model's JSON, tolerant of a code fence around it."""
    stripped = text.strip()
    fence = re.match(r"^```(?:json)?\s*(.*?)\s*```$", stripped, re.S)
    if fence:
        stripped = fence.group(1)
    start = stripped.find("{")
    end = stripped.rfind("}")
    if start == -1 or end == -1:
        raise ValueError("no JSON object in the model's reply")
    return json.loads(stripped[start:end + 1])
