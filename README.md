# Warpcore

A Python-based infrastructure deployment tool optimized for deploying Strands SDK agents and agentcore runtime to AWS.

The name "Warpcore" is a wordplay combining "warp" (from weaving/strands) with "agentcore" (the runtime for Strands agents).

## Features

- **CLI Interface**: Comprehensive command-line tool for infrastructure management
- **Visual Builder**: Desktop app with drag-and-drop interface (N8N-style)
- Direct AWS resource management using boto3
- CDK-compatible state tracking
- Local development mode with AWS connectivity
- Fast parallel deployments
- Resource optimization (shared IAM roles, security groups)
- Real-time deployment monitoring and logs

## Installation

### Recommended: Using uv (Fast!)

```bash
# Install uv
curl -LsSf https://astral.sh/uv/install.sh | sh

# Install Warpcore
uv pip install -e ".[dev]"

# Or use uv's native sync
uv sync --all-extras
```

## Quick Start

### CLI Usage

```bash
# Initialize a new project
warpcore init

# Deploy to an environment
warpcore deploy --env dev

# List deployed resources
warpcore list --env dev

# Start local development mode
warpcore dev --env dev --agent my-agent

# Destroy infrastructure
warpcore destroy --env dev
```

### Visual Builder (Desktop App)

For a visual drag-and-drop interface:

```bash
cd visual-builder
./install-app.sh
```

Then launch "Warpcore Visual Builder" from Applications or run `warpcore-ui` (if you created the CLI launcher).

## Project Structure

```
src/warpcore/
├── cli/              # Command-line interface
├── config/           # Configuration parsing and validation
├── state/            # State management
├── provisioners/     # AWS resource provisioners
├── orchestrator/     # Deployment coordination
├── local_dev/        # Local development server
└── utils/            # Logging, AWS clients, helpers
```

## Building a standalone binary

Produces a single executable with the interpreter embedded, so the target
machine needs no Python at all:

```bash
uv pip install -e ".[build]"
python packaging/build.py
```

Output lands in `dist/` as both `warpcore` and a platform-tagged copy
(`warpcore-macos-arm64`, `warpcore-windows-x86_64`, ...) so artifacts from
several machines can be collected into one release.

PyInstaller does not cross-compile - run the build on each OS you ship. Pass
`--sidecar` to additionally emit a Tauri-sidecar-named copy for the visual
builder to bundle.

This matters most on Windows, where Python console scripts install into
`Scripts\` and are not reliably on `PATH`.

## Development

Run tests:

```bash
pytest
```

Format code:

```bash
black src/
```

Lint code:

```bash
ruff check src/
```

## License

MIT
