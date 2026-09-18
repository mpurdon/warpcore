"""Live health and drift against moto."""

import json

import boto3
import pytest
from moto import mock_aws

from warpcore.discovery.health import canvas_health, describe_live, drift_report
from warpcore.state.models import Resource, State

REGION = "us-east-1"


@pytest.fixture
def aws(monkeypatch):
    for key in ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SECURITY_TOKEN", "AWS_SESSION_TOKEN"):
        monkeypatch.setenv(key, "testing")
    monkeypatch.setenv("AWS_DEFAULT_REGION", REGION)
    with mock_aws():
        yield boto3.Session(region_name=REGION)


def _instance(session):
    ec2 = session.client("ec2")
    ami = ec2.describe_images(Owners=["amazon"])["Images"][0]["ImageId"]
    return ec2.run_instances(ImageId=ami, MinCount=1, MaxCount=1, InstanceType="t2.micro")["Instances"][0]["InstanceId"]


def test_health_reports_running_stopped_and_gone(aws):
    running = _instance(aws)
    stopped = _instance(aws)
    aws.client("ec2").stop_instances(InstanceIds=[stopped])
    account = "123456789012"
    nodes = [
        {"id": "a", "type": "ec2-instance", "arn": f"arn:aws:ec2:{REGION}:{account}:instance/{running}"},
        {"id": "b", "type": "ec2-instance", "arn": f"arn:aws:ec2:{REGION}:{account}:instance/{stopped}"},
        {"id": "c", "type": "ec2-instance", "arn": f"arn:aws:ec2:{REGION}:{account}:instance/i-0000000000gone"},
        {"id": "d", "type": "s3", "arn": "arn:aws:s3:::no-health-for-buckets"},
    ]
    out = canvas_health(aws, REGION, nodes)["resources"]
    assert out[nodes[0]["arn"]]["level"] == "ok"
    assert out[nodes[1]["arn"]]["level"] == "warn" and "stopped" in out[nodes[1]["arn"]]["reason"]
    assert out[nodes[2]["arn"]]["missing"] is True
    assert nodes[3]["arn"] not in out  # a bucket reports no health, so it is not asked


def test_drift_sees_a_changed_queue_and_a_deleted_bucket(aws):
    sqs, s3 = aws.client("sqs"), aws.client("s3")
    url = sqs.create_queue(QueueName="jobs", Attributes={"VisibilityTimeout": "30"})["QueueUrl"]
    arn = sqs.get_queue_attributes(QueueUrl=url, AttributeNames=["QueueArn"])["Attributes"]["QueueArn"]
    s3.create_bucket(Bucket="gone-bucket")
    state = State(environment="dev", region=REGION, account="123456789012", project_name="shop")
    state.add_resource("shared", Resource(id="jobs", type="AWS::SQS::Queue", physical_id=url,
                                          properties={"QueueName": "jobs", "VisibilityTimeout": 30, "QueueArn": arn}, metadata={"managed": True}))
    state.add_resource("shared", Resource(id="gone", type="AWS::S3::Bucket", physical_id="gone-bucket",
                                          properties={"BucketName": "gone-bucket", "VersioningStatus": "Disabled"}, metadata={"managed": True}))
    state.add_resource("shared", Resource(id="host", type="AWS::EC2::Instance", physical_id=f"arn:aws:ec2:{REGION}:123456789012:instance/{_instance(aws)}",
                                          properties={}, metadata={"adopted": True}))
    # Someone changed the queue in the console, and deleted the bucket.
    sqs.set_queue_attributes(QueueUrl=url, Attributes={"VisibilityTimeout": "90"})
    s3.delete_bucket(Bucket="gone-bucket")
    report = drift_report(aws, REGION, state)
    by_id = {i["resource_id"]: i for i in report["items"]}
    assert by_id["jobs"]["kind"] == "modified"
    assert by_id["jobs"]["differences"] == [{"key": "VisibilityTimeout", "recorded": 30, "live": 90}]
    assert by_id["gone"]["kind"] == "missing"
    assert by_id["host"]["kind"] == "unchecked" and by_id["host"]["managed"] is False
    assert report["counts"] == {"ok": 0, "modified": 1, "missing": 1, "unchecked": 1}


def test_describe_live_batches_instances_and_survives_a_bad_id(aws):
    good = _instance(aws)
    wanted = [(f"arn:aws:ec2:{REGION}:1:instance/{good}", "AWS::EC2::Instance"), (f"arn:aws:ec2:{REGION}:1:instance/i-bad", "AWS::EC2::Instance")]
    live = describe_live(aws, REGION, wanted)
    assert live[wanted[0][0]].missing is False and live[wanted[0][0]].properties["InstanceId"] == good
    assert live[wanted[1][0]].missing is True
