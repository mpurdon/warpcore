"""Turning a scanned account into a Visual Builder project."""

import json

import pytest

from warpcore.agentic.scanner import ScannedState
from warpcore.discovery.project_emitter import ProjectEmitter, pattern_matches, select_resources
from warpcore.state.models import Resource

ACCOUNT = "123456789012"
REGION = "us-east-1"


def _res(rtype, name, arn, region=REGION, tags=None, **props):
    return Resource(
        id=name, type=rtype, physical_id=arn, tags=tags or {},
        properties=props, metadata={"region": region},
    )


def _lambda(name, **props):
    return _res(
        "AWS::Lambda::Function", name, f"arn:aws:lambda:{REGION}:{ACCOUNT}:function:{name}",
        FunctionName=name, Runtime="python3.11", MemorySize=512, Timeout=30,
        Handler="main.handler", Role=f"arn:aws:iam::{ACCOUNT}:role/{name}-role", **props,
    )


def _role(name):
    return _res(
        "AWS::IAM::Role", name, f"arn:aws:iam::{ACCOUNT}:role/{name}", region=None,
        RoleName=name, AttachedPolicies=[{"PolicyArn": "arn:aws:iam::aws:policy/AWSLambdaBasicExecutionRole"}],
    )


def _table(name, **props):
    return _res(
        "AWS::DynamoDB::Table", name, f"arn:aws:dynamodb:{REGION}:{ACCOUNT}:table/{name}",
        TableName=name,
        KeySchema=[{"AttributeName": "pk", "KeyType": "HASH"}, {"AttributeName": "sk", "KeyType": "RANGE"}],
        AttributeDefinitions=[{"AttributeName": "pk", "AttributeType": "S"}, {"AttributeName": "sk", "AttributeType": "N"}],
        BillingModeSummary={"BillingMode": "PAY_PER_REQUEST"}, **props,
    )


def _queue(name, **props):
    return _res(
        "AWS::SQS::Queue", name, f"arn:aws:sqs:{REGION}:{ACCOUNT}:{name}",
        QueueArn=f"arn:aws:sqs:{REGION}:{ACCOUNT}:{name}",
        VisibilityTimeout="60", MessageRetentionPeriod=str(4 * 86400), **props,
    )


def _emit(*resources, lambda_as="agent", include_env_values=False):
    state = ScannedState()
    for r in resources:
        state.add_resource(r)
    return ProjectEmitter(
        scanned_state=state, project_name="shop", environment="prod",
        account=ACCOUNT, region=REGION, regions={REGION: len(resources)},
        lambda_as=lambda_as, include_env_values=include_env_values,
    ).emit().payload


class TestSelection:
    def test_star_matches_everything(self):
        assert pattern_matches("*", _table("orders"))

    @pytest.mark.parametrize("pattern", [
        "AWS::DynamoDB::*", "dynamodb::table", "type:dynamodb", "orders", "name:ord*",
        "arn:aws:dynamodb:*", "region:us-east-*", "tag:Project=shop",
    ])
    def test_patterns_are_case_insensitive_globs(self, pattern):
        assert pattern_matches(pattern, _table("orders", tags={"Project": "shop"}) if "tag:" in pattern
                               else _table("orders"))

    def test_field_prefix_pins_the_field(self):
        # "orders" is the name, not the type.
        assert not pattern_matches("type:orders", _table("orders"))

    def test_exclude_wins_over_include(self):
        kept, dropped = select_resources([_table("orders"), _table("audit")], ["*"], ["name:audit"])
        assert [r.id for r in kept] == ["orders"]
        assert [r.id for r in dropped] == ["audit"]

    def test_no_include_means_all(self):
        kept, dropped = select_resources([_table("a"), _table("b")], [], [])
        assert len(kept) == 2 and not dropped


class TestEmit:
    def test_uses_canvas_field_names(self):
        payload = _emit(_table("orders"), _queue("jobs", FifoQueue="true"))
        by_type = {r["type"]: r for r in payload["resources"]}
        assert by_type["dynamodb"]["config"] == {
            "tableName": "orders", "partitionKey": "pk", "partitionKeyType": "S",
            "sortKey": "sk", "sortKeyType": "N", "billingMode": "PAY_PER_REQUEST",
        }
        assert by_type["sqs"]["config"] == {
            "queueName": "jobs", "fifo": True, "visibilityTimeout": 60, "messageRetention": 4,
        }

    def test_lambda_becomes_agent_by_default_and_lambda_on_request(self):
        agent = _emit(_lambda("Checkout_Agent"))
        assert agent["agents"][0]["config"]["name"] == "checkout-agent"
        assert agent["agents"][0]["config"]["path"] == "./agents/checkout-agent"
        assert any("shown as agent" in n["message"] for n in agent["notes"])

        plain = _emit(_lambda("Checkout_Agent"), lambda_as="lambda")
        assert plain["agents"] == []
        assert plain["resources"][0]["type"] == "lambda"
        assert plain["resources"][0]["config"]["functionName"] == "Checkout_Agent"

    def test_env_values_redacted_unless_asked(self):
        fn = _lambda("api", Environment={"Variables": {"TABLE": "orders", "TOKEN": "s3cr3t"}})
        redacted = _emit(fn)["agents"][0]["config"]["environment"]
        assert "s3cr3t" not in json.dumps(redacted)
        copied = _emit(fn, include_env_values=True)["agents"][0]["config"]["environment"]
        assert copied["TOKEN"] == "s3cr3t"

    def test_connections_from_env_role_dlq_and_sources(self):
        fn = _lambda(
            "api",
            Environment={"Variables": {"TABLE_NAME": "orders", "QUEUE_URL": f"https://sqs.{REGION}.amazonaws.com/{ACCOUNT}/jobs"}},
            DeadLetterConfig={"TargetArn": f"arn:aws:sqs:{REGION}:{ACCOUNT}:dead"},
            EventSourceMappings=[{"EventSourceArn": f"arn:aws:sqs:{REGION}:{ACCOUNT}:jobs"}],
        )
        payload = _emit(fn, _role("api-role"), _table("orders"), _queue("jobs"), _queue("dead"))
        kinds = {(c["kind"], c["from_arn"].rsplit(":", 1)[-1], c["to_arn"].rsplit(":", 1)[-1]) for c in payload["connections"]}
        assert ("role", "api", "role/api-role") in {(k, f.split(":")[-1], t) for k, f, t in kinds} or \
            any(c["kind"] == "role" for c in payload["connections"])
        assert any(c["kind"] == "reference" and c["detail"] == "env TABLE_NAME" for c in payload["connections"])
        assert any(c["kind"] == "reference" and c["detail"] == "env QUEUE_URL" for c in payload["connections"])
        assert any(c["kind"] == "dlq" and c["to_arn"].endswith(":dead") for c in payload["connections"])
        assert any(c["kind"] == "event-source" and c["from_arn"].endswith(":jobs") for c in payload["connections"])
        # The role is emitted because a function uses it.
        assert payload["roles"][0]["config"]["roleName"] == "api-role"
        assert payload["roles"][0]["attached_to"] == [fn.physical_id]

    def test_every_included_role_is_emitted_with_who_uses_it(self):
        payload = _emit(_lambda("api"), _role("api-role"), _role("ops-role"))
        by_name = {r["name"]: r for r in payload["roles"]}
        assert set(by_name) == {"api-role", "ops-role"}
        assert by_name["api-role"]["attached_to"] == [f"arn:aws:lambda:{REGION}:{ACCOUNT}:function:api"]
        assert by_name["ops-role"]["attached_to"] == []
        assert "AWS::IAM::Role" not in payload["skipped"]

    def test_rule_targets_and_dangling_ends_dropped(self):
        rule = _res(
            "AWS::Events::Rule", "nightly", f"arn:aws:events:{REGION}:{ACCOUNT}:rule/nightly",
            Name="nightly", ScheduleExpression="rate(1 day)", State="ENABLED",
            Targets=[{"Id": "1", "Arn": f"arn:aws:lambda:{REGION}:{ACCOUNT}:function:api"},
                     {"Id": "2", "Arn": f"arn:aws:lambda:{REGION}:{ACCOUNT}:function:not-included"}],
        )
        payload = _emit(rule, _lambda("api"))
        rule_cfg = payload["resources"][0]["config"]
        assert rule_cfg["ruleType"] == "schedule" and rule_cfg["schedule"] == "rate(1 day)" and rule_cfg["state"] is True
        targets = [c for c in payload["connections"] if c["kind"] == "event-target"]
        assert len(targets) == 1 and targets[0]["to_arn"].endswith(":api")

    def test_everything_is_drawn_unknown_types_as_generic_boxes(self):
        odd = _res("AWS::Budgets::Budget", "monthly", f"arn:aws:budgets::{ACCOUNT}:budget/monthly", region=None)
        payload = _emit(odd, _table("t"))
        assert payload["skipped"] == {}
        assert payload["counts"]["shown"] == 2
        generic = next(r for r in payload["resources"] if r["type"] == "aws-resource")
        assert generic["config"] == {"name": "monthly", "awsType": "AWS::Budgets::Budget"}

    def test_network_containment_becomes_connections(self):
        vpc = _res("AWS::EC2::VPC", "vpc-1", f"arn:aws:ec2:{REGION}:{ACCOUNT}:vpc/vpc-1", VpcId="vpc-1", CidrBlock="10.0.0.0/16")
        subnet = _res("AWS::EC2::Subnet", "subnet-1", f"arn:aws:ec2:{REGION}:{ACCOUNT}:subnet/subnet-1",
                      SubnetId="subnet-1", VpcId="vpc-1", CidrBlock="10.0.1.0/24", AvailabilityZone="us-east-1a", MapPublicIpOnLaunch=True)
        sg = _res("AWS::EC2::SecurityGroup", "sg-web", f"arn:aws:ec2:{REGION}:{ACCOUNT}:security-group/sg-1",
                  GroupId="sg-1", GroupName="web", VpcId="vpc-1", IpPermissions=[{"UserIdGroupPairs": [{"GroupId": "sg-2"}]}])
        sg2 = _res("AWS::EC2::SecurityGroup", "sg-db", f"arn:aws:ec2:{REGION}:{ACCOUNT}:security-group/sg-2",
                   GroupId="sg-2", GroupName="db", VpcId="vpc-1")
        inst = _res("AWS::EC2::Instance", "i-1", f"arn:aws:ec2:{REGION}:{ACCOUNT}:instance/i-1",
                    InstanceId="i-1", InstanceType="t3.micro", State={"Name": "running"}, SubnetId="subnet-1", VpcId="vpc-1",
                    SecurityGroups=[{"GroupId": "sg-1"}], IamInstanceProfile={"Arn": f"arn:aws:iam::{ACCOUNT}:instance-profile/web"},
                    BlockDeviceMappings=[{"DeviceName": "/dev/xvda", "Ebs": {"VolumeId": "vol-1"}}])
        vol = _res("AWS::EC2::Volume", "vol-1", f"arn:aws:ec2:{REGION}:{ACCOUNT}:volume/vol-1", VolumeId="vol-1", Size=8, VolumeType="gp3", Encrypted=True)
        profile = _res("AWS::IAM::InstanceProfile", "web", f"arn:aws:iam::{ACCOUNT}:instance-profile/web", region=None,
                       InstanceProfileName="web", Roles=[{"RoleName": "web-role", "Arn": f"arn:aws:iam::{ACCOUNT}:role/web-role"}])
        payload = _emit(vpc, subnet, sg, sg2, inst, vol, profile, _role("web-role"))
        types = {r["type"] for r in payload["resources"]}
        assert {"vpc", "subnet", "security-group", "ec2-instance", "ebs-volume", "iam-instance-profile"} <= types
        edges = {(c["from_arn"].rsplit("/", 1)[-1], c["to_arn"].rsplit("/", 1)[-1], c["detail"]) for c in payload["connections"]}
        assert ("subnet-1", "vpc-1", "in VPC") in edges
        assert ("i-1", "subnet-1", "in subnet") in edges
        assert ("i-1", "sg-1", "security group") in edges
        assert ("sg-2", "sg-1", "allowed inbound") in edges
        assert ("i-1", "vol-1", "volume /dev/xvda") in edges
        assert ("i-1", "web", "instance profile") in edges
        assert ("web", "web-role", "profile role") in edges
        inst_cfg = next(r for r in payload["resources"] if r["type"] == "ec2-instance")["config"]
        assert inst_cfg["instanceType"] == "t3.micro" and inst_cfg["state"] == "running"
        # A subnet's VpcId must not make it answer for the VPC.
        assert not any(c["to_arn"].endswith("subnet/subnet-1") and c["detail"] == "in VPC" for c in payload["connections"])


def _role_with(name, statements, **extra):
    role = _role(name)
    role.properties["PolicyDocuments"] = [
        {"name": "inline", "source": "inline", "document": {"Version": "2012-10-17", "Statement": statements}},
    ]
    role.properties.update(extra)
    return role


class TestAccess:
    def test_policy_statements_become_read_write_arrows(self):
        fn = _lambda("api")
        role = _role_with("api-role", [
            {"Effect": "Allow", "Action": ["dynamodb:GetItem", "dynamodb:Query"], "Resource": f"arn:aws:dynamodb:{REGION}:{ACCOUNT}:table/orders"},
            {"Effect": "Allow", "Action": "secretsmanager:GetSecretValue", "Resource": "*"},
            {"Effect": "Allow", "Action": ["s3:PutObject", "s3:GetObject"], "Resource": "arn:aws:s3:::archive/*"},
            {"Effect": "Deny", "Action": "sqs:*", "Resource": "*"},
        ])
        secret = _res("AWS::SecretsManager::Secret", "db-password", f"arn:aws:secretsmanager:{REGION}:{ACCOUNT}:secret:db-password-AbCdEf", Name="db-password")
        bucket = _res("AWS::S3::Bucket", "archive", "arn:aws:s3:::archive", region=None, BucketName="archive")
        queue = _queue("jobs")
        payload = _emit(fn, role, _table("orders"), secret, bucket, queue)
        access = {(c["to_arn"].split(":")[-1].split("/")[-1], c["detail"], c["via"]) for c in payload["connections"] if c["kind"] == "access"}
        assert ("orders", "read", "api-role") in access
        assert ("db-password-AbCdEf", "read", "api-role") in access
        assert ("archive", "read/write", "api-role") in access
        # Deny grants nothing, and a secretsmanager:* statement says nothing about a queue.
        assert not any(t == "jobs" for t, _, _ in access)
        sample = next(c for c in payload["connections"] if c["kind"] == "access" and c["to_arn"].endswith("table/orders"))
        assert sample["actions"] == ["dynamodb:GetItem", "dynamodb:Query"]

    def test_real_grant_replaces_env_var_guess(self):
        fn = _lambda("api", Environment={"Variables": {"TABLE": "orders"}})
        role = _role_with("api-role", [{"Effect": "Allow", "Action": "dynamodb:*", "Resource": "*"}])
        payload = _emit(fn, role, _table("orders"))
        kinds = [c["kind"] for c in payload["connections"] if c["to_arn"].endswith("table/orders")]
        assert kinds == ["access"]
        assert next(c for c in payload["connections"] if c["kind"] == "access")["detail"] == "admin"

    def test_instances_get_access_through_their_profile(self):
        inst = _res("AWS::EC2::Instance", "i-1", f"arn:aws:ec2:{REGION}:{ACCOUNT}:instance/i-1",
                    InstanceId="i-1", IamInstanceProfile={"Arn": f"arn:aws:iam::{ACCOUNT}:instance-profile/web"})
        profile = _res("AWS::IAM::InstanceProfile", "web", f"arn:aws:iam::{ACCOUNT}:instance-profile/web", region=None,
                       InstanceProfileName="web", Roles=[{"RoleName": "web-role", "Arn": f"arn:aws:iam::{ACCOUNT}:role/web-role"}])
        role = _role_with("web-role", [{"Effect": "Allow", "Action": "ssm:GetParameter", "Resource": "*"}])
        param = _res("AWS::SSM::Parameter", "github_token", f"arn:aws:ssm:{REGION}:{ACCOUNT}:parameter/github_token", Name="github_token", Type="SecureString")
        payload = _emit(inst, profile, role, param)
        access = [c for c in payload["connections"] if c["kind"] == "access"]
        assert len(access) == 1 and access[0]["from_arn"].endswith("instance/i-1") and access[0]["detail"] == "read"
        param_cfg = next(r for r in payload["resources"] if r["type"] == "ssm-parameter")["config"]
        assert param_cfg["secure"] is True

    def test_key_policy_principals_get_arrows(self):
        fn = _lambda("api")
        role = _role("api-role")
        key = _res("AWS::KMS::Key", "k1", f"arn:aws:kms:{REGION}:{ACCOUNT}:key/k1", KeyId="k1", KeyState="Enabled",
                   KeyPolicy={"Statement": [{"Effect": "Allow", "Principal": {"AWS": f"arn:aws:iam::{ACCOUNT}:role/api-role"},
                                             "Action": ["kms:Decrypt", "kms:Encrypt"], "Resource": "*"}]})
        payload = _emit(fn, role, key)
        access = [c for c in payload["connections"] if c["kind"] == "access"]
        assert len(access) == 1 and access[0]["detail"] == "read/write" and access[0]["via"] == "api-role"


class TestFolding:
    def test_volumes_snapshots_and_versions_fold_into_their_parent(self):
        inst = _res("AWS::EC2::Instance", "i-1", f"arn:aws:ec2:{REGION}:{ACCOUNT}:instance/i-1", InstanceId="i-1")
        # The volume is *called* gitf-data (Name tag) but *referenced* as vol-1.
        vol = _res("AWS::EC2::Volume", "gitf-data", f"arn:aws:ec2:{REGION}:{ACCOUNT}:volume/vol-1", tags={"Name": "gitf-data"}, VolumeId="vol-1", Attachments=[{"InstanceId": "i-1", "Device": "/dev/sda1"}])
        snap = _res("AWS::EC2::Snapshot", "gitf-data", f"arn:aws:ec2:{REGION}:{ACCOUNT}:snapshot/snap-1", tags={"Name": "gitf-data"}, SnapshotId="snap-1", VolumeId="vol-1")
        fn = _lambda("api")
        version = _res("AWS::Lambda::Function/Version", "api:3", f"arn:aws:lambda:{REGION}:{ACCOUNT}:function:api:3")
        loose = _res("AWS::EC2::Volume", "vol-9", f"arn:aws:ec2:{REGION}:{ACCOUNT}:volume/vol-9", VolumeId="vol-9", Attachments=[])
        payload = _emit(inst, vol, snap, fn, version, loose)
        folded = {r["arn"].rsplit("/", 1)[-1]: r.get("folded_into") for r in payload["resources"]}
        assert folded["vol-1"].endswith("instance/i-1")
        assert folded["snap-1"].endswith("volume/vol-1")
        assert next(r for r in payload["resources"] if r["name"] == "api:3")["folded_into"].endswith("function:api")
        assert folded["vol-9"] is None
        assert not any("_props" in r for r in payload["resources"])

    def test_default_security_group_open_to_world_is_flagged(self):
        sg = _res("AWS::EC2::SecurityGroup", "default", f"arn:aws:ec2:{REGION}:{ACCOUNT}:security-group/sg-1", GroupId="sg-1", GroupName="default",
                  IpPermissions=[{"IpProtocol": "tcp", "FromPort": 22, "ToPort": 22, "IpRanges": [{"CidrIp": "0.0.0.0/0"}]},
                                 {"IpProtocol": "-1", "UserIdGroupPairs": [{"GroupId": "sg-1"}]}])
        cfg = _emit(sg)["resources"][0]["config"]
        assert cfg["isDefault"] is True and cfg["openToWorld"] is True
        assert cfg["inboundRules"] == ["tcp 22 from 0.0.0.0/0", "any all from sg sg-1"]


class TestNamesAndHealth:
    def test_default_vpc_and_subnet_are_named_not_numbered(self):
        vpc = _res("AWS::EC2::VPC", "vpc-1", f"arn:aws:ec2:{REGION}:{ACCOUNT}:vpc/vpc-1", VpcId="vpc-1", IsDefault=True, CidrBlock="172.31.0.0/16")
        subnet = _res("AWS::EC2::Subnet", "subnet-1", f"arn:aws:ec2:{REGION}:{ACCOUNT}:subnet/subnet-1", SubnetId="subnet-1", VpcId="vpc-1", DefaultForAz=True, AvailabilityZone="us-east-1a")
        rt = _res("AWS::EC2::RouteTable", "rtb-1", f"arn:aws:ec2:{REGION}:{ACCOUNT}:route-table/rtb-1", RouteTableId="rtb-1", VpcId="vpc-1", Associations=[{"Main": True}])
        igw = _res("AWS::EC2::InternetGateway", "igw-1", f"arn:aws:ec2:{REGION}:{ACCOUNT}:internet-gateway/igw-1", InternetGatewayId="igw-1")
        by_type = {r["type"]: r["config"] for r in _emit(vpc, subnet, rt, igw)["resources"]}
        assert by_type["vpc"]["name"] == "Default VPC" and by_type["vpc"]["vpcId"] == "vpc-1" and by_type["vpc"]["isDefault"] is True
        assert by_type["subnet"]["name"] == "Default subnet" and by_type["subnet"]["isDefault"] is True
        assert by_type["route-table"]["name"] == "Main route table" and by_type["route-table"]["isMain"] is True
        assert by_type["internet-gateway"]["name"] == "Internet gateway"

    def test_a_name_tag_wins_over_the_default_label(self):
        vpc = _res("AWS::EC2::VPC", "vpc-1", f"arn:aws:ec2:{REGION}:{ACCOUNT}:vpc/vpc-1", tags={"Name": "core"}, VpcId="vpc-1", IsDefault=True)
        assert _emit(vpc)["resources"][0]["config"]["name"] == "core"

    def test_health_is_earned_not_assumed(self):
        running = _res("AWS::EC2::Instance", "i-1", f"arn:aws:ec2:{REGION}:{ACCOUNT}:instance/i-1", InstanceId="i-1", State={"Name": "running"})
        stopped = _res("AWS::EC2::Instance", "i-2", f"arn:aws:ec2:{REGION}:{ACCOUNT}:instance/i-2", InstanceId="i-2", State={"Name": "stopped"})
        bucket = _res("AWS::S3::Bucket", "b", "arn:aws:s3:::b", region=None, BucketName="b")
        fn = _lambda("api", State="Active")
        payload = _emit(running, stopped, bucket, fn)
        health = {r["name"]: r["health"] for r in payload["resources"]}
        assert health["i-1"]["level"] == "ok" and "running" in health["i-1"]["reason"]
        assert health["i-2"]["level"] == "warn" and "stopped" in health["i-2"]["reason"]
        assert health["b"]["level"] == "unknown"
        assert payload["agents"][0]["health"]["level"] == "ok"


class TestLogGroups:
    def test_a_functions_log_group_folds_into_it_and_draws_no_access(self):
        fn = _lambda("Checkout_Agent")   # agent name becomes checkout-agent; the log group uses the AWS name
        role = _role_with("Checkout_Agent-role", [{"Effect": "Allow", "Action": ["logs:CreateLogGroup", "logs:PutLogEvents"], "Resource": "*"}])
        own = _res("AWS::Logs::LogGroup", "/aws/lambda/Checkout_Agent", f"arn:aws:logs:{REGION}:{ACCOUNT}:log-group:/aws/lambda/Checkout_Agent:*",
                   logGroupName="/aws/lambda/Checkout_Agent", retentionInDays=14, storedBytes=1234)
        other = _res("AWS::Logs::LogGroup", "app-audit", f"arn:aws:logs:{REGION}:{ACCOUNT}:log-group:app-audit:*", logGroupName="app-audit")
        payload = _emit(fn, role, own, other)
        groups = {r["name"]: r for r in payload["resources"] if r["type"] == "log-group"}
        assert groups["/aws/lambda/Checkout_Agent"]["folded_into"].endswith(":function:Checkout_Agent")
        assert groups["/aws/lambda/Checkout_Agent"]["config"]["storedBytes"] == 1234
        assert "folded_into" not in groups["app-audit"]
        assert not any(c["kind"] == "access" for c in payload["connections"])

    def test_rds_and_api_gateway_log_groups_fold_too(self):
        db = _res("AWS::RDS::DBInstance", "orders-db", f"arn:aws:rds:{REGION}:{ACCOUNT}:db:orders-db", DBInstanceIdentifier="orders-db")
        api = _res("AWS::ApiGatewayV2::Api", "abc123", f"arn:aws:apigateway:{REGION}::/apis/abc123", Name="shop-api")
        g1 = _res("AWS::Logs::LogGroup", "/aws/rds/instance/orders-db/error", f"arn:aws:logs:{REGION}:{ACCOUNT}:log-group:/aws/rds/instance/orders-db/error:*", logGroupName="/aws/rds/instance/orders-db/error")
        g2 = _res("AWS::Logs::LogGroup", "API-Gateway-Execution-Logs_abc123/prod", f"arn:aws:logs:{REGION}:{ACCOUNT}:log-group:API-Gateway-Execution-Logs_abc123/prod:*", logGroupName="API-Gateway-Execution-Logs_abc123/prod")
        payload = _emit(db, api, g1, g2)
        folded = {r["name"]: r.get("folded_into", "") for r in payload["resources"] if r["type"] == "log-group"}
        assert folded["/aws/rds/instance/orders-db/error"].endswith("db:orders-db")
        assert folded["API-Gateway-Execution-Logs_abc123/prod"].endswith("/apis/abc123")

    def test_orphaned_and_duplicate_log_groups(self):
        # The function is gone; its log group must stay a box, not fold into
        # a namesake. The same group seen twice is drawn once.
        orphan = _res("AWS::Logs::LogGroup", "/aws/lambda/gone", f"arn:aws:logs:{REGION}:{ACCOUNT}:log-group:/aws/lambda/gone:*", logGroupName="/aws/lambda/gone")
        same_named = _res("AWS::S3::Bucket", "gone", "arn:aws:s3:::gone", region=None, BucketName="gone")
        twice_a = _res("AWS::Logs::LogGroup", "app", f"arn:aws:logs:{REGION}:{ACCOUNT}:log-group:app", logGroupName="app")
        twice_b = _res("AWS::Logs::LogGroup", "/app", f"arn:aws:logs:{REGION}:{ACCOUNT}:log-group:app:*", logGroupName="app")
        payload = _emit(orphan, same_named, twice_a, twice_b)
        groups = [r for r in payload["resources"] if r["type"] == "log-group"]
        assert len(groups) == 2
        assert not any(r.get("folded_into") for r in groups)


class TestEdgeFlow:
    def test_zone_points_at_distribution_which_points_at_its_origin(self):
        zone = _res("AWS::Route53::HostedZone", "example.com.", f"arn:aws:route53:::hostedzone/Z1", region=None,
                    Name="example.com.", Records=[
                        {"Name": "example.com.", "Type": "A", "Alias": "d123.cloudfront.net.", "Values": []},
                        {"Name": "www.example.com.", "Type": "CNAME", "Alias": None, "Values": ["d123.cloudfront.net"]},
                        {"Name": "api.example.com.", "Type": "A", "Alias": None, "Values": ["203.0.113.5"]},
                    ])
        dist = _res("AWS::CloudFront::Distribution", "E1", f"arn:aws:cloudfront::{ACCOUNT}:distribution/E1", region=None,
                    Id="E1", DomainName="d123.cloudfront.net", Status="Deployed",
                    DistributionConfig={"Enabled": True, "Aliases": {"Items": ["example.com"]},
                                        "Origins": {"Items": [{"Id": "site", "DomainName": "site-bucket.s3-website-us-east-1.amazonaws.com"}]},
                                        "ViewerCertificate": {"ACMCertificateArn": f"arn:aws:acm:us-east-1:{ACCOUNT}:certificate/c1"}})
        bucket = _res("AWS::S3::Bucket", "site-bucket", "arn:aws:s3:::site-bucket", region=None, BucketName="site-bucket")
        cert = _res("AWS::ACM::Certificate", "example.com", f"arn:aws:acm:us-east-1:{ACCOUNT}:certificate/c1", DomainName="example.com", Status="ISSUED")
        inst = _res("AWS::EC2::Instance", "i-1", f"arn:aws:ec2:{REGION}:{ACCOUNT}:instance/i-1", InstanceId="i-1", PublicIpAddress="203.0.113.5", State={"Name": "running"})
        payload = _emit(zone, dist, bucket, cert, inst)
        edges = {(c["kind"], c["from_arn"].rsplit("/", 1)[-1], c["to_arn"].rsplit("/", 1)[-1].rsplit(":", 1)[-1], c["detail"]) for c in payload["connections"]}
        # Two records point at the distribution; one arrow between the pair.
        assert sum(1 for k, f, t, _ in edges if (k, f, t) == ("dns", "Z1", "E1")) == 1
        assert ("dns", "Z1", "i-1", "A api.example.com") in edges
        assert ("origin", "E1", "site-bucket", "origin site") in edges
        assert any(c["kind"] == "reference" and c["detail"] == "TLS certificate" for c in payload["connections"])
        assert next(r for r in payload["resources"] if r["type"] == "cloudfront")["config"]["name"] == "example.com"

