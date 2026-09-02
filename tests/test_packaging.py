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
