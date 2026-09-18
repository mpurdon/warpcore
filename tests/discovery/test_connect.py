"""Composing the way into an instance."""

import json
from unittest.mock import Mock

from warpcore.discovery.connect import ConnectAdvisor, cidr_admits, compose_ssh, find_key, guess_user

ARN = "arn:aws:ec2:us-east-1:123456789012:instance/i-1"


def _ec2(instance, images=None, rules=None, others=None):
    ec2 = Mock()
    ec2.describe_instances.side_effect = lambda **kw: (
        {"Reservations": [{"Instances": [instance]}]} if kw.get("InstanceIds") else {"Reservations": [{"Instances": others or []}]}
    )
    ec2.describe_images.return_value = {"Images": images or [{"Name": "amzn2-ami-hvm"}]}
    ec2.describe_security_group_rules.return_value = {"SecurityGroupRules": rules or []}
    return ec2


def _advisor(ec2, ssm_status=None, home="/nowhere", plugin=True, idle=None):
    ssm = Mock()
    ssm.describe_instance_information.return_value = {"InstanceInformationList": [{"PingStatus": ssm_status}] if ssm_status else []}
    ssm.get_document.return_value = {"Content": json.dumps({"inputs": {"idleSessionTimeout": str(idle)}})} if idle else {}
    session = Mock()
    advisor = ConnectAdvisor(session, "us-east-1", profile="team", home=home, lookup_my_ip=False,
                             which=(lambda name: "/usr/local/bin/" + name) if plugin else (lambda _name: None))
    import warpcore.discovery.connect as mod
    mod.discovery_client = lambda _s, service, _r: {"ec2": ec2, "ssm": ssm}[service]
    return advisor


def test_guesses_the_login_user_from_the_image():
    assert guess_user("ubuntu/images/hvm-ssd/ubuntu-jammy") == "ubuntu"
    assert guess_user("amzn2-ami-kernel-5.10") == "ec2-user"
    assert guess_user("", "Windows") == "Administrator"
    assert guess_user("mystery") == "ec2-user"


def test_cidr_admits():
    assert cidr_admits("100.36.39.164/32", "100.36.39.164") is True
    assert cidr_admits("100.36.39.164/32", "100.36.39.165") is False
    assert cidr_admits("0.0.0.0/0", "8.8.8.8") is True
    assert cidr_admits("10.0.0.0/8", None) is None


def test_finds_the_key_in_the_usual_places(tmp_path):
    (tmp_path / ".ssh").mkdir()
    (tmp_path / ".ssh" / "ops.pem").write_text("k")
    assert find_key("ops", str(tmp_path)) == str(tmp_path / ".ssh" / "ops.pem")
    assert find_key("missing", str(tmp_path)) is None


def test_a_jump_is_a_proxy_command_with_its_own_key():
    cmd = compose_ssh("ec2-user", "10.0.3.5", "/k/host.pem", {"user": "ec2-user", "public_ip": "3.3.3.3", "key_path": "/k/bastion.pem"})
    assert cmd == 'ssh -i /k/host.pem -o ProxyCommand="ssh -i /k/bastion.pem -W %h:%p ec2-user@3.3.3.3" ec2-user@10.0.3.5'


def test_public_instance_with_key_is_plain_ssh():
    inst = {"InstanceId": "i-1", "State": {"Name": "running"}, "PublicIpAddress": "3.1.1.1", "PrivateIpAddress": "10.0.1.5",
            "KeyName": "ops", "ImageId": "ami-1", "SecurityGroups": [{"GroupId": "sg-1"}], "Tags": [{"Key": "Name", "Value": "bastion"}]}
    rules = [{"IsEgress": False, "IpProtocol": "tcp", "FromPort": 22, "ToPort": 22, "CidrIpv4": "100.36.39.164/32"}]
    plan = _advisor(_ec2(inst, rules=rules)).plan(ARN)
    assert plan.method == "ssh"
    assert plan.command == "ssh -i ~/.ssh/ops.pem ec2-user@3.1.1.1"
    by_id = {c.id: c for c in plan.checks}
    assert by_id["running"].ok is True
    assert by_id["ssm"].ok is False and "instance profile" in by_id["ssm"].detail
    assert by_id["key"].ok is False
    assert by_id["port"].ok is None  # our address was not looked up
    assert any("AmazonSSMManagedInstanceCore" in n for n in plan.notes)


def test_private_instance_goes_through_the_admitted_bastion():
    inst = {"InstanceId": "i-1", "State": {"Name": "running"}, "PrivateIpAddress": "10.0.3.5", "VpcId": "vpc-1",
            "KeyName": "ops", "ImageId": "ami-1", "SecurityGroups": [{"GroupId": "sg-host"}]}
    bastion = {"InstanceId": "i-b", "PublicIpAddress": "3.3.3.3", "KeyName": "ops", "ImageId": "ami-1",
               "Tags": [{"Key": "Name", "Value": "bastion"}]}
    rules = [{"IsEgress": False, "IpProtocol": "tcp", "FromPort": 22, "ToPort": 22, "ReferencedGroupInfo": {"GroupId": "sg-bastion"}}]
    plan = _advisor(_ec2(inst, rules=rules, others=[bastion])).plan(ARN)
    assert plan.method == "ssh-jump"
    assert plan.jump["name"] == "bastion"
    assert plan.command == 'ssh -i ~/.ssh/ops.pem -o ProxyCommand="ssh -i ~/.ssh/ops.pem -W %h:%p ec2-user@3.3.3.3" ec2-user@10.0.3.5'


def test_session_manager_wins_when_the_agent_is_online():
    inst = {"InstanceId": "i-1", "State": {"Name": "running"}, "PrivateIpAddress": "10.0.3.5", "ImageId": "ami-1",
            "IamInstanceProfile": {"Arn": "arn:aws:iam::1:instance-profile/ssm"}, "SecurityGroups": []}
    plan = _advisor(_ec2(inst), ssm_status="Online").plan(ARN)
    assert plan.method == "ssm"
    assert plan.command == "aws ssm start-session --target i-1 --region us-east-1 --profile team"


def test_a_stopped_instance_has_no_way_in():
    inst = {"InstanceId": "i-1", "State": {"Name": "stopped"}, "ImageId": "ami-1", "SecurityGroups": []}
    plan = _advisor(_ec2(inst)).plan(ARN)
    assert plan.method == "none"
    assert "Start the instance first." in plan.notes


def test_session_manager_needs_the_plugin_on_this_machine():
    inst = {"InstanceId": "i-1", "State": {"Name": "running"}, "PrivateIpAddress": "10.0.1.5", "ImageId": "ami-1",
            "IamInstanceProfile": {"Arn": "arn:aws:iam::1:instance-profile/ssm"}, "SecurityGroups": []}
    plan = _advisor(_ec2(inst), ssm_status="Online", plugin=False, idle=20).plan(ARN)
    assert plan.method == "ssm"
    by_id = {c.id: c for c in plan.checks}
    assert by_id["plugin"].ok is False and "session-manager-plugin" in by_id["plugin"].detail
    assert any("Install the Session Manager plugin" in n for n in plan.notes)
    assert plan.idle_timeout_minutes == 20
    assert any("20 idle minutes" in n for n in plan.notes)
    ok = _advisor(_ec2(inst), ssm_status="Online", plugin=True).plan(ARN)
    assert {c.id: c for c in ok.checks}["plugin"].ok is True
    assert not any("Install the Session Manager plugin" in n for n in ok.notes)


def test_private_instance_uses_an_instance_connect_endpoint_when_the_vpc_has_one():
    inst = {"InstanceId": "i-1", "State": {"Name": "running"}, "PrivateIpAddress": "10.0.1.5", "ImageId": "ami-1",
            "VpcId": "vpc-1", "KeyName": "ops", "SecurityGroups": [{"GroupId": "sg-1"}]}
    ec2 = _ec2(inst, rules=[{"IsEgress": False, "IpProtocol": "tcp", "FromPort": 22, "ToPort": 22, "CidrIpv4": "10.0.0.0/16"}])
    ec2.describe_instance_connect_endpoints.return_value = {"InstanceConnectEndpoints": [
        {"InstanceConnectEndpointId": "eice-1", "SubnetId": "subnet-1", "State": "create-complete"},
    ]}
    plan = _advisor(ec2).plan(ARN)
    assert plan.method == "eice"
    assert plan.eice == {"id": "eice-1", "subnet_id": "subnet-1", "state": "create-complete"}
    assert plan.command == "aws ec2-instance-connect ssh --instance-id i-1 --connection-type eice --region us-east-1 --profile team --os-user ec2-user"
    assert {c.id: c for c in plan.checks}["eice"].ok is True
    # No endpoint: the plan is the same as before the check existed.
    ec2.describe_instance_connect_endpoints.return_value = {"InstanceConnectEndpoints": []}
    assert _advisor(ec2).plan(ARN).method in ("ssh-jump", "none")
