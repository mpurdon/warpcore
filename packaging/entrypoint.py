"""Frozen-binary entry point.

PyInstaller needs a real module to analyse; the `warpcore` console script that
pip generates does not exist on disk in a form it can follow.
"""

import sys

from warpcore.cli.main import cli

if __name__ == "__main__":
    # Click reads sys.argv itself. standalone_mode keeps its SystemExit
    # handling, which the CLI relies on for non-zero exits.
    sys.exit(cli())
