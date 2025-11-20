"""Cost estimation for deployments."""

from typing import Dict, List
from strands_deploy.state.models import State, Resource
from strands_deploy.utils.logging import get_logger

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
            memory_mb = resource.properties.get("MemorySize", 128)
            memory_gb = memory_mb / 1024.0
            requests = estimates["estimated_monthly_requests"]
            duration_seconds = estimates["estimated_avg_duration_ms"] / 1000.0

            # Compute cost
            gb_seconds = memory_gb * duration_seconds * requests
            compute_cost = gb_seconds * estimates["per_gb_second"]
            request_cost = requests * estimates["per_request"]

            cost = compute_cost + request_cost

        # API Gateway cost calculation
        elif resource_type in ["AWS::ApiGateway::RestApi", "AWS::ApiGatewayV2::Api"]:
            requests = estimates["estimated_monthly_requests"]
            cost = (requests / 1_000_000) * estimates["per_million_requests"]

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
            cost = estimates["base"]
            gb_processed = estimates["estimated_monthly_gb"]
            cost += gb_processed * estimates["per_gb_processed"]

        # CloudWatch Logs cost calculation
        elif resource_type == "AWS::Logs::LogGroup":
            gb_ingested = estimates["estimated_monthly_gb_ingested"]
            gb_stored = estimates["estimated_monthly_gb_stored"]

            cost = (gb_ingested * estimates["per_gb_ingested"]) + (
                gb_stored * estimates["per_gb_stored"]
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
