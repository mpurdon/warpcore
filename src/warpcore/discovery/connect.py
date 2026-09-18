"""How to reach an instance from here, and whether you can.

Connecting is the first thing an operator wants from a card that says
"running", and the answer depends on facts spread across the instance, its
security groups, its AMI, the account's SSM enrolment, the keys on this
machine and the address this machine has right now. This gathers them,
checks each, and composes the command that would work, or says which check
stands in the way. It never connects; it only advises.
"""

import ipaddress
import os
import shutil
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

import boto3
from botocore.exceptions import ClientError

from warpcore.utils.arn import parse_arn, service_identifier
from warpcore.utils.boto import discovery_client
from warpcore.utils.logging import get_logger

logger = get_logger(__name__)

SSH_PORT = 22
RDP_PORT = 3389


@dataclass
class Check:
    """One precondition: what was looked at, and how it came out."""

    id: str
    ok: Optional[bool]          # None: could not be determined
    label: str
    detail: str = ""


@dataclass
class ConnectPlan:
    arn: str
    instance_id: str
    name: str
    state: Optional[str] = None
    platform: str = "linux"
    method: str = "none"                       # ssm | eice | ssh | ssh-jump | rdp | none
    command: Optional[str] = None
    user: Optional[str] = None
    key_name: Optional[str] = None
    key_path: Optional[str] = None
    public_ip: Optional[str] = None
    private_ip: Optional[str] = None
    jump: Optional[Dict[str, Any]] = None      # {instance_id, name, public_ip, user, key_path}
    my_ip: Optional[str] = None
    # An EC2 Instance Connect Endpoint in the instance's VPC, when there is one.
    eice: Optional[Dict[str, Any]] = None      # {id, subnet_id, state}
    # Session Manager's idle timeout in minutes, when the account's preferences say.
    idle_timeout_minutes: Optional[int] = None
    checks: List[Check] = field(default_factory=list)
    notes: List[str] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        from dataclasses import asdict
        return asdict(self)


# What the AMI's name says about the login user. Order matters: "ubuntu"
# before "debian" because some Ubuntu images mention both.
_AMI_USERS = [
    ("windows", "Administrator"),
    ("ubuntu", "ubuntu"),
    ("debian", "admin"),
    ("bitnami", "bitnami"),
    ("fedora", "fedora"),
    ("centos", "centos"),
    ("rhel", "ec2-user"),
    ("suse", "ec2-user"),
    ("amzn", "ec2-user"),
    ("al2023", "ec2-user"),
]


def guess_user(image_name: str, platform_details: str = "") -> str:
    haystack = f"{image_name} {platform_details}".lower()
    for needle, user in _AMI_USERS:
        if needle in haystack:
            return user
    return "ec2-user"


def key_candidates(key_name: str, home: Optional[str] = None) -> List[str]:
    """Where a key pair's private half usually lives on this machine."""
    base = os.path.join(home or os.path.expanduser("~"), ".ssh")
    return [
        os.path.join(base, f"{key_name}.pem"),
        os.path.join(base, key_name),
        os.path.join(base, f"{key_name}.key"),
        os.path.join(base, f"id_{key_name}"),
    ]


def find_key(key_name: str, home: Optional[str] = None) -> Optional[str]:
    for path in key_candidates(key_name, home):
        if os.path.isfile(path):
            return path
    return None


def cidr_admits(cidr: str, ip: Optional[str]) -> Optional[bool]:
    """Whether an address is inside a CIDR; None when the address is unknown."""
    if not ip:
        return None
    try:
        return ipaddress.ip_address(ip) in ipaddress.ip_network(cidr, strict=False)
    except ValueError:
        return False


def my_public_ip(timeout: float = 3.0) -> Optional[str]:
    """This machine's address as AWS sees it; None when offline."""
    try:
        with urllib.request.urlopen("https://checkip.amazonaws.com", timeout=timeout) as resp:
            return resp.read().decode().strip() or None
    except Exception:  # noqa: BLE001 - offline is an answer, not an error
        return None


def compose_ssh(user: str, host: str, key_path: Optional[str], jump: Optional[Dict[str, Any]] = None) -> str:
    """The ssh command. A jump is spelled out as a ProxyCommand rather than
    -J, because -J does not pass the command-line key to the first hop."""
    parts = ["ssh"]
    if key_path:
        parts += ["-i", _quote(key_path)]
    if jump:
        hop = ["ssh"]
        jump_key = jump.get("key_path") or key_path
        if jump_key:
            hop += ["-i", _quote(jump_key)]
        hop += ["-W", "%h:%p", f"{jump['user']}@{jump['public_ip']}"]
        parts += ["-o", f"ProxyCommand=\"{' '.join(hop)}\""]
    parts.append(f"{user}@{host}")
    return " ".join(parts)


SESSION_MANAGER_PLUGIN = "session-manager-plugin"
SESSION_MANAGER_PLUGIN_URL = "https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html"


def plugin_installed(which=shutil.which) -> bool:
    """Whether the Session Manager plugin the AWS CLI shells out to is on this machine."""
    return which(SESSION_MANAGER_PLUGIN) is not None


def compose_eice(instance_id: str, profile: Optional[str], region: str, user: Optional[str], key_path: Optional[str]) -> str:
    """SSH over an Instance Connect Endpoint: the CLI opens the tunnel, no public address needed."""
    parts = ["aws", "ec2-instance-connect", "ssh", "--instance-id", instance_id, "--connection-type", "eice", "--region", region]
    if profile:
        parts += ["--profile", profile]
    if user:
        parts += ["--os-user", user]
    if key_path:
        parts += ["--private-key-file", _quote(key_path)]
    return " ".join(parts)


def compose_ssm(instance_id: str, profile: Optional[str], region: str) -> str:
    parts = ["aws", "ssm", "start-session", "--target", instance_id, "--region", region]
    if profile:
        parts += ["--profile", profile]
    return " ".join(parts)


def _quote(path: str) -> str:
    return f'"{path}"' if " " in path else path


class ConnectAdvisor:
    """Reads what reaching one instance needs, and composes the way in."""

    def __init__(self, session: boto3.Session, region: str, profile: Optional[str] = None,
                 home: Optional[str] = None, lookup_my_ip: bool = True, which=shutil.which):
        self.session = session
        self.region = region
        self.profile = profile
        self.home = home
        self.lookup_my_ip = lookup_my_ip
        self.which = which

    def plan(self, arn: str) -> ConnectPlan:
        parsed = parse_arn(arn)
        region = (parsed.region if parsed and parsed.region else None) or self.region
        instance_id = service_identifier(arn)
        ec2 = discovery_client(self.session, "ec2", region)

        inst = self._instance(ec2, instance_id)
        plan = ConnectPlan(arn=arn, instance_id=instance_id, name=_name(inst) or instance_id)
        if not inst:
            plan.checks.append(Check("exists", False, "Instance found", f"{instance_id} was not returned by EC2"))
            return plan

        plan.state = (inst.get("State") or {}).get("Name")
        plan.public_ip = inst.get("PublicIpAddress")
        plan.private_ip = inst.get("PrivateIpAddress")
        plan.key_name = inst.get("KeyName")
        platform_details = inst.get("PlatformDetails") or ""
        plan.platform = "windows" if "windows" in platform_details.lower() or inst.get("Platform") == "windows" else "linux"
        port = RDP_PORT if plan.platform == "windows" else SSH_PORT

        # 1. Running.
        plan.checks.append(Check("running", plan.state == "running", "Instance running", f"EC2 reports the instance {plan.state}"))

        # 2. Session Manager: an instance profile, and the agent reporting in.
        profile_arn = (inst.get("IamInstanceProfile") or {}).get("Arn")
        ssm_online = self._ssm_online(instance_id, region) if profile_arn else None
        if not profile_arn:
            plan.checks.append(Check("ssm", False, "Session Manager", "No instance profile: the SSM agent cannot register, so Session Manager cannot reach it"))
        elif ssm_online is True:
            plan.checks.append(Check("ssm", True, "Session Manager", "The SSM agent is online; no open port or key needed"))
        elif ssm_online is False:
            plan.checks.append(Check("ssm", False, "Session Manager", "Has an instance profile but the SSM agent is not registered or offline"))
        else:
            plan.checks.append(Check("ssm", None, "Session Manager", "Could not read SSM instance information"))

        # 2b. The plugin the CLI needs for any Session Manager session.
        has_plugin = plugin_installed(self.which)
        if profile_arn:
            plan.checks.append(Check(
                "plugin", has_plugin, "Session Manager plugin on this machine",
                f"{SESSION_MANAGER_PLUGIN} is on PATH" if has_plugin else f"{SESSION_MANAGER_PLUGIN} is not on PATH; the AWS CLI needs it to open a session ({SESSION_MANAGER_PLUGIN_URL})",
            ))
        if ssm_online:
            plan.idle_timeout_minutes = self._idle_timeout(region)

        # 2c. An Instance Connect Endpoint in the VPC: SSH without a public address or a bastion.
        if not inst.get("PublicIpAddress") and plan.platform == "linux":
            plan.eice = self._eice(ec2, inst.get("VpcId"))
            if plan.eice:
                ready = plan.eice.get("state") == "create-complete"
                plan.checks.append(Check("eice", ready, "Instance Connect Endpoint",
                                         f"{plan.eice['id']} in {plan.eice.get('subnet_id')} is {plan.eice.get('state')}"))

        # 3. The login user, from the image.
        user = guess_user(self._image_name(ec2, inst.get("ImageId")), platform_details)
        plan.user = user

        # 4. The key on this machine.
        if plan.key_name:
            plan.key_path = find_key(plan.key_name, self.home)
            plan.checks.append(Check(
                "key", bool(plan.key_path), f"Key pair {plan.key_name} on this machine",
                plan.key_path or f"Not found; looked in {', '.join(key_candidates(plan.key_name, self.home))}",
            ))
        else:
            plan.checks.append(Check("key", False, "Key pair", "The instance was launched without a key pair"))

        # 5. Who the security groups admit on the port, and whether that is us.
        rules = self._ingress(ec2, [g.get("GroupId") for g in inst.get("SecurityGroups") or [] if g.get("GroupId")], port)
        plan.my_ip = my_public_ip() if self.lookup_my_ip else None
        cidr_sources = [r["cidr"] for r in rules if r.get("cidr")]
        group_sources = [r["group"] for r in rules if r.get("group")]
        if not rules:
            plan.checks.append(Check("port", False, f"Port {port} reachable", f"No security group admits port {port}"))
        else:
            admitted = any(cidr_admits(c, plan.my_ip) for c in cidr_sources)
            if plan.public_ip and cidr_sources:
                if plan.my_ip is None:
                    plan.checks.append(Check("port", None, f"Port {port} open to", f"{', '.join(cidr_sources)}; your address could not be determined"))
                else:
                    plan.checks.append(Check("port", admitted, f"Port {port} open to your address",
                                             f"{plan.my_ip} is {'inside' if admitted else 'outside'} {', '.join(cidr_sources)}"))
            elif group_sources:
                plan.checks.append(Check("port", None, f"Port {port} open to", f"members of {', '.join(group_sources)}"))

        # 6. A jump host, when the instance has no public address.
        jump = None
        if not plan.public_ip and plan.platform == "linux":
            jump = self._jump_host(ec2, inst, group_sources)
            if jump:
                plan.jump = jump
                plan.checks.append(Check("jump", True, "Jump host", f"{jump['name']} ({jump['public_ip']}) is admitted on port {port} and has a public address"))
            else:
                plan.checks.append(Check("jump", False, "Jump host", "No public address, and no instance with one is admitted on the port"))

        # The method: Session Manager when the agent answers, else SSH.
        if plan.state != "running":
            plan.method = "none"
            plan.notes.append("Start the instance first.")
        elif ssm_online:
            plan.method = "ssm"
            plan.command = compose_ssm(instance_id, self.profile, region)
        elif plan.platform == "windows":
            plan.method = "rdp" if plan.public_ip else "none"
            if plan.public_ip:
                plan.command = f"open rdp://{user}@{plan.public_ip}"
                plan.notes.append("Windows: connect with an RDP client using the administrator password from the console.")
        elif plan.public_ip:
            plan.method = "ssh"
            plan.command = compose_ssh(user, plan.public_ip, plan.key_path or (f"~/.ssh/{plan.key_name}.pem" if plan.key_name else None))
        elif plan.eice and plan.eice.get("state") == "create-complete":
            plan.method = "eice"
            plan.command = compose_eice(instance_id, self.profile, region, user, plan.key_path)
            if not plan.key_path:
                plan.notes.append("Without a key file the CLI pushes a one-minute key through EC2 Instance Connect; the instance needs the ec2-instance-connect package.")
        elif jump:
            plan.method = "ssh-jump"
            plan.command = compose_ssh(user, plan.private_ip or instance_id, plan.key_path or (f"~/.ssh/{plan.key_name}.pem" if plan.key_name else None), jump)
        else:
            plan.method = "none"

        if plan.method == "ssm" and not has_plugin:
            plan.notes.append(f"Install the Session Manager plugin first: {SESSION_MANAGER_PLUGIN_URL}")
        if plan.method == "ssm" and plan.idle_timeout_minutes:
            plan.notes.append(f"Session Manager ends the session after {plan.idle_timeout_minutes} idle minutes (the account's session preferences).")
        if plan.method in ("ssh", "ssh-jump") and not plan.key_path:
            plan.notes.append(f"Put the private key for {plan.key_name} at ~/.ssh/{plan.key_name}.pem, or edit the -i path.")
        if plan.method in ("ssh", "ssh-jump") and not profile_arn:
            plan.notes.append("Attach an instance profile with AmazonSSMManagedInstanceCore to reach this instance without a key or an open port.")
        return plan

    # ------------------------------------------------------------ lookups

    def _instance(self, ec2, instance_id: str) -> Dict[str, Any]:
        try:
            resp = ec2.describe_instances(InstanceIds=[instance_id])
        except ClientError as e:
            logger.info("describe_instances failed for %s: %s", instance_id, e)
            return {}
        for reservation in resp.get("Reservations", []):
            for inst in reservation.get("Instances", []):
                return inst
        return {}

    def _ssm_online(self, instance_id: str, region: str) -> Optional[bool]:
        try:
            ssm = discovery_client(self.session, "ssm", region)
            resp = ssm.describe_instance_information(Filters=[{"Key": "InstanceIds", "Values": [instance_id]}])
        except ClientError as e:
            logger.info("describe_instance_information failed: %s", e)
            return None
        infos = resp.get("InstanceInformationList", [])
        if not infos:
            return False
        return infos[0].get("PingStatus") == "Online"

    def _idle_timeout(self, region: str) -> Optional[int]:
        """The idle timeout from the account's Session Manager preferences document, if readable."""
        try:
            ssm = discovery_client(self.session, "ssm", region)
            doc = ssm.get_document(Name="SSM-SessionManagerRunShell")
            content = doc.get("Content") if isinstance(doc, dict) else None
            if not isinstance(content, str):
                return None
            import json
            value = (json.loads(content).get("inputs") or {}).get("idleSessionTimeout")
            return int(value) if value not in (None, "") else None
        except Exception as e:  # noqa: BLE001 - preferences are optional context
            logger.info("session preferences not read: %s", e)
            return None

    def _eice(self, ec2, vpc_id: Optional[str]) -> Optional[Dict[str, Any]]:
        if not vpc_id:
            return None
        try:
            resp = ec2.describe_instance_connect_endpoints(Filters=[{"Name": "vpc-id", "Values": [vpc_id]}])
        except Exception as e:  # noqa: BLE001 - an older CLI or a denied call is "no endpoint"
            logger.info("describe_instance_connect_endpoints failed: %s", e)
            return None
        endpoints = resp.get("InstanceConnectEndpoints") if isinstance(resp, dict) else None
        if not isinstance(endpoints, list):
            return None
        ready = [e for e in endpoints if isinstance(e, dict)]
        ready.sort(key=lambda e: e.get("State") != "create-complete")
        if not ready:
            return None
        e = ready[0]
        return {"id": e.get("InstanceConnectEndpointId"), "subnet_id": e.get("SubnetId"), "state": e.get("State")}

    def _image_name(self, ec2, image_id: Optional[str]) -> str:
        if not image_id:
            return ""
        try:
            images = ec2.describe_images(ImageIds=[image_id]).get("Images", [])
        except ClientError:
            return ""
        if not images:
            return ""
        return f"{images[0].get('Name') or ''} {images[0].get('Description') or ''} {images[0].get('PlatformDetails') or ''}"

    def _ingress(self, ec2, group_ids: List[str], port: int) -> List[Dict[str, str]]:
        """Sources admitted on the port: CIDRs and groups."""
        if not group_ids:
            return []
        try:
            resp = ec2.describe_security_group_rules(Filters=[{"Name": "group-id", "Values": group_ids}])
        except ClientError as e:
            logger.info("describe_security_group_rules failed: %s", e)
            return []
        out: List[Dict[str, str]] = []
        for rule in resp.get("SecurityGroupRules", []):
            if rule.get("IsEgress"):
                continue
            proto = rule.get("IpProtocol")
            lo, hi = rule.get("FromPort", -1), rule.get("ToPort", -1)
            covers = proto == "-1" or (proto in ("tcp", "6") and lo != -1 and lo <= port <= hi)
            if not covers:
                continue
            if rule.get("CidrIpv4"):
                out.append({"cidr": rule["CidrIpv4"]})
            elif rule.get("CidrIpv6"):
                out.append({"cidr": rule["CidrIpv6"]})
            elif rule.get("ReferencedGroupInfo", {}).get("GroupId"):
                out.append({"group": rule["ReferencedGroupInfo"]["GroupId"]})
        return out

    def _jump_host(self, ec2, inst: Dict[str, Any], admitted_groups: List[str]) -> Optional[Dict[str, Any]]:
        """A running instance with a public address in one of the admitted groups."""
        if not admitted_groups:
            return None
        try:
            resp = ec2.describe_instances(Filters=[
                {"Name": "instance.group-id", "Values": admitted_groups},
                {"Name": "instance-state-name", "Values": ["running"]},
                {"Name": "vpc-id", "Values": [inst.get("VpcId") or ""]},
            ])
        except ClientError:
            return None
        for reservation in resp.get("Reservations", []):
            for cand in reservation.get("Instances", []):
                if cand.get("InstanceId") == inst.get("InstanceId") or not cand.get("PublicIpAddress"):
                    continue
                key = cand.get("KeyName")
                return {
                    "instance_id": cand["InstanceId"],
                    "name": _name(cand) or cand["InstanceId"],
                    "public_ip": cand["PublicIpAddress"],
                    "user": guess_user(self._image_name(ec2, cand.get("ImageId")), cand.get("PlatformDetails") or ""),
                    "key_name": key,
                    "key_path": find_key(key, self.home) if key else None,
                }
        return None


def _name(inst: Dict[str, Any]) -> Optional[str]:
    for tag in inst.get("Tags") or []:
        if tag.get("Key") == "Name":
            return tag.get("Value")
    return None
