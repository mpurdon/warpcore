# Agentic Reconciliation System

An optional AI-powered system for infrastructure drift detection, failure analysis, and automated recovery planning.

## Overview

The agentic reconciliation system enhances the Strands deployment system with LLM-powered analysis capabilities while maintaining deterministic execution. It provides natural language insights into infrastructure issues without compromising reliability.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│           Deterministic Deployment Engine                │
│  (Executes planned changes in predictable order)        │
└────────────────┬────────────────────────────────────────┘
                 │
                 │ Provides context
                 │
┌────────────────▼────────────────────────────────────────┐
│         Agentic Reconciliation System (Optional)         │
│  (Analyzes drift, suggests fixes, learns from failures)  │
└──────────────────────────────────────────────────────────┘
```

## Components

### 1. Models (`models.py`)
Data structures for drift detection, failure analysis, and recovery planning.

**Key Classes:**
- `DriftItem`: Single drift detection
- `DriftReport`: Complete drift analysis
- `FailureAnalysis`: AI-powered failure diagnosis
- `MissingResource`: Missing infrastructure detection
- `RecoveryPlan`: AI-generated recovery actions

### 2. Scanner (`scanner.py`)
AWS resource scanner for drift detection.

**Features:**
- Uses Resource Groups Tagging API
- Filters by project and environment tags
- Supports detailed property retrieval
- Handles multiple AWS services

### 3. LLM Client (`llm_client.py`)
Interface to LLM providers for AI analysis.

**Supported Providers:**
- OpenAI (GPT-4)
- Anthropic (Claude)
- AWS Bedrock
- Local models

**Key Methods:**
- `analyze_drift()`: Natural language drift analysis
- `analyze_failure()`: Root cause analysis
- `prioritize_missing_resources()`: Impact-based prioritization
- `suggest_recovery()`: Recovery plan generation

### 4. Reconciler (`reconciler.py`)
Main orchestrator for agentic features.

**Core Functionality:**
- Drift detection and comparison
- Failure analysis with context
- Missing resource identification
- Recovery plan generation

## Usage

### CLI Commands

#### Detect Drift
```bash
strands agentic drift --env prod --llm-provider openai
```

#### Analyze Failure
```bash
strands agentic analyze-failure "AccessDenied" \
  --env dev \
  --resource-id my-lambda \
  --llm-provider anthropic
```

#### Generate Recovery Plan
```bash
strands agentic reconcile --env staging
```

#### Find Missing Resources
```bash
strands agentic missing --env prod
```

### Programmatic Usage

```python
from strands_deploy.agentic import AgenticReconciler, LLMClient, LLMProvider
import boto3

# Setup
boto_session = boto3.Session()
state_manager = StateManager('state.json')
llm_client = LLMClient(provider=LLMProvider.OPENAI)

# Create reconciler
reconciler = AgenticReconciler(
    state_manager=state_manager,
    boto_session=boto_session,
    project_name='my-project',
    environment='dev',
    region='us-east-1',
    llm_client=llm_client
)

# Detect drift
drift_report = reconciler.detect_drift()

# Analyze failure
analysis = reconciler.analyze_failure(error)

# Find missing resources
missing = reconciler.find_missing_resources()

# Generate recovery plan
plan = reconciler.generate_recovery_plan(drift_report)
```

## Configuration

### LLM Provider Setup

#### OpenAI
```bash
export OPENAI_API_KEY='your-key'
```

#### Anthropic
```bash
export ANTHROPIC_API_KEY='your-key'
```

#### AWS Bedrock
Uses standard AWS credentials - no additional setup required.

#### Local Models
```python
llm_client = LLMClient(
    provider=LLMProvider.LOCAL,
    endpoint='http://localhost:11434'  # Ollama endpoint
)
```

### Custom Model Selection
```python
llm_client = LLMClient(
    provider=LLMProvider.OPENAI,
    model='gpt-4-turbo'
)
```

## Design Principles

### 1. Deterministic Execution
- AI only analyzes and suggests
- Core engine executes deterministically
- No automatic changes without approval

### 2. Human in the Loop
- All suggestions require review
- Clear warnings about AI content
- Explicit confirmation for actions

### 3. Explainability
- Natural language explanations
- Confidence scores provided
- Reasoning shown for decisions

### 4. Fallback Support
- Works without LLM API keys
- Graceful degradation
- No hard dependencies

### 5. Security First
- API keys in environment variables
- No sensitive data to LLM by default
- Read-only AWS access for scanning
- Audit logging of AI interactions

## Use Cases

### 1. Drift Detection
**Problem:** Manual changes to infrastructure go unnoticed
**Solution:** Automated scanning with AI-powered impact analysis

### 2. Failure Analysis
**Problem:** Cryptic AWS error messages are hard to debug
**Solution:** AI translates errors into actionable fixes

### 3. Missing Resources
**Problem:** Resources deleted manually break deployments
**Solution:** Automated detection with prioritized recovery

### 4. Recovery Planning
**Problem:** Complex drift requires careful remediation
**Solution:** AI generates step-by-step recovery plans

## Limitations

### Current
- No automatic execution (requires manual approval)
- Best results require LLM API access
- LLM API calls incur costs
- AI analysis adds latency
- Suggestions may not always be correct

### Future Enhancements
- Automatic execution with safety checks
- Offline operation with local models
- Learning from past failures
- Scheduled drift detection
- Predictive analysis

## Testing

### Unit Tests
```bash
pytest tests/agentic/test_models.py
pytest tests/agentic/test_scanner.py
pytest tests/agentic/test_llm_client.py
pytest tests/agentic/test_reconciler.py
```

### Integration Tests
```bash
pytest tests/agentic/test_integration.py
```

### Manual Testing
1. Deploy infrastructure
2. Manually modify resources
3. Run drift detection
4. Verify AI analysis
5. Test recovery plan generation

## Security Considerations

### API Key Management
- Store in environment variables
- Never log or persist
- Rotate regularly
- Use secrets manager in production

### AWS Permissions
Required permissions for scanning:
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "tag:GetResources",
        "lambda:GetFunction",
        "iam:GetRole",
        "ec2:DescribeVpcs",
        "ec2:DescribeSecurityGroups",
        "s3:GetBucketLocation",
        "dynamodb:DescribeTable",
        "sqs:GetQueueAttributes",
        "sns:GetTopicAttributes"
      ],
      "Resource": "*"
    }
  ]
}
```

### Data Privacy
- Sanitize sensitive data before LLM
- Support on-premises deployment
- Audit all AI interactions
- Comply with data residency requirements

## Troubleshooting

### LLM Not Working
```bash
# Check API key
echo $OPENAI_API_KEY

# Test connection
python -c "from strands_deploy.agentic import LLMClient; client = LLMClient(); print('OK')"
```

### Scanner Not Finding Resources
- Verify resources have correct tags
- Check AWS credentials and permissions
- Ensure region is correct
- Review Resource Groups Tagging API limits

### Drift Detection Issues
- Verify state file exists and is valid
- Check AWS connectivity
- Review scanner logs for errors
- Ensure resources are tagged correctly

## Contributing

### Adding New Resource Types
1. Add scanner method in `scanner.py`
2. Update resource type mapping
3. Add tests
4. Update documentation

### Adding New LLM Providers
1. Add provider to `LLMProvider` enum
2. Implement client initialization
3. Implement API call method
4. Add tests
5. Update documentation

### Improving AI Prompts
1. Test prompt changes thoroughly
2. Measure accuracy improvements
3. Document prompt engineering decisions
4. Consider token usage impact

## References

- [Design Document](../../../../docs/task-12-agentic-reconciliation-summary.md)
- [Examples](../../../../examples/agentic_reconciliation_example.py)
- [CLI Documentation](../cli/agentic.py)
- [Requirements](../../../../.kiro/specs/strands-aws-deployment-system/requirements.md)

## License

Part of the Strands AWS Deployment System.
