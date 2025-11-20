"""Logging infrastructure with structured JSON logging."""

import logging
import json
import sys
from datetime import datetime
from pathlib import Path
from typing import Any


class JSONFormatter(logging.Formatter):
    """Custom formatter that outputs logs as JSON."""
    
    def format(self, record: logging.LogRecord) -> str:
        """Format log record as JSON.
        
        Args:
            record: The log record to format
            
        Returns:
            JSON-formatted log string
        """
        log_data = {
            'timestamp': datetime.utcnow().isoformat() + 'Z',
            'level': record.levelname,
            'logger': record.name,
            'message': record.getMessage(),
        }
        
        # Add exception info if present
        if record.exc_info:
            log_data['exception'] = self.formatException(record.exc_info)
        
        # Add extra fields
        if hasattr(record, 'resource_id'):
            log_data['resource_id'] = record.resource_id
        if hasattr(record, 'resource_type'):
            log_data['resource_type'] = record.resource_type
        if hasattr(record, 'operation'):
            log_data['operation'] = record.operation
        if hasattr(record, 'duration'):
            log_data['duration'] = record.duration
        
        return json.dumps(log_data)


class ConsoleFormatter(logging.Formatter):
    """Human-readable formatter for console output."""
    
    COLORS = {
        'DEBUG': '\033[36m',    # Cyan
        'INFO': '\033[32m',     # Green
        'WARNING': '\033[33m',  # Yellow
        'ERROR': '\033[31m',    # Red
        'CRITICAL': '\033[35m', # Magenta
    }
    RESET = '\033[0m'
    
    def format(self, record: logging.LogRecord) -> str:
        """Format log record for console.
        
        Args:
            record: The log record to format
            
        Returns:
            Formatted log string with colors
        """
        color = self.COLORS.get(record.levelname, '')
        reset = self.RESET
        
        timestamp = datetime.utcnow().strftime('%H:%M:%S')
        level = f"{color}{record.levelname:8}{reset}"
        message = record.getMessage()
        
        # Add resource info if present
        if hasattr(record, 'resource_id'):
            message = f"[{record.resource_id}] {message}"
        
        return f"{timestamp} {level} {message}"


def setup_logging(log_level: str = 'info') -> None:
    """Setup logging infrastructure.
    
    Args:
        log_level: Logging level (debug, info, warning, error)
    """
    # Convert string level to logging constant
    level = getattr(logging, log_level.upper())
    
    # Create logs directory
    log_dir = Path('.strands/logs')
    log_dir.mkdir(parents=True, exist_ok=True)
    
    # Setup root logger
    root_logger = logging.getLogger()
    root_logger.setLevel(level)
    
    # Remove existing handlers
    root_logger.handlers.clear()
    
    # Console handler with human-readable format
    console_handler = logging.StreamHandler(sys.stdout)
    console_handler.setLevel(level)
    console_handler.setFormatter(ConsoleFormatter())
    root_logger.addHandler(console_handler)
    
    # File handler with JSON format
    log_file = log_dir / f"strands-{datetime.utcnow().strftime('%Y%m%d')}.jsonl"
    file_handler = logging.FileHandler(log_file)
    file_handler.setLevel(logging.DEBUG)  # Always log debug to file
    file_handler.setFormatter(JSONFormatter())
    root_logger.addHandler(file_handler)
    
    # Reduce noise from boto3 and other libraries
    logging.getLogger('boto3').setLevel(logging.WARNING)
    logging.getLogger('botocore').setLevel(logging.WARNING)
    logging.getLogger('urllib3').setLevel(logging.WARNING)


def get_logger(name: str) -> logging.Logger:
    """Get a logger instance.
    
    Args:
        name: Name of the logger (typically __name__)
        
    Returns:
        Configured logger instance
    """
    return logging.getLogger(name)


class LogContext:
    """Context manager for adding structured fields to logs."""
    
    def __init__(self, logger: logging.Logger, **kwargs: Any):
        """Initialize log context.
        
        Args:
            logger: Logger to add context to
            **kwargs: Key-value pairs to add to log records
        """
        self.logger = logger
        self.context = kwargs
        self.old_factory = None
    
    def __enter__(self):
        """Enter context and add fields to logger."""
        old_factory = logging.getLogRecordFactory()
        
        def record_factory(*args, **kwargs):
            record = old_factory(*args, **kwargs)
            for key, value in self.context.items():
                setattr(record, key, value)
            return record
        
        self.old_factory = old_factory
        logging.setLogRecordFactory(record_factory)
        return self
    
    def __exit__(self, exc_type, exc_val, exc_tb):
        """Exit context and restore original factory."""
        if self.old_factory:
            logging.setLogRecordFactory(self.old_factory)
