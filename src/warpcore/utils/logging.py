"""Logging infrastructure with structured JSON logging."""

import logging
import json
import os
import sys
from datetime import datetime
from pathlib import Path
from typing import Any, Optional


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
    
    log_dir = _resolve_log_dir()

    # Setup root logger
    root_logger = logging.getLogger()
    root_logger.setLevel(level)
    
    # Remove existing handlers
    root_logger.handlers.clear()
    
    # Console handler with human-readable format.
    # Diagnostics go to stderr so that stdout stays clean for machine-readable
    # output - `warpcore discover inventory --json | jq` has to work.
    console_handler = logging.StreamHandler(sys.stderr)
    console_handler.setLevel(level)
    console_handler.setFormatter(ConsoleFormatter())
    root_logger.addHandler(console_handler)
    
    # File handler with JSON format. Skipped entirely if no writable
    # location exists - a log file is never worth failing the command for.
    if log_dir is not None:
        log_file = log_dir / f"warpcore-{datetime.utcnow().strftime('%Y%m%d')}.jsonl"
        try:
            file_handler = logging.FileHandler(log_file)
        except OSError:
            file_handler = None
        if file_handler is not None:
            file_handler.setLevel(logging.DEBUG)  # Always log debug to file
            file_handler.setFormatter(JSONFormatter())
            root_logger.addHandler(file_handler)
    
    # Reduce noise from boto3 and other libraries
    logging.getLogger('boto3').setLevel(logging.WARNING)
    logging.getLogger('botocore').setLevel(logging.WARNING)
    logging.getLogger('urllib3').setLevel(logging.WARNING)


def _resolve_log_dir() -> Optional[Path]:
    """Somewhere writable for the JSONL log, or None.

    Prefers the project-local `.warpcore/logs` so logs sit next to the state
    they describe. That is relative to the working directory, which is wrong
    when the process was spawned by the desktop app - the CWD is `/` or the
    app bundle, both read-only - so fall back to the user's home. Every
    failure mode here used to raise and abort the command before it started.
    """
    candidates = [
        Path.cwd() / ".warpcore" / "logs",
        Path.home() / ".warpcore" / "logs",
    ]
    for candidate in candidates:
        try:
            candidate.mkdir(parents=True, exist_ok=True)
            if os.access(candidate, os.W_OK):
                return candidate
        except OSError:
            continue
    return None


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
