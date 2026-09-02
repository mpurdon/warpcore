"""Cost estimation for deployments."""

from typing import Dict
from warpcore.state.models import State, Resource
from warpcore.utils.logging import get_logger

logger = get_logger(__name__)


class CostEstimator:
    """Estimates monthly costs for deployed resources."""

    # Approximate monthly costs (USD) - these are rough estimates
    # In production, these should be configurable or fetched from AWS Pricing API
    COST_ESTIMATES = {
        "AWS::Lambda::Function": {
            "base": 0.0,  # First 1M requests free
            "per_gb_second": 0.0000166667,  # $0.00001667 per GB-second
            "per_request": 0.0000002,  # $0.20 per 1M requests
            "estimated_monthly_requests": 100000,  # Assume 100k requests/month
            "estimated_avg_duration_ms": 1000,  # Assume 1s average duration
        },
        "AWS::ApiGateway::RestApi": {
            "base": 0.0,
            "per_million_requests": 3.50,  # $3.50 per million requests
            "estimated_monthly_requests": 100000,
        },
        "AWS::ApiGatewayV2::Api": {
            "base": 0.0,
            "per_million_requests": 1.00,  # $1.00 per million requests (HTTP API)
            "estimated_monthly_requests": 100000,
        },
        "AWS::DynamoDB::Table": {
            "base": 0.0,  # On-demand pricing
            "per_million_read_requests": 0.25,
            "per_million_write_requests": 1.25,
            "per_gb_storage": 0.25,
            "estimated_monthly_reads": 100000,
            "estimated_monthly_writes": 50000,
            "estimated_storage_gb": 1,
        },
        "AWS::S3::Bucket": {
            "base": 0.0,
            "per_gb_storage": 0.023,  # Standard storage
            "per_1000_put_requests": 0.005,
            "per_1000_get_requests": 0.0004,
            "estimated_storage_gb": 5,
            "estimated_monthly_puts": 10000,
            "estimated_monthly_gets": 50000,
        },
        "AWS::SQS::Queue": {
            "base": 0.0,  # First 1M requests free
            "per_million_requests": 0.40,
            "estimated_monthly_requests": 100000,
        },
        "AWS::SNS::Topic": {
            "base": 0.0,  # First 1M requests free
            "per_million_requests": 0.50,
            "estimated_monthly_notifications": 100000,
        },
        "AWS::EC2::VPC": {
            "base": 0.0,  # VPC itself is free
        },
        "AWS::EC2::Subnet": {
            "base": 0.0,
        },
        "AWS::EC2::InternetGateway": {
            "base": 0.0,
        },
        "AWS::EC2::NatGateway": {
            "base": 32.85,  # $0.045/hour * 730 hours
            "per_gb_processed": 0.045,
            "estimated_monthly_gb": 100,
        },
        "AWS::EC2::SecurityGroup": {
            "base": 0.0,
        },
        "AWS::IAM::Role": {
            "base": 0.0,
        },
        "AWS::Logs::LogGroup": {
            "base": 0.0,
            "per_gb_ingested": 0.50,
            "per_gb_stored": 0.03,
            "estimated_monthly_gb_ingested": 1,
            "estimated_monthly_gb_stored": 5,
        },
    }

    # Pricing that is not attached to a single resource type in the table above.
    XRAY_PER_MILLION_TRACES = 5.00       # traces recorded
    VPC_ENDPOINT_PER_HOUR = 0.01         # per interface endpoint, per AZ
    HOURS_PER_MONTH = 730                # ~30.4 days

    # --------------------------------------------------------------- pricing
    #
    # These take raw parameters rather than a Resource so that callers who only
    # have a config - `warpcore forecast`, which runs before anything is
    # deployed - can price a change without inventing a State first.
    # estimate_resource_cost() below delegates to them, so the two paths cannot
    # drift apart.

    def estimate_lambda_cost(
        self, memory_mb: int, duration_ms: float, requests: int
    ) -> float:
        """Monthly Lambda cost for a given size, duration and request volume."""
        estimates = self.COST_ESTIMATES["AWS::Lambda::Function"]
        gb_seconds = (memory_mb / 1024.0) * (duration_ms / 1000.0) * requests
        compute_cost = gb_seconds * estimates["per_gb_second"]
        request_cost = requests * estimates["per_request"]
        return compute_cost + request_cost

    def estimate_api_gateway_cost(self, requests: int, api_type: str = "http") -> float:
        """API Gateway cost. HTTP APIs are markedly cheaper than REST APIs."""
        key = (
            "AWS::ApiGatewayV2::Api" if api_type == "http"
            else "AWS::ApiGateway::RestApi"
        )
        estimates = self.COST_ESTIMATES[key]
        return (requests / 1_000_000) * estimates["per_million_requests"]

    def estimate_cloudwatch_logs_cost(
        self, data_ingested_gb: float, data_stored_gb: float = 0.0
    ) -> float:
        """CloudWatch Logs cost for ingestion plus retained storage."""
        estimates = self.COST_ESTIMATES["AWS::Logs::LogGroup"]
        return (
            data_ingested_gb * estimates["per_gb_ingested"]
            + data_stored_gb * estimates["per_gb_stored"]
        )

    def estimate_xray_cost(self, traces: int) -> float:
        """X-Ray cost for recorded traces."""
        return (traces / 1_000_000) * self.XRAY_PER_MILLION_TRACES

    def estimate_nat_gateway_cost(self, hours: float, data_processed_gb: float) -> float:
        """NAT Gateway cost: hourly charge plus per-GB data processing."""
        estimates = self.COST_ESTIMATES["AWS::EC2::NatGateway"]
        # `base` in the table is a monthly figure; convert back to hourly so an
        # arbitrary period can be priced.
        hourly_rate = estimates["base"] / self.HOURS_PER_MONTH
        return hours * hourly_rate + data_processed_gb * estimates["per_gb_processed"]

    def estimate_vpc_endpoint_cost(self, endpoint_count: int, hours: float) -> float:
        """Interface VPC endpoint cost. Data processing is not included."""
        return endpoint_count * hours * self.VPC_ENDPOINT_PER_HOUR

    # ---------------------------------------------------------------- states

    def estimate_deployment_cost(self, state: State) -> float:
        """
        Estimate monthly cost for a deployment.

        Args:
            state: Deployment state

        Returns:
            Estimated monthly cost in USD
        """
        total_cost = 0.0

        for _, resource in state.all_resources():
            cost = self.estimate_resource_cost(resource)
            total_cost += cost
            logger.debug(f"Estimated cost for {resource.id}: ${cost:.2f}/month")

        logger.info(f"Total estimated monthly cost: ${total_cost:.2f}")
        return total_cost

    def estimate_resource_cost(self, resource: Resource) -> float:
        """
        Estimate monthly cost for a single resource.

        Args:
            resource: Resource to estimate

        Returns:
            Estimated monthly cost in USD
        """
        resource_type = resource.type
        estimates = self.COST_ESTIMATES.get(resource_type)

        if not estimates:
            logger.debug(f"No cost estimate available for {resource_type}")
            return 0.0

        cost = estimates.get("base", 0.0)

        # Lambda function cost calculation
        if resource_type == "AWS::Lambda::Function":
            cost = self.estimate_lambda_cost(
                memory_mb=resource.properties.get("MemorySize", 128),
                duration_ms=estimates["estimated_avg_duration_ms"],
                requests=estimates["estimated_monthly_requests"],
            )

        # API Gateway cost calculation
        elif resource_type in ["AWS::ApiGateway::RestApi", "AWS::ApiGatewayV2::Api"]:
            cost = self.estimate_api_gateway_cost(
                requests=estimates["estimated_monthly_requests"],
                api_type="http" if resource_type == "AWS::ApiGatewayV2::Api" else "rest",
            )

        # DynamoDB cost calculation
        elif resource_type == "AWS::DynamoDB::Table":
            reads = estimates["estimated_monthly_reads"]
            writes = estimates["estimated_monthly_writes"]
            storage_gb = estimates["estimated_storage_gb"]

            read_cost = (reads / 1_000_000) * estimates["per_million_read_requests"]
            write_cost = (writes / 1_000_000) * estimates["per_million_write_requests"]
            storage_cost = storage_gb * estimates["per_gb_storage"]

            cost = read_cost + write_cost + storage_cost

        # S3 cost calculation
        elif resource_type == "AWS::S3::Bucket":
            storage_gb = estimates["estimated_storage_gb"]
            puts = estimates["estimated_monthly_puts"]
            gets = estimates["estimated_monthly_gets"]

            storage_cost = storage_gb * estimates["per_gb_storage"]
            put_cost = (puts / 1000) * estimates["per_1000_put_requests"]
            get_cost = (gets / 1000) * estimates["per_1000_get_requests"]

            cost = storage_cost + put_cost + get_cost

        # SQS cost calculation
        elif resource_type == "AWS::SQS::Queue":
            requests = estimates["estimated_monthly_requests"]
            if requests > 1_000_000:
                cost = ((requests - 1_000_000) / 1_000_000) * estimates["per_million_requests"]

        # SNS cost calculation
        elif resource_type == "AWS::SNS::Topic":
            notifications = estimates["estimated_monthly_notifications"]
            if notifications > 1_000_000:
                cost = (
                    (notifications - 1_000_000) / 1_000_000
                ) * estimates["per_million_requests"]

        # NAT Gateway cost calculation
        elif resource_type == "AWS::EC2::NatGateway":
            cost = self.estimate_nat_gateway_cost(
                hours=self.HOURS_PER_MONTH,
                data_processed_gb=estimates["estimated_monthly_gb"],
            )

        # CloudWatch Logs cost calculation
        elif resource_type == "AWS::Logs::LogGroup":
            cost = self.estimate_cloudwatch_logs_cost(
                data_ingested_gb=estimates["estimated_monthly_gb_ingested"],
                data_stored_gb=estimates["estimated_monthly_gb_stored"],
            )

        return cost

    def get_cost_breakdown(self, state: State) -> Dict[str, float]:
        """
        Get cost breakdown by resource type.

        Args:
            state: Deployment state

        Returns:
            Dictionary mapping resource types to estimated costs
        """
        breakdown = {}

        for _, resource in state.all_resources():
            resource_type = resource.type
            cost = self.estimate_resource_cost(resource)

            if resource_type not in breakdown:
                breakdown[resource_type] = 0.0
            breakdown[resource_type] += cost

        return breakdown

    def compare_costs(self, state1: State, state2: State) -> Dict[str, float]:
        """
        Compare costs between two states.

        Args:
            state1: First state
            state2: Second state

        Returns:
            Dictionary with cost comparison
        """
        cost1 = self.estimate_deployment_cost(state1)
        cost2 = self.estimate_deployment_cost(state2)

        breakdown1 = self.get_cost_breakdown(state1)
        breakdown2 = self.get_cost_breakdown(state2)

        # Calculate differences by resource type
        all_types = set(breakdown1.keys()) | set(breakdown2.keys())
        type_diffs = {}
        for resource_type in all_types:
            diff = breakdown2.get(resource_type, 0.0) - breakdown1.get(resource_type, 0.0)
            if abs(diff) > 0.01:  # Only include significant differences
                type_diffs[resource_type] = diff

        return {
            "total_cost_before": cost1,
            "total_cost_after": cost2,
            "total_difference": cost2 - cost1,
            "by_resource_type": type_diffs,
        }
