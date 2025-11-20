# Design Document

## Overview

The Strands AWS Deployment System is a Python-based infrastructure deployment tool optimized for deploying Strands SDK agents and agentcore runtime to AWS. The system uses boto3 for direct AWS resource management, maintains CDK-compatible state files, and provides local development capabilities similar to SST v2. The architecture prioritizes deployment speed, resource optimization, and developer experience through a comprehensive CLI interface.

### Key Design Principles

1. **Direct Control**: Use boto3 clients directly for AWS operations, avoiding abstraction layers that slow deployment
2. **State Compatibility**: Maintain state in CDK-compatible format for migration flexibility
3. **Resource Optimization**: Share resources (IAM roles, security groups) across agents following AWS best practices
4. **Developer Experience**: Provide fast feedback, clear error messages, and intuitive CLI commands
5. **Monorepo Support**: Handle multiple agents in a single repository with selective deployment
6. **Production Ready**: Implement AWS Well-Architected principles by default

## Architecture

### High-Level Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                         CLI Layer                            │
│  (Command parsing, user interaction, output formatting)      │
└────────────────┬────────────────────────────────────────────┘
                 │
┌────────────────▼────────────────────────────────────────────┐
│                    Orchestration Layer                       │
│  (Deployment planning, dependency resolution, parallelization)│
└────────────────┬────────────────────────────────────────────┘
                 │
┌────────────────▼────────────────────────────────────────────┐
│                    Resource Management Layer                 │
│  (Resource provisioners, state management, change detection) │
└────────────────┬────────────────────────────────────────────┘
                 │
┌────────────────▼────────────────────────────────────────────┐
│                      AWS Integration Layer                   │
│         (boto3 clients, credential management, retries)      │
└──────────────────────────────────────────────────────────────┘
```

### Component Architecture

The system is organized into distinct modules:

- **CLI Module**: Command-line interface using Click framework
- **Config Module**: Configuration file parsing and validation
- **State Module**: State file management with CDK compatibility
- **Provisioner Module**: Resource-specific provisioners (Lambda, API Gateway, VPC, etc.)
- **Orchestrator Module**: Deployment planning and execution coordination
- **Local Dev Module**: Local development server and AWS proxy
- **Utils Module**: Logging, AWS client management, helpers

## Components and Interfaces

### 1. CLI Module

**Purpose**: Provide user-facing command-line interface

**Key Commands**:
- `deploy`: Deploy infrastructure to AWS
- `destroy`: Remove deployed infrastructure
- `list`: Show deployed resources
- `describe`: Show detailed resource information
- `dev`: Start local development mode
- `init`: Initialize a new project configuration
- `env`: Manage deployment environments

**Interface**:
```python
# CLI entry point
@click.group()
@click.option('--profile', help='AWS profile to use')
@click.option('--region', help='AWS region')
@click.option('--log-level', default='info')
def cli(profile, region, log_level):
    """Strands AWS Deployment System"""
    pass

@cli.command()
@click.option('--env', required=True, help='Environment name')
@click.option('--agent', help='Specific agent to deploy')
@click.option('--parallel/--sequential', default=True)
def deploy(env, agent, parallel):
    """Deploy infrastructure to AWS"""
    pass
```

### 2. Configuration Module

**Purpose**: Parse and validate infrastructure configuration files

**Configuration File Format** (YAML):
```yaml
# strands.yaml
project:
  name: my-strands-project
  region: us-east-1

agents:
  - name: customer-support-agent
    path: ./apps/customer-support
    runtime: python3.11
    memory: 512
    timeout: 30
    environment:
      MODEL: claude-3-sonnet
    
  - name: data-analysis-agent
    path: ./apps/data-analysis
    runtime: python3.11
    memory: 1024
    timeout: 60

shared:
  vpc:
    enabled: true
    cidr: 10.0.0.0/16
  
  api_gateway:
    type: http
    cors: true
  
  monitoring:
    xray: true
    alarms: true

environments:
  dev:
    account: "123456789012"
    region: us-east-1
  
  prod:
    account: "987654321098"
    region: us-east-1
    vpc:
      enabled: true
```

**Interface**:
```python
class Config:
    def __init__(self, config_path: str):
        self.config_path = config_path
        self.data = {}
    
    def load(self) -> dict:
        """Load and validate configuration"""
        pass
    
    def get_agents(self) -> List[AgentConfig]:
        """Get list of agent configurations"""
        pass
    
    def get_environment(self, env_name: str) -> EnvironmentConfig:
        """Get environment-specific configuration"""
        pass
    
    def validate(self) -> List[ValidationError]:
        """Validate configuration against schema"""
        pass
```

### 3. State Module

**Purpose**: Manage deployment state with CDK compatibility

**State File Format** (JSON):
```json
{
  "version": "1.0",
  "environment": "dev",
  "region": "us-east-1",
  "account": "123456789012",
  "timestamp": "2025-11-19T10:30:00Z",
  "stacks": {
    "shared-infrastructure": {
      "resources": {
        "SharedExecutionRole": {
          "type": "AWS::IAM::Role",
          "physicalId": "arn:aws:iam::123456789012:role/strands-shared-execution",
          "properties": {
            "RoleName": "strands-shared-execution",
            "AssumeRolePolicyDocument": "..."
          },
          "dependencies": []
        },
        "VPC": {
          "type": "AWS::EC2::VPC",
          "physicalId": "vpc-abc123",
          "properties": {
            "CidrBlock": "10.0.0.0/16"
          },
          "dependencies": []
        }
      }
    },
    "customer-support-agent": {
      "resources": {
        "LambdaFunction": {
          "type": "AWS::Lambda::Function",
          "physicalId": "arn:aws:lambda:us-east-1:123456789012:function:customer-support-agent",
          "properties": {
            "FunctionName": "customer-support-agent",
            "Runtime": "python3.11",
            "Role": "arn:aws:iam::123456789012:role/strands-shared-execution"
          },
          "dependencies": ["SharedExecutionRole"]
        }
      }
    }
  }
}
```

**Interface**:
```python
class StateManager:
    def __init__(self, state_path: str):
        self.state_path = state_path
        self.state = {}
    
    def load(self) -> State:
        """Load state from file"""
        pass
    
    def save(self, state: State):
        """Save state to file"""
        pass
    
    def get_resource(self, resource_id: str) -> Resource:
        """Get resource from state"""
        pass
    
    def add_resource(self, stack_name: str, resource: Resource):
        """Add resource to state"""
        pass
    
    def remove_resource(self, resource_id: str):
        """Remove resource from state"""
        pass
    
    def get_dependencies(self, resource_id: str) -> List[str]:
        """Get resource dependencies"""
        pass
```

### 4. Provisioner Module

**Purpose**: Implement resource-specific provisioning logic

**Base Provisioner Interface**:
```python
class BaseProvisioner(ABC):
    def __init__(self, boto_session: boto3.Session):
        self.session = boto_session
    
    @abstractmethod
    def plan(self, desired: Resource, current: Optional[Resource]) -> ProvisionPlan:
        """Determine what changes are needed"""
        pass
    
    @abstractmethod
    def provision(self, plan: ProvisionPlan) -> Resource:
        """Execute provisioning plan"""
        pass
    
    @abstractmethod
    def destroy(self, resource: Resource):
        """Destroy resource"""
        pass
    
    def get_current_state(self, resource_id: str) -> Optional[Resource]:
        """Fetch current resource state from AWS"""
        pass
```

**Specific Provisioners**:
- `IAMRoleProvisioner`: Manages IAM roles with least-privilege policies
- `LambdaProvisioner`: Deploys Lambda functions with code packaging
- `APIGatewayProvisioner`: Configures API Gateway with routes
- `VPCProvisioner`: Creates VPC with subnets, NAT gateways, VPC endpoints
- `SecurityGroupProvisioner`: Manages security groups with optimization
- `CloudWatchProvisioner`: Sets up alarms and log groups

### 5. Orchestrator Module

**Purpose**: Coordinate deployment execution with dependency resolution and parallelization

**Interface**:
```python
class DeploymentOrchestrator:
    def __init__(self, config: Config, state_manager: StateManager):
        self.config = config
        self.state_manager = state_manager
        self.provisioners = {}
    
    def plan_deployment(self, agent_filter: Optional[str] = None) -> DeploymentPlan:
        """Create deployment plan with dependency graph"""
        pass
    
    def execute_deployment(self, plan: DeploymentPlan, parallel: bool = True) -> DeploymentResult:
        """Execute deployment plan"""
        pass
    
    def plan_destruction(self) -> DestructionPlan:
        """Create destruction plan with reverse dependency order"""
        pass
    
    def execute_destruction(self, plan: DestructionPlan) -> DestructionResult:
        """Execute destruction plan"""
        pass
```

**Deployment Algorithm**:
1. Load configuration and current state
2. Build dependency graph of all resources
3. Detect changes (new, modified, deleted resources)
4. Topologically sort resources by dependencies
5. Group independent resources for parallel execution
6. Execute provisioning in waves (each wave contains independent resources)
7. Update state after each successful provisioning
8. Rollback on failure (optional)

### 6. Local Development Module

**Purpose**: Enable local agent execution with AWS resource connectivity

**Architecture**:
```
┌──────────────────┐         ┌──────────────────┐
│  Local Agent     │         │   AWS Resources  │
│  Process         │         │   (DynamoDB,     │
│  (Python)        │◄────────┤    S3, etc.)     │
└──────────────────┘         └──────────────────┘
         │
         │ HTTP/WebSocket
         │
┌────────▼──────────┐
│  Dev Server       │
│  (Hot Reload,     │
│   Request Proxy)  │
└───────────────────┘
```

**Interface**:
```python
class LocalDevServer:
    def __init__(self, config: Config, state_manager: StateManager):
        self.config = config
        self.state = state_manager.load()
        self.agent_processes = {}
    
    def start(self, agent_name: str):
        """Start local development server for agent"""
        pass
    
    def reload_agent(self, agent_name: str):
        """Hot reload agent code"""
        pass
    
    def proxy_request(self, request: Request) -> Response:
        """Proxy HTTP request to local agent"""
        pass
    
    def inject_aws_config(self, agent_name: str) -> dict:
        """Inject AWS resource configuration into agent environment"""
        pass
```

**Features**:
- File watcher for automatic code reloading
- Environment variable injection with AWS resource ARNs/endpoints
- Request/response logging
- Error display with stack traces
- AWS credential forwarding to local process

### 7. Resource Optimization Module

**Purpose**: Implement resource sharing and cost optimization

**Shared Resource Strategy**:

1. **Shared IAM Execution Role**:
   - Single role for all Lambda functions in an application
   - Dynamically build policy with permissions for all agents
   - Reduces IAM role limits and simplifies management

2. **Security Group Consolidation**:
   - Group resources by security requirements
   - Create shared security groups for common patterns
   - Use security group references for inter-resource communication

3. **VPC Endpoint Sharing**:
   - Single set of VPC endpoints for all agents
   - Reduces costs and simplifies networking

**Interface**:
```python
class ResourceOptimizer:
    def optimize_iam_roles(self, agents: List[AgentConfig]) -> IAMRole:
        """Create shared execution role for all agents"""
        pass
    
    def optimize_security_groups(self, resources: List[Resource]) -> List[SecurityGroup]:
        """Consolidate security groups"""
        pass
    
    def detect_duplicates(self, state: State) -> List[DuplicateResource]:
        """Detect duplicate resources that can be consolidated"""
        pass

### 8. Tagging and Cost Management

**Purpose**: Implement comprehensive tagging strategy for cost allocation, resource management, and compliance

**Tagging Strategy**:

All resources are automatically tagged with:
- `strands:project`: Project name from configuration
- `strands:environment`: Environment name (dev, staging, prod)
- `strands:agent`: Agent name (for agent-specific resources)
- `strands:managed-by`: "strands-deployment-system"
- `strands:version`: Deployment system version
- `strands:deployed-at`: ISO 8601 timestamp
- `strands:deployed-by`: IAM user/role that performed deployment

**Custom Tags**:
```yaml
# strands.yaml
project:
  name: my-project
  tags:
    team: platform
    cost-center: engineering
    compliance: hipaa
    owner: [email]

agents:
  - name: customer-support
    tags:
      service: customer-support
      tier: production
```

**Tag Inheritance**:
- Project-level tags apply to all resources
- Agent-level tags apply to agent-specific resources
- Resource-level tags override inherited tags

**Cost Allocation Tags**:
```python
class TagManager:
    def __init__(self, config: Config):
        self.config = config
    
    def generate_tags(self, resource: Resource, context: DeploymentContext) -> Dict[str, str]:
        """Generate complete tag set for resource"""
        tags = {
            'strands:project': context.project_name,
            'strands:environment': context.environment,
            'strands:managed-by': 'strands-deployment-system',
            'strands:version': VERSION,
            'strands:deployed-at': datetime.utcnow().isoformat(),
            'strands:deployed-by': context.iam_identity
        }
        
        # Add agent tag if applicable
        if resource.agent_name:
            tags['strands:agent'] = resource.agent_name
        
        # Add custom tags
        tags.update(self.config.project.tags)
        if resource.agent_name:
            agent_config = self.config.get_agent(resource.agent_name)
            tags.update(agent_config.tags)
        
        # Add resource-specific tags
        tags.update(resource.tags)
        
        return tags
    
    def apply_tags(self, resource_arn: str, tags: Dict[str, str]):
        """Apply tags to AWS resource"""
        pass
    
    def get_cost_allocation_tags(self) -> List[str]:
        """Get list of tags to activate for cost allocation"""
        return [
            'strands:project',
            'strands:environment',
            'strands:agent',
            'team',
            'cost-center'
        ]
```

**Cost Tracking Features**:
- Automatic activation of cost allocation tags in AWS
- CLI command to view costs by tag
- Cost reports grouped by project, environment, agent
- Budget alerts based on tags

**CLI Commands**:
```bash
# View costs by environment
$ strands costs --by environment

# View costs by agent
$ strands costs --by agent

# View costs for specific project
$ strands costs --project my-project --period last-month

# Set budget alert
$ strands budget set --environment prod --limit 1000 --alert-threshold 80
```

### 9. IPAM (IP Address Management) Support

**Purpose**: Integrate with AWS VPC IPAM for centralized IP address management

**IPAM Integration**:

```yaml
# strands.yaml
shared:
  vpc:
    enabled: true
    ipam:
      enabled: true
      pool_id: ipam-pool-0abc123def456789  # Optional: use specific IPAM pool
      netmask_length: 24  # Request /24 CIDR from IPAM
    # OR specify CIDR manually (without IPAM)
    cidr: 10.0.0.0/16
```

**IPAM Features**:

1. **Automatic CIDR Allocation**:
   - Request CIDR block from IPAM pool
   - Automatic allocation based on netmask length
   - Prevents IP address conflicts across environments

2. **Multi-Region Support**:
   - Allocate non-overlapping CIDRs for each region
   - Support for VPC peering and Transit Gateway

3. **IPAM Pool Hierarchy**:
   - Support for organizational IPAM pool structure
   - Respect pool allocation rules and constraints

4. **CIDR Tracking**:
   - Track allocated CIDRs in state file
   - Release CIDRs back to IPAM on VPC destruction
   - Prevent CIDR leaks

**Implementation**:

```python
class IPAMManager:
    def __init__(self, boto_session: boto3.Session):
        self.ec2_client = boto_session.client('ec2')
    
    def allocate_cidr(self, pool_id: str, netmask_length: int, description: str) -> str:
        """Allocate CIDR from IPAM pool"""
        response = self.ec2_client.allocate_ipam_pool_cidr(
            IpamPoolId=pool_id,
            NetmaskLength=netmask_length,
            Description=description
        )
        return response['IpamPoolAllocation']['Cidr']
    
    def release_cidr(self, pool_id: str, cidr: str):
        """Release CIDR back to IPAM pool"""
        self.ec2_client.release_ipam_pool_allocation(
            IpamPoolId=pool_id,
            Cidr=cidr
        )
    
    def get_available_cidrs(self, pool_id: str) -> List[str]:
        """Get available CIDRs from IPAM pool"""
        pass
    
    def validate_cidr_allocation(self, pool_id: str, cidr: str) -> bool:
        """Validate CIDR is allocated from pool"""
        pass
```

**VPC Provisioner with IPAM**:

```python
class VPCProvisioner(BaseProvisioner):
    def __init__(self, boto_session: boto3.Session, ipam_manager: IPAMManager):
        super().__init__(boto_session)
        self.ipam_manager = ipam_manager
    
    def provision(self, plan: ProvisionPlan) -> Resource:
        vpc_config = plan.resource.properties
        
        # Allocate CIDR from IPAM if enabled
        if vpc_config.get('ipam', {}).get('enabled'):
            pool_id = vpc_config['ipam']['pool_id']
            netmask_length = vpc_config['ipam']['netmask_length']
            
            cidr = self.ipam_manager.allocate_cidr(
                pool_id=pool_id,
                netmask_length=netmask_length,
                description=f"VPC for {plan.resource.id}"
            )
            
            vpc_config['cidr_block'] = cidr
        
        # Create VPC with allocated or specified CIDR
        vpc = self.ec2_client.create_vpc(
            CidrBlock=vpc_config['cidr_block'],
            TagSpecifications=[...]
        )
        
        return Resource(
            id=plan.resource.id,
            type='AWS::EC2::VPC',
            physical_id=vpc['Vpc']['VpcId'],
            properties={
                'cidr_block': vpc_config['cidr_block'],
                'ipam_pool_id': vpc_config.get('ipam', {}).get('pool_id')
            }
        )
    
    def destroy(self, resource: Resource):
        # Delete VPC
        self.ec2_client.delete_vpc(VpcId=resource.physical_id)
        
        # Release CIDR back to IPAM if applicable
        if resource.properties.get('ipam_pool_id'):
            self.ipam_manager.release_cidr(
                pool_id=resource.properties['ipam_pool_id'],
                cidr=resource.properties['cidr_block']
            )
```

**IPAM Benefits**:
- Centralized IP address management across AWS organization
- Automatic CIDR allocation prevents conflicts
- Compliance with organizational IP addressing policies
- Simplified multi-region and multi-account deployments
- Automatic CIDR cleanup on resource destruction

## Data Models

### Core Models

```python
@dataclass
class Resource:
    id: str
    type: str
    physical_id: Optional[str]
    properties: dict
    dependencies: List[str]
    tags: dict

@dataclass
class AgentConfig:
    name: str
    path: str
    runtime: str
    memory: int
    timeout: int
    environment: dict
    handler: str = "main.handler"

@dataclass
class EnvironmentConfig:
    name: str
    account: str
    region: str
    overrides: dict

@dataclass
class DeploymentPlan:
    waves: List[List[Resource]]  # Each wave contains independent resources
    changes: Dict[str, ChangeType]  # CREATE, UPDATE, DELETE
    estimated_duration: int

@dataclass
class State:
    version: str
    environment: str
    region: str
    account: str
    timestamp: datetime
    stacks: Dict[str, Stack]

@dataclass
class Stack:
    name: str
    resources: Dict[str, Resource]
```

## Error Handling and Recovery

### Error Categories

1. **Configuration Errors**: Invalid YAML, missing required fields
2. **AWS Errors**: API throttling, permission denied, resource limits
3. **Network Errors**: Connection timeouts, DNS failures, transient network issues
4. **State Errors**: Corrupted state file, state drift
5. **Dependency Errors**: Circular dependencies, missing dependencies
6. **Provisioning Errors**: Resource creation failures
7. **Partial Failure**: Some resources succeed, others fail

### Error Handling Strategy

```python
class DeploymentError(Exception):
    def __init__(self, message: str, resource_id: str, cause: Exception):
        self.message = message
        self.resource_id = resource_id
        self.cause = cause
    
    def to_user_message(self) -> str:
        """Convert to user-friendly error message"""
        pass

class ErrorHandler:
    def handle_aws_error(self, error: ClientError, resource: Resource) -> ErrorAction:
        """Determine action for AWS errors (retry, skip, fail)"""
        pass
    
    def handle_network_error(self, error: Exception, resource: Resource) -> ErrorAction:
        """Handle network failures with smart retry"""
        pass
    
    def handle_provisioning_error(self, error: Exception, resource: Resource) -> ErrorAction:
        """Handle provisioning failures"""
        pass
```

### Network Failure Recovery

**Smart Retry Strategy**:
```python
class RetryStrategy:
    def __init__(self):
        self.max_retries = 5
        self.base_delay = 1  # seconds
        self.max_delay = 60  # seconds
    
    def should_retry(self, error: Exception, attempt: int) -> bool:
        """Determine if error is retryable"""
        retryable_errors = [
            'RequestTimeout',
            'ServiceUnavailable', 
            'ThrottlingException',
            'TooManyRequestsException',
            'ConnectionError',
            'ReadTimeout'
        ]
        return any(e in str(error) for e in retryable_errors) and attempt < self.max_retries
    
    def get_delay(self, attempt: int) -> float:
        """Calculate exponential backoff with jitter"""
        delay = min(self.base_delay * (2 ** attempt), self.max_delay)
        jitter = random.uniform(0, delay * 0.1)
        return delay + jitter
```

**Connection Pooling**:
- Reuse boto3 sessions and clients across operations
- Configure connection pool size based on parallelism
- Implement connection health checks

**Checkpoint System**:
```python
class DeploymentCheckpoint:
    def __init__(self, checkpoint_path: str):
        self.checkpoint_path = checkpoint_path
    
    def save_progress(self, completed_resources: List[str], pending_resources: List[str]):
        """Save deployment progress for recovery"""
        pass
    
    def load_progress(self) -> Tuple[List[str], List[str]]:
        """Load checkpoint to resume deployment"""
        pass
    
    def clear(self):
        """Clear checkpoint after successful deployment"""
        pass
```

**Resume Capability**:
- Automatically detect interrupted deployments
- Offer to resume from last checkpoint
- Skip already-provisioned resources
- Re-validate existing resources before continuing

### Rollback Strategy

**Automatic Rollback**:
- Optional flag `--auto-rollback` for automatic rollback on failure
- Rollback only newly created resources (don't touch pre-existing)
- Preserve failed state for debugging

**Manual Rollback**:
- `rollback` command to revert to previous state
- Show diff of what will be rolled back
- Require confirmation before executing

**Partial Rollback**:
- Rollback specific resources or stacks
- Useful for multi-agent deployments where one agent fails

## Testing Strategy

### Unit Tests

- Test each provisioner independently with mocked boto3 clients
- Test configuration parsing and validation
- Test state management operations
- Test dependency resolution algorithm
- Test resource optimization logic

**Tools**: pytest, moto (AWS mocking)

### Integration Tests

- Test full deployment flow with LocalStack
- Test local development server with sample agent
- Test multi-agent deployment from monorepo
- Test environment switching
- Test destruction and cleanup

**Tools**: pytest, LocalStack, Docker

### End-to-End Tests

- Deploy real Strands agent to AWS test account
- Verify agent functionality
- Test local development mode with deployed resources
- Verify resource optimization (shared roles, security groups)
- Test destruction and verify cleanup

**Environment**: Dedicated AWS test account

### Performance Tests

- Measure deployment time for various agent counts
- Verify parallel deployment performance
- Test incremental deployment speed
- Measure state file load/save performance

**Targets**:
- Initial deployment: < 2 minutes for single agent
- Incremental deployment: < 30 seconds
- State operations: < 1 second

## Security Considerations

### Credential Management

- Use AWS credential chain (environment, profile, IAM role)
- Never store credentials in state files or logs
- Support MFA and assume role for production deployments
- Validate credentials before deployment

### IAM Policies

- Generate least-privilege policies based on agent requirements
- Separate policies for deployment (admin) vs runtime (agent execution)
- Use resource-level permissions where possible
- Regular policy auditing recommendations

### Network Security

- Private subnets for agent execution by default
- VPC endpoints for AWS service access (no internet)
- Security groups with minimal ingress rules
- Network ACLs for additional defense layer

### Secrets Management

- Integration with AWS Secrets Manager for agent secrets
- Automatic secret rotation support
- Encrypted environment variables for Lambda

## Performance Optimizations

### Deployment Speed

1. **Parallel Provisioning**: Deploy independent resources simultaneously
2. **Change Detection**: Skip unchanged resources
3. **Caching**: Cache resource configurations and AWS API responses
4. **Batch Operations**: Use batch APIs where available (e.g., tagging)

### Resource Efficiency

1. **Shared Resources**: Single IAM role, consolidated security groups
2. **VPC Endpoints**: Reduce NAT gateway costs
3. **Lambda Optimization**: Right-size memory and timeout
4. **API Gateway Caching**: Enable caching for frequently accessed endpoints

### State Management

1. **Incremental Updates**: Update only changed portions of state
2. **Compression**: Compress large state files
3. **Lazy Loading**: Load state sections on demand

## Deployment History and Audit Trail

### S3-Based History Storage

**Purpose**: Maintain complete audit trail of all deployments with configurations and logs stored in S3

**S3 Bucket Structure**:
```
s3://strands-deployments-{account-id}-{region}/
├── {project-name}/
│   ├── {environment}/
│   │   ├── deployments/
│   │   │   ├── 2025-11-19T10-30-00Z-abc123/
│   │   │   │   ├── config.yaml           # Configuration used
│   │   │   │   ├── state-before.json     # State before deployment
│   │   │   │   ├── state-after.json      # State after deployment
│   │   │   │   ├── deployment-plan.json  # Planned changes
│   │   │   │   ├── execution-log.jsonl   # Structured execution logs
│   │   │   │   ├── logs/
│   │   │   │   │   ├── vpc.log
│   │   │   │   │   ├── iam-role.log
│   │   │   │   │   ├── lambda-agent-1.log
│   │   │   │   │   └── api-gateway.log
│   │   │   │   └── metadata.json         # Deployment metadata
│   │   │   ├── 2025-11-19T11-15-00Z-def456/
│   │   │   └── ...
│   │   └── current/
│   │       ├── config.yaml               # Current active config
│   │       └── state.json                # Current state
│   └── {another-environment}/
└── {another-project}/
```

**Deployment Metadata**:
```json
{
  "deploymentId": "2025-11-19T10-30-00Z-abc123",
  "projectName": "my-strands-project",
  "environment": "prod",
  "startTime": "2025-11-19T10:30:00Z",
  "endTime": "2025-11-19T10:31:52Z",
  "duration": 112,
  "status": "success",
  "deployedBy": "arn:aws:iam::123456789012:user/john",
  "deploymentMethod": "cli",
  "version": "1.0.0",
  "changes": {
    "created": ["lambda-agent-1", "api-gateway-route"],
    "updated": ["iam-role-shared"],
    "deleted": []
  },
  "resourceCount": 15,
  "estimatedCost": 45.50,
  "tags": {
    "team": "platform",
    "cost-center": "engineering"
  }
}
```

**History Manager**:

```python
class DeploymentHistoryManager:
    def __init__(self, s3_client, bucket_name: str, project_name: str, environment: str):
        self.s3 = s3_client
        self.bucket_name = bucket_name
        self.project_name = project_name
        self.environment = environment
    
    def create_deployment_record(self, config: Config, state_before: State) -> str:
        """Create new deployment record and return deployment ID"""
        deployment_id = f"{datetime.utcnow().isoformat()}Z-{uuid.uuid4().hex[:6]}"
        prefix = self._get_deployment_prefix(deployment_id)
        
        # Upload configuration
        self.s3.put_object(
            Bucket=self.bucket_name,
            Key=f"{prefix}/config.yaml",
            Body=yaml.dump(config.to_dict())
        )
        
        # Upload state before deployment
        self.s3.put_object(
            Bucket=self.bucket_name,
            Key=f"{prefix}/state-before.json",
            Body=json.dumps(state_before.to_dict(), indent=2)
        )
        
        return deployment_id
    
    def finalize_deployment_record(self, deployment_id: str, result: DeploymentResult):
        """Finalize deployment record with results and logs"""
        prefix = self._get_deployment_prefix(deployment_id)
        
        # Upload state after deployment
        self.s3.put_object(
            Bucket=self.bucket_name,
            Key=f"{prefix}/state-after.json",
            Body=json.dumps(result.state.to_dict(), indent=2)
        )
        
        # Upload execution logs (structured JSONL)
        execution_log = "\n".join(
            json.dumps(log_entry) for log_entry in result.logs
        )
        self.s3.put_object(
            Bucket=self.bucket_name,
            Key=f"{prefix}/execution-log.jsonl",
            Body=execution_log
        )
        
        # Upload per-resource logs
        for resource_id, logs in result.resource_logs.items():
            self.s3.put_object(
                Bucket=self.bucket_name,
                Key=f"{prefix}/logs/{resource_id}.log",
                Body=logs
            )
        
        # Upload metadata
        metadata = {
            "deploymentId": deployment_id,
            "projectName": self.project_name,
            "environment": self.environment,
            "startTime": result.start_time.isoformat(),
            "endTime": result.end_time.isoformat(),
            "duration": result.duration,
            "status": result.status,
            "deployedBy": result.deployed_by,
            "deploymentMethod": result.method,
            "version": VERSION,
            "changes": result.changes,
            "resourceCount": len(result.state.all_resources()),
            "estimatedCost": result.estimated_cost,
            "tags": result.tags
        }
        self.s3.put_object(
            Bucket=self.bucket_name,
            Key=f"{prefix}/metadata.json",
            Body=json.dumps(metadata, indent=2)
        )
        
        # Update current config and state
        self._update_current(result.config, result.state)
    
    def list_deployments(self, limit: int = 50) -> List[DeploymentMetadata]:
        """List recent deployments"""
        prefix = f"{self.project_name}/{self.environment}/deployments/"
        response = self.s3.list_objects_v2(
            Bucket=self.bucket_name,
            Prefix=prefix,
            Delimiter='/'
        )
        
        deployments = []
        for common_prefix in response.get('CommonPrefixes', []):
            deployment_prefix = common_prefix['Prefix']
            metadata = self._load_metadata(deployment_prefix)
            deployments.append(metadata)
        
        return sorted(deployments, key=lambda d: d.start_time, reverse=True)[:limit]
    
    def get_deployment(self, deployment_id: str) -> DeploymentRecord:
        """Get complete deployment record"""
        prefix = self._get_deployment_prefix(deployment_id)
        
        return DeploymentRecord(
            metadata=self._load_metadata(prefix),
            config=self._load_config(prefix),
            state_before=self._load_state(f"{prefix}/state-before.json"),
            state_after=self._load_state(f"{prefix}/state-after.json"),
            execution_log=self._load_execution_log(prefix),
            resource_logs=self._load_resource_logs(prefix)
        )
    
    def compare_deployments(self, deployment_id_1: str, deployment_id_2: str) -> DeploymentDiff:
        """Compare two deployments"""
        d1 = self.get_deployment(deployment_id_1)
        d2 = self.get_deployment(deployment_id_2)
        
        return DeploymentDiff(
            config_diff=self._diff_configs(d1.config, d2.config),
            state_diff=self._diff_states(d1.state_after, d2.state_after),
            duration_diff=d2.metadata.duration - d1.metadata.duration,
            cost_diff=d2.metadata.estimated_cost - d1.metadata.estimated_cost
        )
    
    def rollback_to_deployment(self, deployment_id: str) -> Config:
        """Get configuration from previous deployment for rollback"""
        deployment = self.get_deployment(deployment_id)
        return deployment.config
    
    def _get_deployment_prefix(self, deployment_id: str) -> str:
        return f"{self.project_name}/{self.environment}/deployments/{deployment_id}"
    
    def _update_current(self, config: Config, state: State):
        """Update current config and state"""
        current_prefix = f"{self.project_name}/{self.environment}/current"
        
        self.s3.put_object(
            Bucket=self.bucket_name,
            Key=f"{current_prefix}/config.yaml",
            Body=yaml.dump(config.to_dict())
        )
        
        self.s3.put_object(
            Bucket=self.bucket_name,
            Key=f"{current_prefix}/state.json",
            Body=json.dumps(state.to_dict(), indent=2)
        )
```

**CLI Commands for History**:

```bash
# List recent deployments
$ strands history list --environment prod --limit 20

# Show deployment details
$ strands history show --deployment-id 2025-11-19T10-30-00Z-abc123

# Compare two deployments
$ strands history diff \
  --from 2025-11-19T10-30-00Z-abc123 \
  --to 2025-11-19T11-15-00Z-def456

# View deployment logs
$ strands history logs --deployment-id 2025-11-19T10-30-00Z-abc123

# View logs for specific resource
$ strands history logs \
  --deployment-id 2025-11-19T10-30-00Z-abc123 \
  --resource lambda-agent-1

# Rollback to previous deployment
$ strands rollback --to-deployment 2025-11-19T10-30-00Z-abc123

# Export deployment report
$ strands history export \
  --deployment-id 2025-11-19T10-30-00Z-abc123 \
  --format pdf \
  --output deployment-report.pdf
```

**Visual Builder Integration**:

In the Visual Builder, add a "History" panel:

```
┌─────────────────────────────────────────────────────────┐
│  Deployment History                                      │
├─────────────────────────────────────────────────────────┤
│  📅 Nov 19, 2025 11:15 AM  ✓ Success      1m 52s       │
│     • Updated IAM role                                   │
│     • Created Lambda function                            │
│     [View Details] [Rollback]                           │
│                                                          │
│  📅 Nov 19, 2025 10:30 AM  ✓ Success      1m 45s       │
│     • Created VPC                                        │
│     • Created 3 agents                                   │
│     [View Details] [Rollback]                           │
│                                                          │
│  📅 Nov 18, 2025 4:20 PM   ✗ Failed       0m 23s       │
│     • Failed to create Lambda                            │
│     [View Details] [Retry]                              │
│                                                          │
│  [Load More...]                                         │
└─────────────────────────────────────────────────────────┘
```

**Deployment Comparison View**:

```
┌─────────────────────────────────────────────────────────┐
│  Comparing Deployments                                   │
│  From: Nov 19, 10:30 AM → To: Nov 19, 11:15 AM         │
├─────────────────────────────────────────────────────────┤
│  Configuration Changes:                                  │
│  + agents[0].memory: 512 → 1024                         │
│  + agents[1].timeout: 30 → 60                           │
│                                                          │
│  Resource Changes:                                       │
│  ~ lambda-agent-1 (updated)                             │
│  + lambda-agent-2 (created)                             │
│                                                          │
│  Performance:                                            │
│  Duration: 1m 45s → 1m 52s (+7s)                        │
│  Cost: $42.30 → $45.50 (+$3.20/month)                   │
└─────────────────────────────────────────────────────────┘
```

**Automatic Cleanup**:

```python
class HistoryCleanupPolicy:
    def __init__(self, history_manager: DeploymentHistoryManager):
        self.history = history_manager
    
    def apply_retention_policy(self, policy: RetentionPolicy):
        """Apply retention policy to deployment history"""
        # Keep last N successful deployments
        # Keep all failed deployments for X days
        # Keep deployments with specific tags indefinitely
        pass
    
    def cleanup_old_deployments(self, days: int):
        """Delete deployments older than specified days"""
        pass
```

**S3 Lifecycle Policy**:
```yaml
# Automatically transition old deployment logs to cheaper storage
lifecycle_rules:
  - id: archive-old-deployments
    prefix: deployments/
    transitions:
      - days: 30
        storage_class: STANDARD_IA
      - days: 90
        storage_class: GLACIER
    expiration:
      days: 365  # Delete after 1 year
```

## Monitoring and Observability

### Deployment Metrics

- Track deployment duration per resource type
- Monitor failure rates and error types
- Track resource count and cost estimates
- Store metrics in CloudWatch for dashboards

### Runtime Metrics

- CloudWatch metrics for Lambda invocations
- X-Ray tracing for agent execution
- Custom metrics for agent-specific KPIs

### Logging

- Structured logging (JSON format)
- Log levels: DEBUG, INFO, WARNING, ERROR
- Separate log files for each deployment
- CloudWatch Logs integration for deployed agents
- S3 storage for long-term log retention

### Audit Trail

- Complete audit trail of all deployments in S3
- Track who deployed what, when, and why
- Configuration versioning
- State snapshots before/after each deployment
- Compliance reporting capabilities

## Migration and Compatibility

### CDK Migration Path

The state file format is designed for CDK compatibility:

1. Export state to CDK CloudFormation template
2. Import existing resources into CDK stack
3. Gradually migrate to CDK constructs
4. Remove Strands deployment system when ready

### Backward Compatibility

- Semantic versioning for state file format
- State migration scripts for version upgrades
- Deprecation warnings for breaking changes

## Infrastructure Reconciliation

### Agentic Reconciliation System

While the core deployment process is deterministic, an optional agentic system can help with infrastructure drift detection and reconciliation.

**Architecture**:
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

**Use Cases for Agentic System**:

1. **Drift Detection and Analysis**:
   - Scan AWS account for resources matching project tags
   - Compare actual state vs desired state
   - Identify manual changes, deleted resources, or orphaned resources
   - Generate natural language explanation of drift
   - Suggest reconciliation actions

2. **Failure Analysis and Recovery**:
   - Analyze deployment failures with context
   - Suggest potential fixes (e.g., "IAM role missing permission X")
   - Learn from past failures to prevent recurrence
   - Generate recovery plans for complex failure scenarios

3. **Missing Infrastructure Detection**:
   - Scan state file and AWS account
   - Identify resources that should exist but don't
   - Detect dependency gaps (e.g., Lambda exists but IAM role missing)
   - Prioritize missing resources by criticality

4. **Optimization Recommendations**:
   - Analyze resource usage patterns
   - Suggest cost optimizations
   - Identify security improvements
   - Recommend consolidation opportunities

**Implementation Approach**:

```python
class AgenticReconciler:
    def __init__(self, llm_client, state_manager: StateManager, aws_scanner: AWSScanner):
        self.llm = llm_client
        self.state_manager = state_manager
        self.aws_scanner = aws_scanner
    
    def detect_drift(self) -> DriftReport:
        """Detect infrastructure drift using AWS scanning"""
        desired_state = self.state_manager.load()
        actual_state = self.aws_scanner.scan_resources()
        
        drift = self._compare_states(desired_state, actual_state)
        
        # Use LLM to analyze and explain drift
        analysis = self.llm.analyze_drift(drift)
        
        return DriftReport(drift=drift, analysis=analysis, suggestions=analysis.suggestions)
    
    def analyze_failure(self, error: DeploymentError, context: DeploymentContext) -> FailureAnalysis:
        """Analyze deployment failure and suggest fixes"""
        # Gather context: error message, resource config, AWS state, logs
        full_context = self._gather_failure_context(error, context)
        
        # Use LLM to analyze failure
        analysis = self.llm.analyze_failure(full_context)
        
        return FailureAnalysis(
            root_cause=analysis.root_cause,
            suggested_fixes=analysis.fixes,
            confidence=analysis.confidence
        )
    
    def find_missing_resources(self) -> List[MissingResource]:
        """Identify resources that should exist but don't"""
        desired_state = self.state_manager.load()
        actual_state = self.aws_scanner.scan_resources()
        
        missing = []
        for resource_id, resource in desired_state.all_resources():
            if not actual_state.has_resource(resource.physical_id):
                missing.append(MissingResource(
                    resource_id=resource_id,
                    resource_type=resource.type,
                    expected_config=resource.properties
                ))
        
        # Use LLM to prioritize and explain impact
        prioritized = self.llm.prioritize_missing_resources(missing)
        
        return prioritized
    
    def generate_recovery_plan(self, drift: DriftReport) -> RecoveryPlan:
        """Generate deterministic recovery plan from drift analysis"""
        # LLM suggests recovery actions
        suggestions = self.llm.suggest_recovery(drift)
        
        # Convert suggestions to deterministic deployment plan
        plan = self._convert_to_deployment_plan(suggestions)
        
        return RecoveryPlan(plan=plan, explanation=suggestions.explanation)
```

**Key Principles**:

1. **Deterministic Execution**: The agentic system only analyzes and suggests; the deployment engine executes deterministically
2. **Human in the Loop**: Agentic suggestions require user approval before execution
3. **Explainability**: All agentic decisions include natural language explanations
4. **Fallback**: System works without agentic features; they're purely additive
5. **Learning**: Store failure patterns and resolutions to improve future suggestions

**CLI Integration**:
```bash
# Detect drift with agentic analysis
$ strands drift --analyze

# Analyze a deployment failure
$ strands analyze-failure --deployment-id abc123

# Find missing infrastructure
$ strands reconcile --check

# Generate and execute recovery plan
$ strands reconcile --fix
```

**Benefits**:
- Faster troubleshooting with AI-powered failure analysis
- Proactive drift detection and remediation
- Learning system that improves over time
- Natural language explanations for complex infrastructure issues

**Limitations**:
- Requires LLM API access (OpenAI, Anthropic, or local model)
- Adds latency to analysis operations
- Suggestions may not always be correct (requires validation)
- Additional cost for LLM API calls

## Visual Infrastructure Builder

### Overview

A cross-platform desktop application (Electron or Tauri) that provides a visual, node-based interface for designing, deploying, and monitoring Strands infrastructure. Inspired by n8n's workflow builder, this tool allows developers to drag-and-drop resources, connect them visually, and watch deployments execute in real-time.

### Architecture

```
┌─────────────────────────────────────────────────────────┐
│              Visual Builder (Electron/Tauri)             │
│  ┌────────────────────────────────────────────────────┐ │
│  │         Canvas (React Flow / Vue Flow)             │ │
│  │  ┌──────┐      ┌──────┐      ┌──────┐            │ │
│  │  │Agent │─────▶│ IAM  │─────▶│  S3  │            │ │
│  │  └──────┘      └──────┘      └──────┘            │ │
│  └────────────────────────────────────────────────────┘ │
│  ┌────────────────────────────────────────────────────┐ │
│  │    Property Panel (Edit node/edge properties)      │ │
│  └────────────────────────────────────────────────────┘ │
└────────────────┬────────────────────────────────────────┘
                 │
                 │ Reads/Writes
                 │
┌────────────────▼────────────────────────────────────────┐
│              strands.yaml Configuration                  │
└────────────────┬────────────────────────────────────────┘
                 │
                 │ Used by
                 │
┌────────────────▼────────────────────────────────────────┐
│              CLI Deployment Engine                       │
└──────────────────────────────────────────────────────────┘
```

### Core Features

#### 1. Visual Canvas

**Node Types**:
- **Agent Nodes**: Represent Strands agents with configurable runtime, memory, timeout
- **Resource Nodes**: AWS resources (S3, DynamoDB, SQS, SNS, EventBridge, etc.)
- **IAM Nodes**: Roles, policies, permissions (auto-generated or custom)
- **Network Nodes**: VPC, subnets, security groups
- **API Nodes**: API Gateway endpoints, routes

**Node Properties**:
```typescript
interface AgentNode {
  id: string;
  type: 'agent';
  data: {
    name: string;
    path: string;
    runtime: string;
    memory: number;
    timeout: number;
    environment: Record<string, string>;
  };
  position: { x: number; y: number };
}

interface ResourceNode {
  id: string;
  type: 's3' | 'dynamodb' | 'sqs' | 'sns';
  data: {
    name: string;
    configuration: Record<string, any>;
  };
  position: { x: number; y: number };
}
```

#### 2. Connection System

**Edge Types**:
- **Permission Edge**: Defines IAM permissions between agent and resource
- **Trigger Edge**: Defines event triggers (S3 → Lambda, SQS → Lambda)
- **Data Flow Edge**: Shows data flow between resources

**Edge Configuration**:
```typescript
interface PermissionEdge {
  id: string;
  source: string;  // Agent node ID
  target: string;  // Resource node ID
  type: 'permission';
  data: {
    permissions: string[];  // ['s3:GetObject', 's3:PutObject']
    conditions?: Record<string, any>;  // IAM policy conditions
    resourcePath?: string;  // Specific resource path (e.g., 'bucket-name/*')
  };
}
```

**Visual Permission Editor**:
- Drag from agent to resource to create connection
- Click edge to open permission editor
- Select from common permission templates (Read, Write, Full Access)
- Or define custom IAM actions
- Visual indicator shows permission level (color-coded)

#### 3. Real-Time Deployment Visualization

**Deployment View with Glow Effects**:
```
┌─────────────────────────────────────────────────────────┐
│  Deployment Progress                                     │
│                                                          │
│  ┌──────┐ ✓    ┌──────┐ ⟳    ┌──────┐ ⏸               │
│  │ VPC  │─────▶│ IAM  │─────▶│Agent │                  │
│  └──────┘      └──────┘      └──────┘                  │
│  🟢 Glow       🔵 Pulse      ⚪ Dim                     │
│                                                          │
│  Current: Creating IAM role 'shared-execution'          │
│  Progress: 3/7 resources deployed                       │
│  Time: 45s elapsed                                      │
└─────────────────────────────────────────────────────────┘
```

**Visual Status Indicators**:

1. **Success (Green Glow)**:
   - Solid green border with soft green glow effect
   - Checkmark icon overlay
   - Glow intensity: 8px blur, 0.6 opacity
   - CSS: `box-shadow: 0 0 8px 2px rgba(34, 197, 94, 0.6)`

2. **Deploying (Blue Pulse)**:
   - Animated blue border with pulsing glow
   - Spinner icon overlay
   - Pulse animation: 1.5s ease-in-out infinite
   - CSS: `animation: pulse 1.5s ease-in-out infinite`

3. **Pending (Dim Gray)**:
   - Dashed gray border, no glow
   - Clock icon overlay
   - Reduced opacity: 0.6

4. **Failed (Red Glow)**:
   - Solid red border with intense red glow
   - X icon overlay
   - Glow intensity: 10px blur, 0.8 opacity
   - CSS: `box-shadow: 0 0 10px 3px rgba(239, 68, 68, 0.8)`

5. **Warning (Yellow Glow)**:
   - Solid yellow border with yellow glow
   - Warning triangle icon overlay
   - Glow intensity: 8px blur, 0.6 opacity
   - CSS: `box-shadow: 0 0 8px 2px rgba(234, 179, 8, 0.6)`

**Execution Log View (n8n-style)**:

When clicking on any node during or after deployment:

```
┌─────────────────────────────────────────────────────────┐
│  IAM Role: shared-execution                       [×]    │
├─────────────────────────────────────────────────────────┤
│  Status: ✓ Deployed Successfully                        │
│  Duration: 3.2s                                         │
│  Physical ID: arn:aws:iam::123456789012:role/...       │
├─────────────────────────────────────────────────────────┤
│  📋 Execution Steps                                     │
│                                                          │
│  ✓ 1. Validate IAM role configuration        0.1s      │
│  ✓ 2. Check for existing role                0.3s      │
│  ✓ 3. Create IAM role                         2.1s      │
│  ✓ 4. Attach inline policies                  0.5s      │
│  ✓ 5. Apply tags                              0.2s      │
│                                                          │
├─────────────────────────────────────────────────────────┤
│  📝 Logs                                                │
│  [Filter: All ▼] [Search...]                           │
│                                                          │
│  10:23:45.123 INFO  Starting IAM role provisioning     │
│  10:23:45.234 DEBUG Validating configuration           │
│  10:23:45.345 INFO  Role does not exist, creating...   │
│  10:23:45.456 DEBUG Calling iam:CreateRole             │
│  10:23:47.567 INFO  Role created successfully          │
│  10:23:47.678 DEBUG Attaching policy document          │
│  10:23:48.123 INFO  Applied 3 tags to role             │
│  10:23:48.234 INFO  ✓ Deployment complete              │
│                                                          │
├─────────────────────────────────────────────────────────┤
│  🔧 Configuration                                       │
│  {                                                       │
│    "RoleName": "shared-execution",                      │
│    "AssumeRolePolicyDocument": {...},                   │
│    "Tags": [...]                                        │
│  }                                                       │
│                                                          │
├─────────────────────────────────────────────────────────┤
│  📊 AWS API Calls (5)                                   │
│                                                          │
│  ✓ iam:GetRole                    0.3s   200 OK        │
│  ✓ iam:CreateRole                 2.1s   200 OK        │
│  ✓ iam:PutRolePolicy              0.5s   200 OK        │
│  ✓ iam:TagRole                    0.2s   200 OK        │
│                                                          │
└─────────────────────────────────────────────────────────┘
```

**Execution Log Features**:

1. **Step-by-Step Progress**:
   - Each provisioning step shown with status icon
   - Duration for each step
   - Expandable steps for detailed sub-operations
   - Real-time updates as deployment progresses

2. **Detailed Logs**:
   - Timestamped log entries
   - Log level filtering (DEBUG, INFO, WARNING, ERROR)
   - Search functionality
   - Copy logs to clipboard
   - Download logs as file
   - Auto-scroll to latest (toggleable)

3. **Configuration View**:
   - Show resource configuration as JSON/YAML
   - Syntax highlighting
   - Collapsible sections
   - Copy configuration

4. **AWS API Calls**:
   - List all AWS API calls made for this resource
   - Show request/response times
   - HTTP status codes
   - Expandable to see request/response bodies
   - Useful for debugging and understanding what happened

5. **Error Details** (for failed resources):
   ```
   ┌─────────────────────────────────────────────────────────┐
   │  Lambda Function: customer-support-agent          [×]    │
   ├─────────────────────────────────────────────────────────┤
   │  Status: ✗ Deployment Failed                            │
   │  Duration: 5.3s                                         │
   ├─────────────────────────────────────────────────────────┤
   │  ❌ Error Details                                       │
   │                                                          │
   │  Error Type: AccessDeniedException                      │
   │  Message: User is not authorized to perform             │
   │           lambda:CreateFunction                         │
   │                                                          │
   │  📋 Suggested Fixes:                                    │
   │  • Add lambda:CreateFunction permission to IAM user     │
   │  • Verify AWS credentials are correct                   │
   │  • Check service control policies (SCPs)                │
   │                                                          │
   │  [View Full Stack Trace]  [Retry Deployment]           │
   │                                                          │
   ├─────────────────────────────────────────────────────────┤
   │  📝 Logs                                                │
   │                                                          │
   │  10:25:12.123 INFO  Starting Lambda provisioning       │
   │  10:25:12.234 DEBUG Packaging function code            │
   │  10:25:15.345 DEBUG Uploading to S3                    │
   │  10:25:17.456 ERROR Failed to create function          │
   │  10:25:17.567 ERROR AccessDeniedException: User is...  │
   │                                                          │
   └─────────────────────────────────────────────────────────┘
   ```

**Global Execution Timeline**:

Bottom panel showing overall deployment timeline:

```
┌─────────────────────────────────────────────────────────┐
│  Deployment Timeline                                     │
│                                                          │
│  0s    10s   20s   30s   40s   50s   60s               │
│  ├─────┼─────┼─────┼─────┼─────┼─────┼─────┤          │
│  │█████│                                                 │  VPC (5s)
│       │██│                                               │  Subnets (2s)
│          │████████│                                      │  IAM Role (8s)
│                   │██████│                               │  Security Group (6s)
│                          │████████████│                  │  Lambda (12s)
│                                       │████│             │  API Gateway (4s)
│                                                          │
│  Total Duration: 52s                                    │
│  Parallel Efficiency: 67% (saved 26s)                   │
└─────────────────────────────────────────────────────────┘
```

**Interactive Features**:

1. **Click Node → Open Execution Log**:
   - Single click on any node opens execution log panel
   - Panel slides in from right side
   - Can pin panel to keep it open while clicking other nodes

2. **Hover Effects**:
   - Hover over node shows quick status tooltip
   - Tooltip includes: status, duration, physical ID
   - Hover during deployment shows current step

3. **Edge Status**:
   - Edges (connections) also show status
   - Green: Both resources deployed successfully
   - Blue: Deployment in progress
   - Red: One or both resources failed
   - Animated flow effect during deployment

4. **Deployment History**:
   - View past deployments
   - Compare execution times
   - See what changed between deployments
   - Replay deployment visualization

**Implementation Details**:

```typescript
interface ExecutionLog {
  resourceId: string;
  status: 'pending' | 'deploying' | 'success' | 'failed' | 'warning';
  startTime: Date;
  endTime?: Date;
  duration?: number;
  physicalId?: string;
  steps: ExecutionStep[];
  logs: LogEntry[];
  apiCalls: APICall[];
  configuration: any;
  error?: ErrorDetails;
}

interface ExecutionStep {
  id: string;
  name: string;
  status: 'pending' | 'running' | 'success' | 'failed';
  startTime: Date;
  endTime?: Date;
  duration?: number;
}

interface LogEntry {
  timestamp: Date;
  level: 'DEBUG' | 'INFO' | 'WARNING' | 'ERROR';
  message: string;
  context?: any;
}

interface APICall {
  service: string;
  operation: string;
  startTime: Date;
  duration: number;
  statusCode: number;
  request?: any;
  response?: any;
}

// WebSocket message for real-time updates
interface DeploymentUpdate {
  type: 'resource_status' | 'log_entry' | 'step_complete' | 'api_call';
  resourceId: string;
  data: any;
}
```

**CSS for Glow Effects**:

```css
/* Success glow */
.node-success {
  border: 2px solid #22c55e;
  box-shadow: 0 0 8px 2px rgba(34, 197, 94, 0.6);
}

/* Deploying pulse animation */
.node-deploying {
  border: 2px solid #3b82f6;
  animation: pulse 1.5s ease-in-out infinite;
}

@keyframes pulse {
  0%, 100% {
    box-shadow: 0 0 8px 2px rgba(59, 130, 246, 0.4);
  }
  50% {
    box-shadow: 0 0 16px 4px rgba(59, 130, 246, 0.8);
  }
}

/* Failed glow */
.node-failed {
  border: 2px solid #ef4444;
  box-shadow: 0 0 10px 3px rgba(239, 68, 68, 0.8);
}

/* Warning glow */
.node-warning {
  border: 2px solid #eab308;
  box-shadow: 0 0 8px 2px rgba(234, 179, 8, 0.6);
}

/* Pending (dim) */
.node-pending {
  border: 2px dashed #9ca3af;
  opacity: 0.6;
}
```

#### 4. Configuration Sync

**Bidirectional Sync**:
- Visual changes automatically update `strands.yaml`
- Manual `strands.yaml` edits reflect in visual canvas
- Conflict resolution UI for simultaneous edits

**Export/Import**:
- Export canvas as `strands.yaml`
- Import existing `strands.yaml` to visualize
- Export as diagram (PNG, SVG) for documentation

#### 5. Resource Library

**Drag-and-Drop Palette**:
```
┌─────────────────────┐
│   Resource Library  │
├─────────────────────┤
│ 🤖 Agents           │
│   • Python Agent    │
│   • Node.js Agent   │
│                     │
│ 💾 Storage          │
│   • S3 Bucket       │
│   • DynamoDB Table  │
│                     │
│ 📨 Messaging        │
│   • SQS Queue       │
│   • SNS Topic       │
│   • EventBridge     │
│                     │
│ 🌐 API              │
│   • API Gateway     │
│   • Lambda URL      │
│                     │
│ 🔐 Security         │
│   • IAM Role        │
│   • Security Group  │
└─────────────────────┘
```

#### 6. Templates and Patterns

**Pre-built Templates**:
- "Simple Agent": Agent + API Gateway + IAM
- "Event-Driven Agent": Agent + SQS + DynamoDB + IAM
- "Multi-Agent System": Multiple agents with shared resources
- "Production Setup": VPC + Private subnets + Agents + Monitoring

**Custom Templates**:
- Save current canvas as template
- Share templates with team
- Template marketplace (community templates)

#### 7. Environment Management

**Environment Switcher**:
- Visual dropdown to switch between dev/staging/prod
- Show environment-specific overrides on canvas
- Deploy to specific environment from UI
- Compare environments side-by-side

#### 8. Cost Estimation

**Real-Time Cost Display**:
- Show estimated monthly cost per resource
- Total infrastructure cost at bottom of canvas
- Cost breakdown by service
- Warning when cost exceeds threshold

#### 9. Validation and Linting

**Visual Validation**:
- Red outline on nodes with configuration errors
- Yellow outline for warnings
- Hover to see validation messages
- "Fix" button for auto-fixable issues

**Dependency Validation**:
- Highlight missing connections (e.g., Agent without IAM role)
- Suggest required connections
- Detect circular dependencies

### Technical Implementation

**Frontend Stack**:
- **Framework**: Electron (cross-platform) or Tauri (lighter, Rust-based)
- **UI Library**: React or Vue
- **Canvas Library**: React Flow or Vue Flow (node-based editor)
- **State Management**: Zustand or Pinia
- **Styling**: Tailwind CSS

**Backend Integration**:
- Embedded Python runtime for CLI engine
- IPC communication between UI and CLI
- WebSocket for real-time deployment updates

**File Watching**:
- Watch `strands.yaml` for external changes
- Auto-reload canvas when file changes
- Prompt user to reload if conflicts detected

### User Workflows

#### Workflow 1: Create New Infrastructure

1. Open Visual Builder
2. Drag "Python Agent" node onto canvas
3. Drag "S3 Bucket" node onto canvas
4. Connect agent to S3 bucket (creates permission edge)
5. Click edge, select "Read/Write" permissions
6. Click "Deploy" button
7. Watch real-time deployment progress
8. See success notification with deployed URLs

#### Workflow 2: Modify Existing Infrastructure

1. Open Visual Builder
2. Load existing `strands.yaml` (auto-visualized)
3. Click agent node, increase memory from 512MB to 1024MB
4. Click "Deploy Changes"
5. See only modified resources highlighted
6. Confirm deployment
7. Watch incremental deployment (only agent updates)

#### Workflow 3: Debug Deployment Failure

1. Deployment fails (agent node turns red)
2. Click agent node to see error details
3. Error: "IAM role missing s3:PutObject permission"
4. Click "Fix" button (opens permission editor)
5. Add missing permission to edge
6. Click "Retry Deployment"
7. Watch successful deployment

### Integration with CLI

**Seamless Integration**:
- Visual Builder generates/updates `strands.yaml`
- CLI reads same `strands.yaml` for deployments
- Can use CLI in CI/CD, Visual Builder for development
- Both tools share same state files

**CLI Commands from UI**:
- "Open Terminal" button to run CLI commands
- Copy CLI command for current action
- View CLI output in integrated terminal

## Future Enhancements

1. **Multi-Region Deployment**: Deploy agents across multiple regions with visual region selector
2. **Blue-Green Deployments**: Visual traffic shifting controls
3. **Cost Estimation**: Real-time cost calculator in visual builder
4. **Advanced Drift Detection**: Visual diff showing drift on canvas
5. **Plugin System**: Custom node types and provisioners
6. **Collaborative Editing**: Multiple users editing same canvas (like Figma)
7. **CI/CD Integration**: GitHub Actions, GitLab CI templates with visual pipeline builder
8. **Policy as Code**: Visual policy editor with drag-and-drop rules
9. **Agentic Auto-Remediation**: AI-suggested fixes shown visually on canvas
10. **Mobile App**: View and monitor deployments on mobile
11. **3D Visualization**: 3D infrastructure visualization for complex systems
