# AWS Client Management and Error Handling

This document describes the AWS client management and error handling implementation for the Strands deployment system.

## Overview

The implementation provides three core components:

1. **AWS Client Manager**: Manages boto3 sessions and clients with credential validation and role assumption
2. **Retry Strategy**: Implements exponential backoff for transient errors
3. **Error Handler**: Categorizes and provides user-friendly error messages

## Components

### 1. AWS Client Manager (`aws_client.py`)

Manages AWS credentials, sessions, and clients with connection pooling.

#### Features

- **Credential Management**: Supports AWS profiles, environment variables, and IAM roles
- **Credential Validation**: Validates credentials before deployment
- **Role Assumption**: Supports cross-account deployments via IAM role assumption
- **Connection Pooling**: Reuses boto3 clients for better performance
- **Client Caching**: Caches clients to avoid repeated initialization

#### Usage

```python
from strands_deploy.utils import AWSClientManager, AssumeRoleConfig

# Basic usage
client_manager = AWSClientManager(
    profile='default',
    region='us-east-1'
)

# Validate credentials
credentials = client_manager.validate_credentials()
print(f"Account: {credentials.account_id}")
print(f"User: {credentials.user_arn}")

# Get AWS clients
s3_client = client_manager.get_client('s3')
lambda_client = client_manager.get_client('lambda')

# Assume role for cross-account deployment
assume_role_config = AssumeRoleConfig(
    role_arn='arn:aws:iam::123456789012:role/DeploymentRole',
    session_name='strands-deployment',
    duration_seconds=3600
)

client_manager = AWSClientManager(
    region='us-east-1',
    assume_role_config=assume_role_config
)

# Assume the role
assumed_credentials = client_manager.assume_role()

# Clients will now use assumed role credentials
lambda_client = client_manager.get_client('lambda')
```

#### Configuration

The client manager supports the following configuration:

- `profile`: AWS profile name (from `~/.aws/credentials`)
- `region`: AWS region
- `assume_role_config`: Configuration for IAM role assumption
- `max_pool_connections`: Maximum connections in the connection pool (default: 50)

#### Credential Resolution

Credentials are resolved in the following order:

1. Assumed role credentials (if configured)
2. AWS profile (if specified)
3. Environment variables (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`)
4. IAM role (if running on EC2/ECS/Lambda)
5. Default profile from `~/.aws/credentials`

### 2. Retry Strategy (`retry.py`)

Implements exponential backoff with jitter for handling transient errors.

#### Features

- **Exponential Backoff**: Delay increases exponentially with each retry
- **Jitter**: Adds randomness to prevent thundering herd
- **Smart Retry Detection**: Automatically detects retryable errors
- **Configurable**: Customizable retry parameters
- **Decorator Support**: Can be used as a function decorator
- **Circuit Breaker**: Prevents cascading failures

#### Retryable Errors

The following AWS error codes trigger automatic retry:

- `RequestTimeout`
- `ServiceUnavailable`
- `ThrottlingException`
- `TooManyRequestsException`
- `RequestLimitExceeded`
- `Throttling`
- `RequestThrottled`
- `ProvisionedThroughputExceededException`
- `LimitExceededException`
- `InternalError`
- `InternalFailure`
- `ServiceException`

Network errors (connection errors, timeouts) also trigger retry.

#### Usage

```python
from strands_deploy.utils import RetryStrategy, with_retry

# Using RetryStrategy class
retry_strategy = RetryStrategy(
    max_retries=5,
    base_delay=1.0,
    max_delay=60.0,
    exponential_base=2.0,
    jitter=True
)

def create_lambda():
    # Operation that might fail
    return lambda_client.create_function(**config)

result = retry_strategy.execute_with_retry(create_lambda)

# Using decorator
@with_retry(max_retries=3, base_delay=2.0)
def create_lambda_function(client, config):
    return client.create_function(**config)

result = create_lambda_function(lambda_client, function_config)
```

#### Retry Algorithm

The retry delay is calculated as:

```
delay = min(base_delay * (exponential_base ^ attempt), max_delay)
delay += random(0, delay * 0.1)  # Add jitter
```

Example with default settings:
- Attempt 1: ~1.0s delay
- Attempt 2: ~2.0s delay
- Attempt 3: ~4.0s delay
- Attempt 4: ~8.0s delay
- Attempt 5: ~16.0s delay

#### Circuit Breaker

The circuit breaker prevents cascading failures by temporarily blocking requests after repeated failures:

```python
from strands_deploy.utils import CircuitBreaker

circuit_breaker = CircuitBreaker(
    failure_threshold=5,
    recovery_timeout=60.0
)

def call_external_service():
    return circuit_breaker.call(make_api_call)
```

States:
- **CLOSED**: Normal operation
- **OPEN**: Too many failures, requests fail immediately
- **HALF_OPEN**: Testing recovery, limited requests allowed

### 3. Error Handler (`errors.py`)

Categorizes errors and provides user-friendly error messages with suggestions.

#### Error Categories

- `CONFIGURATION`: Invalid configuration
- `AWS`: AWS service errors
- `NETWORK`: Network connectivity issues
- `STATE`: State file errors
- `DEPENDENCY`: Resource dependency errors
- `PROVISIONING`: Resource creation/update failures
- `CREDENTIAL`: AWS credential issues
- `PERMISSION`: IAM permission errors
- `RESOURCE_LIMIT`: AWS service limits exceeded
- `VALIDATION`: Input validation errors
- `UNKNOWN`: Uncategorized errors

#### Error Severity

- `CRITICAL`: Deployment cannot continue
- `ERROR`: Resource failed but deployment can continue
- `WARNING`: Non-fatal issue
- `INFO`: Informational message

#### Usage

```python
from strands_deploy.utils import ErrorHandler, ErrorContext, error_handler

# Using global error handler
try:
    lambda_client.create_function(**config)
except Exception as e:
    context = ErrorContext(
        resource_id='my-lambda-function',
        resource_type='AWS::Lambda::Function',
        operation='create',
        aws_service='lambda',
        aws_operation='CreateFunction'
    )
    
    deployment_error = error_handler.handle_exception(e, context)
    
    # Display user-friendly message
    print(deployment_error.to_user_message())
    
    # Log the error
    error_handler.log_error(deployment_error)
    
    # Get structured error data
    error_dict = deployment_error.to_dict()
```

#### Custom Error Types

```python
from strands_deploy.utils import (
    ConfigurationError,
    CredentialError,
    PermissionError,
    NetworkError,
    StateError,
    DependencyError,
    ProvisioningError
)

# Raise specific error types
raise ConfigurationError(
    "Invalid agent configuration",
    context=ErrorContext(resource_id='agent-1'),
    suggestions=[
        'Check agent name is valid',
        'Verify runtime is supported'
    ]
)
```

#### Error Message Format

Error messages include:

1. **Error header**: Severity and message
2. **Context**: Resource ID, operation, etc.
3. **Cause**: Original exception message
4. **Suggestions**: Actionable fixes

Example:

```
❌ ERROR: Access denied - insufficient permissions: User is not authorized to perform lambda:CreateFunction
   Resource: my-lambda-function
   Operation: create
   Cause: An error occurred (AccessDenied) when calling the CreateFunction operation

💡 Suggested fixes:
   1. Check IAM policies attached to your user/role
   2. Verify you have the required permissions for this operation
   3. Review service control policies (SCPs) if using AWS Organizations
   4. Check resource-based policies on the target resource
```

## Integration with Provisioners

Provisioners should use these utilities for consistent error handling:

```python
from strands_deploy.utils import (
    AWSClientManager,
    with_retry,
    ErrorHandler,
    ErrorContext,
    ProvisioningError
)

class LambdaProvisioner:
    def __init__(self, client_manager: AWSClientManager):
        self.client_manager = client_manager
        self.lambda_client = client_manager.get_client('lambda')
        self.error_handler = ErrorHandler()
    
    @with_retry(max_retries=3)
    def create_function(self, config):
        try:
            response = self.lambda_client.create_function(**config)
            return response
        except Exception as e:
            context = ErrorContext(
                resource_id=config['FunctionName'],
                resource_type='AWS::Lambda::Function',
                operation='create',
                aws_service='lambda',
                aws_operation='CreateFunction'
            )
            
            deployment_error = self.error_handler.handle_exception(e, context)
            self.error_handler.log_error(deployment_error)
            
            raise ProvisioningError(
                f"Failed to create Lambda function: {deployment_error.message}",
                context=context,
                cause=e,
                suggestions=deployment_error.suggestions
            )
```

## Best Practices

1. **Always validate credentials** before starting deployment
2. **Use retry decorator** for all AWS API calls
3. **Provide context** when handling errors
4. **Log errors** with appropriate severity
5. **Cache clients** for better performance
6. **Clear cache** when switching credentials
7. **Use circuit breaker** for external service calls
8. **Handle specific error types** for better user experience

## Testing

Run the example to test the implementation:

```bash
python examples/aws_client_example.py
```

The example demonstrates:
- Basic client usage
- Credential validation
- Role assumption
- Retry strategy
- Error handling and categorization

## Requirements Satisfied

This implementation satisfies the following requirements:

- **9.1**: Standard AWS credential resolution
- **9.2**: AWS profile selection support
- **9.3**: Credential validation before deployment
- **9.4**: Clear error messages for invalid credentials
- **9.5**: IAM role assumption for cross-account deployments
- **Network failure recovery**: Retry strategy with exponential backoff
- **1.5**: Actionable error reporting
- **10.4**: Full stack traces in debug logs
- **Error Handling**: Comprehensive error categorization and user-friendly messages

## Future Enhancements

Potential improvements:

1. **Metrics**: Track retry counts and error rates
2. **Caching**: Cache credential validation results
3. **MFA Support**: Enhanced MFA token handling
4. **Regional Failover**: Automatic failover to backup regions
5. **Cost Tracking**: Track API call costs
6. **Rate Limiting**: Proactive rate limiting to avoid throttling
