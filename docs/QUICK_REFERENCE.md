# Warpcore - Quick Reference Guide

## Quick Win Commands

### Diff - Preview Changes

Show what would change without deploying:

```bash
# Show diff for environment
warpcore diff --env dev

# Show diff for specific agent
warpcore diff --env prod --agent customer-support

# JSON output for CI/CD
warpcore diff --env dev --json-output
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
warpcore validate

# Validate specific environment
warpcore validate --env prod

# Strict mode (warnings as errors)
warpcore validate --strict

# JSON output
warpcore validate --json-output
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
warpcore graph --env dev --format tree

# ASCII format (levels)
warpcore graph --env dev --format ascii

# DOT format (Graphviz)
warpcore graph --env dev --format dot

# Save to file
warpcore graph --env dev --format dot --output graph.dot

# Open in browser (auto-render)
warpcore graph --env dev --format dot

# Filter by agent
warpcore graph --env prod --agent customer-support
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
warpcore output --env dev

# Filter by agent
warpcore output --env prod --agent customer-support

# JSON format
warpcore output --env dev --format json

# Environment variable format
warpcore output --env dev --format env

# Get specific output
warpcore output --env dev --output-name customer-support-agent_url
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
eval $(warpcore output --env dev --format env)

# Get API endpoint for testing
API_URL=$(warpcore output --env dev --output-name api_endpoint)
curl $API_URL
```

---

### Forecast - Predict Costs

Predict costs before deployment:

```bash
# Monthly forecast (default)
warpcore forecast

# Daily forecast
warpcore forecast --period daily

# Yearly forecast
warpcore forecast --period yearly

# JSON output
warpcore forecast --json-output

# Specific environment
warpcore forecast --env prod
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
warpcore limits show

# Set a limit
warpcore limits set lambda max_memory_mb 2048
warpcore limits set cost max_monthly_cost_usd 5000

# Reset to defaults
warpcore limits reset

# Check configuration against limits
warpcore limits check

# Check specific environment
warpcore limits check --env prod
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
warpcore notifications show

# Configure Slack
warpcore notifications configure --slack-webhook https://hooks.slack.com/...

# Configure Discord
warpcore notifications configure --discord-webhook https://discord.com/api/webhooks/...

# Configure email
warpcore notifications configure --email [email]

# Configure PagerDuty
warpcore notifications configure --pagerduty-key your-integration-key

# Enable/disable channels
warpcore notifications toggle slack on
warpcore notifications toggle discord off

# Enable/disable events
warpcore notifications event deployment_success on
warpcore notifications event cost_alert off

# Test notifications
warpcore notifications test --message "Test notification"
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
warpcore deploy --env dev

# Deploy specific agent
warpcore deploy --env prod --agent customer-support

# Sequential deployment
warpcore deploy --env dev --sequential

# Auto-rollback on failure
warpcore deploy --env prod --auto-rollback
```

---

### Destroy

Remove deployed infrastructure:

```bash
# Destroy all resources
warpcore destroy --env dev

# Destroy specific agent
warpcore destroy --env prod --agent customer-support

# Skip confirmation
warpcore destroy --env dev --yes
```

---

### List

Show deployed resources:

```bash
# List all resources
warpcore list --env dev

# Filter by agent
warpcore list --env prod --agent customer-support

# Filter by type
warpcore list --env dev --type AWS::Lambda::Function

# Filter by tag
warpcore list --env prod --tag team=platform
```

---

### Describe

Show detailed resource information:

```bash
# Describe resource
warpcore describe customer-support-agent --env dev
```

---

### Dev

Start local development server:

```bash
# Start dev server
warpcore dev --env dev --agent customer-support
```

---

### Init

Initialize new project:

```bash
# Interactive initialization
warpcore init

# With options
warpcore init --name my-project --region us-east-1
```

---

## Environment Commands

```bash
# List environments
warpcore env list

# Show environment details
warpcore env show dev

# Compare environments
warpcore env diff dev prod
```

---

## History Commands

```bash
# List deployment history
warpcore history list --env dev

# Show deployment details
warpcore history show <deployment-id> --env dev

# View logs
warpcore history logs --env dev --lines 100

# Compare deployments
warpcore history compare <id1> <id2> --env dev

# Rollback to previous deployment
warpcore history rollback <deployment-id> --env dev
```

---

## Cost Commands

```bash
# View costs by environment
warpcore costs --by environment

# View costs by agent
warpcore costs --by agent

# View costs for period
warpcore costs --project my-project --period last-month

# Set budget alert
warpcore budget set --environment prod --limit 1000 --alert-threshold 80
```

---

## Agentic Commands

```bash
# Detect drift
warpcore agentic drift --env dev

# Analyze failures
warpcore agentic analyze --env dev

# Reconcile infrastructure
warpcore agentic reconcile --env dev
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
        run: warpcore validate --strict
      
      - name: Check limits
        run: warpcore limits check
      
      - name: Forecast costs
        run: warpcore forecast --json-output > forecast.json
      
      - name: Show diff
        if: github.event_name == 'pull_request'
        run: warpcore diff --env dev --json-output > diff.json
      
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
        run: warpcore deploy --env dev
```

### GitLab CI

```yaml
stages:
  - validate
  - deploy

validate:
  stage: validate
  script:
    - warpcore validate --strict
    - warpcore limits check
    - warpcore forecast --json-output > forecast.json
    - warpcore diff --env dev --json-output > diff.json
  artifacts:
    reports:
      dotenv: forecast.json

deploy:
  stage: deploy
  script:
    - warpcore deploy --env dev
  only:
    - main
```

---

## Shell Aliases

Add to your `.bashrc` or `.zshrc`:

```bash
# Quick aliases
alias sd='warpcore deploy'
alias sde='warpcore destroy'
alias sl='warpcore list'
alias sv='warpcore validate'
alias sf='warpcore forecast'
alias so='warpcore output'

# Environment-specific
alias sd-dev='warpcore deploy --env dev'
alias sd-prod='warpcore deploy --env prod'
alias sl-dev='warpcore list --env dev'
alias sl-prod='warpcore list --env prod'
```

---

## Tips & Tricks

### 1. Preview Before Deploy

Always validate and diff before deploying:

```bash
warpcore validate --strict && \
warpcore diff --env prod && \
warpcore deploy --env prod
```

### 2. Export Outputs

Export outputs as environment variables:

```bash
eval $(warpcore output --env dev --format env)
echo $CUSTOMER_SUPPORT_AGENT_URL
```

### 3. Cost Monitoring

Set up cost alerts and check forecasts:

```bash
# Set budget
warpcore limits set cost max_monthly_cost_usd 1000

# Check forecast
warpcore forecast --period monthly

# Configure alerts
warpcore notifications configure --slack-webhook <url>
warpcore notifications event cost_alert on
```

### 4. Visualize Architecture

Generate architecture diagrams:

```bash
# Generate graph
warpcore graph --env prod --format dot --output architecture.dot

# Render to PNG
dot -Tpng architecture.dot -o architecture.png

# Or auto-open in browser
warpcore graph --env prod --format dot
```

### 5. CI/CD Integration

Use JSON outputs in pipelines:

```bash
# Get deployment summary
DIFF=$(warpcore diff --env prod --json-output)
TO_ADD=$(echo $DIFF | jq '.summary.to_add')
TO_CHANGE=$(echo $DIFF | jq '.summary.to_change')

# Get cost forecast
COST=$(warpcore forecast --json-output | jq '.total_cost')

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
warpcore notifications configure --slack-webhook <team-webhook>

# Enable all events
warpcore notifications event deployment_start on
warpcore notifications event deployment_success on
warpcore notifications event deployment_failure on
warpcore notifications event cost_alert on
```

---

## Troubleshooting

### Validation Fails

```bash
# See detailed errors
warpcore validate --strict

# Check specific environment
warpcore validate --env prod
```

### Deployment Fails

```bash
# Check logs
warpcore history logs --env dev --lines 100

# Analyze with AI
warpcore agentic analyze --env dev

# View failed resources
warpcore list --env dev
```

### Cost Too High

```bash
# Check forecast
warpcore forecast --period monthly

# Check limits
warpcore limits show

# Adjust configuration
# Edit warpcore.yaml to reduce memory, timeout, etc.

# Validate changes
warpcore validate
warpcore forecast
```

### Dependency Issues

```bash
# Visualize dependencies
warpcore graph --env dev --format tree

# Check for circular dependencies
warpcore validate
```

---

## Getting Help

```bash
# General help
warpcore --help

# Command help
warpcore deploy --help
warpcore diff --help
warpcore validate --help

# Version
warpcore --version
```

---

## Configuration Files

### Project Configuration (`warpcore.yaml`)

Main configuration file for your project.

### Limits Configuration (`.warpcore/limits.json`)

Organizational resource limits.

### Notifications Configuration (`.warpcore/notifications.json`)

Notification channel and event configuration.

### State Files (`.warpcore/state/*.json`)

Deployment state for each environment.

---

## Best Practices

1. **Always validate before deploying**
   ```bash
   warpcore validate --strict && warpcore deploy --env prod
   ```

2. **Preview changes with diff**
   ```bash
   warpcore diff --env prod
   ```

3. **Monitor costs**
   ```bash
   warpcore forecast --period monthly
   warpcore limits set cost max_monthly_cost_usd 1000
   ```

4. **Set up notifications**
   ```bash
   warpcore notifications configure --slack-webhook <url>
   ```

5. **Use limits to enforce standards**
   ```bash
   warpcore limits set lambda max_memory_mb 2048
   warpcore limits check
   ```

6. **Document architecture**
   ```bash
   warpcore graph --env prod --format dot --output docs/architecture.dot
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


### Discover: account to project

Turn what is deployed in an account into a Visual Builder project:

```bash
warpcore --profile prod discover project \
  --project-name shop --env prod \
  --region us-east-1 --region eu-west-1 \
  --include 'AWS::Lambda::*' --include type:dynamodb --exclude 'name:*-test' \
  --lambda-as agent --adopt --json
```

Globs match type, name, ARN, region or `tag=value`; prefix with `type:`, `name:`,
`tag:` or `region:` to pin a field. `--adopt` registers the included resources in
local deployment state so `deploy` updates them instead of creating duplicates.
Use `--progress` for NDJSON progress events ending in a `result` event.
