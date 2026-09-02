"""Progress event emission."""

import io
import json
import threading

from warpcore.utils.progress import (
    ProgressEmitter,
    ndjson_writer,
    plan_for,
)


class TestEmitter:
    def test_disabled_emitter_does_nothing(self):
        emitter = ProgressEmitter(None)
        assert not emitter.enabled
        emitter.emit("anything", x=1)  # must not raise

    def test_events_carry_the_name_and_fields(self):
        seen = []
        ProgressEmitter(seen.append).emit("region_start", region="us-east-1")
        assert seen[0]["event"] == "region_start"
        assert seen[0]["region"] == "us-east-1"

    def test_every_event_is_timestamped(self):
        seen = []
        ProgressEmitter(seen.append).emit("x")
        assert "elapsed" in seen[0]

    def test_a_broken_consumer_cannot_break_the_scan(self):
        """Progress is telemetry; a UI that throws must not abort discovery."""
        def explode(_):
            raise RuntimeError("consumer is broken")

        ProgressEmitter(explode).emit("x")  # must not raise

    def test_child_binds_fields_to_every_event(self):
        seen = []
        region = ProgressEmitter(seen.append).child(region="eu-west-1")
        region.emit("service", service="ec2")
        assert seen[0]["region"] == "eu-west-1"
        assert seen[0]["service"] == "ec2"

    def test_child_fields_can_be_overridden(self):
        seen = []
        region = ProgressEmitter(seen.append).child(region="eu-west-1")
        region.emit("service", region="us-east-1")
        assert seen[0]["region"] == "us-east-1"

    def test_concurrent_emitters_do_not_interleave(self):
        """Regions and services report from many threads at once."""
        lines = io.StringIO()
        emitter = ProgressEmitter(ndjson_writer(lines))

        def worker(n):
            for i in range(50):
                emitter.emit("service", service=f"svc-{n}", i=i)

        threads = [threading.Thread(target=worker, args=(n,)) for n in range(8)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        rows = [line for line in lines.getvalue().splitlines() if line]
        assert len(rows) == 400
        for row in rows:
            json.loads(row)  # every line is complete JSON, not a torn write


class TestNdjsonWriter:
    def test_one_compact_line_per_event(self):
        buf = io.StringIO()
        write = ndjson_writer(buf)
        write({"event": "a"})
        write({"event": "b"})
        assert buf.getvalue().count("\n") == 2
        assert "\n" not in json.dumps({"event": "a"}, separators=(",", ":"))

    def test_non_serialisable_values_do_not_raise(self):
        from datetime import datetime

        buf = io.StringIO()
        ndjson_writer(buf)({"event": "a", "when": datetime.utcnow()})
        assert json.loads(buf.getvalue())["when"]


def test_plan_lists_phases_in_order():
    assert plan_for(["ec2", "s3"], hydrate=False) == [
        "resource-explorer", "service:ec2", "service:s3", "tags",
    ]


def test_plan_includes_hydrate_when_requested():
    assert plan_for(["ec2"], hydrate=True)[-1] == "hydrate"
