# Package Manager Comparison for Warpcore

## TL;DR: Use uv

For the best developer experience with Warpcore, we recommend **uv**.

## Comparison

| Feature | uv | pip | Poetry |
|---------|----|----|--------|
| **Speed** | ⚡️ 10-100x faster | Baseline | 2-3x faster |
| **Lockfile** | ✅ `uv.lock` | ❌ No | ✅ `poetry.lock` |
| **Virtual env** | ✅ Automatic | Manual | ✅ Automatic |
| **Setup complexity** | 🟢 Simple | 🟢 Simple | 🟡 Medium |
| **pyproject.toml** | ✅ Native | ✅ Native | ✅ Native |
| **Dependency resolution** | ⚡️ Rust-based | 🐌 Slow | 🟡 Medium |
| **Compatibility** | ✅ pip-compatible | ✅ Standard | 🟡 Own format |
| **Install size** | ~10MB | Included | ~50MB |

## Detailed Comparison

### uv (Recommended) ⭐

**Pros:**
- Extremely fast (written in Rust)
- Drop-in pip replacement
- Automatic virtual environment management
- Lockfile for reproducible builds
- Works with existing pyproject.toml
- Single binary, easy to install
- Active development by Astral (makers of Ruff)

**Cons:**
- Relatively new (but stable)
- Smaller ecosystem than pip/Poetry

**Best for:**
- Fast iteration during development
- CI/CD pipelines (speed matters)
- Teams that want modern tooling without complexity

**Install:**
```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
```

**Usage:**
```bash
uv sync              # Install deps + create venv
uv run warpcore init # Run commands
uv add boto3         # Add dependency
uv pip install -e .  # pip-compatible mode
```

### pip (Current)

**Pros:**
- Comes with Python
- Universal standard
- Everyone knows it
- Simple

**Cons:**
- Slow dependency resolution
- No lockfile (without pip-tools)
- Manual virtual environment management
- Can have version conflicts

**Best for:**
- Quick prototypes
- When you can't install additional tools
- Maximum compatibility

**Usage:**
```bash
python -m venv venv
source venv/bin/activate
pip install -e ".[dev]"
```

### Poetry

**Pros:**
- Mature and stable
- Good dependency management
- Lockfile support
- Nice CLI
- Publishing to PyPI built-in

**Cons:**
- Slower than uv
- More opinionated about project structure
- Heavier weight
- Can conflict with pip workflows
- Requires migration effort

**Best for:**
- Publishing packages to PyPI
- Teams already using Poetry
- Projects that need strict dependency management

**Usage:**
```bash
poetry install
poetry run warpcore init
poetry add boto3
```

## Migration Guide

### From pip to uv

No migration needed! uv is pip-compatible:

```bash
# Install uv
curl -LsSf https://astral.sh/uv/install.sh | sh

# Use it exactly like pip
uv pip install -e ".[dev]"

# Or use native uv commands (better)
uv sync --all-extras
```

### From pip to Poetry

Requires more work:

```bash
# Install Poetry
curl -sSL https://install.python-poetry.org | python3 -

# Convert pyproject.toml (manual)
# Poetry uses different format for dependencies

# Install
poetry install
```

## Recommendation for Warpcore

**For development:** Use **uv**
- Fast iteration
- Easy setup
- Modern tooling
- No migration needed

**For CI/CD:** Use **uv**
- Dramatically faster builds
- Reproducible with lockfile
- Simple caching

**For users:** Support **all three**
- Users can choose their preferred tool
- pyproject.toml works with all of them

## Performance Comparison

Real-world install times for Warpcore:

```
pip:    ~15-30 seconds
Poetry: ~10-20 seconds
uv:     ~1-3 seconds
```

## Current Status

Warpcore currently uses:
- **Build backend:** hatchling (lightweight, modern)
- **Recommended installer:** uv
- **Compatible with:** pip, Poetry, pipx, uv

All three package managers work with the current `pyproject.toml`.
