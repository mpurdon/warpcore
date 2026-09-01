# Warpcore - Feature Implementation Plan

**Last Updated:** 2026-01-22

## Completed Features

### Priority 1 Items - ✅ COMPLETED

#### 1.1 History Commands (CLI) - ✅ DONE
- Implemented S3-based deployment history storage in `manager.py`
- Added `get_deployment_for_rollback()`, `get_cost_breakdown()`, `delete_deployment()` methods
- Updated `history list` command to use S3 history manager with fallback to local logs
- Implemented `history show` with detailed metadata, timing, resource changes, logs, API calls, and costs
- Implemented `history compare` with config diff, state diff, and metrics comparison
- Implemented `history rollback` with dry-run mode, confirmation dialog, and actual rollback execution

#### 1.2 Visual Builder - ✅ DONE
- Created `useDeployment.ts` hook for real-time deployment event handling
- Enhanced Tauri backend with `execute_deployment`, `execute_destroy`, `validate_config`, `get_deployment_history` commands
- Added chrono dependency for timestamp generation
- Enhanced `DeploymentHistoryPanel.tsx` with rollback confirmation, comparison, and export features
- Expanded template system with AI/ML templates (Bedrock Agent, RAG Agent, Multi-Agent Workflow, Async Pipeline)
- Added template categories, import/export, and `applyTemplate` helper

### Priority 2 Items - ✅ COMPLETED

#### 2.1 Agentic Reconciliation Testing - ✅ DONE
- Created comprehensive test suite in `tests/agentic/`
- `test_scanner.py`: Tests for AWSScanner, ARN parsing, resource scanning
- `test_models.py`: Tests for all Pydantic models (DriftItem, DriftReport, FailureAnalysis, RecoveryPlan, etc.)
- `test_reconciler.py`: Tests for AgenticReconciler drift detection, comparison, and recovery planning
- `test_llm_client.py`: Tests for LLM client with OpenAI mocking, prompt construction, fallback behavior
- Added `conftest.py` with shared fixtures
- Updated `pyproject.toml` with pytest configuration

---

## Original Analysis (For Reference)

Based on codebase analysis, here are features that were not complete and needed work:

---

## Priority 1: Partially Implemented (Blockers for MVP)

### 1.1 History Commands (CLI)
**Location:** `src/warpcore/cli/main.py:1047-1169`

Currently the following history commands have placeholder implementations:
- `history show` - Shows "will be implemented with S3-based deployment history"
- `history compare` - Shows "will be implemented with S3-based deployment history"
- `history rollback` - Partial implementation, no actual rollback logic

**Required Work:**
- [ ] Implement S3-based deployment history storage
- [ ] Create deployment snapshot model (config, state, timestamp)
- [ ] Implement `history show` to fetch and display deployment metadata
- [ ] Implement `history compare` to diff two deployment snapshots
- [ ] Implement `history rollback` with actual state restoration
- [ ] Add deployment ID generation and tracking

**Files to modify:**
- `src/warpcore/history/manager.py`
- `src/warpcore/cli/main.py`

---

### 1.2 Visual Builder (Tauri Desktop App)
**Location:** `visual-builder/`

Per IMPLEMENTATION_NOTES.md, the following subtasks remain:

| Subtask | Description | Status |
|---------|-------------|--------|
| 13.2 | Full node system with all AWS resource types | Not Started |
| 13.3 | Permission editor modal for edges | Not Started |
| 13.4 | Bidirectional config sync with conflict resolution | Partial |
| 13.5 | WebSocket for real-time deployment updates | Not Started |
| 13.6 | Complete execution log panel features | Partial |
| 13.7 | Deployment timeline parallel execution viz | Partial |
| 13.8 | Deployment history panel | Not Started |
| 13.9 | Validation and cost estimation UI | Partial |
| 13.10 | Template system | Not Started |

**Required Work:**
- [ ] Complete all remaining node types (EventBridge, CloudWatch, etc.)
- [ ] Build role assignment modal for IAM edges
- [ ] Implement YAML conflict resolution when external edits occur
- [ ] Connect WebSocket to CLI output streaming
- [ ] Add search/filter to execution logs
- [ ] Visualize parallel execution lanes in timeline
- [ ] Create history panel with diff viewer
- [ ] Integrate CLI validation results in UI
- [ ] Build template library with save/load

---

## Priority 2: Core Functionality Gaps

### 2.1 History Module - Full Implementation
**Location:** `src/warpcore/history/`

The history module has models but incomplete integration:
- `models.py` - Has `DeploymentRecord`, `CostEstimate`
- `cost_estimator.py` - Basic cost estimation exists
- `comparison.py` - Deployment comparison logic
- `retention.py` - Retention policy handling
- `manager.py` - Needs S3 backend implementation

**Required Work:**
- [ ] Add S3 storage backend to `manager.py`
- [ ] Implement deployment record creation on each deploy
- [ ] Add state snapshot capture
- [ ] Implement retention policy enforcement
- [ ] Add cost tracking per deployment

---

### 2.2 Agentic Reconciliation Testing
**Location:** `src/warpcore/agentic/`

The agentic module exists but needs validation:
- `scanner.py` - Drift detection scanner
- `reconciler.py` - LLM-powered reconciliation
- `llm_client.py` - LLM client wrapper

**Required Work:**
- [ ] Add unit tests for drift detection
- [ ] Test LLM integration (Bedrock/OpenAI)
- [ ] Add dry-run mode for reconciliation
- [ ] Implement reconciliation plan approval workflow

---

### 2.3 CLI Commands Polish
**Location:** `src/warpcore/cli/`

Several CLI commands need completion:

| Command | Status | Missing |
|---------|--------|---------|
| `diff` | Implemented | Needs testing |
| `validate` | Implemented | Needs edge case handling |
| `graph` | Implemented | Needs export formats (PNG, DOT) |
| `forecast` | Implemented | Needs ML cost prediction |
| `limits` | Implemented | Needs all service limits |
| `notifications` | Implemented | Needs webhook integration |

---

## Priority 3: From ROADMAP - Phase 1 (Operational Maturity)

### 3.1 Testing Infrastructure
- [ ] Automatic provisioning of test resources
- [ ] Integration test environment setup
- [ ] Automated test resource cleanup

### 3.2 Secrets Management
- [ ] Automatic secrets rotation setup
- [ ] Secrets versioning and rollback
- [ ] Integration with external secret stores (Vault)

### 3.3 Compliance & Security
- [ ] AWS Config integration
- [ ] Security Hub integration
- [ ] WAF integration for API Gateway

---

## Priority 4: From ROADMAP - Phase 2 (Advanced Deployment)

### 4.1 Progressive Delivery
- [ ] Canary deployments with automatic rollback
- [ ] Blue-green deployment support
- [ ] Lambda aliases and versions management

### 4.2 Database Support
- [ ] RDS/Aurora provisioning
- [ ] Database migration management

---

## Priority 5: Developer Experience (Phase 3)

### 5.1 GitOps & CI/CD
- [ ] GitOps mode with repository watching
- [ ] Drift detection with auto-remediation
- [ ] GitHub Actions integration templates

### 5.2 Migration Tools
- [ ] Import existing AWS resources into state
- [ ] Migrate from AWS CDK
- [ ] Migrate from Serverless Framework

---

## Recommended Implementation Order

1. **Week 1-2: History Commands**
   - Complete S3-based history storage
   - Enable rollback functionality

2. **Week 3-4: Visual Builder Core**
   - Complete remaining node types
   - Implement WebSocket streaming

3. **Week 5-6: Visual Builder Polish**
   - Template system
   - History panel
   - Conflict resolution

4. **Week 7-8: Testing & Stability**
   - Agentic reconciliation testing
   - CLI edge cases
   - Integration tests

5. **Future: ROADMAP items**
   - Phase 1-8 features as prioritized

---

## Technical Debt Noted

1. **Logging**: `utils/logging.py` modified - may need cleanup
2. **Config models**: `config/models.py` has many modifications
3. **Optimizer**: `optimizer/optimizer.py` is placeholder
4. **Mock data**: Visual builder uses mock execution logs

---

## Files with Uncommitted Changes (from git status)

These files have modifications that should be reviewed:
- CLI commands: `agentic.py`, `diff.py`, `forecast.py`, `graph.py`, `limits.py`, `notifications.py`, `output.py`, `validate.py`
- Config: `models.py`, `parser.py`
- History: `manager.py`
- Optimizer: `optimizer.py`
- Visual builder: Multiple components

Consider committing current progress before starting new features.
