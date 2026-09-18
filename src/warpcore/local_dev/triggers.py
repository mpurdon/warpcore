"""Live triggers for local development: events from deployed resources,
delivered to the handler running on this machine.

The deployed queue keeps receiving what the account sends it; `warpcore dev
--from-queue orders` long-polls that queue and calls the local handler with
the same SQS-shaped event Lambda would have given it. A message the handler
accepts is deleted; one it raises on stays and returns after the queue's
visibility timeout, exactly as it would in Lambda. Nothing is deployed and
nothing in the account changes shape: this is a consumer, not a stub.

Queues first because they are the trigger a local process can take over
safely: an API route or a bucket notification points at a function, and
taking that over means changing the account. Those stay as they are.
"""

from __future__ import annotations

import hashlib
import threading
from typing import Any, Callable, Dict, Iterable, List, Optional

import boto3

from ..state.models import State
from ..utils.logging import get_logger

logger = get_logger(__name__)

Handler = Callable[[Dict[str, Any], Any], Any]

ENV_QUEUES = "WARPCORE_DEV_QUEUES"


class _Context:
    """The little Lambda gives a handler, as far as a local one needs."""

    function_name = "local"
    memory_limit_in_mb = 0
    aws_request_id = "local"

    def get_remaining_time_in_millis(self) -> int:  # noqa: D401 - Lambda's name
        return 60_000


def queue_arn(queue_url: str, region: str) -> str:
    # https://sqs.<region>.amazonaws.com/<account>/<name>
    parts = queue_url.rstrip("/").split("/")
    account, name = parts[-2], parts[-1]
    return f"arn:aws:sqs:{region}:{account}:{name}"


def sqs_event(messages: Iterable[Dict[str, Any]], queue_url: str, region: str) -> Dict[str, Any]:
    """The event Lambda would receive for these messages."""
    arn = queue_arn(queue_url, region)
    records = []
    for m in messages:
        body = m.get("Body", "")
        records.append({
            "messageId": m.get("MessageId"),
            "receiptHandle": m.get("ReceiptHandle"),
            "body": body,
            "attributes": m.get("Attributes") or {},
            "messageAttributes": m.get("MessageAttributes") or {},
            "md5OfBody": m.get("MD5OfBody") or hashlib.md5(body.encode()).hexdigest(),  # noqa: S324 - SQS's own checksum
            "eventSource": "aws:sqs",
            "eventSourceARN": arn,
            "awsRegion": region,
        })
    return {"Records": records}


def queue_urls_from_state(state: State, wanted: Iterable[str]) -> List[str]:
    """Resolve each name to a queue URL: a resource id, a queue name, an ARN, or already a URL."""
    out: List[str] = []
    entries = [r for _stack, r in state.all_resources() if r.type == "AWS::SQS::Queue"]
    for name in wanted:
        if name.startswith("https://"):
            out.append(name)
            continue
        hit = None
        for r in entries:
            url = (r.properties or {}).get("QueueUrl") or (r.physical_id if str(r.physical_id).startswith("https://") else None)
            arn = (r.properties or {}).get("QueueArn") or (r.physical_id if str(r.physical_id).startswith("arn:") else None)
            qname = (r.properties or {}).get("QueueName") or (url.rstrip("/").split("/")[-1] if url else None)
            if name in (r.id, arn, qname) and url:
                hit = url
                break
        if hit is None:
            raise ValueError(f"no queue named {name} in the deployment state; give a queue URL or deploy it first")
        out.append(hit)
    return out


class QueueRelay:
    """One queue, long-polled, delivered to the handler in batches."""

    def __init__(self, session: boto3.Session, region: str, queue_url: str, handler: Handler,
                 batch: int = 10, wait_seconds: int = 20, log: Callable[[str], None] = logger.info):
        self.sqs = session.client("sqs", region_name=region)
        self.region = region
        self.queue_url = queue_url
        self.handler = handler
        self.batch = max(1, min(10, batch))
        self.wait_seconds = max(0, min(20, wait_seconds))
        self.log = log
        self.delivered = 0
        self.failed = 0

    def poll_once(self) -> int:
        """Receive up to a batch, call the handler once with all of it. Returns the messages received."""
        resp = self.sqs.receive_message(
            QueueUrl=self.queue_url, MaxNumberOfMessages=self.batch, WaitTimeSeconds=self.wait_seconds,
            AttributeNames=["All"], MessageAttributeNames=["All"],
        )
        messages = resp.get("Messages") or []
        if not messages:
            return 0
        event = sqs_event(messages, self.queue_url, self.region)
        name = self.queue_url.rstrip("/").split("/")[-1]
        try:
            self.handler(event, _Context())
        except Exception as e:  # noqa: BLE001 - the handler's failure is the point of the log line
            self.failed += len(messages)
            self.log(f"[{name}] handler raised on {len(messages)} message(s); they return after the visibility timeout: {e}")
            return len(messages)
        self.sqs.delete_message_batch(
            QueueUrl=self.queue_url,
            Entries=[{"Id": str(i), "ReceiptHandle": m["ReceiptHandle"]} for i, m in enumerate(messages)],
        )
        self.delivered += len(messages)
        self.log(f"[{name}] delivered {len(messages)} message(s) to the local handler")
        return len(messages)

    def run(self, stop: threading.Event) -> None:
        while not stop.is_set():
            try:
                self.poll_once()
            except Exception as e:  # noqa: BLE001 - a failed poll is a log line, not the end
                self.log(f"[{self.queue_url}] poll failed: {e}")
                stop.wait(5)


def run_relays(handler: Handler, queue_urls: List[str], region: str, profile: Optional[str] = None,
               stop: Optional[threading.Event] = None, log: Callable[[str], None] = print) -> List[QueueRelay]:
    """One thread per queue until `stop` is set (or Ctrl+C when no event is given)."""
    session = boto3.Session(profile_name=profile, region_name=region)
    relays = [QueueRelay(session, region, url, handler, log=log) for url in queue_urls]
    own_stop = stop is None
    stop = stop or threading.Event()
    threads = [threading.Thread(target=r.run, args=(stop,), daemon=True, name=f"relay:{r.queue_url}") for r in relays]
    for t in threads:
        t.start()
    if own_stop:
        try:
            while any(t.is_alive() for t in threads):
                stop.wait(1)
        except KeyboardInterrupt:
            stop.set()
    return relays


def parse_queue_env(value: Optional[str]) -> List[str]:
    return [v for v in (value or "").split(",") if v]


__all__ = ["QueueRelay", "run_relays", "sqs_event", "queue_urls_from_state", "queue_arn", "parse_queue_env", "ENV_QUEUES"]

