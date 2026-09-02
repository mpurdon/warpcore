"""Account-wide inventory across regions.

AWSScanner is bound to one region. This drives one scanner per region and
merges the results, so "what is in this account" can be answered for the whole
account rather than one region at a time.

Global services (IAM, S3, Route 53, CloudFront) are returned by every region's
scan; merging by ARN reports each once.
"""

from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Sequence

import boto3
from botocore.exceptions import BotoCoreError, ClientError

from warpcore.agentic.scanner import AWSScanner, ScanError, ScanScope, ScannedState
from warpcore.utils.boto import discovery_client
from warpcore.utils.logging import get_logger
from warpcore.utils.progress import (
    REGION_DONE,
    REGION_START,
    SCAN_DONE,
    SCAN_START,
    ProgressCallback,
    ProgressEmitter,
)

logger = get_logger(__name__)


@dataclass
class RegionResult:
    """What one region contributed."""

    region: str
    resource_count: int = 0
    explorer_available: bool = False
    errors: int = 0
    failed: Optional[str] = None


@dataclass
class AccountInventory:
    """Merged result of scanning several regions."""

    account: str
    regions: List[RegionResult] = field(default_factory=list)
    scanned: ScannedState = field(default_factory=ScannedState)

    def region_summary(self) -> Dict[str, int]:
        return {r.region: r.resource_count for r in self.regions}


def enabled_regions(session: boto3.Session, seed_region: str = "us-east-1") -> List[str]:
    """Regions this account can use.

    describe_regions is itself regional; any region that works will do to
    ask the question.
    """
    ec2 = discovery_client(session, "ec2", seed_region)
    response = ec2.describe_regions(AllRegions=False)
    return sorted(r["RegionName"] for r in response.get("Regions", []))


def scan_account(
    session: boto3.Session,
    account: str,
    regions: Sequence[str],
    hydrate: bool = False,
    resource_types: Optional[Sequence[str]] = None,
    max_per_region: Optional[int] = None,
    max_workers: int = 4,
    progress: Optional[ProgressCallback] = None,
) -> AccountInventory:
    """Scan several regions and merge them into one inventory.

    Regions are scanned in parallel; a region that fails is recorded and the
    others still complete. Hydration is per-region because detail calls are
    regional.

    `progress`, when given, receives an event as each region and each service
    within it starts and finishes. Every AWS client used here is built with
    adaptive retries, so widening `max_workers` makes the scan back off under
    throttling rather than fail.
    """
    inventory = AccountInventory(account=account)
    inventory.scanned.explorer_available = False
    emitter = ProgressEmitter(progress)
    emitter.emit(
        SCAN_START, account=account, regions=list(regions), hydrate=hydrate,
        parallelism=max_workers,
    )

    def scan_one(region: str) -> tuple:
        region_progress = emitter.child(region=region)
        region_progress.emit(REGION_START)
        scanner = AWSScanner(
            boto_session=session,
            project_name="",
            environment="",
            region=region,
            account=account,
        )
        state = scanner.scan_resources(
            scope=ScanScope.ACCOUNT,
            hydrate=hydrate,
            resource_types=resource_types,
            max_resources=max_per_region,
            progress=region_progress,
        )
        return region, state

    with ThreadPoolExecutor(max_workers=max_workers) as pool:
        futures = {pool.submit(scan_one, region): region for region in regions}
        for future in as_completed(futures):
            region = futures[future]
            try:
                _, state = future.result()
            except (ClientError, BotoCoreError, Exception) as e:  # noqa: BLE001
                logger.warning(f"Scan of {region} failed: {e}")
                emitter.emit(REGION_DONE, region=region, status="failed", error=str(e))
                inventory.regions.append(RegionResult(region=region, failed=str(e)))
                inventory.scanned.add_error(ScanError(
                    physical_id=f"(region: {region})",
                    resource_type="region",
                    stage="enumerate",
                    message=str(e),
                ))
                continue

            emitter.emit(
                REGION_DONE, region=region, status="done",
                count=len(state.resources),
                explorer=state.explorer_available,
                errors=len(state.errors),
            )
            inventory.regions.append(RegionResult(
                region=region,
                resource_count=len(state.resources),
                explorer_available=state.explorer_available,
                errors=len(state.errors),
            ))
            inventory.scanned.explorer_available |= state.explorer_available

            for resource in state.get_all_resources():
                # Stamp the region so a merged list still says where each
                # resource lives; global resources keep the first region seen.
                resource.metadata.setdefault("region", region)
                if not inventory.scanned.has_resource(resource.physical_id or ""):
                    inventory.scanned.add_resource(resource)
            for error in state.errors:
                inventory.scanned.add_error(error)
            for rtype, count in state.unhydrated.items():
                inventory.scanned.unhydrated[rtype] = (
                    inventory.scanned.unhydrated.get(rtype, 0) + count
                )

    inventory.regions.sort(key=lambda r: r.region)
    emitter.emit(
        SCAN_DONE, total=len(inventory.scanned.resources),
        regions=len(inventory.regions),
        failed=sum(1 for r in inventory.regions if r.failed),
    )
    logger.info(
        f"Account {account}: {len(inventory.scanned.resources)} resources "
        f"across {len(regions)} region(s)"
    )
    return inventory
