"""Guards for things that only break in a frozen binary.

PyInstaller produces an interpreter that does not run `site`, so a handful of
conveniences the REPL provides are simply absent. These fail at runtime, in one
command, on an end user's machine - the worst place to find them - and never in
the test suite, because the test suite runs under a normal interpreter.
"""

import ast
from pathlib import Path

import pytest

SRC = Path(__file__).resolve().parent.parent / "src" / "warpcore"

# Injected by the site module, not builtins. Absent under `python -S` and in a
# PyInstaller binary, where calling one raises NameError.
SITE_BUILTINS = {"exit", "quit", "copyright", "credits", "license"}


def python_files():
    return sorted(SRC.rglob("*.py"))


def test_there_are_source_files_to_check():
    """Guard the guard: a bad glob would make every test below vacuous."""
    assert len(python_files()) > 20


@pytest.mark.parametrize("path", python_files(), ids=lambda p: p.name)
def test_no_site_builtins(path):
    """`exit(1)` works in a REPL and raises NameError in the shipped binary.

    Found by freezing: `warpcore validate` was the only command that used it,
    and it crashed with NameError on every invocation of the packaged build.
    """
    tree = ast.parse(path.read_text(), filename=str(path))

    offenders = [
        f"{path.name}:{node.lineno} {node.func.id}()"
        for node in ast.walk(tree)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Name)
        and node.func.id in SITE_BUILTINS
    ]

    assert not offenders, (
        "site-module builtins are not available in a frozen binary; "
        f"use sys.exit() instead: {', '.join(offenders)}"
    )


def test_no_module_level_file_data_loading():
    """__file__-relative data loading breaks when files live inside the archive.

    PyInstaller unpacks to a temp dir at runtime, so paths built from __file__
    resolve somewhere the developer never intended. Nothing does this today;
    this test keeps it that way.
    """
    offenders = [
        f"{p.relative_to(SRC)}"
        for p in python_files()
        if "__file__" in p.read_text()
    ]
    assert not offenders, (
        "these modules reference __file__, which does not point where you "
        f"expect in a frozen binary: {offenders}"
    )


class TestLoggingNeverBlocksStartup:
    """setup_logging created `.warpcore/logs` relative to CWD and raised if it
    could not. A process spawned by the desktop app starts in `/`, so every
    CLI call from the GUI died in setup_logging before reaching its command.
    Found the first time the bundled app tried to scan an account."""

    def test_read_only_cwd_falls_back_to_home(self, tmp_path, monkeypatch):
        from warpcore.utils.logging import _resolve_log_dir

        home = tmp_path / "home"
        home.mkdir()
        monkeypatch.setenv("HOME", str(home))
        monkeypatch.chdir("/")

        resolved = _resolve_log_dir()
        assert resolved is not None
        assert resolved == home / ".warpcore" / "logs"
        assert resolved.is_dir()

    def test_writable_cwd_is_preferred(self, tmp_path, monkeypatch):
        from warpcore.utils.logging import _resolve_log_dir

        monkeypatch.chdir(tmp_path)
        assert _resolve_log_dir() == tmp_path / ".warpcore" / "logs"

    def test_nowhere_writable_returns_none_rather_than_raising(self, monkeypatch):
        from warpcore.utils.logging import _resolve_log_dir

        monkeypatch.setenv("HOME", "/nonexistent-warpcore-home")
        monkeypatch.chdir("/")
        assert _resolve_log_dir() is None

    def test_setup_logging_survives_with_no_log_dir(self, monkeypatch):
        import logging

        from warpcore.utils.logging import setup_logging

        monkeypatch.setenv("HOME", "/nonexistent-warpcore-home")
        monkeypatch.chdir("/")
        setup_logging("info")  # must not raise
        assert logging.getLogger().handlers, "console handler should still be installed"
