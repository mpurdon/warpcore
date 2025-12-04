# Strands Deploy - Quick Reference Guide

## Quick Win Commands

### Diff - Preview Changes

Show what would change without deploying:

```bash
# Show diff for environment
strands diff --env dev

# Show diff for specific agent
strands diff --env prod --agent customer-support

# JSON output for CI/CD
strands diff --env dev --json-output
```

**Output:**
- Resources to create (green)
- Resources to update (yellow)
- Resources to destroy (red)
- Deployment waves
- Estimated duration

---

### Validate - Check Configuration

Validate configuration before deploying:

```bash
# Validate configuration
strands validate

# Validate specific environment
strands validate --env prod

# Strict mode (warnings as errors)
strands validate --strict

# JSON output
strands validate --json-output
```

**Checks:**
- Configuration structure
- Environment settings (account, region)
- Agent settings (runtime, memory, timeout)
- IAM policies (overly permissive warnings)
- VPC configuration (CIDR, IPAM)

---

### Graph - Visualize Dependencies

Visualize resource dependency graph:

```bash
# Tree format (terminal)
strands graph --env dev --format tree

# ASCII format (levels)
strands graph --env dev --format ascii

# DOT format (Graphviz)
strands graph --env dev --format dot

# Save to file
strands graph --env dev --format dot --output graph.dot

# Open in browser (auto-render)
strands graph --env dev --format dot

# Filter by agent
strands graph --env prod --agent customer-support
```

**Formats:**
- `tree`: Rich tree visualization in terminal
- `ascii`: Level-based ASCII art
- `dot`: Graphviz DOT format (can render to PNG/SVG)

---

### Output - Show Stack Outputs

Show deployed resource outputs (endpoints, ARNs):

```bash
# Show all outputs
strands output --env dev

# Filter by agent
strands output --env prod --agent customer-support

# JSON format
strands output --env dev --format json

# Environment variable format
strands output --env dev --format env

# Get specific output
strands output --env dev --output-name customer-support-agent_url
```

**Output Types:**
- Lambda: ARN, name, function URL
- API Gateway: ID, endpoint
- S3: Bucket name, ARN
- DynamoDB: Table name, ARN
- SQS: Queue URL, ARN
- SNS: Topic ARN
- VPC: VPC ID, CIDR
- Security Group: Group ID
- IAM Role: ARN, name

**Use Cases:**
```bash
# Export to environment variables
eval $(strands output --env dev --format env)

# Get API endpoint for testing
API_URL=$(strands output --env dev --output-name api_endpoint)
curl $API_URL
```

---

### Forecast - Predict Costs

Predict costs before deployment:

```bash
# Monthly forecast (default)
strands forecast

# Daily forecast
strands forecast --period daily

# Yearly forecast
strands forecast --period yearly

# JSON output
strands forecast --json-output

# Specific environment
strands forecast --env prod
```

**Cost Breakdown:**
- Lambda (compute + requests)
- API Gateway (requests)
- CloudWatch Logs (data ingestion)
- X-Ray (traces)
- NAT Gateway (hours + data)
- VPC Endpoints (hours)

**Assumptions:**
- Lambda: 1M requests/month, 1s avg duration
- API Gateway: 1M requests/month
- NAT Gateway: 100GB data/month
- 24/7 operation

---

### Limits - Manage Resource Limits

Set and enforce organizational resource limits:

```bash
# Show current limits
strands limits show

# Set a limit
strands limits set lambda max_memory_mb 2048
strands limits set cost max_monthly_cost_usd 5000

# Reset to defaults
strands limits reset

# Check configuration against limits
strands limits check

# Check specific environment
strands limits check --env prod
```

**Default Limits:**
```
Lambda:
  - Max memory: 3008 MB
  - Max timeout: 300 seconds
  - Max concurrent executions: 100

DynamoDB:
  - Max read capacity: 1000
  - Max write capacity: 1000

API Gateway:
  - Max throttle rate: 10000
  - Max throttle burst: 5000

VPC:
  - Max NAT gateways: 3
  - Max VPCs per region: 5

Cost:
  - Max monthly cost: $1000
  - Alert threshold: 80%
```

---

### Notifications - Deployment Alerts

Configure deployment notifications:

```bash
# Show configuration
strands notifications show

# Configure Slack
strands notifications configure --slack-webhook https://hooks.slack.com/...

# Configure Discord
strands notifications configure --discord-webhook https://discord.com/api/webhooks/...

# Configure email
strands notifications configure --email [email]

# Configure PagerDuty
strands notifications configure --pagerduty-key your-integration-key

# Enable/disable channels
strands notifications toggle slack on
strands notifications toggle discord off

# Enable/disable events
strands notifications event deployment_success on
strands notifications event cost_alert off

# Test notifications
strands notifications test --message "Test notification"
```

**Supported Events:**
- `deployment_start`: When deployment begins
- `deployment_success`: When deployment succeeds
- `deployment_failure`: When deployment fails
- `cost_alert`: When cost thresholds exceeded

**Channels:**
- **Slack**: Rich formatted messages
- **Discord**: Embedded messages
- **Email**: AWS SES (requires setup)
- **PagerDuty**: Critical alerts only

---

## Core Commands

### Deploy

Deploy infrastructure to AWS:

```bash
# Deploy to environment
strands deploy --env dev

# Deploy specific agent
strands deploy --env prod --agent customer-support

# Sequential deployment
strands deploy --env dev --sequential

# Auto-rollback on failure
strands deploy --env prod --auto-rollback
```

---

### Destroy

Remove deployed infrastructure:

```bash
# Destroy all resources
strands destroy --env dev

# Destroy specific agent
strands destroy --env prod --agent customer-support

# Skip confirmation
strands destroy --env dev --yes
```

---

### List

Show deployed resources:

```bash
# List all resources
strands list --env dev

# Filter by agent
strands list --env prod --agent customer-support

# Filter by type
strands list --env dev --type AWS::Lambda::Function

# Filter by tag
strands list --env prod --tag team=platform
```

---

### Describe

Show detailed resource information:

```bash
# Describe resource
strands describe customer-support-agent --env dev
```

---

### Dev

Start local development server:

```bash
# Start dev server
strands dev --env dev --agent customer-support
```

---

### Init

Initialize new project:

```bash
# Interactive initialization
strands init

# With options
strands init --name my-project --region us-east-1
```

---

## Environment Commands

```bash
# List environments
strands env list

# Show environment details
strands env show dev

# Compare environments
strands env diff dev prod
```

---

## History Commands

```bash
# List deployment history
strands history list --env dev

# Show deployment details
strands history show <deployment-id> --env dev

# View logs
strands history logs --env dev --lines 100

# Compare deployments
strands history compare <id1> <id2> --env dev

# Rollback to previous deployment
strands history rollback <deployment-id> --env dev
```

---

## Cost Commands

```bash
# View costs by environment
strands costs --by environment

# View costs by agent
strands costs --by agent

# View costs for period
strands costs --project my-project --period last-month

# Set budget alert
strands budget set --environment prod --limit 1000 --alert-threshold 80
```

---

## Agentic Commands

```bash
# Detect drift
strands agentic drift --env dev

# Analyze failures
strands agentic analyze --env dev

# Reconcile infrastructure
strands agentic reconcile --env dev
```

---

## CI/CD Integration Examples

### GitHub Actions

```yaml
name: Deploy

on:
  pull_request:
    branches: [main]
  push:
    branches: [main]

jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      
      - name: Validate
        run: strands validate --strict
      
      - name: Check limits
        run: strands limits check
      
      - name: Forecast costs
        run: strands forecast --json-output > forecast.json
      
      - name: Show diff
        if: github.event_name == 'pull_request'
        run: strands diff --env dev --json-output > diff.json
      
      - name: Comment on PR
        if: github.event_name == 'pull_request'
        uses: actions/github-script@v6
        with:
          script: |
            const diff = require('./diff.json');
            const forecast = require('./forecast.json');
            github.rest.issues.createComment({
              ...context.repo,
              issue_number: context.issue.number,
              body: `**Changes:** ${diff.summary.to_add} to add, ${diff.summary.to_change} to change\n**Cost:** $${forecast.total_cost}/month`
            });
  
  deploy:
    needs: validate
    if: github.event_name == 'push'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - name: Deploy
        run: strands deploy --env dev
```

### GitLab CI

```yaml
stages:
  - validate
  - deploy

validate:
  stage: validate
  script:
    - strands validate --strict
    - strands limits check
    - strands forecast --json-output > forecast.json
    - strands diff --env dev --json-output > diff.json
  artifacts:
    reports:
      dotenv: forecast.json

deploy:
  stage: deploy
  script:
    - strands deploy --env dev
  only:
    - main
```

---

## Shell Aliases

Add to your `.bashrc` or `.zshrc`:

```bash
# Quick aliases
alias sd='strands deploy'
alias sde='strands destroy'
alias sl='strands list'
alias sv='strands validate'
alias sf='strands forecast'
alias so='strands output'

# Environment-specific
alias sd-dev='strands deploy --env dev'
alias sd-prod='strands deploy --env prod'
alias sl-dev='strands list --env dev'
alias sl-prod='strands list --env prod'
```

---

## Tips & Tricks

### 1. Preview Before Deploy

Always validate and diff before deploying:

```bash
strands validate --strict && \
strands diff --env prod && \
strands deploy --env prod
```

### 2. Export Outputs

Export outputs as environment variables:

```bash
eval $(strands output --env dev --format env)
echo $CUSTOMER_SUPPORT_AGENT_URL
```

### 3. Cost Monitoring

Set up cost alerts and check forecasts:

```bash
# Set budget
strands limits set cost max_monthly_cost_usd 1000

# Check forecast
strands forecast --period monthly

# Configure alerts
strands notifications configure --slack-webhook <url>
strands notifications event cost_alert on
```

### 4. Visualize Architecture

Generate architecture diagrams:

```bash
# Generate graph
strands graph --env prod --format dot --output architecture.dot

# Render to PNG
dot -Tpng architecture.dot -o architecture.png

# Or auto-open in browser
strands graph --env prod --format dot
```

### 5. CI/CD Integration

Use JSON outputs in pipelines:

```bash
# Get deployment summary
DIFF=$(strands diff --env prod --json-output)
TO_ADD=$(echo $DIFF | jq '.summary.to_add')
TO_CHANGE=$(echo $DIFF | jq '.summary.to_change')

# Get cost forecast
COST=$(strands forecast --json-output | jq '.total_cost')

# Fail if cost too high
if (( $(echo "$COST > 1000" | bc -l) )); then
  echo "Cost too high: $COST"
  exit 1
fi
```

### 6. Team Notifications

Keep team informed:

```bash
# Configure Slack for team channel
strands notifications configure --slack-webhook <team-webhook>

# Enable all events
strands notifications event deployment_start on
strands notifications event deployment_success on
strands notifications event deployment_failure on
strands notifications event cost_alert on
```

---

## Troubleshooting

### Validation Fails

```bash
# See detailed errors
strands validate --strict

# Check specific environment
strands validate --env prod
```

### Deployment Fails

```bash
# Check logs
strands history logs --env dev --lines 100

# Analyze with AI
strands agentic analyze --env dev

# View failed resources
strands list --env dev
```

### Cost Too High

```bash
# Check forecast
strands forecast --period monthly

# Check limits
strands limits show

# Adjust configuration
# Edit strands.yaml to reduce memory, timeout, etc.

# Validate changes
strands validate
strands forecast
```

### Dependency Issues

```bash
# Visualize dependencies
strands graph --env dev --format tree

# Check for circular dependencies
strands validate
```

---

## Getting Help

```bash
# General help
strands --help

# Command help
strands deploy --help
strands diff --help
strands validate --help

# Version
strands --version
```

---

## Configuration Files

### Project Configuration (`strands.yaml`)

Main configuration file for your project.

### Limits Configuration (`.strands/limits.json`)

Organizational resource limits.

### Notifications Configuration (`.strands/notifications.json`)

Notification channel and event configuration.

### State Files (`.strands/state/*.json`)

Deployment state for each environment.

---

## Best Practices

1. **Always validate before deploying**
   ```bash
   strands validate --strict && strands deploy --env prod
   ```

2. **Preview changes with diff**
   ```bash
   strands diff --env prod
   ```

3. **Monitor costs**
   ```bash
   strands forecast --period monthly
   strands limits set cost max_monthly_cost_usd 1000
   ```

4. **Set up notifications**
   ```bash
   strands notifications configure --slack-webhook <url>
   ```

5. **Use limits to enforce standards**
   ```bash
   strands limits set lambda max_memory_mb 2048
   strands limits check
   ```

6. **Document architecture**
   ```bash
   strands graph --env prod --format dot --output docs/architecture.dot
   ```

7. **Integrate with CI/CD**
   - Validate on every PR
   - Show diff in PR comments
   - Deploy on merge to main
   - Send notifications to team

---

## Additional Resources

- Full documentation: `docs/`
- Roadmap: `ROADMAP.md`
- Examples: `examples/`
- Architecture: `docs/design.md`
