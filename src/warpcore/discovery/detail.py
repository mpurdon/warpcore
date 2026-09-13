"""Everything about one resource, from its ARN.

This is the drill-in behind `warpcore discover detail` and the GUI's resource
panel. It needs no state file: the ARN alone identifies the resource, and each
section is fetched live.

Sections are produced by per-type enrichers. Each is failure-isolated - a
denied CloudWatch call must not hide the security group rules that did load -
so a section that could not be read reports why, rather than the whole detail
failing.
"""

from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional

import boto3
from botocore.exceptions import BotoCoreError, ClientError

from warpcore.agentic.scanner import AWSScanner, _json_safe
from warpcore.monitoring.usage import ResourceUsage, ResourceUsageReader
from warpcore.utils.arn import parse_arn, resource_type_from_arn, service_identifier
from warpcore.utils.boto import discovery_client
from warpcore.utils.logging import get_logger

logger = get_logger(__name__)


@dataclass
class Related:
    """Another resource this one is connected to."""

    relation: str          # "attached-volume", "security-group", "subnet", ...
    arn: str
    type: str
    name: str = ""
    detail: str = ""


@dataclass
class LogEvent:
    timestamp: str
    message: str
    stream: str = ""


@dataclass
class LogGroupSummary:
    name: str
    arn: str = ""
    stored_bytes: int = 0
    retention_days: Optional[int] = None
    recent_events: List[LogEvent] = field(default_factory=list)


@dataclass
class SecurityGroupRule:
    direction: str         # "ingress" | "egress"
    protocol: str
    from_port: Optional[int]
    to_port: Optional[int]
    source: str            # CIDR, prefix list, or another SG
    description: str = ""


@dataclass
class NetworkDetail:
    vpc_id: Optional[str] = None
    subnet_id: Optional[str] = None
    availability_zone: Optional[str] = None
    private_ips: List[str] = field(default_factory=list)
    public_ips: List[str] = field(default_factory=list)
    security_groups: List[Dict[str, Any]] = field(default_factory=list)
    rules: List[SecurityGroupRule] = field(default_factory=list)
    interfaces: List[Dict[str, Any]] = field(default_factory=list)
    flow_logs: List[Dict[str, Any]] = field(default_factory=list)
    routes: List[Dict[str, Any]] = field(default_factory=list)
    notes: List[str] = field(default_factory=list)


@dataclass
class ResourceDetail:
    arn: str
    type: str
    region: str
    name: str
    tags: Dict[str, str] = field(default_factory=dict)
    configuration: Dict[str, Any] = field(default_factory=dict)
    metrics: Optional[ResourceUsage] = None
    logs: List[LogGroupSummary] = field(default_factory=list)
    network: Optional[NetworkDetail] = None
    related: List[Related] = field(default_factory=list)
    cost_hint: Optional[str] = None
    # What the service says about the resource's state right now, in the
    # same terms the import used, so the canvas can compare then and now.
    health: Optional[Dict[str, str]] = None
    notes: List[str] = field(default_factory=list)
    errors: Dict[str, str] = field(default_factory=dict)   # section -> why

    def to_dict(self) -> Dict[str, Any]:
        """JSON-ready form, for the CLI's --json and the GUI."""
        from dataclasses import asdict

        payload = asdict(self)
        if self.metrics is not None:
            payload["metrics"] = {
                "window_hours": self.metrics.window_hours,
                "series": [
                    {"name": m.name, "statistic": m.statistic, "unit": m.unit,
                     "total": m.total, "average": m.average, "maximum": m.maximum,
                     "latest": m.latest, "datapoints": m.datapoints, "error": m.error,
                     "points": [{"t": t, "v": v} for t, v in m.points]}
                    for m in self.metrics.metrics
                ],
                "notes": self.metrics.notes,
            }
        return _json_safe(payload)


class ResourceDetailReader:
    """Builds a ResourceDetail for an ARN."""

    def __init__(self, boto_session: boto3.Session, region: str):
        self.session = boto_session
        self.region = region
        self.logger = get_logger(__name__)

    # ------------------------------------------------------------- entry

    def read(
        self,
        arn: str,
        window_hours: int = 24,
        include_metrics: bool = True,
        include_logs: bool = True,
        tags: Optional[Dict[str, str]] = None,
    ) -> ResourceDetail:
        parsed = parse_arn(arn)
        region = (parsed.region if parsed and parsed.region else None) or self.region
        resource_type = resource_type_from_arn(arn)
        identifier = service_identifier(arn)

        detail = ResourceDetail(
            arn=arn, type=resource_type, region=region,
            name=(tags or {}).get("Name") or identifier, tags=dict(tags or {}),
        )

        self._section(detail, "configuration", lambda: self._configuration(detail, resource_type, arn))
        if detail.configuration:
            from warpcore.discovery.project_emitter import resource_health
            detail.health = resource_health(resource_type, detail.configuration)
        if not detail.tags:
            self._section(detail, "tags", lambda: self._tags(detail))

        enricher = self._ENRICHERS.get(resource_type)
        if enricher:
            self._section(detail, "network", lambda: enricher(self, detail))
        else:
            detail.notes.append(f"No network/relationship enricher for {resource_type} yet")

        if include_metrics:
            self._section(detail, "metrics", lambda: self._metrics(detail, window_hours))
        if include_logs:
            self._section(detail, "logs", lambda: self._logs(detail, window_hours))

        self._cost_hint(detail)
        return detail

    def _section(self, detail: ResourceDetail, name: str, fn) -> None:
        """Run one section, recording rather than raising on failure."""
        try:
            fn()
        except (ClientError, BotoCoreError) as e:
            code = getattr(e, "response", {}).get("Error", {}).get("Code", type(e).__name__)
            detail.errors[name] = f"{code}: {e}"
        except Exception as e:  # noqa: BLE001 - one section must not sink the rest
            detail.errors[name] = f"{type(e).__name__}: {e}"

    # ---------------------------------------------------------- sections

    def _configuration(self, detail: ResourceDetail, resource_type: str, arn: str) -> None:
        scanner = AWSScanner(self.session, "", "", detail.region)
        config = scanner.get_resource_details(resource_type, arn)
        if config is None:
            detail.notes.append(f"No configuration reader for {resource_type} yet")
            return
        detail.configuration = _json_safe(config)
        # Most describe_* responses carry tags; lift them if we have none.
        if not detail.tags:
            raw = config.get("Tags") or config.get("tags") or []
            if isinstance(raw, list):
                detail.tags = {t.get("Key"): t.get("Value", "") for t in raw if t.get("Key")}
            elif isinstance(raw, dict):
                detail.tags = dict(raw)
            if detail.tags.get("Name"):
                detail.name = detail.tags["Name"]

    def _tags(self, detail: ResourceDetail) -> None:
        client = discovery_client(self.session, "resourcegroupstaggingapi", detail.region)
        response = client.get_resources(ResourceARNList=[detail.arn])
        for entry in response.get("ResourceTagMappingList", []):
            detail.tags = {t["Key"]: t["Value"] for t in entry.get("Tags", [])}
        if detail.tags.get("Name"):
            detail.name = detail.tags["Name"]

    def _metrics(self, detail: ResourceDetail, window_hours: int) -> None:
        reader = ResourceUsageReader(self.session, detail.region)
        detail.metrics = reader.read(
            resource_id=detail.name, resource_type=detail.type,
            physical_id=detail.arn, window_hours=window_hours,
        )

    def _logs(self, detail: ResourceDetail, window_hours: int) -> None:
        """Log groups that plausibly belong to this resource.

        Only Lambda has a deterministic group name. For everything else the
        best available heuristic is a group whose name contains the resource's
        id or name - which is how the CloudWatch agent and most people name
        them.
        """
        logs = discovery_client(self.session, "logs", detail.region)
        identifier = service_identifier(detail.arn)

        candidates: List[str] = []
        if detail.type == "AWS::Lambda::Function":
            candidates.append(f"/aws/lambda/{identifier}")
        elif detail.type == "AWS::Logs::LogGroup":
            candidates.append(identifier)
        else:
            needles = {identifier, detail.name}
            for page in logs.get_paginator("describe_log_groups").paginate():
                for group in page.get("logGroups", []):
                    name = group["logGroupName"]
                    if any(n and n in name for n in needles):
                        candidates.append(name)
            candidates = candidates[:5]

        if not candidates:
            detail.notes.append("No CloudWatch log group appears to belong to this resource")
            return

        start_ms = int((datetime.utcnow() - timedelta(hours=window_hours)).timestamp() * 1000)
        for name in candidates:
            summary = LogGroupSummary(name=name)
            try:
                described = logs.describe_log_groups(logGroupNamePrefix=name)
                for group in described.get("logGroups", []):
                    if group["logGroupName"] == name:
                        summary.arn = group.get("arn", "")
                        summary.stored_bytes = group.get("storedBytes", 0)
                        summary.retention_days = group.get("retentionInDays")
                events = logs.filter_log_events(
                    logGroupName=name, startTime=start_ms, limit=25,
                )
                summary.recent_events = [
                    LogEvent(
                        timestamp=datetime.utcfromtimestamp(e["timestamp"] / 1000).isoformat(),
                        message=e.get("message", "").rstrip()[:500],
                        stream=e.get("logStreamName", ""),
                    )
                    for e in events.get("events", [])
                ]
            except ClientError as e:
                code = e.response.get("Error", {}).get("Code")
                if code != "ResourceNotFoundException":
                    detail.errors[f"logs:{name}"] = code or str(e)
                    continue
            detail.logs.append(summary)

    # --------------------------------------------------------- enrichers

    def _ec2(self):
        return discovery_client(self.session, "ec2", self.region)

    def _sg_rules(self, ec2, group_ids: List[str]) -> List[SecurityGroupRule]:
        rules: List[SecurityGroupRule] = []
        if not group_ids:
            return rules
        response = ec2.describe_security_group_rules(
            Filters=[{"Name": "group-id", "Values": group_ids}]
        )
        for r in response.get("SecurityGroupRules", []):
            source = (
                r.get("CidrIpv4") or r.get("CidrIpv6") or r.get("PrefixListId")
                or (r.get("ReferencedGroupInfo") or {}).get("GroupId") or "?"
            )
            rules.append(SecurityGroupRule(
                direction="egress" if r.get("IsEgress") else "ingress",
                protocol="all" if r.get("IpProtocol") == "-1" else r.get("IpProtocol", "?"),
                from_port=r.get("FromPort") if r.get("FromPort", -1) != -1 else None,
                to_port=r.get("ToPort") if r.get("ToPort", -1) != -1 else None,
                source=source,
                description=r.get("Description", ""),
            ))
        return rules

    def _flow_logs(self, ec2, resource_ids: List[str]) -> List[Dict[str, Any]]:
        if not resource_ids:
            return []
        response = ec2.describe_flow_logs(
            Filters=[{"Name": "resource-id", "Values": resource_ids}]
        )
        return [
            {"id": f.get("FlowLogId"), "status": f.get("FlowLogStatus"),
             "traffic": f.get("TrafficType"), "destination": f.get("LogDestination")
             or f.get("LogGroupName")}
            for f in response.get("FlowLogs", [])
        ]

    def _enrich_instance(self, detail: ResourceDetail) -> None:
        ec2 = self._ec2()
        cfg = detail.configuration
        if not cfg:
            return
        net = NetworkDetail(
            vpc_id=cfg.get("VpcId"), subnet_id=cfg.get("SubnetId"),
            availability_zone=(cfg.get("Placement") or {}).get("AvailabilityZone"),
        )
        for eni in cfg.get("NetworkInterfaces", []):
            net.interfaces.append({
                "id": eni.get("NetworkInterfaceId"),
                "private_ip": eni.get("PrivateIpAddress"),
                "public_ip": (eni.get("Association") or {}).get("PublicIp"),
                "subnet": eni.get("SubnetId"),
            })
            if eni.get("PrivateIpAddress"):
                net.private_ips.append(eni["PrivateIpAddress"])
            public = (eni.get("Association") or {}).get("PublicIp")
            if public:
                net.public_ips.append(public)

        group_ids = [g["GroupId"] for g in cfg.get("SecurityGroups", [])]
        net.security_groups = [
            {"id": g["GroupId"], "name": g.get("GroupName")} for g in cfg.get("SecurityGroups", [])
        ]
        net.rules = self._sg_rules(ec2, group_ids)
        net.flow_logs = self._flow_logs(
            ec2, [i["id"] for i in net.interfaces if i.get("id")] + [net.subnet_id, net.vpc_id]
        )
        if not net.flow_logs:
            net.notes.append("No VPC flow logs cover this instance; network traffic is not being recorded")
        detail.network = net

        acct = parse_arn(detail.arn).account if parse_arn(detail.arn) else ""
        def ec2_arn(kind, rid):
            return f"arn:aws:ec2:{detail.region}:{acct}:{kind}/{rid}"

        for g in net.security_groups:
            detail.related.append(Related("security-group", ec2_arn("security-group", g["id"]),
                                          "AWS::EC2::SecurityGroup", g.get("name") or g["id"]))
        if net.subnet_id:
            detail.related.append(Related("subnet", ec2_arn("subnet", net.subnet_id), "AWS::EC2::Subnet", net.subnet_id))
        if net.vpc_id:
            detail.related.append(Related("vpc", ec2_arn("vpc", net.vpc_id), "AWS::EC2::VPC", net.vpc_id))
        for mapping in cfg.get("BlockDeviceMappings", []):
            vol = (mapping.get("Ebs") or {}).get("VolumeId")
            if vol:
                detail.related.append(Related("attached-volume", ec2_arn("volume", vol),
                                              "AWS::EC2::Volume", vol, mapping.get("DeviceName", "")))
        profile = (cfg.get("IamInstanceProfile") or {}).get("Arn")
        if profile:
            detail.related.append(Related("instance-profile", profile, "AWS::IAM::InstanceProfile",
                                          profile.rsplit("/", 1)[-1]))
        if cfg.get("KeyName"):
            detail.related.append(Related("key-pair", ec2_arn("key-pair", cfg["KeyName"]),
                                          "AWS::EC2::KeyPair", cfg["KeyName"]))

    def _enrich_nat(self, detail: ResourceDetail) -> None:
        cfg = detail.configuration
        if not cfg:
            return
        net = NetworkDetail(vpc_id=cfg.get("VpcId"), subnet_id=cfg.get("SubnetId"))
        for addr in cfg.get("NatGatewayAddresses", []):
            if addr.get("PublicIp"):
                net.public_ips.append(addr["PublicIp"])
            if addr.get("PrivateIp"):
                net.private_ips.append(addr["PrivateIp"])
            if addr.get("NetworkInterfaceId"):
                net.interfaces.append({"id": addr["NetworkInterfaceId"]})
        net.flow_logs = self._flow_logs(self._ec2(), [net.subnet_id, net.vpc_id])
        detail.network = net
        acct = parse_arn(detail.arn).account
        if net.subnet_id:
            detail.related.append(Related("subnet", f"arn:aws:ec2:{detail.region}:{acct}:subnet/{net.subnet_id}",
                                          "AWS::EC2::Subnet", net.subnet_id))
        if net.vpc_id:
            detail.related.append(Related("vpc", f"arn:aws:ec2:{detail.region}:{acct}:vpc/{net.vpc_id}",
                                          "AWS::EC2::VPC", net.vpc_id))
        for addr in cfg.get("NatGatewayAddresses", []):
            if addr.get("AllocationId"):
                detail.related.append(Related("elastic-ip",
                    f"arn:aws:ec2:{detail.region}:{acct}:elastic-ip/{addr['AllocationId']}",
                    "AWS::EC2::EIP", addr.get("PublicIp", addr["AllocationId"])))

    def _enrich_vpc(self, detail: ResourceDetail) -> None:
        ec2 = self._ec2()
        vpc_id = service_identifier(detail.arn)
        acct = parse_arn(detail.arn).account
        net = NetworkDetail(vpc_id=vpc_id)
        net.flow_logs = self._flow_logs(ec2, [vpc_id])
        if not net.flow_logs:
            net.notes.append("VPC flow logs are not enabled; traffic inside this VPC is not recorded")

        filt = [{"Name": "vpc-id", "Values": [vpc_id]}]
        def rel(kind, items, id_key, rtype, name_fn=lambda i: None):
            for item in items:
                rid = item[id_key]
                name = next((t["Value"] for t in item.get("Tags", []) if t["Key"] == "Name"), None) or name_fn(item) or rid
                detail.related.append(Related(kind, f"arn:aws:ec2:{detail.region}:{acct}:{kind}/{rid}", rtype, name))

        rel("subnet", ec2.describe_subnets(Filters=filt)["Subnets"], "SubnetId", "AWS::EC2::Subnet",
            lambda s: f"{s.get('CidrBlock')} {s.get('AvailabilityZone')}")
        rel("security-group", ec2.describe_security_groups(Filters=filt)["SecurityGroups"], "GroupId",
            "AWS::EC2::SecurityGroup", lambda g: g.get("GroupName"))
        rel("route-table", ec2.describe_route_tables(Filters=filt)["RouteTables"], "RouteTableId", "AWS::EC2::RouteTable")
        rel("natgateway", ec2.describe_nat_gateways(Filters=filt)["NatGateways"], "NatGatewayId", "AWS::EC2::NatGateway")
        rel("internet-gateway", ec2.describe_internet_gateways(
            Filters=[{"Name": "attachment.vpc-id", "Values": [vpc_id]}])["InternetGateways"],
            "InternetGatewayId", "AWS::EC2::InternetGateway")
        instances = [i for r in ec2.describe_instances(Filters=filt)["Reservations"] for i in r["Instances"]
                     if i["State"]["Name"] != "terminated"]
        rel("instance", instances, "InstanceId", "AWS::EC2::Instance",
            lambda i: f"{i.get('InstanceType')} {i['State']['Name']}")
        detail.network = net

    def _enrich_subnet(self, detail: ResourceDetail) -> None:
        ec2 = self._ec2()
        subnet_id = service_identifier(detail.arn)
        cfg = detail.configuration
        acct = parse_arn(detail.arn).account
        net = NetworkDetail(vpc_id=cfg.get("VpcId"), subnet_id=subnet_id,
                            availability_zone=cfg.get("AvailabilityZone"))
        # Which route table, and therefore whether it is public.
        rts = ec2.describe_route_tables(
            Filters=[{"Name": "association.subnet-id", "Values": [subnet_id]}])["RouteTables"]
        if not rts and cfg.get("VpcId"):
            rts = [rt for rt in ec2.describe_route_tables(
                Filters=[{"Name": "vpc-id", "Values": [cfg["VpcId"]]}])["RouteTables"]
                if any(a.get("Main") for a in rt.get("Associations", []))]
        for rt in rts:
            for route in rt.get("Routes", []):
                net.routes.append({
                    "destination": route.get("DestinationCidrBlock") or route.get("DestinationIpv6CidrBlock"),
                    "target": route.get("GatewayId") or route.get("NatGatewayId")
                              or route.get("InstanceId") or route.get("VpcPeeringConnectionId") or "local",
                    "state": route.get("State"),
                })
            detail.related.append(Related("route-table",
                f"arn:aws:ec2:{detail.region}:{acct}:route-table/{rt['RouteTableId']}",
                "AWS::EC2::RouteTable", rt["RouteTableId"]))
        public = any((r["target"] or "").startswith("igw-") for r in net.routes)
        net.notes.append("Public subnet (routes to an internet gateway)" if public else "Private subnet")
        net.flow_logs = self._flow_logs(ec2, [subnet_id, cfg.get("VpcId")])
        detail.network = net
        if cfg.get("VpcId"):
            detail.related.append(Related("vpc", f"arn:aws:ec2:{detail.region}:{acct}:vpc/{cfg['VpcId']}",
                                          "AWS::EC2::VPC", cfg["VpcId"]))
        instances = [i for r in ec2.describe_instances(
            Filters=[{"Name": "subnet-id", "Values": [subnet_id]}])["Reservations"] for i in r["Instances"]
            if i["State"]["Name"] != "terminated"]
        for i in instances:
            name = next((t["Value"] for t in i.get("Tags", []) if t["Key"] == "Name"), i["InstanceId"])
            detail.related.append(Related("instance", f"arn:aws:ec2:{detail.region}:{acct}:instance/{i['InstanceId']}",
                                          "AWS::EC2::Instance", name, i["State"]["Name"]))

    def _enrich_security_group(self, detail: ResourceDetail) -> None:
        ec2 = self._ec2()
        group_id = service_identifier(detail.arn)
        acct = parse_arn(detail.arn).account
        net = NetworkDetail(vpc_id=detail.configuration.get("VpcId"))
        net.rules = self._sg_rules(ec2, [group_id])
        open_to_world = [r for r in net.rules if r.direction == "ingress" and r.source in ("0.0.0.0/0", "::/0")]
        if open_to_world:
            ports = sorted({f"{r.from_port}" if r.from_port == r.to_port else f"{r.from_port}-{r.to_port}"
                            for r in open_to_world if r.from_port is not None} or {"all"})
            net.notes.append(f"Ingress open to the internet on port(s): {', '.join(ports)}")
        enis = ec2.describe_network_interfaces(
            Filters=[{"Name": "group-id", "Values": [group_id]}])["NetworkInterfaces"]
        for eni in enis:
            att = eni.get("Attachment") or {}
            detail.related.append(Related("used-by-interface",
                f"arn:aws:ec2:{detail.region}:{acct}:network-interface/{eni['NetworkInterfaceId']}",
                "AWS::EC2::NetworkInterface", eni["NetworkInterfaceId"],
                att.get("InstanceId") or eni.get("Description", "")))
            if att.get("InstanceId"):
                detail.related.append(Related("used-by-instance",
                    f"arn:aws:ec2:{detail.region}:{acct}:instance/{att['InstanceId']}",
                    "AWS::EC2::Instance", att["InstanceId"]))
        if not enis:
            net.notes.append("Not attached to any network interface - this group is unused")
        detail.network = net

    def _enrich_volume(self, detail: ResourceDetail) -> None:
        cfg = detail.configuration
        acct = parse_arn(detail.arn).account
        for att in cfg.get("Attachments", []):
            if att.get("InstanceId"):
                detail.related.append(Related("attached-to", f"arn:aws:ec2:{detail.region}:{acct}:instance/{att['InstanceId']}",
                                              "AWS::EC2::Instance", att["InstanceId"], att.get("Device", "")))
        if not cfg.get("Attachments"):
            detail.notes.append("Volume is not attached to any instance; it still incurs storage charges")
        if cfg.get("SnapshotId"):
            detail.related.append(Related("created-from-snapshot",
                f"arn:aws:ec2:{detail.region}:{acct}:snapshot/{cfg['SnapshotId']}",
                "AWS::EC2::Snapshot", cfg["SnapshotId"]))

    def _enrich_lambda(self, detail: ResourceDetail) -> None:
        cfg = detail.configuration
        if cfg.get("Role"):
            detail.related.append(Related("execution-role", cfg["Role"], "AWS::IAM::Role", cfg["Role"].rsplit("/", 1)[-1]))
        vpc = cfg.get("VpcConfig") or {}
        if vpc.get("VpcId"):
            acct = parse_arn(detail.arn).account
            net = NetworkDetail(vpc_id=vpc["VpcId"])
            net.security_groups = [{"id": g} for g in vpc.get("SecurityGroupIds", [])]
            net.rules = self._sg_rules(self._ec2(), vpc.get("SecurityGroupIds", []))
            detail.network = net
            for sid in vpc.get("SubnetIds", []):
                detail.related.append(Related("subnet", f"arn:aws:ec2:{detail.region}:{acct}:subnet/{sid}", "AWS::EC2::Subnet", sid))
        for layer in cfg.get("Layers", []):
            detail.related.append(Related("layer", layer.get("Arn", ""), "AWS::Lambda::LayerVersion", layer.get("Arn", "").rsplit(":", 2)[-2]))

    def _enrich_iam_role(self, detail: ResourceDetail) -> None:
        cfg = detail.configuration
        for pol in cfg.get("AttachedPolicies", []):
            detail.related.append(Related("attached-policy", pol.get("PolicyArn", ""), "AWS::IAM::ManagedPolicy", pol.get("PolicyName", "")))
        last = (cfg.get("RoleLastUsed") or {}).get("LastUsedDate")
        detail.notes.append(f"Last used: {last}" if last else "Never used (per IAM RoleLastUsed)")

    _ENRICHERS = {
        "AWS::EC2::Instance": _enrich_instance,
        "AWS::EC2::NatGateway": _enrich_nat,
        "AWS::EC2::VPC": _enrich_vpc,
        "AWS::EC2::Subnet": _enrich_subnet,
        "AWS::EC2::SecurityGroup": _enrich_security_group,
        "AWS::EC2::Volume": _enrich_volume,
        "AWS::Lambda::Function": _enrich_lambda,
        "AWS::IAM::Role": _enrich_iam_role,
    }

    # ------------------------------------------------------------- cost

    def _cost_hint(self, detail: ResourceDetail) -> None:
        """Rough on-demand monthly figure, where the type has an obvious one.

        These are order-of-magnitude hints for triage, not a bill. They ignore
        reservations, savings plans, data transfer and free tier.
        """
        cfg = detail.configuration
        t = detail.type
        if t == "AWS::EC2::NatGateway":
            detail.cost_hint = "~$33/month hourly charge + $0.045/GB processed (per NAT gateway)"
        elif t == "AWS::EC2::Instance":
            state = (cfg.get("State") or {}).get("Name")
            if state == "running":
                detail.cost_hint = f"Running {cfg.get('InstanceType', '?')}: on-demand hourly rate applies continuously"
            elif state == "stopped":
                detail.cost_hint = "Stopped: no compute charge, but attached EBS volumes still bill"
        elif t == "AWS::EC2::Volume":
            size = cfg.get("Size")
            if size:
                rate = {"gp3": 0.08, "gp2": 0.10, "io1": 0.125, "io2": 0.125, "st1": 0.045, "sc1": 0.015}.get(cfg.get("VolumeType"), 0.10)
                detail.cost_hint = f"~${size * rate:.2f}/month for {size} GiB {cfg.get('VolumeType', '')}"
        elif t == "AWS::EC2::EIP":
            detail.cost_hint = "~$3.65/month (public IPv4 is charged whether attached or not since Feb 2024)"
