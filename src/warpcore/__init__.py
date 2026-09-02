"""Warpcore."""

from importlib.metadata import PackageNotFoundError, version as _version

try:
    # Single source of truth: pyproject.toml, read back from installed
    # metadata. The frozen binary bundles that metadata explicitly (see
    # packaging/warpcore.spec) so this keeps working there.
    __version__ = _version("warpcore")
except PackageNotFoundError:
    # Running from a source tree that was never installed.
    __version__ = "0.0.0+unknown"

__all__ = ["__version__"]
