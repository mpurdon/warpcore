"""Example usage of AWS client management and error handling."""

from strands_deploy.utils import (
    AWSClientManager,
    AssumeRoleConfig,
    RetryStrategy,
    with_retry,
    ErrorHandler,
    ErrorContext,
    error_handler
)


def example_basic_client():
    """Example: Basic AWS client usage."""
    print("=== Basic AWS Client Usage ===")
    
    # Create client manager
    client_manager = AWSClientManager(
        profile='default',
        region='us-east-1'
    )
    
    # Validate credentials
    try:
        credentials = client_manager.validate_credentials()
        print(f"✓ Credentials validated")
        print(f"  Account: {credentials.account_id}")
        print(f"  User: {credentials.user_arn}")
        print(f"  Region: {credentials.region}")
    except Exception as e:
        deployment_error = error_handler.handle_exception(e)
        print(deployment_error.to_user_message())
        return
    
    # Get S3 client
    s3_client = client_manager.get_client('s3')
    print(f"✓ Created S3 client")


def example_assume_role():
    """Example: Assuming an IAM role."""
    print("\n=== Assume IAM Role ===")
    
    # Configure role assumption
    assume_role_config = AssumeRoleConfig(
        role_arn='arn:aws:iam::123456789012:role/DeploymentRole',
        session_name='strands-deployment',
        duration_seconds=3600
    )
    
    client_manager = AWSClientManager(
        region='us-east-1',
        assume_role_config=assume_role_config
    )
    
    try:
        # Validate base credentials
        base_creds = client_manager.validate_credentials()
        print(f"✓ Base credentials: {base_creds.user_arn}")
        
        # Assume role
        assumed_creds = client_manager.assume_role()
        print(f"✓ Assumed role: {assumed_creds.user_arn}")
        
        # Use assumed role credentials
        lambda_client = client_manager.get_client('lambda')
        print(f"✓ Created Lambda client with assumed role")
        
    except Exception as e:
        deployment_error = error_handler.handle_exception(e)
        print(deployment_error.to_user_message())


def example_retry_strategy():
    """Example: Using retry strategy."""
    print("\n=== Retry Strategy ===")
    
    retry_strategy = RetryStrategy(
        max_retries=3,
        base_delay=1.0,
        max_delay=10.0
    )
    
    # Example function that might fail
    attempt_count = [0]
    
    def flaky_operation():
        attempt_count[0] += 1
        print(f"  Attempt {attempt_count[0]}")
        
        if attempt_count[0] < 3:
            # Simulate transient error
            from botocore.exceptions import ClientError
            raise ClientError(
                {'Error': {'Code': 'ThrottlingException', 'Message': 'Rate exceeded'}},
                'DescribeInstances'
            )
        
        return "Success!"
    
    try:
        result = retry_strategy.execute_with_retry(flaky_operation)
        print(f"✓ Operation succeeded: {result}")
    except Exception as e:
        print(f"✗ Operation failed: {e}")


@with_retry(max_retries=3, base_delay=0.5)
def example_decorated_function():
    """Example: Using retry decorator."""
    print("  Executing decorated function")
    return "Success!"


def example_error_handling():
    """Example: Error handling and categorization."""
    print("\n=== Error Handling ===")
    
    # Simulate various errors
    from botocore.exceptions import ClientError, NoCredentialsError
    
    # 1. Permission error
    print("\n1. Permission Error:")
    permission_error = ClientError(
        {
            'Error': {
                'Code': 'AccessDenied',
                'Message': 'User is not authorized to perform lambda:CreateFunction'
            },
            'ResponseMetadata': {'RequestId': 'abc-123'}
        },
        'CreateFunction'
    )
    
    context = ErrorContext(
        resource_id='my-lambda-function',
        resource_type='AWS::Lambda::Function',
        operation='create',
        aws_service='lambda',
        aws_operation='CreateFunction'
    )
    
    deployment_error = error_handler.handle_exception(permission_error, context)
    print(deployment_error.to_user_message())
    
    # 2. Credential error
    print("\n2. Credential Error:")
    cred_error = NoCredentialsError()
    deployment_error = error_handler.handle_exception(cred_error)
    print(deployment_error.to_user_message())
    
    # 3. Network error
    print("\n3. Network Error:")
    network_error = ConnectionError("Failed to establish connection")
    deployment_error = error_handler.handle_exception(network_error)
    print(deployment_error.to_user_message())


def main():
    """Run all examples."""
    print("AWS Client Management and Error Handling Examples")
    print("=" * 60)
    
    # Note: These examples will fail without valid AWS credentials
    # Uncomment to run with real credentials
    
    # example_basic_client()
    # example_assume_role()
    
    # These examples work without AWS credentials
    example_retry_strategy()
    
    print("\n4. Decorated Function with Retry:")
    try:
        result = example_decorated_function()
        print(f"✓ {result}")
    except Exception as e:
        print(f"✗ {e}")
    
    example_error_handling()
    
    print("\n" + "=" * 60)
    print("Examples completed!")


if __name__ == '__main__':
    main()
