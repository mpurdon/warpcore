"""Retry strategy with exponential backoff for AWS operations."""

import time
import random
from typing import Callable, TypeVar, Optional, List, Type
from functools import wraps
from botocore.exceptions import ClientError
from strands_deploy.utils.logging import get_logger

logger = get_logger(__name__)

T = TypeVar('T')


class RetryStrategy:
    """Implements exponential backoff retry strategy for transient errors."""
    
    # AWS error codes that should trigger a retry
    RETRYABLE_ERROR_CODES = {
        'RequestTimeout',
        'ServiceUnavailable',
        'ThrottlingException',
        'TooManyRequestsException',
        'RequestLimitExceeded',
        'Throttling',
        'RequestThrottled',
        'ProvisionedThroughputExceededException',
        'LimitExceededException',
        'InternalError',
        'InternalFailure',
        'ServiceException',
    }
    
    # Network-related exceptions that should trigger a retry
    RETRYABLE_EXCEPTIONS = (
        ConnectionError,
        TimeoutError,
    )
    
    def __init__(
        self,
        max_retries: int = 5,
        base_delay: float = 1.0,
        max_delay: float = 60.0,
        exponential_base: float = 2.0,
        jitter: bool = True
    ):
        """Initialize retry strategy.
        
        Args:
            max_retries: Maximum number of retry attempts
            base_delay: Base delay in seconds for first retry
            max_delay: Maximum delay in seconds between retries
            exponential_base: Base for exponential backoff calculation
            jitter: Whether to add random jitter to delay
        """
        self.max_retries = max_retries
        self.base_delay = base_delay
        self.max_delay = max_delay
        self.exponential_base = exponential_base
        self.jitter = jitter
    
    def should_retry(self, error: Exception, attempt: int) -> bool:
        """Determine if an error should trigger a retry.
        
        Args:
            error: The exception that occurred
            attempt: Current attempt number (0-indexed)
            
        Returns:
            True if the error is retryable and max retries not exceeded
        """
        if attempt >= self.max_retries:
            return False
        
        # Check for retryable network exceptions
        if isinstance(error, self.RETRYABLE_EXCEPTIONS):
            return True
        
        # Check for retryable AWS errors
        if isinstance(error, ClientError):
            error_code = error.response.get('Error', {}).get('Code', '')
            if error_code in self.RETRYABLE_ERROR_CODES:
                return True
        
        # Check for connection errors in the error message
        error_str = str(error).lower()
        if any(keyword in error_str for keyword in ['connection', 'timeout', 'network']):
            return True
        
        return False
    
    def get_delay(self, attempt: int) -> float:
        """Calculate delay before next retry using exponential backoff.
        
        Args:
            attempt: Current attempt number (0-indexed)
            
        Returns:
            Delay in seconds before next retry
        """
        # Calculate exponential delay
        delay = min(
            self.base_delay * (self.exponential_base ** attempt),
            self.max_delay
        )
        
        # Add jitter if enabled (random value between 0 and 10% of delay)
        if self.jitter:
            jitter_amount = random.uniform(0, delay * 0.1)
            delay += jitter_amount
        
        return delay
    
    def execute_with_retry(
        self,
        func: Callable[..., T],
        *args,
        **kwargs
    ) -> T:
        """Execute a function with retry logic.
        
        Args:
            func: Function to execute
            *args: Positional arguments for the function
            **kwargs: Keyword arguments for the function
            
        Returns:
            Result of the function call
            
        Raises:
            The last exception if all retries are exhausted
        """
        last_exception = None
        
        for attempt in range(self.max_retries + 1):
            try:
                result = func(*args, **kwargs)
                
                # Log successful retry if this wasn't the first attempt
                if attempt > 0:
                    logger.info(f"Operation succeeded after {attempt} retries")
                
                return result
                
            except Exception as e:
                last_exception = e
                
                # Check if we should retry
                if not self.should_retry(e, attempt):
                    logger.debug(f"Error is not retryable or max retries exceeded: {e}")
                    raise
                
                # Calculate delay
                delay = self.get_delay(attempt)
                
                # Log retry attempt
                error_info = self._get_error_info(e)
                logger.warning(
                    f"Attempt {attempt + 1}/{self.max_retries + 1} failed: {error_info}. "
                    f"Retrying in {delay:.2f}s..."
                )
                
                # Wait before retrying
                time.sleep(delay)
        
        # All retries exhausted
        logger.error(f"All {self.max_retries} retry attempts exhausted")
        raise last_exception
    
    def _get_error_info(self, error: Exception) -> str:
        """Extract useful error information for logging.
        
        Args:
            error: The exception
            
        Returns:
            Human-readable error description
        """
        if isinstance(error, ClientError):
            error_code = error.response.get('Error', {}).get('Code', 'Unknown')
            error_message = error.response.get('Error', {}).get('Message', str(error))
            return f"{error_code}: {error_message}"
        
        return f"{type(error).__name__}: {str(error)}"


def with_retry(
    max_retries: int = 5,
    base_delay: float = 1.0,
    max_delay: float = 60.0,
    exponential_base: float = 2.0,
    jitter: bool = True
):
    """Decorator to add retry logic to a function.
    
    Args:
        max_retries: Maximum number of retry attempts
        base_delay: Base delay in seconds for first retry
        max_delay: Maximum delay in seconds between retries
        exponential_base: Base for exponential backoff calculation
        jitter: Whether to add random jitter to delay
        
    Returns:
        Decorated function with retry logic
        
    Example:
        @with_retry(max_retries=3, base_delay=2.0)
        def create_lambda_function(client, config):
            return client.create_function(**config)
    """
    def decorator(func: Callable[..., T]) -> Callable[..., T]:
        @wraps(func)
        def wrapper(*args, **kwargs) -> T:
            strategy = RetryStrategy(
                max_retries=max_retries,
                base_delay=base_delay,
                max_delay=max_delay,
                exponential_base=exponential_base,
                jitter=jitter
            )
            return strategy.execute_with_retry(func, *args, **kwargs)
        
        return wrapper
    
    return decorator


class CircuitBreaker:
    """Circuit breaker pattern to prevent cascading failures.
    
    The circuit breaker has three states:
    - CLOSED: Normal operation, requests pass through
    - OPEN: Too many failures, requests fail immediately
    - HALF_OPEN: Testing if service recovered, limited requests pass through
    """
    
    def __init__(
        self,
        failure_threshold: int = 5,
        recovery_timeout: float = 60.0,
        expected_exception: Type[Exception] = Exception
    ):
        """Initialize circuit breaker.
        
        Args:
            failure_threshold: Number of failures before opening circuit
            recovery_timeout: Seconds to wait before attempting recovery
            expected_exception: Exception type to track for failures
        """
        self.failure_threshold = failure_threshold
        self.recovery_timeout = recovery_timeout
        self.expected_exception = expected_exception
        
        self.failure_count = 0
        self.last_failure_time: Optional[float] = None
        self.state = 'CLOSED'  # CLOSED, OPEN, HALF_OPEN
    
    def call(self, func: Callable[..., T], *args, **kwargs) -> T:
        """Execute function with circuit breaker protection.
        
        Args:
            func: Function to execute
            *args: Positional arguments
            **kwargs: Keyword arguments
            
        Returns:
            Result of function call
            
        Raises:
            Exception: If circuit is open or function fails
        """
        if self.state == 'OPEN':
            # Check if we should attempt recovery
            if time.time() - self.last_failure_time >= self.recovery_timeout:
                logger.info("Circuit breaker entering HALF_OPEN state")
                self.state = 'HALF_OPEN'
            else:
                raise Exception(f"Circuit breaker is OPEN. Service unavailable.")
        
        try:
            result = func(*args, **kwargs)
            
            # Success - reset failure count
            if self.state == 'HALF_OPEN':
                logger.info("Circuit breaker closing after successful recovery")
                self.state = 'CLOSED'
                self.failure_count = 0
            
            return result
            
        except self.expected_exception as e:
            self.failure_count += 1
            self.last_failure_time = time.time()
            
            if self.failure_count >= self.failure_threshold:
                logger.error(
                    f"Circuit breaker opening after {self.failure_count} failures"
                )
                self.state = 'OPEN'
            
            raise
    
    def reset(self):
        """Manually reset the circuit breaker."""
        self.state = 'CLOSED'
        self.failure_count = 0
        self.last_failure_time = None
        logger.info("Circuit breaker manually reset")
