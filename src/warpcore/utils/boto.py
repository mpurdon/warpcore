"""Shared boto3 client construction for discovery.

Discovery fans out hard: every enabled region in parallel, and within each
region a dozen services at once. On botocore's default retry behaviour that is
a reliable way to get throttled, and a throttled call surfaces as a missing
resource rather than an error - the inventory just comes back short.

Every client used by discovery is built here so three things are true of all
of them:

  * adaptive retries, which measure the throttle rate AWS is applying and slow
    the client down to match, rather than retrying into the same wall
  * a connection pool large enough for the fan-out, so parallelism is not
    silently serialised by connections queueing
  * one client per (service, region), cached, because creating clients is slow
    and doing it from many threads is the part of botocore people get bitten by
"""

import threading
from typing import Dict, Optional, Tuple

import boto3
from botocore.config import Config

from warpcore.utils.logging import get_logger

logger = get_logger(__name__)

# Adaptive mode adds client-side rate limiting on top of retries: botocore
# tracks throttling responses and throttles itself to the rate AWS will accept.
# That is what makes a wide parallel scan safe rather than merely retried.
DISCOVERY_CONFIG = Config(
    retries={"mode": "adaptive", "max_attempts": 8},
    # Must comfortably exceed regions x services in flight, or connections
    # queue and the scan is serialised without any visible error.
    max_pool_connections=64,
    connect_timeout=10,
    read_timeout=60,
    user_agent_extra="warpcore-discovery",
)


class ClientFactory:
    """Caches configured clients per (service, region).

    Bound to one boto3 Session. Safe to share across the scan's threads.
    """

    def __init__(self, session: boto3.Session, config: Optional[Config] = None):
        self.session = session
        self.config = config or DISCOVERY_CONFIG
        self._clients: Dict[Tuple[str, Optional[str]], object] = {}
        self._lock = threading.Lock()

    def client(self, service: str, region: Optional[str] = None):
        """A configured client, created once per service and region."""
        key = (service, region)
        # Fast path without the lock; dict reads are atomic under the GIL.
        existing = self._clients.get(key)
        if existing is not None:
            return existing

        with self._lock:
            # Another thread may have created it while this one waited.
            existing = self._clients.get(key)
            if existing is not None:
                return existing
            created = self.session.client(service, region_name=region, config=self.config)
            self._clients[key] = created
            return created


_FACTORIES: Dict[int, ClientFactory] = {}
_FACTORIES_LOCK = threading.Lock()


def client_factory(session: boto3.Session) -> ClientFactory:
    """The ClientFactory for a session, created on first use.

    Keyed on the session so every component in one scan - scanner, enumerator,
    Resource Explorer, detail readers - shares a pool and a cache rather than
    each building its own.
    """
    key = id(session)
    existing = _FACTORIES.get(key)
    if existing is not None:
        return existing
    with _FACTORIES_LOCK:
        existing = _FACTORIES.get(key)
        if existing is not None:
            return existing
        factory = ClientFactory(session)
        _FACTORIES[key] = factory
        return factory


def discovery_client(session: boto3.Session, service: str, region: Optional[str] = None):
    """Configured, cached client for a service in a region."""
    return client_factory(session).client(service, region)
