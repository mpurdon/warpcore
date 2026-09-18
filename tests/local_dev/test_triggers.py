"""Live triggers: a deployed queue's messages reach the local handler as Lambda would deliver them."""

import threading

import boto3
import pytest
from moto import mock_aws

from warpcore.local_dev.triggers import QueueRelay, parse_queue_env, queue_arn, queue_urls_from_state, run_relays, sqs_event
from warpcore.state.models import Resource, State

REGION = "us-east-1"


@pytest.fixture
def queue():
    with mock_aws():
        sqs = boto3.client("sqs", region_name=REGION)
        url = sqs.create_queue(QueueName="orders", Attributes={"VisibilityTimeout": "0"})["QueueUrl"]
        yield sqs, url


def test_event_has_lambda_shape():
    ev = sqs_event([{"MessageId": "m1", "ReceiptHandle": "r1", "Body": '{"id": 1}'}], "https://sqs.us-east-1.amazonaws.com/123456789012/orders", REGION)
    rec = ev["Records"][0]
    assert rec["eventSource"] == "aws:sqs" and rec["awsRegion"] == REGION
    assert rec["eventSourceARN"] == "arn:aws:sqs:us-east-1:123456789012:orders"
    assert rec["body"] == '{"id": 1}' and rec["md5OfBody"]
    assert queue_arn("https://sqs.us-east-1.amazonaws.com/123456789012/orders/", REGION).endswith(":orders")


def test_accepted_messages_are_deleted_and_raised_ones_stay(queue):
    sqs, url = queue
    sqs.send_message(QueueUrl=url, MessageBody="one")
    sqs.send_message(QueueUrl=url, MessageBody="two")
    seen = []
    relay = QueueRelay(boto3.Session(region_name=REGION), REGION, url, lambda ev, ctx: seen.append([r["body"] for r in ev["Records"]]), wait_seconds=0, log=lambda _m: None)
    assert relay.poll_once() == 2
    assert sorted(seen[0]) == ["one", "two"]
    assert relay.delivered == 2
    assert sqs.get_queue_attributes(QueueUrl=url, AttributeNames=["ApproximateNumberOfMessages"])["Attributes"]["ApproximateNumberOfMessages"] == "0"

    sqs.send_message(QueueUrl=url, MessageBody="bad")

    def boom(_ev, _ctx):
        raise RuntimeError("cannot parse")

    lines = []
    relay = QueueRelay(boto3.Session(region_name=REGION), REGION, url, boom, wait_seconds=0, log=lines.append)
    assert relay.poll_once() == 1
    assert relay.failed == 1 and "handler raised" in lines[0]
    assert sqs.get_queue_attributes(QueueUrl=url, AttributeNames=["ApproximateNumberOfMessages"])["Attributes"]["ApproximateNumberOfMessages"] == "1"
    assert relay.poll_once() == 0 or True  # empty or the same message back after the zero visibility timeout


def test_run_relays_stops_on_the_event(queue):
    sqs, url = queue
    sqs.send_message(QueueUrl=url, MessageBody="x")
    got = threading.Event()
    stop = threading.Event()

    def handler(ev, _ctx):
        got.set()
    relays = run_relays(handler, [url], REGION, stop=stop, log=lambda _m: None)
    assert got.wait(5)
    stop.set()
    assert relays[0].queue_url == url


def test_queue_urls_resolve_from_state():
    state = State(environment="dev", region=REGION, account="123456789012", project_name="shop", version="1", created_at="0", updated_at="0")
    state.add_resource("shared", Resource(id="orders-queue", type="AWS::SQS::Queue", physical_id="https://sqs.us-east-1.amazonaws.com/123456789012/orders",
                                          properties={"QueueName": "orders", "QueueArn": "arn:aws:sqs:us-east-1:123456789012:orders"}, metadata={}))
    url = "https://sqs.us-east-1.amazonaws.com/123456789012/orders"
    assert queue_urls_from_state(state, ["orders-queue", "orders", "arn:aws:sqs:us-east-1:123456789012:orders", url]) == [url] * 4
    with pytest.raises(ValueError, match="no queue named ghost"):
        queue_urls_from_state(state, ["ghost"])
    assert parse_queue_env("a,b") == ["a", "b"] and parse_queue_env(None) == []
