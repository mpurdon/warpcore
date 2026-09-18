# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec for a standalone `warpcore` binary.

Produces a single executable with the interpreter embedded, so the target
machine needs no Python. This exists mainly for two reasons:

  * Windows. Python console scripts install into `Scripts\\`, which is not
    reliably on PATH, so `warpcore` may simply not resolve.
  * The Tauri app shells out to `warpcore` and inherits whatever the user's
    PATH happens to point at. A bundled binary removes that variable.

Build with: pyinstaller packaging/warpcore.spec --noconfirm
"""

from PyInstaller.utils.hooks import collect_submodules, copy_metadata

# SPECPATH is injected by PyInstaller; deriving the root from it means the
# spec works regardless of the directory the build is invoked from.
import os
ROOT = os.path.abspath(os.path.join(SPECPATH, os.pardir))

datas = []


def optional_submodules(package, skip=()):
    """Every submodule of an optional dependency, or nothing when it is absent.

    `skip` names prefixes to leave out: mcp.cli imports typer, which the
    server never needs, and collecting it aborts the build when typer is
    not installed.
    """
    try:
        __import__(package)
    except ImportError:
        return []
    return collect_submodules(package, filter=lambda name: not name.startswith(tuple(skip)))


# devmode._warpcore_version() calls importlib.metadata.version("warpcore").
# Without the dist-info the lookup raises and the version silently degrades to
# "unknown" in every dev-session manifest.
datas += copy_metadata("warpcore")

a = Analysis(
    [os.path.join(SPECPATH, "entrypoint.py")],
    pathex=[os.path.join(ROOT, "src")],
    binaries=[],
    datas=datas,
    hiddenimports=[
        # Click subcommands are imported eagerly by cli.main, but the agentic
        # LLM providers are imported lazily inside _initialize_client and would
        # otherwise be missed. They are optional at runtime; when the SDK is
        # installed in the build environment it ships, otherwise the provider
        # reports itself unavailable.
        "warpcore.cli.main",
        *optional_submodules("anthropic"),
        *optional_submodules("mcp", skip=("mcp.cli",)),
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        # Test and lint tooling must never reach the shipped binary.
        "pytest",
        "moto",
        "black",
        "ruff",
        "PyInstaller",
        # Pulled in transitively by some botocore paths; unused here and large.
        "tkinter",
        "test",
        "unittest",
    ],
    noarchive=False,
    optimize=0,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name="warpcore",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    # UPX corrupts signatures on macOS and trips antivirus heuristics on
    # Windows; the size saving is not worth either.
    upx=False,
    runtime_tmpdir=None,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
