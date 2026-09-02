"""`warpcore --version`.

The flag exists because the visual builder bundles the CLI as a sidecar: when
the GUI and CLI disagree about a flag, the first question is which binary is
running. docs/QUICK_REFERENCE.md documented this flag long before it existed.
"""

import re
import tomllib
from pathlib import Path

from click.testing import CliRunner

import warpcore
from warpcore.cli.main import cli

ROOT = Path(__file__).resolve().parent.parent.parent


def _run(*args):
    return CliRunner().invoke(cli, list(args), catch_exceptions=False)


class TestVersionFlag:
    def test_long_flag(self):
        result = _run("--version")
        assert result.exit_code == 0
        assert "warpcore" in result.output

    def test_short_flag(self):
        assert _run("-V").exit_code == 0

    def test_reports_the_package_version(self):
        assert warpcore.__version__ in _run("--version").output

    def test_reports_the_python_version(self):
        """Half of "why does the GUI see a different CLI" is the interpreter."""
        import sys

        assert sys.version.split()[0] in _run("--version").output

    def test_distinguishes_a_frozen_binary_from_a_source_install(self):
        """Whether this is the bundled sidecar or a pip install is the other half."""
        output = _run("--version").output
        assert "source install" in output or "standalone binary" in output

    def test_exits_before_requiring_a_subcommand(self):
        """--version must work with no config and no AWS credentials present."""
        result = _run("--version")
        assert result.exit_code == 0
        assert "Usage:" not in result.output


class TestVersionHasOneSourceOfTruth:
    def test_matches_pyproject(self):
        """__init__ reads installed metadata, which comes from pyproject."""
        declared = tomllib.loads((ROOT / "pyproject.toml").read_text())["project"]["version"]
        assert warpcore.__version__ == declared

    def test_version_is_not_hardcoded_in_the_package(self):
        """A literal here would drift from pyproject the first time it bumped."""
        source = (ROOT / "src" / "warpcore" / "__init__.py").read_text()
        literals = re.findall(r'__version__\s*=\s*["\']([^"\']+)["\']', source)
        # The only literal permitted is the not-installed fallback.
        assert all("unknown" in lit for lit in literals), (
            f"__version__ should be derived from package metadata, found {literals}"
        )

    def test_devmode_reports_the_same_version(self):
        """The dev-session manifest and --version must never disagree."""
        from warpcore.devmode import DevMode

        assert DevMode().manifest()["runtime"]["warpcore"] == warpcore.__version__
