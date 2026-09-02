"""The audit log: append-only, crash-durable, readable back."""

import json

import pytest

from warpcore.audit.models import AuditEntry, AuditOperation, AuditStatus, UndoKind
from warpcore.audit.recorder import AuditRecorder, resource_snapshot
from warpcore.state.models import Resource


@pytest.fixture
def recorder(tmp_path):
    return AuditRecorder(
        environment="dev", audit_dir=tmp_path,
        actor="arn:aws:iam::1:user/mp", command="deploy --env dev",
        project_name="demo", region="us-east-1",
    )


def _resource(name="fn", **props):
    return Resource(
        id=name, type="AWS::Lambda::Function",
        physical_id=f"arn:aws:lambda:us-east-1:1:function:{name}",
        properties=props or {"MemorySize": 512},
    )


class TestRecording:
    def test_successful_operation_is_recorded(self, recorder):
        with recorder.operation(AuditOperation.CREATE, "fn", "AWS::Lambda::Function") as rec:
            rec.after = _resource()

        entries = recorder.entries()
        assert len(entries) == 1
        assert entries[0].operation is AuditOperation.CREATE
        assert entries[0].status is AuditStatus.SUCCESS
        assert entries[0].physical_id.endswith("function:fn")

    def test_failure_is_recorded_and_the_exception_still_propagates(self, recorder):
        with pytest.raises(RuntimeError):
            with recorder.operation(AuditOperation.UPDATE, "fn") as rec:
                rec.before = _resource()
                raise RuntimeError("AccessDenied")

        entry = recorder.entries()[0]
        assert entry.status is AuditStatus.FAILED
        assert "AccessDenied" in entry.error

    def test_context_metadata_is_stamped_onto_entries(self, recorder):
        with recorder.operation(AuditOperation.CREATE, "fn") as rec:
            rec.after = _resource()
        entry = recorder.entries()[0]
        assert entry.actor == "arn:aws:iam::1:user/mp"
        assert entry.command == "deploy --env dev"
        assert entry.project_name == "demo"
        assert entry.session_id == recorder.session_id

    def test_duration_is_measured(self, recorder):
        with recorder.operation(AuditOperation.CREATE, "fn") as rec:
            rec.after = _resource()
        assert recorder.entries()[0].duration_ms >= 0

    def test_disabled_recorder_writes_nothing(self, tmp_path):
        recorder = AuditRecorder(environment="dev", audit_dir=tmp_path, enabled=False)
        with recorder.operation(AuditOperation.CREATE, "fn") as rec:
            rec.after = _resource()
        assert recorder.entries() == []


class TestAppendOnly:
    def test_log_is_jsonl(self, recorder):
        for i in range(3):
            with recorder.operation(AuditOperation.CREATE, f"fn{i}") as rec:
                rec.after = _resource(f"fn{i}")

        lines = recorder.path.read_text().strip().split("\n")
        assert len(lines) == 3
        for line in lines:
            json.loads(line)

    def test_marking_undone_appends_rather_than_rewrites(self, recorder):
        with recorder.operation(AuditOperation.CREATE, "fn") as rec:
            rec.after = _resource()
        entry = recorder.entries()[0]
        before_lines = recorder.path.read_text().count("\n")

        recorder.mark_undone(entry.id, "undo123")

        assert recorder.path.read_text().count("\n") == before_lines + 1
        # The original entry line is untouched.
        assert recorder.path.read_text().split("\n")[0].count('"status":"success"') == 1

    def test_undo_marker_is_folded_in_on_read(self, recorder):
        with recorder.operation(AuditOperation.CREATE, "fn") as rec:
            rec.after = _resource()
        entry = recorder.entries()[0]
        recorder.mark_undone(entry.id, "undo123")

        reread = recorder.get(entry.id)
        assert reread.status is AuditStatus.UNDONE
        assert reread.is_undone()
        assert reread.undone_by_entry == "undo123"

    def test_corrupt_line_does_not_break_the_read(self, recorder):
        with recorder.operation(AuditOperation.CREATE, "fn") as rec:
            rec.after = _resource()
        with open(recorder.path, "a") as f:
            f.write("this is not json\n")

        assert len(recorder.entries()) == 1


class TestQuerying:
    @pytest.fixture
    def populated(self, recorder):
        with recorder.operation(AuditOperation.CREATE, "a") as rec:
            rec.after = _resource("a")
        with recorder.operation(AuditOperation.UPDATE, "b") as rec:
            rec.before, rec.after = _resource("b"), _resource("b", MemorySize=1024)
        with recorder.operation(AuditOperation.DELETE, "c") as rec:
            rec.before = _resource("c")
        return recorder

    def test_newest_first_by_default(self, populated):
        assert [e.resource_id for e in populated.entries()] == ["c", "b", "a"]

    def test_filter_by_operation(self, populated):
        entries = populated.entries(operation=AuditOperation.UPDATE)
        assert [e.resource_id for e in entries] == ["b"]

    def test_filter_by_resource(self, populated):
        assert len(populated.entries(resource_id="a")) == 1

    def test_limit_applies_after_sorting(self, populated):
        assert [e.resource_id for e in populated.entries(limit=1)] == ["c"]

    def test_get_by_id_prefix(self, populated):
        entry = populated.entries()[0]
        assert populated.get(entry.id[:6]).id == entry.id

    def test_get_returns_none_for_unknown_id(self, populated):
        assert populated.get("zzzzzz") is None

    def test_sessions_group_entries(self, populated):
        sessions = populated.sessions()
        assert len(sessions) == 1
        assert sessions[0]["count"] == 3


class TestUndoClassification:
    def test_create_is_reversed_by_destroy(self):
        entry = AuditEntry(operation=AuditOperation.CREATE, resource_id="a",
                           physical_id="arn:aws:s3:::a")
        assert entry.undo_kind() is UndoKind.DESTROY
        assert entry.is_undoable()

    def test_update_is_reversed_by_reprovision(self):
        entry = AuditEntry(operation=AuditOperation.UPDATE, resource_id="a",
                           before=resource_snapshot(_resource()))
        assert entry.undo_kind() is UndoKind.REPROVISION

    def test_delete_is_reversed_by_recreate(self):
        entry = AuditEntry(operation=AuditOperation.DELETE, resource_id="a",
                           before=resource_snapshot(_resource()))
        assert entry.undo_kind() is UndoKind.RECREATE

    def test_create_without_physical_id_is_unsupported(self):
        entry = AuditEntry(operation=AuditOperation.CREATE, resource_id="a")
        assert entry.undo_kind() is UndoKind.UNSUPPORTED
        assert not entry.is_undoable()

    def test_failed_entry_is_not_undoable(self):
        entry = AuditEntry(operation=AuditOperation.CREATE, resource_id="a",
                           physical_id="arn:x", status=AuditStatus.FAILED)
        assert not entry.is_undoable()

    def test_an_undo_is_not_itself_undoable(self):
        entry = AuditEntry(operation=AuditOperation.DELETE, resource_id="a",
                           before=resource_snapshot(_resource()), undoes_entry="abc")
        assert not entry.is_undoable()

    def test_changed_properties_reports_the_diff(self):
        entry = AuditEntry(
            operation=AuditOperation.UPDATE, resource_id="a",
            before=resource_snapshot(_resource(MemorySize=512, Timeout=30)),
            after=resource_snapshot(_resource(MemorySize=1024, Timeout=30)),
        )
        changes = entry.changed_properties()
        assert changes == {"MemorySize": {"before": 512, "after": 1024}}
