# Strands AWS Deployment System

A Python-based infrastructure deployment tool optimized for deploying Strands SDK agents and agentcore runtime to AWS.

## Features

- Direct AWS resource management using boto3
- CDK-compatible state tracking
- Local development mode with AWS connectivity
- Fast parallel deployments
- Resource optimization (shared IAM roles, security groups)
- Comprehensive CLI interface

## Installation

```bash
pip install -e .
```

For development:

```bash
pip install -e ".[dev]"
```

## Quick Start

```bash
# Initialize a new project
strands init

# Deploy to an environment
strands deploy --env dev

# List deployed resources
strands list --env dev

# Start local development mode
strands dev --env dev --agent my-agent

# Destroy infrastructure
strands destroy --env dev
```

## Project Structure

```
src/strands_deploy/
├── cli/              # Command-line interface
├── config/           # Configuration parsing and validation
├── state/            # State management
├── provisioners/     # AWS resource provisioners
├── orchestrator/     # Deployment coordination
├── local_dev/        # Local development server
└── utils/            # Logging, AWS clients, helpers
```

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
