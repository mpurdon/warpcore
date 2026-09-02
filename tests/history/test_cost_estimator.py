"""Cost estimator pricing.

The parameterised methods and the Resource-based path must agree: they share
one implementation precisely so a forecast and a deployment cost estimate
cannot quote different numbers for the same thing.
"""

import pytest

from warpcore.history.cost_estimator import CostEstimator
from warpcore.state.models import Resource


@pytest.fixture
def estimator():
    return CostEstimator()


class TestParameterisedPricing:
    def test_lambda_cost_scales_with_memory(self, estimator):
        small = estimator.estimate_lambda_cost(128, 1000, 100_000)
        large = estimator.estimate_lambda_cost(1024, 1000, 100_000)
        assert large > small

    def test_lambda_cost_scales_with_duration(self, estimator):
        short = estimator.estimate_lambda_cost(512, 1000, 100_000)
        long = estimator.estimate_lambda_cost(512, 4000, 100_000)
        assert long > short

    def test_lambda_cost_is_zero_with_no_requests(self, estimator):
        assert estimator.estimate_lambda_cost(512, 1000, 0) == 0.0

    def test_http_api_is_cheaper_than_rest_api(self, estimator):
        http = estimator.estimate_api_gateway_cost(1_000_000, "http")
        rest = estimator.estimate_api_gateway_cost(1_000_000, "rest")
        assert http < rest
        assert http == pytest.approx(1.00)
        assert rest == pytest.approx(3.50)

    def test_logs_cost_covers_ingest_and_storage(self, estimator):
        ingest_only = estimator.estimate_cloudwatch_logs_cost(1.0)
        with_storage = estimator.estimate_cloudwatch_logs_cost(1.0, 5.0)
        assert ingest_only == pytest.approx(0.50)
        assert with_storage == pytest.approx(0.65)

    def test_xray_cost(self, estimator):
        assert estimator.estimate_xray_cost(1_000_000) == pytest.approx(5.00)

    def test_nat_gateway_hourly_rate_matches_the_monthly_figure(self, estimator):
        """A full month of hours must reproduce the table's monthly base."""
        month = estimator.estimate_nat_gateway_cost(
            hours=CostEstimator.HOURS_PER_MONTH, data_processed_gb=0
        )
        assert month == pytest.approx(32.85)

    def test_nat_gateway_charges_for_data(self, estimator):
        assert estimator.estimate_nat_gateway_cost(730, 100) == pytest.approx(37.35)

    def test_vpc_endpoint_scales_with_count_and_hours(self, estimator):
        assert estimator.estimate_vpc_endpoint_cost(3, 730) == pytest.approx(21.90)
        assert estimator.estimate_vpc_endpoint_cost(0, 730) == 0.0


class TestResourcePathIsUnchanged:
    """Pinned against the values the pre-refactor implementation produced."""

    @pytest.mark.parametrize("resource_type,properties,expected", [
        ("AWS::Lambda::Function", {"MemorySize": 512}, 0.853335),
        ("AWS::Lambda::Function", {"MemorySize": 128}, 0.22833375),
        ("AWS::ApiGatewayV2::Api", {}, 0.10),
        ("AWS::ApiGateway::RestApi", {}, 0.35),
        ("AWS::DynamoDB::Table", {}, 0.3375),
        ("AWS::S3::Bucket", {}, 0.185),
        ("AWS::SQS::Queue", {}, 0.0),
        ("AWS::SNS::Topic", {}, 0.0),
        ("AWS::EC2::NatGateway", {}, 37.35),
        ("AWS::Logs::LogGroup", {}, 0.65),
        ("AWS::IAM::Role", {}, 0.0),
    ])
    def test_resource_costs(self, estimator, resource_type, properties, expected):
        resource = Resource(id="x", type=resource_type, properties=properties)
        assert estimator.estimate_resource_cost(resource) == pytest.approx(expected)

    def test_unknown_type_costs_nothing_rather_than_raising(self, estimator):
        resource = Resource(id="x", type="AWS::Kinesis::Stream")
        assert estimator.estimate_resource_cost(resource) == 0.0

    def test_lambda_defaults_to_128mb_when_unset(self, estimator):
        unset = Resource(id="x", type="AWS::Lambda::Function", properties={})
        explicit = Resource(id="y", type="AWS::Lambda::Function",
                            properties={"MemorySize": 128})
        assert estimator.estimate_resource_cost(unset) == \
            estimator.estimate_resource_cost(explicit)


def test_both_paths_agree_for_the_same_lambda(estimator):
    """The refactor's whole point: one implementation, two entry points."""
    table = CostEstimator.COST_ESTIMATES["AWS::Lambda::Function"]
    via_resource = estimator.estimate_resource_cost(
        Resource(id="x", type="AWS::Lambda::Function", properties={"MemorySize": 512})
    )
    via_params = estimator.estimate_lambda_cost(
        memory_mb=512,
        duration_ms=table["estimated_avg_duration_ms"],
        requests=table["estimated_monthly_requests"],
    )
    assert via_resource == pytest.approx(via_params)
