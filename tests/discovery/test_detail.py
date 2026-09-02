"""Resource drill-in."""

import boto3
import pytest
from moto import mock_aws

from warpcore.discovery.detail import ResourceDetailReader

REGION = "us-east-1"
ACCOUNT = "123456789012"


@pytest.fixture
def aws_credentials(monkeypatch):
    for key in ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY",
                "AWS_SECURITY_TOKEN", "AWS_SESSION_TOKEN"):
        monkeypatch.setenv(key, "testing")
    monkeypatch.setenv("AWS_DEFAULT_REGION", REGION)


@pytest.fixture
def environment(aws_credentials):
    """A VPC with a public subnet, an instance in it, and a wide-open SG."""
    with mock_aws():
        session = boto3.Session(region_name=REGION)
        ec2 = session.client("ec2", region_name=REGION)

        vpc = ec2.create_vpc(CidrBlock="10.0.0.0/16")["Vpc"]["VpcId"]
        subnet = ec2.create_subnet(VpcId=vpc, CidrBlock="10.0.1.0/24")["Subnet"]["SubnetId"]
        igw = ec2.create_internet_gateway()["InternetGateway"]["InternetGatewayId"]
        ec2.attach_internet_gateway(InternetGatewayId=igw, VpcId=vpc)
        rt = ec2.create_route_table(VpcId=vpc)["RouteTable"]["RouteTableId"]
        ec2.create_route(RouteTableId=rt, DestinationCidrBlock="0.0.0.0/0", GatewayId=igw)
        ec2.associate_route_table(RouteTableId=rt, SubnetId=subnet)

        sg = ec2.create_security_group(GroupName="web", Description="web", VpcId=vpc)["GroupId"]
        ec2.authorize_security_group_ingress(GroupId=sg, IpPermissions=[
            {"IpProtocol": "tcp", "FromPort": 22, "ToPort": 22,
             "IpRanges": [{"CidrIp": "0.0.0.0/0", "Description": "ssh from anywhere"}]},
        ])

        instance = ec2.run_instances(
            ImageId="ami-12345678", MinCount=1, MaxCount=1,
            SubnetId=subnet, SecurityGroupIds=[sg], KeyName="ops",
            TagSpecifications=[{"ResourceType": "instance",
                                "Tags": [{"Key": "Name", "Value": "web-1"}]}],
        )["Instances"][0]["InstanceId"]

        yield {
            "session": session, "vpc": vpc, "subnet": subnet, "sg": sg,
            "instance": instance,
            "instance_arn": f"arn:aws:ec2:{REGION}:{ACCOUNT}:instance/{instance}",
            "vpc_arn": f"arn:aws:ec2:{REGION}:{ACCOUNT}:vpc/{vpc}",
            "subnet_arn": f"arn:aws:ec2:{REGION}:{ACCOUNT}:subnet/{subnet}",
            "sg_arn": f"arn:aws:ec2:{REGION}:{ACCOUNT}:security-group/{sg}",
        }


def _read(env, arn, **kwargs):
    reader = ResourceDetailReader(env["session"], REGION)
    return reader.read(arn, include_metrics=False, include_logs=False, **kwargs)


class TestInstance:
    def test_identity_comes_from_the_name_tag(self, environment):
        detail = _read(environment, environment["instance_arn"])
        assert detail.name == "web-1"
        assert detail.type == "AWS::EC2::Instance"

    def test_configuration_is_loaded(self, environment):
        detail = _read(environment, environment["instance_arn"])
        assert detail.configuration["InstanceId"] == environment["instance"]

    def test_network_section_has_placement_and_ips(self, environment):
        detail = _read(environment, environment["instance_arn"])
        assert detail.network.vpc_id == environment["vpc"]
        assert detail.network.subnet_id == environment["subnet"]
        assert detail.network.private_ips

    def test_security_group_rules_are_expanded(self, environment):
        detail = _read(environment, environment["instance_arn"])
        ingress = [r for r in detail.network.rules if r.direction == "ingress"]
        assert any(r.from_port == 22 and r.source == "0.0.0.0/0" for r in ingress)

    def test_missing_flow_logs_are_called_out(self, environment):
        detail = _read(environment, environment["instance_arn"])
        assert any("flow logs" in n for n in detail.network.notes)

    def test_related_resources_are_linked(self, environment):
        detail = _read(environment, environment["instance_arn"])
        relations = {r.relation: r for r in detail.related}
        assert relations["vpc"].arn == environment["vpc_arn"]
        assert relations["subnet"].arn == environment["subnet_arn"]
        assert relations["security-group"].arn == environment["sg_arn"]
        assert relations["key-pair"].name == "ops"

    def test_cost_hint_for_a_running_instance(self, environment):
        detail = _read(environment, environment["instance_arn"])
        assert "Running" in detail.cost_hint


class TestSecurityGroup:
    def test_world_open_ingress_is_flagged(self, environment):
        detail = _read(environment, environment["sg_arn"])
        assert any("open to the internet" in n and "22" in n for n in detail.network.notes)

    def test_reports_what_uses_it(self, environment):
        detail = _read(environment, environment["sg_arn"])
        assert any(r.relation == "used-by-instance" for r in detail.related)


class TestSubnet:
    def test_public_subnet_is_detected_from_its_routes(self, environment):
        detail = _read(environment, environment["subnet_arn"])
        assert any("Public subnet" in n for n in detail.network.notes)
        assert any(r["target"].startswith("igw-") for r in detail.network.routes)

    def test_lists_instances_in_it(self, environment):
        detail = _read(environment, environment["subnet_arn"])
        assert any(r.relation == "instance" and r.name == "web-1" for r in detail.related)


class TestVpc:
    def test_links_everything_inside_it(self, environment):
        detail = _read(environment, environment["vpc_arn"])
        relations = {r.relation for r in detail.related}
        assert {"subnet", "security-group", "route-table", "internet-gateway", "instance"} <= relations


class TestFailureIsolation:
    def test_one_failing_section_does_not_sink_the_rest(self, environment, monkeypatch):
        from warpcore.discovery import detail as module

        def boom(self, detail, *_):
            raise RuntimeError("cloudwatch is down")

        monkeypatch.setattr(module.ResourceDetailReader, "_metrics", boom)
        reader = ResourceDetailReader(environment["session"], REGION)
        detail = reader.read(environment["instance_arn"], include_logs=False)

        assert detail.configuration, "configuration should still have loaded"
        assert "metrics" in detail.errors
        assert "cloudwatch is down" in detail.errors["metrics"]

    def test_unknown_type_still_returns_identity(self, environment):
        detail = _read(environment, f"arn:aws:kinesis:{REGION}:{ACCOUNT}:stream/s")
        assert detail.type == "AWS::Kinesis::Stream"
        assert any("enricher" in n for n in detail.notes)


def test_to_dict_is_json_serialisable(environment):
    import json

    detail = _read(environment, environment["instance_arn"])
    json.dumps(detail.to_dict())  # must not raise
