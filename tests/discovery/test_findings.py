"""The rules, and the model's ranking over them."""

from datetime import datetime, timezone
from unittest.mock import Mock

from warpcore.discovery.findings import (
    ProjectReviewer, _parse_json, open_ports_by_group, review_nodes, review_snapshot,
)
from warpcore.monitoring.usage import MetricSeries, ResourceUsage


def _usage(arn, **series):
    u = ResourceUsage(resource_id=arn, resource_type="x", physical_id=arn, window_hours=24)
    for key, value in series.items():
        name, stat = key.rsplit("_", 1)
        u.metrics.append(MetricSeries(name=name, namespace="", statistic=stat, datapoints=24,
                                      average=value, maximum=value, total=value, latest=value))
    return u


def _node(id, type, arn=None, config=None, meta=None, **extra):
    return {"id": id, "type": type, "arn": arn or f"arn:aws:ec2:us-east-1:1:{type}/{id}", "label": id,
            "config": config or {}, "meta": meta or {}, **extra}


def test_open_ports_are_read_off_the_group_rules():
    sg = _node("sg-1", "security-group", config={"inboundRules": ["tcp 22 from sg sg-2", "tcp 9005 from 0.0.0.0/0", "tcp 443 from ::/0"], "openToWorld": True, "memberCount": 1})
    assert open_ports_by_group([sg]) == {"sg-1": ["tcp 9005", "tcp 443"]}


def test_an_idle_public_host_with_open_ports_is_flagged_high_with_evidence():
    sg = _node("sg-1", "security-group", config={"inboundRules": ["tcp 9005 from 0.0.0.0/0"], "openToWorld": True, "memberCount": 1})
    host = _node("host", "ec2-instance", config={"state": "running", "instanceType": "t2.large", "publicIp": "3.1.1.1"},
                 meta={"securityGroups": [{"id": "sg-1", "name": "web"}]})
    usage = {host["arn"]: _usage(host["arn"], CPUUtilization_Average=0.2, CPUUtilization_Maximum=1.1, NetworkIn_Sum=2000, NetworkOut_Sum=500, StatusCheckFailed_Maximum=0)}
    findings = review_nodes([sg, host], usage, 24)
    by_id = {f.id.split(":")[0]: f for f in findings}
    assert by_id["exposed"].severity == "high"
    assert "tcp 9005" in by_id["exposed"].title
    assert "little or nothing is using" in by_id["exposed"].detail
    assert by_id["idle"].evidence["cpuPeak"] == 1.1
    assert by_id["no-ssm"].kind == "operability"
    # High first, then medium, then low.
    assert [f.severity for f in findings] == ["high", "medium", "low"]


def test_a_busy_host_is_not_idle_and_a_healthy_status_is_silent():
    host = _node("host", "ec2-instance", config={"state": "running", "instanceProfile": "ssm"})
    usage = {host["arn"]: _usage(host["arn"], CPUUtilization_Average=30, CPUUtilization_Maximum=80, StatusCheckFailed_Maximum=0)}
    assert review_nodes([host], usage, 24) == []


def test_a_quiet_nat_gateway_and_a_stopped_host_are_cost_findings():
    nat = _node("nat", "nat-gateway", config={"name": "nat-1"})
    stopped = _node("old", "ec2-instance", config={"state": "stopped", "instanceType": "t2.large"}, meta={"attachments": [{"type": "ebs-volume", "detail": "8 GiB · gp2"}]})
    usage = {nat["arn"]: _usage(nat["arn"], BytesOutToDestination_Sum=25_000)}
    findings = review_nodes([nat, stopped], usage, 24)
    kinds = {f.id.split(":")[0]: f for f in findings}
    assert kinds["quiet-nat"].kind == "cost" and "24.4 KB" in kinds["quiet-nat"].title
    assert kinds["stopped"].evidence["volumes"] == ["8 GiB · gp2"]


def test_an_old_snapshot_is_flagged_and_a_recent_one_is_not():
    today = datetime(2026, 9, 13, tzinfo=timezone.utc)
    old = _node("snap", "ebs-snapshot", config={"taken": "2026-01-01", "size": 8})
    new = _node("snap2", "ebs-snapshot", config={"taken": "2026-09-01", "size": 8})
    assert review_snapshot(old, today)[0].evidence["ageDays"] == 255
    assert review_snapshot(new, today) == []


def test_lambda_errors_and_rds_without_connections():
    fn = _node("fn", "lambda", arn="arn:aws:lambda:us-east-1:1:function:fn")
    db = _node("db", "rds-instance", arn="arn:aws:rds:us-east-1:1:db:db")
    usage = {fn["arn"]: _usage(fn["arn"], Errors_Sum=12, Invocations_Sum=100), db["arn"]: _usage(db["arn"], DatabaseConnections_Maximum=0)}
    findings = {f.id.split(":")[0]: f for f in review_nodes([fn, db], usage, 24)}
    assert findings["errors"].severity == "high" and "12.0%" in findings["errors"].detail
    assert findings["no-connections"].kind == "cost"


def test_the_model_ranks_and_explains_but_cannot_add_or_drop():
    sg = _node("sg-1", "security-group", config={"inboundRules": ["tcp 9005 from 0.0.0.0/0"], "openToWorld": True, "memberCount": 1})
    host = _node("host", "ec2-instance", config={"state": "running", "instanceType": "t2.large"}, meta={"securityGroups": [{"id": "sg-1"}]})
    usage = {host["arn"]: _usage(host["arn"], CPUUtilization_Average=0.2, CPUUtilization_Maximum=1.1, NetworkIn_Sum=100)}
    llm = Mock()
    llm.model = "claude-opus-5"
    llm._call_llm.return_value = '```json\n{"summary": "A quiet host with an open port.", "findings": [{"id": "idle:host", "rank": 2, "why": "It idles."}, {"id": "exposed:host", "rank": 1, "why": "Open to the world."}, {"id": "made-up", "rank": 3, "why": "x"}]}\n```'
    reviewer = ProjectReviewer(Mock(), "us-east-1", llm=llm)
    import warpcore.discovery.findings as mod
    mod.ResourceUsageReader = lambda *_a, **_k: Mock(read=lambda *_a, **_k: usage[host["arn"]])
    review = reviewer.review([sg, host], hours=24)
    assert review.summary == "A quiet host with an open port."
    assert review.model == "claude-opus-5"
    assert [f.id for f in review.findings][:2] == ["exposed:host", "idle:host"]
    assert review.findings[0].why == "Open to the world."
    assert all(f.id != "made-up" for f in review.findings)


def test_a_broken_model_reply_leaves_the_rules_output_standing():
    host = _node("host", "ec2-instance", config={"state": "stopped"})
    llm = Mock(); llm._call_llm.return_value = "I cannot help with that."
    reviewer = ProjectReviewer(Mock(), "us-east-1", llm=llm)
    review = reviewer.review([host], hours=24)
    assert [f.id for f in review.findings] == ["stopped:host"]
    assert "model" in review.errors


def test_parse_json_tolerates_prose_around_the_object():
    assert _parse_json('Sure: {"a": 1} hope that helps') == {"a": 1}


def test_mutes_take_findings_out_of_the_counts_but_not_the_list(tmp_path):
    from warpcore.discovery.findings import apply_mutes, group_by_resource, read_mutes, remove_mute, write_mute, Review
    host = _node("host", "ec2-instance", config={"state": "stopped", "instanceType": "t2.large"}, meta={"attachments": [{"type": "ebs-volume", "detail": "8 GiB · gp2"}]})
    nat = _node("nat", "nat-gateway", config={"name": "nat-1"})
    usage = {nat["arn"]: _usage(nat["arn"], BytesOutToDestination_Sum=100)}
    review = Review(window_hours=24, findings=review_nodes([host, nat], usage, 24))
    write_mute(tmp_path, "stopped:host", "decommission scheduled for October")
    assert read_mutes(tmp_path)["stopped:host"]["reason"] == "decommission scheduled for October"
    apply_mutes(review, read_mutes(tmp_path))
    by_id = {f.id: f for f in review.findings}
    assert by_id["stopped:host"].status == "muted" and by_id["stopped:host"].mute_reason == "decommission scheduled for October"
    assert [f.id for f in review.open()] == ["quiet-nat:nat"]
    groups = group_by_resource(review.findings, [host, nat])
    assert [g.arn for g in groups] == [nat["arn"]]
    assert groups[0].savings_usd_month == 32.0 and groups[0].effort == "config"
    assert remove_mute(tmp_path, "stopped:host") is True and read_mutes(tmp_path) == {}
    # The mute file is something a team can commit.
    assert (tmp_path / ".warpcore" / "findings-mutes.yaml").exists()


def test_a_resource_with_several_findings_is_one_group_with_the_worst_severity_and_least_effort():
    sg = _node("sg-1", "security-group", config={"inboundRules": ["tcp 9005 from 0.0.0.0/0"], "openToWorld": True, "memberCount": 1})
    host = _node("host", "ec2-instance", config={"state": "running", "instanceType": "t2.large", "publicIp": "3.1.1.1"},
                 meta={"securityGroups": [{"id": "sg-1", "name": "web"}]})
    usage = {host["arn"]: _usage(host["arn"], CPUUtilization_Average=0.2, CPUUtilization_Maximum=1.1, NetworkIn_Sum=2000, StatusCheckFailed_Maximum=0)}
    findings = review_nodes([sg, host], usage, 24)
    from warpcore.discovery.findings import group_by_resource
    groups = group_by_resource(findings, [sg, host])
    assert len(groups) == 1
    g = groups[0]
    assert g.node_id == "host" and g.severity == "high" and g.effort == "none"
    assert set(g.finding_ids) == {"exposed:host", "idle:host", "no-ssm:host"}
    assert {f.id: f.effort for f in findings}["idle:host"] == "restart"
