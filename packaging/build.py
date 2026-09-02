#!/usr/bin/env python3
"""Build the standalone `warpcore` binary.

    python packaging/build.py
    python packaging/build.py --sidecar   # also emit a Tauri sidecar copy

PyInstaller does not cross-compile: run this on each OS you ship. The output is
named for the host platform so artifacts from several machines can be collected
into one release without colliding.
"""

import argparse
import os
import platform
import shutil
import subprocess
import sys
import sysconfig
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SPEC = ROOT / "packaging" / "warpcore.spec"
DIST = ROOT / "dist"
EXE_SUFFIX = ".exe" if sys.platform == "win32" else ""
BINARY = DIST / f"warpcore{EXE_SUFFIX}"


def rust_target_triple() -> str:
    """The target triple Tauri expects in a sidecar filename.

    Tauri resolves sidecars as `<name>-<triple><exe suffix>`, so the name has to
    match what the Rust toolchain calls this host.
    """
    try:
        out = subprocess.run(
            ["rustc", "-vV"], capture_output=True, text=True, check=True
        ).stdout
        for line in out.splitlines():
            if line.startswith("host:"):
                return line.split(":", 1)[1].strip()
    except (OSError, subprocess.CalledProcessError):
        pass

    # Fall back to deriving it, so the build still works without a Rust
    # toolchain installed.
    machine = {"x86_64": "x86_64", "AMD64": "x86_64", "arm64": "aarch64",
               "aarch64": "aarch64"}.get(platform.machine(), platform.machine())
    system = {"darwin": "apple-darwin", "linux": "unknown-linux-gnu",
              "win32": "pc-windows-msvc"}.get(sys.platform, sys.platform)
    return f"{machine}-{system}"


def platform_tag() -> str:
    """Short os-arch tag for release artifact names."""
    system = {"darwin": "macos", "win32": "windows"}.get(sys.platform, "linux")
    machine = platform.machine().lower().replace("amd64", "x86_64")
    return f"{system}-{machine}"


def build() -> Path:
    print(f"Building warpcore for {platform_tag()} "
          f"(python {sysconfig.get_python_version()})...")
    subprocess.run(
        [sys.executable, "-m", "PyInstaller", str(SPEC), "--noconfirm",
         "--log-level", "WARN"],
        cwd=ROOT,
        check=True,
    )
    if not BINARY.exists():
        raise SystemExit(f"expected {BINARY} but it was not produced")
    return BINARY


def smoke_test(binary: Path) -> None:
    """Run the binary with the environment stripped.

    A binary that only works inside the build venv defeats the purpose, and
    PyInstaller will happily produce one if a dependency was resolved from the
    environment rather than bundled.
    """
    env = {"PATH": "/usr/bin:/bin", "HOME": os.path.expanduser("~")}
    if sys.platform == "win32":
        # Windows needs its system directories to load the CRT at all.
        env = {"PATH": os.environ.get("SystemRoot", "C:\\Windows") + "\\System32",
               "SystemRoot": os.environ.get("SystemRoot", "C:\\Windows"),
               "USERPROFILE": os.path.expanduser("~")}

    result = subprocess.run(
        [str(binary), "--help"], env=env, capture_output=True, text=True
    )
    if result.returncode != 0 or "Warpcore" not in result.stdout:
        print(result.stdout)
        print(result.stderr, file=sys.stderr)
        raise SystemExit("smoke test failed: binary does not run standalone")
    print("  smoke test: runs with a stripped environment")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--sidecar", action="store_true",
        help="also write a Tauri-sidecar-named copy into visual-builder/src-tauri/binaries/",
    )
    args = parser.parse_args()

    binary = build()
    smoke_test(binary)

    size_mb = binary.stat().st_size / (1024 * 1024)
    release_name = f"warpcore-{platform_tag()}{EXE_SUFFIX}"
    release_path = DIST / release_name
    shutil.copy2(binary, release_path)

    print(f"\n  {binary}  ({size_mb:.0f} MB)")
    print(f"  {release_path}")

    if args.sidecar:
        sidecar_dir = ROOT / "visual-builder" / "src-tauri" / "binaries"
        sidecar_dir.mkdir(parents=True, exist_ok=True)
        sidecar = sidecar_dir / f"warpcore-{rust_target_triple()}{EXE_SUFFIX}"
        shutil.copy2(binary, sidecar)
        print(f"  {sidecar}")
        print("\n  Add to tauri.conf.json: bundle.externalBin = [\"binaries/warpcore\"]")


if __name__ == "__main__":
    main()
