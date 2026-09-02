"""Service enumeration - the part that sees untagged resources."""

import boto3
import pytest
from moto import mock_aws

from warpcore.discovery.enumerator import ServiceEnumerator

REGION = "us-east-1"


@pytest.fixture
def aws_credentials(monkeypatch):
    for key in ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY",
                "AWS_SECURITY_TOKEN", "AWS_SESSION_TOKEN"):
        monkeypatch.setenv(key, "testing")
    monkeypatch.setenv("AWS_DEFAULT_REGION", REGION)


@pytest.fixture
def account(aws_credentials):
    with mock_aws():
        session = boto3.Session(region_name=REGION)
        s3 = session.client("s3", region_name=REGION)
        s3.create_bucket(Bucket="never-tagged")

        ddb = session.client("dynamodb", region_name=REGION)
        ddb.create_table(
            TableName="orders",
            KeySchema=[{"AttributeName": "pk", "KeyType": "HASH"}],
            AttributeDefinitions=[{"AttributeName": "pk", "AttributeType": "S"}],
            BillingMode="PAY_PER_REQUEST",
        )

        sqs = session.client("sqs", region_name=REGION)
        sqs.create_queue(QueueName="work")

        sns = session.client("sns", region_name=REGION)
        sns.create_topic(Name="alerts")

        yield session


def _enumerator(session):
    return ServiceEnumerator(session, region=REGION, account="123456789012")


def test_finds_never_tagged_resources(account):
    """The whole reason this module exists."""
    resources = _enumerator(account).enumerate(services=["s3"])
    assert "never-tagged" in {r.id for r in resources}


def test_enumerates_multiple_services(account):
    resources = _enumerator(account).enumerate(
        services=["s3", "dynamodb", "sqs", "sns"]
    )
    found = {r.type for r in resources}
    assert "AWS::S3::Bucket" in found
    assert "AWS::DynamoDB::Table" in found
    assert "AWS::SQS::Queue" in found
    assert "AWS::SNS::Topic" in found


def test_synthesised_arns_round_trip_through_the_parser(account):
    from warpcore.utils.arn import resource_type_from_arn

    for resource in _enumerator(account).enumerate(services=["dynamodb", "sqs", "sns", "s3"]):
        assert resource.physical_id.startswith("arn:")
        assert resource_type_from_arn(resource.physical_id) == resource.type


def test_a_failing_service_does_not_stop_the_others(account, monkeypatch):
    enumerator = _enumerator(account)

    def boom(self):
        raise RuntimeError("permission denied")

    monkeypatch.setitem(ServiceEnumerator._ENUMERATORS, "dynamodb", boom)
    resources = enumerator.enumerate(services=["s3", "dynamodb"])

    assert any(r.type == "AWS::S3::Bucket" for r in resources)
    assert any(e.service == "dynamodb" for e in enumerator.errors)


def test_unknown_service_is_ignored(account):
    enumerator = _enumerator(account)
    assert enumerator.enumerate(services=["not-a-service"]) == []


def test_supported_services_is_stable(account):
    services = _enumerator(account).supported_services()
    assert services == sorted(services)
    assert "lambda" in services and "iam" in services


class TestEc2Coverage:
    """EC2 enumeration used to return only VPCs, subnets and security groups.

    An inventory of a live account therefore described the network but not the
    running instances, NAT gateways or Elastic IPs inside it - the parts that
    cost money, and what someone asking "what is deployed here" means. Found
    against a real account whose 4 instances and 2 NAT gateways were invisible.
    """

    @pytest.fixture
    def networked_account(self, aws_credentials):
        with mock_aws():
            session = boto3.Session(region_name=REGION)
            ec2 = session.client("ec2", region_name=REGION)

            vpc = ec2.create_vpc(CidrBlock="10.0.0.0/16")["Vpc"]["VpcId"]
            subnet = ec2.create_subnet(VpcId=vpc, CidrBlock="10.0.1.0/24")["Subnet"]["SubnetId"]
            igw = ec2.create_internet_gateway()["InternetGateway"]["InternetGatewayId"]
            ec2.attach_internet_gateway(InternetGatewayId=igw, VpcId=vpc)
            ec2.create_route_table(VpcId=vpc)

            ec2.run_instances(
                ImageId="ami-12345678", MinCount=2, MaxCount=2, SubnetId=subnet,
                TagSpecifications=[{
                    "ResourceType": "instance",
                    "Tags": [{"Key": "Name", "Value": "worker"}],
                }],
            )
            eip = ec2.allocate_address(Domain="vpc")
            ec2.create_nat_gateway(SubnetId=subnet, AllocationId=eip["AllocationId"])
            ec2.create_volume(AvailabilityZone=f"{REGION}a", Size=8)
            yield session

    def _types(self, session):
        resources = ServiceEnumerator(
            session, region=REGION, account="123456789012"
        ).enumerate(services=["ec2"])
        return resources

    @pytest.mark.parametrize("resource_type", [
        "AWS::EC2::Instance",
        "AWS::EC2::NatGateway",
        "AWS::EC2::EIP",
        "AWS::EC2::Volume",
        "AWS::EC2::RouteTable",
        "AWS::EC2::InternetGateway",
        "AWS::EC2::VPC",
        "AWS::EC2::Subnet",
        "AWS::EC2::SecurityGroup",
        "AWS::EC2::NetworkInterface",
    ])
    def test_type_is_enumerated(self, networked_account, resource_type):
        found = {r.type for r in self._types(networked_account)}
        assert resource_type in found

    def test_instances_use_their_name_tag(self, networked_account):
        instances = [r for r in self._types(networked_account)
                     if r.type == "AWS::EC2::Instance"]
        assert instances
        assert all(r.id == "worker" for r in instances)

    def test_untagged_resources_fall_back_to_their_id(self, networked_account):
        vpcs = [r for r in self._types(networked_account) if r.type == "AWS::EC2::VPC"]
        assert any(r.id.startswith("vpc-") for r in vpcs)

    def test_synthesised_arns_round_trip(self, networked_account):
        from warpcore.utils.arn import resource_type_from_arn

        for resource in self._types(networked_account):
            assert resource_type_from_arn(resource.physical_id) == resource.type

    def test_terminated_instances_are_excluded(self, networked_account):
        """Terminated instances linger in the API and are not actionable."""
        ec2 = networked_account.client("ec2", region_name=REGION)
        ids = [i["InstanceId"] for r in ec2.describe_instances()["Reservations"]
               for i in r["Instances"]]
        ec2.terminate_instances(InstanceIds=ids)

        instances = [r for r in self._types(networked_account)
                     if r.type == "AWS::EC2::Instance"]
        assert instances == []
