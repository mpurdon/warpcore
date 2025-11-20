"""Cost management and allocation tag activation."""

from datetime import datetime, timedelta
from typing import Dict, List, Optional
from strands_deploy.utils.logging import get_logger

logger = get_logger(__name__)


class CostManager:
    """Manages cost allocation tags and cost reporting."""

    def __init__(self, boto_session):
        """Initialize cost manager.

        Args:
            boto_session: Boto3 session for AWS API calls
        """
        self.boto_session = boto_session
        self.ce_client = boto_session.client("ce")  # Cost Explorer
        logger.info("Initialized CostManager")

    def activate_cost_allocation_tags(self, tag_keys: List[str]) -> Dict[str, bool]:
        """Activate cost allocation tags in AWS Cost Explorer.

        Args:
            tag_keys: List of tag keys to activate for cost allocation

        Returns:
            Dictionary mapping tag keys to activation status (True if successful)
        """
        results = {}

        try:
            # Get current cost allocation tag status
            response = self.ce_client.list_cost_allocation_tags(Status="Active", MaxResults=100)
            active_tags = {tag["TagKey"] for tag in response.get("CostAllocationTags", [])}

            # Activate tags that aren't already active
            tags_to_activate = [key for key in tag_keys if key not in active_tags]

            if tags_to_activate:
                self.ce_client.update_cost_allocation_tags_status(
                    CostAllocationTagsStatus=[
                        {"TagKey": key, "Status": "Active"} for key in tags_to_activate
                    ]
                )
                logger.info(f"Activated {len(tags_to_activate)} cost allocation tags")

                for key in tags_to_activate:
                    results[key] = True
            else:
                logger.info("All requested cost allocation tags are already active")

            # Mark already active tags as successful
            for key in tag_keys:
                if key in active_tags:
                    results[key] = True

        except Exception as e:
            logger.error(f"Failed to activate cost allocation tags: {e}")
            for key in tag_keys:
                results[key] = False

        return results

    def get_costs_by_tag(
        self,
        tag_key: str,
        start_date: Optional[datetime] = None,
        end_date: Optional[datetime] = None,
        granularity: str = "MONTHLY",
    ) -> Dict[str, float]:
        """Get costs grouped by a specific tag.

        Args:
            tag_key: Tag key to group costs by (e.g., 'strands:environment')
            start_date: Start date for cost query (defaults to 30 days ago)
            end_date: End date for cost query (defaults to today)
            granularity: Cost granularity ('DAILY', 'MONTHLY', 'HOURLY')

        Returns:
            Dictionary mapping tag values to costs in USD
        """
        if start_date is None:
            start_date = datetime.utcnow() - timedelta(days=30)
        if end_date is None:
            end_date = datetime.utcnow()

        try:
            response = self.ce_client.get_cost_and_usage(
                TimePeriod={
                    "Start": start_date.strftime("%Y-%m-%d"),
                    "End": end_date.strftime("%Y-%m-%d"),
                },
                Granularity=granularity,
                Metrics=["UnblendedCost"],
                GroupBy=[{"Type": "TAG", "Key": tag_key}],
            )

            costs = {}
            for result in response.get("ResultsByTime", []):
                for group in result.get("Groups", []):
                    tag_value = group["Keys"][0].split("$")[-1]  # Extract value from "tag$value"
                    amount = float(group["Metrics"]["UnblendedCost"]["Amount"])

                    if tag_value in costs:
                        costs[tag_value] += amount
                    else:
                        costs[tag_value] = amount

            logger.info(f"Retrieved costs for {len(costs)} tag values of '{tag_key}'")
            return costs

        except Exception as e:
            logger.error(f"Failed to get costs by tag '{tag_key}': {e}")
            return {}

    def get_project_costs(
        self,
        project_name: str,
        start_date: Optional[datetime] = None,
        end_date: Optional[datetime] = None,
    ) -> float:
        """Get total costs for a specific project.

        Args:
            project_name: Project name to get costs for
            start_date: Start date for cost query (defaults to 30 days ago)
            end_date: End date for cost query (defaults to today)

        Returns:
            Total cost in USD
        """
        costs = self.get_costs_by_tag("strands:project", start_date, end_date)
        return costs.get(project_name, 0.0)

    def get_environment_costs(
        self,
        environment: str,
        start_date: Optional[datetime] = None,
        end_date: Optional[datetime] = None,
    ) -> float:
        """Get total costs for a specific environment.

        Args:
            environment: Environment name to get costs for
            start_date: Start date for cost query (defaults to 30 days ago)
            end_date: End date for cost query (defaults to today)

        Returns:
            Total cost in USD
        """
        costs = self.get_costs_by_tag("strands:environment", start_date, end_date)
        return costs.get(environment, 0.0)

    def get_agent_costs(
        self,
        agent_name: str,
        start_date: Optional[datetime] = None,
        end_date: Optional[datetime] = None,
    ) -> float:
        """Get total costs for a specific agent.

        Args:
            agent_name: Agent name to get costs for
            start_date: Start date for cost query (defaults to 30 days ago)
            end_date: End date for cost query (defaults to today)

        Returns:
            Total cost in USD
        """
        costs = self.get_costs_by_tag("strands:agent", start_date, end_date)
        return costs.get(agent_name, 0.0)

    def get_cost_breakdown(
        self,
        project_name: Optional[str] = None,
        environment: Optional[str] = None,
        start_date: Optional[datetime] = None,
        end_date: Optional[datetime] = None,
    ) -> Dict[str, Dict[str, float]]:
        """Get detailed cost breakdown by service and tag.

        Args:
            project_name: Optional project name filter
            environment: Optional environment filter
            start_date: Start date for cost query (defaults to 30 days ago)
            end_date: End date for cost query (defaults to today)

        Returns:
            Dictionary with cost breakdown by service and tags
        """
        if start_date is None:
            start_date = datetime.utcnow() - timedelta(days=30)
        if end_date is None:
            end_date = datetime.utcnow()

        try:
            # Build filter expression
            filter_expr = None
            if project_name:
                filter_expr = {"Tags": {"Key": "strands:project", "Values": [project_name]}}
            if environment:
                env_filter = {"Tags": {"Key": "strands:environment", "Values": [environment]}}
                if filter_expr:
                    filter_expr = {"And": [filter_expr, env_filter]}
                else:
                    filter_expr = env_filter

            # Get costs by service
            kwargs = {
                "TimePeriod": {
                    "Start": start_date.strftime("%Y-%m-%d"),
                    "End": end_date.strftime("%Y-%m-%d"),
                },
                "Granularity": "MONTHLY",
                "Metrics": ["UnblendedCost"],
                "GroupBy": [{"Type": "SERVICE", "Key": "SERVICE"}],
            }

            if filter_expr:
                kwargs["Filter"] = filter_expr

            response = self.ce_client.get_cost_and_usage(**kwargs)

            breakdown = {"by_service": {}, "total": 0.0}

            for result in response.get("ResultsByTime", []):
                for group in result.get("Groups", []):
                    service = group["Keys"][0]
                    amount = float(group["Metrics"]["UnblendedCost"]["Amount"])

                    if service in breakdown["by_service"]:
                        breakdown["by_service"][service] += amount
                    else:
                        breakdown["by_service"][service] = amount

                    breakdown["total"] += amount

            logger.info(f"Retrieved cost breakdown for {len(breakdown['by_service'])} services")
            return breakdown

        except Exception as e:
            logger.error(f"Failed to get cost breakdown: {e}")
            return {"by_service": {}, "total": 0.0}

    def set_budget_alert(
        self,
        budget_name: str,
        limit_amount: float,
        alert_threshold: int = 80,
        email_addresses: Optional[List[str]] = None,
        tag_filters: Optional[Dict[str, str]] = None,
    ) -> bool:
        """Create a budget alert for cost monitoring.

        Args:
            budget_name: Name for the budget
            limit_amount: Budget limit in USD
            alert_threshold: Percentage threshold for alert (default 80%)
            email_addresses: List of email addresses to notify
            tag_filters: Optional tag filters for the budget (e.g., {'strands:environment': 'prod'})

        Returns:
            True if budget was created successfully, False otherwise
        """
        try:
            budgets_client = self.boto_session.client("budgets")

            # Get account ID
            sts_client = self.boto_session.client("sts")
            account_id = sts_client.get_caller_identity()["Account"]

            # Build budget definition
            budget = {
                "BudgetName": budget_name,
                "BudgetLimit": {"Amount": str(limit_amount), "Unit": "USD"},
                "TimeUnit": "MONTHLY",
                "BudgetType": "COST",
            }

            # Add cost filters if tag filters provided
            if tag_filters:
                budget["CostFilters"] = {
                    f"tag:{key}": [value] for key, value in tag_filters.items()
                }

            # Build notification
            notifications = []
            if email_addresses:
                notifications.append(
                    {
                        "Notification": {
                            "NotificationType": "ACTUAL",
                            "ComparisonOperator": "GREATER_THAN",
                            "Threshold": alert_threshold,
                            "ThresholdType": "PERCENTAGE",
                        },
                        "Subscribers": [
                            {"SubscriptionType": "EMAIL", "Address": email}
                            for email in email_addresses
                        ],
                    }
                )

            # Create budget
            budgets_client.create_budget(
                AccountId=account_id,
                Budget=budget,
                NotificationsWithSubscribers=notifications,
            )

            logger.info(f"Created budget alert '{budget_name}' with ${limit_amount} limit")
            return True

        except Exception as e:
            logger.error(f"Failed to create budget alert: {e}")
            return False

    def get_cost_forecast(
        self, days_ahead: int = 30, tag_filters: Optional[Dict[str, str]] = None
    ) -> float:
        """Get cost forecast for the next N days.

        Args:
            days_ahead: Number of days to forecast (default 30)
            tag_filters: Optional tag filters for the forecast

        Returns:
            Forecasted cost in USD
        """
        try:
            start_date = datetime.utcnow()
            end_date = start_date + timedelta(days=days_ahead)

            kwargs = {
                "TimePeriod": {
                    "Start": start_date.strftime("%Y-%m-%d"),
                    "End": end_date.strftime("%Y-%m-%d"),
                },
                "Metric": "UNBLENDED_COST",
                "Granularity": "MONTHLY",
            }

            # Add filters if provided
            if tag_filters:
                filter_expr = {
                    "And": [
                        {"Tags": {"Key": f"tag:{key}", "Values": [value]}}
                        for key, value in tag_filters.items()
                    ]
                }
                if len(tag_filters) == 1:
                    filter_expr = list(filter_expr["And"])[0]
                kwargs["Filter"] = filter_expr

            response = self.ce_client.get_cost_forecast(**kwargs)

            total_forecast = sum(
                float(result["MeanValue"]) for result in response.get("ForecastResultsByTime", [])
            )

            logger.info(f"Cost forecast for next {days_ahead} days: ${total_forecast:.2f}")
            return total_forecast

        except Exception as e:
            logger.error(f"Failed to get cost forecast: {e}")
            return 0.0
