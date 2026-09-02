"""Resource usage metric summarisation."""

from datetime import datetime, timedelta
from unittest.mock import Mock

import pytest

from warpcore.monitoring.usage import ResourceUsageReader


def _reader():
    return ResourceUsageReader(Mock(), region="us-east-1")


def _cloudwatch(values):
    client = Mock()
    now = datetime.utcnow()
    client.get_metric_statistics.return_value = {
        "Datapoints": [
            {"Timestamp": now - timedelta(hours=i), **v}
            for i, v in enumerate(values)
        ]
    }
    return client


class TestMetricSummarisation:
    def test_sum_series_reports_a_total(self):
        series = _reader()._read_metric(
            cloudwatch=_cloudwatch([{"Sum": 10}, {"Sum": 20}, {"Sum": 5}]),
            namespace="AWS/Lambda", metric_name="Invocations", statistic="Sum",
            unit="Count", dimensions=[], start=datetime.utcnow(),
            end=datetime.utcnow(), period=300,
        )
        assert series.total == 35
        assert series.maximum == 20
        assert series.datapoints == 3

    @pytest.mark.parametrize("statistic", ["Average", "Maximum"])
    def test_non_sum_series_has_no_total(self, statistic):
        """Summing per-period averages produces a meaningless number that
        nonetheless renders as a measurement."""
        series = _reader()._read_metric(
            cloudwatch=_cloudwatch([{statistic: 4790}, {statistic: 5244}]),
            namespace="AWS/Lambda", metric_name="Duration", statistic=statistic,
            unit="Milliseconds", dimensions=[], start=datetime.utcnow(),
            end=datetime.utcnow(), period=300,
        )
        assert series.total is None
        assert series.average == pytest.approx(5017.0)
        assert series.maximum == 5244

    def test_no_datapoints_leaves_everything_unset(self):
        series = _reader()._read_metric(
            cloudwatch=_cloudwatch([]),
            namespace="AWS/Lambda", metric_name="Errors", statistic="Sum",
            unit="Count", dimensions=[], start=datetime.utcnow(),
            end=datetime.utcnow(), period=300,
        )
        assert series.datapoints == 0
        assert series.total is None and series.average is None

    def test_client_error_is_captured_on_the_series(self):
        from botocore.exceptions import ClientError

        client = Mock()
        client.get_metric_statistics.side_effect = ClientError(
            {"Error": {"Code": "AccessDenied", "Message": "no"}}, "GetMetricStatistics"
        )
        series = _reader()._read_metric(
            cloudwatch=client, namespace="AWS/Lambda", metric_name="Errors",
            statistic="Sum", unit="Count", dimensions=[],
            start=datetime.utcnow(), end=datetime.utcnow(), period=300,
        )
        assert series.error is not None
        assert series.datapoints == 0


class TestDimensionResolution:
    def test_sqs_metrics_key_on_the_queue_name_not_the_url(self):
        # get_queue_attributes wants a URL, CloudWatch wants the bare name.
        assert _reader()._dimension_value(
            "AWS::SQS::Queue", "q", "arn:aws:sqs:us-east-1:1:my-queue"
        ) == "my-queue"

    def test_lambda_metrics_key_on_the_function_name(self):
        assert _reader()._dimension_value(
            "AWS::Lambda::Function", "f", "arn:aws:lambda:us-east-1:1:function:my-fn"
        ) == "my-fn"

    def test_missing_physical_id_falls_back_to_the_logical_id(self):
        assert _reader()._dimension_value("AWS::Lambda::Function", "f", None) == "f"


def test_unsupported_type_reports_a_note_rather_than_failing():
    usage = _reader().read(
        resource_id="r", resource_type="AWS::Kinesis::Stream",
        physical_id="arn:aws:kinesis:us-east-1:1:stream/s",
    )
    assert usage.metrics == []
    assert any("no usage metrics" in n.lower() for n in usage.notes)
