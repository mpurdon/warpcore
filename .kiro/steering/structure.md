# Project Structure

## Root Directory Layout
```
src/warpcore/          # Main package (note: package name differs from CLI name "warpcore")
├── cli/                     # Command-line interface modules
├── config/                  # Configuration parsing and validation
├── state/                   # State management and checkpoints
├── provisioners/            # AWS resource provisioners
├── orchestrator/            # Deployment coordination and planning
├── local_dev/               # Local development server
├── monitoring/              # CloudWatch and X-Ray integration
├── history/                 # Deployment history and cost tracking
├── agentic/                 # AI-powered reconciliation
├── optimizer/               # Resource optimization
├── tagging/                 # Resource tagging and cost management
└── utils/                   # Shared utilities (AWS clients, logging, errors)
```

## Key Architectural Components

### CLI Module (`cli/`)
- `main.py`: Primary CLI entry point with core commands
- `costs.py`, `agentic.py`, `diff.py`, etc.: Specialized command groups
- Each command module follows Click framework patterns
- Rich console used for all output formatting

### Configuration (`config/`)
- `models.py`: Pydantic models for type-safe configuration
- `parser.py`: YAML configuration file parsing
- `monorepo.py`: Multi-project configuration support
- Configuration file: `warpcore.yaml`

### Provisioners (`provisioners/`)
- `base.py`: Abstract base class defining provisioner interface
- Individual AWS service provisioners (e.g., `lambda_function.py`, `api_gateway.py`)
- Each provisioner implements: `plan()`, `provision()`, `destroy()`, `get_current_state()`
- Resource definitions use dataclasses with type hints

### State Management (`state/`)
- `manager.py`: Core state persistence and loading
- `models.py`: State data structures
- `checkpoint.py`: Rollback and recovery support
- State files stored in `.warpcore/state/` directory

### Orchestration (`orchestrator/`)
- `orchestrator.py`: Main deployment coordination
- `dependency_graph.py`: Resource dependency resolution
- `executor.py`: Parallel/sequential execution engine
- `planner.py`: Deployment planning and change detection
- `rollback.py`: Automatic rollback strategies

## File Naming Conventions
- Use snake_case for all Python files and directories
- Provisioner files named after AWS service (e.g., `lambda_function.py` not `lambda.py`)
- CLI command modules match command names
- Model files contain Pydantic classes for data validation

## Import Patterns
- Absolute imports from package root: `from warpcore.utils.logging import get_logger`
- Group imports: stdlib, third-party, local
- Use type hints from `typing` module for Python 3.11 compatibility

## Configuration Files
- Main config: `warpcore.yaml` (YAML format)
- State files: `.warpcore/state/{project}-{env}.json`
- Logs: `.warpcore/logs/warpcore-{date}.jsonl`
- Checkpoints: `.warpcore/state/{project}-{env}.checkpoint`

## Directory Conventions
- `.warpcore/`: Local state and logs (add to .gitignore)
- `examples/`: Usage examples and sample code
- `docs/`: Task completion summaries and documentation
- `visual-builder/`: UI components (separate from core CLI)

## Error Handling Patterns
- Custom exceptions in `utils/errors.py`
- Rich console for user-friendly error display
- Structured logging with JSON format for automation
- Graceful degradation for missing AWS permissions