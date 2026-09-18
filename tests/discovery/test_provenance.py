"""Who deployed a resource: tags, stacks, state files."""

import json

import boto3
import pytest
from moto import mock_aws

from warpcore.discovery.provenance import (
    StackClassifier, attach_provenance, from_tags, pulumi_index, sst_apps, sst_v3_index, terraform_index,
)
from warpcore.state.models import Resource

REGION = "us-east-1"


class TestTags:
    def test_sst_v3_amplify_copilot_chalice_and_plain_cloudformation(self):
        assert from_tags({"sst:app": "shop", "sst:stage": "dev"})["manager"] == "sst-v3"
        cfn = from_tags({"aws:cloudformation:stack-name": "shop-dev", "aws:cloudformation:logical-id": "ApiFn"})
        assert cfn == {"manager": "cloudformation", "stack": "shop-dev", "logical_id": "ApiFn", "evidence": "tag aws:cloudformation:stack-name"}
        v2 = from_tags({"aws:cloudformation:stack-name": "dev-shop-Api", "sst:app": "shop", "sst:stage": "dev"})
        assert v2["manager"] == "sst-v2" and v2["stack"] == "dev-shop-Api"
        assert from_tags({"copilot-application": "shop", "copilot-environment": "test"})["manager"] == "copilot"
        assert from_tags({"created-by": "amplify"})["manager"] == "amplify"
        chalice = from_tags({"aws-chalice": "version=1.31:stage=dev:app=shop"})
        assert chalice["app"] == "shop" and chalice["stage"] == "dev"
        assert from_tags({"warpcore:managed-by": "warpcore", "warpcore:project": "shop"})["manager"] == "warpcore"
        assert from_tags({"Name": "x"}) is None


class TestStateFiles:
    def test_terraform_state_maps_arns_ids_and_bucket_names_to_addresses(self):
        state = {"version": 4, "terraform_version": "1.14.0", "resources": [
            {"mode": "managed", "type": "aws_lambda_function", "name": "api", "module": "module.app",
             "instances": [{"attributes": {"id": "shop-api", "arn": "arn:aws:lambda:us-east-1:1:function:shop-api"}}]},
            {"mode": "managed", "type": "aws_s3_bucket", "name": "uploads",
             "instances": [{"index_key": "eu", "attributes": {"id": "shop-uploads", "bucket": "shop-uploads"}}]},
            {"mode": "data", "type": "aws_caller_identity", "name": "me", "instances": [{"attributes": {"id": "1"}}]},
        ]}
        idx = terraform_index(state)
        assert idx["arn:aws:lambda:us-east-1:1:function:shop-api"]["address"] == "module.app.aws_lambda_function.api"
        assert idx["arn:aws:s3:::shop-uploads"]["address"] == 'aws_s3_bucket.uploads["eu"]'
        assert "1" not in idx  # data sources are not managed
        assert idx["shop-api"]["manager"] == "terraform"

    def test_pulumi_checkpoint_maps_outputs_to_urns(self):
        ckpt = {"version": 3, "checkpoint": {"stack": "dev", "latest": {"resources": [
            {"urn": "urn:pulumi:dev::shop::pulumi:pulumi:Stack::shop-dev", "type": "pulumi:pulumi:Stack", "custom": False},
            {"urn": "urn:pulumi:dev::shop::aws:lambda/function:Function::api", "type": "aws:lambda/function:Function", "custom": True,
             "id": "shop-api", "outputs": {"arn": "arn:aws:lambda:us-east-1:1:function:shop-api"}},
        ]}}}
        idx = pulumi_index(ckpt, manager="sst-v3", app="shop", stage="dev")
        prov = idx["arn:aws:lambda:us-east-1:1:function:shop-api"]
        assert prov["urn"].endswith("::api") and prov["name"] == "api" and prov["app"] == "shop"
        assert "urn:pulumi:dev::shop::pulumi:pulumi:Stack::shop-dev" not in {p["urn"] for p in idx.values()}


@pytest.fixture
def aws(monkeypatch):
    for key in ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SECURITY_TOKEN", "AWS_SESSION_TOKEN"):
        monkeypatch.setenv(key, "testing")
    monkeypatch.setenv("AWS_DEFAULT_REGION", REGION)
    with mock_aws():
        yield boto3.Session(region_name=REGION)


class TestStacks:
    def test_a_cdk_stack_and_a_serverless_stack_are_recognised(self, aws):
        cfn = aws.client("cloudformation")
        cfn.create_stack(StackName="ShopStack", TemplateBody=json.dumps({"AWSTemplateFormatVersion": "2010-09-09",
            "Resources": {"CDKMetadata": {"Type": "AWS::CDK::Metadata", "Properties": {"Analytics": "v2:deflate64:xx"}},
                          "Q": {"Type": "AWS::SQS::Queue"}}}))
        cfn.create_stack(StackName="shop-dev", TemplateBody=json.dumps({"AWSTemplateFormatVersion": "2010-09-09",
            "Description": "The AWS CloudFormation template for this Serverless application",
            "Resources": {"ServerlessDeploymentBucket": {"Type": "AWS::S3::Bucket"}}}))
        cfn.create_stack(StackName="plain", TemplateBody=json.dumps({"AWSTemplateFormatVersion": "2010-09-09", "Resources": {"Q": {"Type": "AWS::SQS::Queue"}}}), Tags=[{"Key": "sst:app", "Value": "legacy"}])
        c = StackClassifier(aws, REGION)
        assert c.classify("ShopStack")[0] == "cdk"
        assert c.classify("shop-dev")[0] == "serverless"
        assert c.classify("plain")[0] == "sst-v2"
        assert c.classify("does-not-exist")[0] == "cloudformation"

    def test_sst_v3_state_is_read_from_the_bootstrap_bucket(self, aws):
        aws.client("ssm").put_parameter(Name="/sst/bootstrap", Type="String", Value=json.dumps({"version": 1, "state": "sst-state-abc", "asset": "sst-asset-abc"}))
        aws.client("s3").create_bucket(Bucket="sst-state-abc")
        aws.client("s3").put_object(Bucket="sst-state-abc", Key="app/shop/dev.json", Body=json.dumps({"checkpoint": {"latest": {"resources": [
            {"urn": "urn:pulumi:dev::shop::sst:aws:Function$aws:lambda/function:Function::Api", "type": "aws:lambda/function:Function", "custom": True,
             "id": "shop-dev-ApiFunction", "outputs": {"arn": "arn:aws:lambda:us-east-1:1:function:shop-dev-ApiFunction"}}]}}}))
        idx, notes = sst_v3_index(aws, REGION, [("shop", "dev"), ("shop", "missing")])
        assert idx["arn:aws:lambda:us-east-1:1:function:shop-dev-ApiFunction"]["manager"] == "sst-v3"
        assert any("app/shop/missing.json" in n for n in notes)


class TestAttach:
    def test_state_files_win_over_tags_and_stacks_refine_cloudformation(self, aws):
        aws.client("cloudformation").create_stack(StackName="ShopStack", TemplateBody=json.dumps({"AWSTemplateFormatVersion": "2010-09-09", "Resources": {"CDKMetadata": {"Type": "AWS::CDK::Metadata"}, "Q": {"Type": "AWS::SQS::Queue"}}}))
        fn = Resource(id="api", type="AWS::Lambda::Function", physical_id="arn:aws:lambda:us-east-1:1:function:api", tags={"aws:cloudformation:stack-name": "ShopStack", "aws:cloudformation:logical-id": "Api1"})
        vpc = Resource(id="vpc", type="AWS::EC2::VPC", physical_id="arn:aws:ec2:us-east-1:1:vpc/vpc-1", properties={"VpcId": "vpc-1"}, tags={})
        hand = Resource(id="host", type="AWS::EC2::Instance", physical_id="arn:aws:ec2:us-east-1:1:instance/i-1", tags={"Name": "host"})
        tf = terraform_index({"version": 4, "resources": [{"mode": "managed", "type": "aws_vpc", "name": "main", "instances": [{"attributes": {"id": "vpc-1", "arn": "arn:aws:ec2:us-east-1:1:vpc/vpc-1"}}]}]})
        counts = attach_provenance([fn, vpc, hand], classifier=StackClassifier(aws, REGION), indexes=[tf])
        assert counts == {"cdk": 1, "terraform": 1}
        assert fn.metadata["provenance"]["manager"] == "cdk" and fn.metadata["provenance"]["logical_id"] == "Api1"
        assert vpc.metadata["provenance"]["address"] == "aws_vpc.main"
        assert "provenance" not in (hand.metadata or {})

    def test_sst_apps_come_from_tags(self):
        r = Resource(id="x", type="AWS::SQS::Queue", tags={"sst:app": "shop", "sst:stage": "dev"})
        assert sst_apps([r]) == [("shop", "dev")]
