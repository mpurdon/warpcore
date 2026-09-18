"""Import snapshots: kept per import, compared by ARN, quiet about noise."""

from datetime import datetime, timedelta, timezone

from click.testing import CliRunner

from warpcore.cli.main import cli
from warpcore.discovery.snapshots import diff_snapshots, latest_diff, list_snapshots, write_snapshot

T0 = datetime(2026, 9, 1, tzinfo=timezone.utc)


def payload(resources, connections=()):
    return {"account": "1", "regions": ["us-east-1"], "agents": [], "resources": resources, "connections": list(connections)}


def res(arn, name, typ, config=None, health=None):
    return {"arn": arn, "name": name, "type": typ, "config": config or {}, "health": health}


def test_two_imports_diff_by_arn(tmp_path):
    a = payload([
        res("arn:a", "orders", "lambda", {"memory": 128, "storedBytes": 10}),
        res("arn:b", "old", "sqs"),
        res("arn:c", "web", "ec2-instance", {}, {"level": "ok"}),
    ], [{"from_arn": "arn:a", "to_arn": "arn:b", "kind": "sends"}])
    b = payload([
        res("arn:a", "orders", "lambda", {"memory": 256, "storedBytes": 99}),
        res("arn:c", "web", "ec2-instance", {}, {"level": "warn"}),
        res("arn:d", "new", "dynamodb"),
    ], [{"from_arn": "arn:a", "to_arn": "arn:d", "kind": "reads"}])
    p1 = write_snapshot(tmp_path, a, T0)
    p2 = write_snapshot(tmp_path, b, T0 + timedelta(days=1))
    assert list_snapshots(tmp_path) == [p1, p2]
    d = latest_diff(tmp_path)
    assert d is not None and not d.empty()
    assert [r["name"] for r in d.added] == ["new"]
    assert [r["name"] for r in d.removed] == ["old"]
    assert d.changed == [
        {"arn": "arn:a", "name": "orders", "type": "lambda", "changes": [{"key": "memory", "before": 128, "after": 256}]},
        {"arn": "arn:c", "name": "web", "type": "ec2-instance", "changes": [{"key": "health", "before": "ok", "after": "warn"}]},
    ]
    assert d.connections_added == [{"from": "orders", "to": "new", "kind": "reads"}]
    assert d.connections_removed == [{"from": "orders", "to": "old", "kind": "sends"}]


def test_one_import_has_nothing_to_compare(tmp_path):
    write_snapshot(tmp_path, payload([res("arn:a", "x", "sqs")]))
    assert latest_diff(tmp_path) is None
    same = diff_snapshots({"resources": [res("arn:a", "x", "sqs")]}, {"resources": [res("arn:a", "x", "sqs")]})
    assert same.empty()


def test_snapshots_command_reports(tmp_path):
    (tmp_path / "warpcore.yaml").write_text("project: {name: x}\n")
    write_snapshot(tmp_path, payload([res("arn:a", "x", "sqs")]), T0)
    write_snapshot(tmp_path, payload([res("arn:a", "x", "sqs"), res("arn:b", "y", "sns")]), T0 + timedelta(hours=1))
    r = CliRunner().invoke(cli, ["discover", "snapshots", "--config", str(tmp_path / "warpcore.yaml")])
    assert r.exit_code == 0, r.output
    assert "+ sns y" in r.output
    r = CliRunner().invoke(cli, ["discover", "snapshots", "--config", str(tmp_path / "warpcore.yaml"), "--json"])
    assert '"since_last_import"' in r.output and '"taken_at"' in r.output
