"""Error handling framework for deployment operations."""

from typing import Optional, Dict, Any, List
from enum import Enum
from dataclasses import dataclass
from botocore.exceptions import ClientError, NoCredentialsError, PartialCredentialsError
from strands_deploy.utils.logging import get_logger

logger = get_logger(__name__)


class ErrorCategory(Enum):
    """Categories of errors that can occur during deployment."""
    CONFIGURATION = "configuration"
    AWS = "aws"
    NETWORK = "network"
    STATE = "state"
    DEPENDENCY = "dependency"
    PROVISIONING = "provisioning"
    CREDENTIAL = "credential"
    PERMISSION = "permission"
    RESOURCE_LIMIT = "resource_limit"
    VALIDATION = "validation"
    UNKNOWN = "unknown"


class ErrorSeverity(Enum):
    """Severity levels for errors."""
    CRITICAL = "critical"  # Deployment cannot continue
    ERROR = "error"  # Resource failed but deployment can continue
    WARNING = "warning"  # Non-fatal issue
    INFO = "info"  # Informational message


@dataclass
class ErrorContext:
    """Context information for an error."""
    resource_id: Optional[str] = None
    resource_type: Optional[str] = None
    operation: Optional[str] = None
    aws_service: Optional[str] = None
    aws_operation: Optional[str] = None
    request_id: Optional[str] = None
    additional_info: Optional[Dict[str, Any]] = None


class DeploymentError(Exception):
    """Base exception for deployment errors."""
    
    def __init__(
        self,
        message: str,
        category: ErrorCategory = ErrorCategory.UNKNOWN,
        severity: ErrorSeverity = ErrorSeverity.ERROR,
        context: Optional[ErrorContext] = None,
        cause: Optional[Exception] = None,
        suggestions: Optional[List[str]] = None
    ):
        """Initialize deployment error.
        
        Args:
            message: Human-readable error message
            category: Error category
            severity: Error severity
            context: Additional context about the error
            cause: Original exception that caused this error
            suggestions: List of suggested fixes
        """
        super().__init__(message)
        self.message = message
        self.category = category
        self.severity = severity
        self.context = context or ErrorContext()
        self.cause = cause
        self.suggestions = suggestions or []
    
    def to_user_message(self) -> str:
        """Convert error to user-friendly message.
        
        Returns:
            Formatted error message for display to user
        """
        lines = []
        
        # Error header
        lines.append(f"❌ {self.severity.value.upper()}: {self.message}")
        
        # Context information
        if self.context.resource_id:
            lines.append(f"   Resource: {self.context.resource_id}")
        if self.context.operation:
            lines.append(f"   Operation: {self.context.operation}")
        
        # Original error
        if self.cause:
            lines.append(f"   Cause: {str(self.cause)}")
        
        # Suggestions
        if self.suggestions:
            lines.append("\n💡 Suggested fixes:")
            for i, suggestion in enumerate(self.suggestions, 1):
                lines.append(f"   {i}. {suggestion}")
        
        return "\n".join(lines)
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert error to dictionary for logging/serialization.
        
        Returns:
            Dictionary representation of the error
        """
        return {
            'message': self.message,
            'category': self.category.value,
            'severity': self.severity.value,
            'context': {
                'resource_id': self.context.resource_id,
                'resource_type': self.context.resource_type,
                'operation': self.context.operation,
                'aws_service': self.context.aws_service,
                'aws_operation': self.context.aws_operation,
                'request_id': self.context.request_id,
                'additional_info': self.context.additional_info
            },
            'cause': str(self.cause) if self.cause else None,
            'suggestions': self.suggestions
        }


class ConfigurationError(DeploymentError):
    """Error in configuration file or settings."""
    
    def __init__(self, message: str, **kwargs):
        super().__init__(
            message,
            category=ErrorCategory.CONFIGURATION,
            severity=ErrorSeverity.CRITICAL,
            **kwargs
        )


class CredentialError(DeploymentError):
    """Error related to AWS credentials."""
    
    def __init__(self, message: str, **kwargs):
        super().__init__(
            message,
            category=ErrorCategory.CREDENTIAL,
            severity=ErrorSeverity.CRITICAL,
            **kwargs
        )


class PermissionError(DeploymentError):
    """Error related to AWS permissions."""
    
    def __init__(self, message: str, **kwargs):
        super().__init__(
            message,
            category=ErrorCategory.PERMISSION,
            severity=ErrorSeverity.ERROR,
            **kwargs
        )


class NetworkError(DeploymentError):
    """Network-related error."""
    
    def __init__(self, message: str, **kwargs):
        super().__init__(
            message,
            category=ErrorCategory.NETWORK,
            severity=ErrorSeverity.ERROR,
            **kwargs
        )


class StateError(DeploymentError):
    """Error related to state management."""
    
    def __init__(self, message: str, **kwargs):
        super().__init__(
            message,
            category=ErrorCategory.STATE,
            severity=ErrorSeverity.CRITICAL,
            **kwargs
        )


class DependencyError(DeploymentError):
    """Error related to resource dependencies."""
    
    def __init__(self, message: str, **kwargs):
        super().__init__(
            message,
            category=ErrorCategory.DEPENDENCY,
            severity=ErrorSeverity.ERROR,
            **kwargs
        )


class ProvisioningError(DeploymentError):
    """Error during resource provisioning."""
    
    def __init__(self, message: str, **kwargs):
        super().__init__(
            message,
            category=ErrorCategory.PROVISIONING,
            severity=ErrorSeverity.ERROR,
            **kwargs
        )


class ResourceLimitError(DeploymentError):
    """Error due to AWS resource limits."""
    
    def __init__(self, message: str, **kwargs):
        super().__init__(
            message,
            category=ErrorCategory.RESOURCE_LIMIT,
            severity=ErrorSeverity.ERROR,
            **kwargs
        )


class ValidationError(DeploymentError):
    """Error during validation."""
    
    def __init__(self, message: str, **kwargs):
        super().__init__(
            message,
            category=ErrorCategory.VALIDATION,
            severity=ErrorSeverity.ERROR,
            **kwargs
        )


class ErrorHandler:
    """Handles and categorizes errors from AWS and other sources."""
    
    # Mapping of AWS error codes to error categories and suggestions
    AWS_ERROR_MAPPING = {
        # Credential errors
        'InvalidClientTokenId': {
            'category': ErrorCategory.CREDENTIAL,
            'message': 'AWS credentials are invalid or expired',
            'suggestions': [
                'Check that your AWS credentials are correctly configured',
                'Verify credentials using: aws sts get-caller-identity',
                'Update credentials if they have expired'
            ]
        },
        'SignatureDoesNotMatch': {
            'category': ErrorCategory.CREDENTIAL,
            'message': 'AWS credential signature is invalid',
            'suggestions': [
                'Verify your AWS secret access key is correct',
                'Check for any special characters in credentials',
                'Regenerate AWS credentials if necessary'
            ]
        },
        'ExpiredToken': {
            'category': ErrorCategory.CREDENTIAL,
            'message': 'AWS session token has expired',
            'suggestions': [
                'Refresh your AWS session credentials',
                'Re-authenticate with your identity provider',
                'Check if MFA token needs to be refreshed'
            ]
        },
        
        # Permission errors
        'AccessDenied': {
            'category': ErrorCategory.PERMISSION,
            'message': 'Access denied - insufficient permissions',
            'suggestions': [
                'Check IAM policies attached to your user/role',
                'Verify you have the required permissions for this operation',
                'Review service control policies (SCPs) if using AWS Organizations',
                'Check resource-based policies on the target resource'
            ]
        },
        'UnauthorizedOperation': {
            'category': ErrorCategory.PERMISSION,
            'message': 'Operation not authorized',
            'suggestions': [
                'Add the required IAM permission for this operation',
                'Check if the operation requires additional conditions',
                'Verify you are operating in the correct AWS region'
            ]
        },
        
        # Resource limit errors
        'LimitExceeded': {
            'category': ErrorCategory.RESOURCE_LIMIT,
            'message': 'AWS service limit exceeded',
            'suggestions': [
                'Request a service limit increase through AWS Support',
                'Review and clean up unused resources',
                'Consider using resource sharing or consolidation'
            ]
        },
        'TooManyRequestsException': {
            'category': ErrorCategory.RESOURCE_LIMIT,
            'message': 'API rate limit exceeded',
            'suggestions': [
                'Reduce the frequency of API calls',
                'Implement exponential backoff (already enabled)',
                'Consider batching operations where possible'
            ]
        },
        
        # Resource errors
        'ResourceNotFoundException': {
            'category': ErrorCategory.PROVISIONING,
            'message': 'Resource not found',
            'suggestions': [
                'Verify the resource exists in the specified region',
                'Check if the resource was deleted manually',
                'Ensure resource ID or ARN is correct'
            ]
        },
        'ResourceAlreadyExistsException': {
            'category': ErrorCategory.PROVISIONING,
            'message': 'Resource already exists',
            'suggestions': [
                'Use a different name for the resource',
                'Delete the existing resource if it is no longer needed',
                'Import the existing resource into state'
            ]
        },
        'ResourceInUseException': {
            'category': ErrorCategory.PROVISIONING,
            'message': 'Resource is currently in use',
            'suggestions': [
                'Wait for the resource to become available',
                'Check for dependencies that are using this resource',
                'Consider using a different resource'
            ]
        },
        
        # Validation errors
        'ValidationException': {
            'category': ErrorCategory.VALIDATION,
            'message': 'Invalid parameter or configuration',
            'suggestions': [
                'Review the error message for specific validation failures',
                'Check AWS documentation for parameter requirements',
                'Verify all required parameters are provided'
            ]
        },
        'InvalidParameterException': {
            'category': ErrorCategory.VALIDATION,
            'message': 'Invalid parameter value',
            'suggestions': [
                'Check parameter format and constraints',
                'Review AWS service documentation for valid values',
                'Verify parameter types match expected types'
            ]
        },
        
        # Network errors
        'RequestTimeout': {
            'category': ErrorCategory.NETWORK,
            'message': 'Request timed out',
            'suggestions': [
                'Check your network connectivity',
                'Verify AWS service is available in your region',
                'Retry the operation (automatic retry enabled)'
            ]
        },
        'ServiceUnavailable': {
            'category': ErrorCategory.NETWORK,
            'message': 'AWS service temporarily unavailable',
            'suggestions': [
                'Wait a few moments and retry',
                'Check AWS Service Health Dashboard',
                'Automatic retry is enabled'
            ]
        }
    }
    
    def __init__(self):
        """Initialize error handler."""
        self.logger = get_logger(__name__)
    
    def handle_exception(
        self,
        error: Exception,
        context: Optional[ErrorContext] = None
    ) -> DeploymentError:
        """Handle an exception and convert to DeploymentError.
        
        Args:
            error: The exception to handle
            context: Additional context about where the error occurred
            
        Returns:
            DeploymentError with categorization and suggestions
        """
        context = context or ErrorContext()
        
        # Handle AWS ClientError
        if isinstance(error, ClientError):
            return self._handle_aws_error(error, context)
        
        # Handle credential errors
        if isinstance(error, (NoCredentialsError, PartialCredentialsError)):
            return self._handle_credential_error(error, context)
        
        # Handle network errors
        if isinstance(error, (ConnectionError, TimeoutError)):
            return self._handle_network_error(error, context)
        
        # Handle already-wrapped DeploymentError
        if isinstance(error, DeploymentError):
            return error
        
        # Unknown error
        return DeploymentError(
            message=str(error),
            category=ErrorCategory.UNKNOWN,
            severity=ErrorSeverity.ERROR,
            context=context,
            cause=error,
            suggestions=['Check logs for more details', 'Contact support if issue persists']
        )
    
    def _handle_aws_error(
        self,
        error: ClientError,
        context: ErrorContext
    ) -> DeploymentError:
        """Handle AWS ClientError.
        
        Args:
            error: The ClientError
            context: Error context
            
        Returns:
            Categorized DeploymentError
        """
        error_code = error.response.get('Error', {}).get('Code', 'Unknown')
        error_message = error.response.get('Error', {}).get('Message', str(error))
        request_id = error.response.get('ResponseMetadata', {}).get('RequestId')
        
        # Update context with AWS-specific information
        context.request_id = request_id
        
        # Look up error in mapping
        error_info = self.AWS_ERROR_MAPPING.get(error_code)
        
        if error_info:
            return DeploymentError(
                message=f"{error_info['message']}: {error_message}",
                category=error_info['category'],
                severity=ErrorSeverity.ERROR,
                context=context,
                cause=error,
                suggestions=error_info['suggestions']
            )
        
        # Unknown AWS error
        return DeploymentError(
            message=f"AWS Error ({error_code}): {error_message}",
            category=ErrorCategory.AWS,
            severity=ErrorSeverity.ERROR,
            context=context,
            cause=error,
            suggestions=[
                'Check AWS documentation for this error code',
                f'AWS Request ID: {request_id}',
                'Review CloudTrail logs for more details'
            ]
        )
    
    def _handle_credential_error(
        self,
        error: Exception,
        context: ErrorContext
    ) -> CredentialError:
        """Handle credential-related errors.
        
        Args:
            error: The credential error
            context: Error context
            
        Returns:
            CredentialError
        """
        if isinstance(error, NoCredentialsError):
            return CredentialError(
                message='No AWS credentials found',
                context=context,
                cause=error,
                suggestions=[
                    'Configure AWS credentials using: aws configure',
                    'Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY environment variables',
                    'Use an IAM role if running on EC2/ECS/Lambda',
                    'Specify a profile with --profile flag'
                ]
            )
        
        if isinstance(error, PartialCredentialsError):
            return CredentialError(
                message='Incomplete AWS credentials',
                context=context,
                cause=error,
                suggestions=[
                    'Ensure both access key ID and secret access key are provided',
                    'Check credential configuration in ~/.aws/credentials',
                    'Verify environment variables are set correctly'
                ]
            )
        
        return CredentialError(
            message=f'Credential error: {str(error)}',
            context=context,
            cause=error
        )
    
    def _handle_network_error(
        self,
        error: Exception,
        context: ErrorContext
    ) -> NetworkError:
        """Handle network-related errors.
        
        Args:
            error: The network error
            context: Error context
            
        Returns:
            NetworkError
        """
        return NetworkError(
            message=f'Network error: {str(error)}',
            context=context,
            cause=error,
            suggestions=[
                'Check your internet connection',
                'Verify network firewall rules allow AWS API access',
                'Check if VPN or proxy is interfering',
                'Retry the operation (automatic retry enabled)',
                'Verify AWS endpoints are accessible'
            ]
        )
    
    def log_error(self, error: DeploymentError):
        """Log an error with appropriate level.
        
        Args:
            error: The error to log
        """
        log_message = error.to_user_message()
        
        if error.severity == ErrorSeverity.CRITICAL:
            self.logger.error(log_message)
        elif error.severity == ErrorSeverity.ERROR:
            self.logger.error(log_message)
        elif error.severity == ErrorSeverity.WARNING:
            self.logger.warning(log_message)
        else:
            self.logger.info(log_message)
        
        # Log full error details at debug level
        self.logger.debug(f"Error details: {error.to_dict()}")


# Global error handler instance
error_handler = ErrorHandler()
