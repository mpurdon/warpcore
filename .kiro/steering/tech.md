# Technology Stack

## Build System & Package Management
- **Build System**: hatchling with pyproject.toml configuration
- **Python Version**: 3.11+ (supports 3.11 and 3.12)
- **Package Manager**: uv (recommended) or pip with editable installs for development
- **Lockfile**: uv.lock for reproducible builds

## Core Dependencies
- **boto3**: AWS SDK for Python (>=1.34.0)
- **click**: Command-line interface framework (>=8.1.0)
- **pydantic**: Data validation and settings management (>=2.5.0)
- **rich**: Rich text and beautiful formatting for terminal (>=13.7.0)
- **pyyaml**: YAML parsing for configuration files (>=6.0)
- **watchdog**: File system event monitoring for local dev (>=3.0.0)

## Development Tools
- **pytest**: Testing framework with asyncio support
- **moto**: AWS service mocking for tests
- **black**: Code formatting (line length: 100)
- **ruff**: Fast Python linter and formatter

## Architecture Patterns
- **Provisioner Pattern**: Abstract base class for AWS resource management
- **State Management**: JSON-based state tracking with checkpoint support
- **Orchestration**: Dependency graph-based deployment coordination
- **Plugin Architecture**: Modular provisioners for different AWS services

## Common Commands

### Installation
```bash
# Recommended: Using uv (10-100x faster)
uv sync --all-extras

# Alternative: Using pip
pip install -e ".[dev]"
```

### Development Workflow
```bash
# With uv (recommended)
uv run pytest
uv run black src/
uv run ruff check src/

# With pip
pytest
black src/
ruff check src/
```

### CLI Usage
```bash
# With uv (recommended)
uv run warpcore init
uv run warpcore deploy --env dev
uv run warpcore dev --env dev --agent my-agent
uv run warpcore list --env dev

# Or activate venv first
source .venv/bin/activate
warpcore init
warpcore deploy --env dev
```

## Code Style Guidelines
- Line length: 100 characters
- Use type hints for all function parameters and return values
- Follow PEP 8 naming conventions
- Use dataclasses for data structures
- Prefer composition over inheritance
- Use Rich console for all CLI output formatting