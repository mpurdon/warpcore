"""Local development server for running agents locally with AWS connectivity."""

import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Dict, List, Optional, Any
import signal
import json

from watchdog.observers import Observer
from watchdog.events import FileSystemEventHandler, FileSystemEvent

from ..config.models import AgentConfig
from ..state.models import State, Resource
from ..utils.logging import get_logger

logger = get_logger(__name__)


class AgentCodeChangeHandler(FileSystemEventHandler):
    """File system event handler for agent code changes."""

    def __init__(self, agent_name: str, callback):
        """
        Initialize handler.

        Args:
            agent_name: Name of the agent
            callback: Function to call when code changes are detected
        """
        self.agent_name = agent_name
        self.callback = callback
        self.last_reload_time = 0
        self.debounce_seconds = 1.0  # Debounce rapid file changes

    def on_modified(self, event: FileSystemEvent):
        """Handle file modification events."""
        if event.is_directory:
            return

        # Filter for Python files
        if not event.src_path.endswith('.py'):
            return

        # Debounce rapid changes
        current_time = time.time()
        if current_time - self.last_reload_time < self.debounce_seconds:
            return

        self.last_reload_time = current_time
        logger.info(f"Code change detected in {event.src_path}")
        self.callback()

    def on_created(self, event: FileSystemEvent):
        """Handle file creation events."""
        if event.is_directory:
            return

        if event.src_path.endswith('.py'):
            logger.info(f"New file created: {event.src_path}")
            self.callback()


class LocalDevServer:
    """Local development server for running agents with hot-reload and AWS connectivity."""

    def __init__(self, agent_config: AgentConfig, state: State, aws_profile: Optional[str] = None):
        """
        Initialize LocalDevServer.

        Args:
            agent_config: Agent configuration
            state: Deployment state containing AWS resource information
            aws_profile: Optional AWS profile to use for credentials
        """
        self.agent_config = agent_config
        self.state = state
        self.aws_profile = aws_profile
        self.agent_process: Optional[subprocess.Popen] = None
        self.observer: Optional[Observer] = None
        self.is_running = False

    def start(self) -> None:
        """Start the local development server."""
        logger.info(f"Starting local development server for agent: {self.agent_config.name}")

        # Validate agent path exists
        agent_path = Path(self.agent_config.path)
        if not agent_path.exists():
            raise ValueError(f"Agent path does not exist: {agent_path}")

        # Start file watcher
        self._start_file_watcher()

        # Start agent process
        self._start_agent_process()

        self.is_running = True
        logger.info(f"Local development server started for {self.agent_config.name}")
        logger.info(f"Watching for code changes in: {agent_path}")

    def stop(self) -> None:
        """Stop the local development server."""
        logger.info(f"Stopping local development server for agent: {self.agent_config.name}")

        self.is_running = False

        # Stop file watcher
        if self.observer:
            self.observer.stop()
            self.observer.join()
            self.observer = None

        # Stop agent process
        self._stop_agent_process()

        logger.info(f"Local development server stopped for {self.agent_config.name}")

    def reload(self) -> None:
        """Reload the agent by restarting the process."""
        logger.info(f"Reloading agent: {self.agent_config.name}")
        self._stop_agent_process()
        time.sleep(0.5)  # Brief pause before restart
        self._start_agent_process()
        logger.info(f"Agent reloaded: {self.agent_config.name}")

    def _start_file_watcher(self) -> None:
        """Start file system watcher for code changes."""
        agent_path = Path(self.agent_config.path).resolve()

        # Create event handler with reload callback
        event_handler = AgentCodeChangeHandler(
            agent_name=self.agent_config.name,
            callback=self.reload
        )

        # Create and start observer
        self.observer = Observer()
        self.observer.schedule(event_handler, str(agent_path), recursive=True)
        self.observer.start()

        logger.debug(f"File watcher started for: {agent_path}")

    def _start_agent_process(self) -> None:
        """Start the agent process with injected environment variables."""
        agent_path = Path(self.agent_config.path).resolve()

        # Build environment variables
        env = self._build_environment()

        # Determine the command to run
        # For Python agents, we'll run the handler module
        handler_parts = self.agent_config.handler.split('.')
        if len(handler_parts) != 2:
            raise ValueError(f"Invalid handler format: {self.agent_config.handler}. Expected 'module.function'")

        module_name, function_name = handler_parts

        # Create a simple runner script
        runner_script = f"""
import sys
import os
import json
from pathlib import Path

# Add agent path to sys.path
sys.path.insert(0, str(Path('{agent_path}')))

# Import the handler
try:
    from {module_name} import {function_name}
except ImportError as e:
    print(f"Error importing handler: {{e}}", file=sys.stderr)
    sys.exit(1)

# Simple local development loop
print("Agent running in local development mode...")
print("Press Ctrl+C to stop")
print()

# For now, just keep the process alive
# In a real implementation, this would set up a local HTTP server
# or event loop to handle requests
try:
    import time
    while True:
        time.sleep(1)
except KeyboardInterrupt:
    print("\\nShutting down...")
"""

        # Start the process
        try:
            self.agent_process = subprocess.Popen(
                [sys.executable, '-c', runner_script],
                env=env,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                bufsize=1,  # Line buffered
                cwd=str(agent_path)
            )

            logger.info(f"Agent process started with PID: {self.agent_process.pid}")

            # Start threads to read stdout/stderr
            import threading

            def read_output(pipe, prefix):
                """Read and log output from subprocess."""
                try:
                    for line in pipe:
                        line = line.rstrip()
                        if line:
                            logger.info(f"[{self.agent_config.name}] {line}")
                except Exception as e:
                    logger.error(f"Error reading {prefix}: {e}")

            stdout_thread = threading.Thread(
                target=read_output,
                args=(self.agent_process.stdout, "stdout"),
                daemon=True
            )
            stderr_thread = threading.Thread(
                target=read_output,
                args=(self.agent_process.stderr, "stderr"),
                daemon=True
            )

            stdout_thread.start()
            stderr_thread.start()

        except Exception as e:
            logger.error(f"Failed to start agent process: {e}")
            raise

    def _stop_agent_process(self) -> None:
        """Stop the agent process gracefully."""
        if self.agent_process is None:
            return

        try:
            logger.debug(f"Stopping agent process (PID: {self.agent_process.pid})")

            # Try graceful shutdown first
            self.agent_process.terminate()

            # Wait up to 5 seconds for graceful shutdown
            try:
                self.agent_process.wait(timeout=5)
                logger.debug("Agent process terminated gracefully")
            except subprocess.TimeoutExpired:
                # Force kill if graceful shutdown fails
                logger.warning("Agent process did not terminate gracefully, forcing kill")
                self.agent_process.kill()
                self.agent_process.wait()

        except Exception as e:
            logger.error(f"Error stopping agent process: {e}")
        finally:
            self.agent_process = None

    def _build_environment(self) -> Dict[str, str]:
        """
        Build environment variables for the agent process.

        Injects AWS resource ARNs and configuration from deployed state.

        Returns:
            Dictionary of environment variables
        """
        # Start with current environment
        env = os.environ.copy()

        # Add AWS profile if specified
        if self.aws_profile:
            env['AWS_PROFILE'] = self.aws_profile

        # Add AWS region from state
        env['AWS_REGION'] = self.state.region
        env['AWS_DEFAULT_REGION'] = self.state.region

        # Add agent-specific environment variables from config
        env.update(self.agent_config.environment)

        # Inject AWS resource information from state
        resource_env = self._extract_resource_environment()
        env.update(resource_env)

        # Add development mode flag
        env['STRANDS_DEV_MODE'] = 'true'
        env['STRANDS_AGENT_NAME'] = self.agent_config.name

        return env

    def _extract_resource_environment(self) -> Dict[str, str]:
        """
        Extract AWS resource information from state and create environment variables.

        Returns:
            Dictionary of environment variables with AWS resource information
        """
        env = {}

        # Find the agent's stack
        agent_stack_name = self.agent_config.name
        stack = self.state.get_stack(agent_stack_name)

        if not stack:
            logger.warning(f"No stack found for agent: {agent_stack_name}")
            return env

        # Extract resource ARNs and endpoints
        for resource_id, resource in stack.resources.items():
            # Create environment variable name from resource ID
            env_var_name = f"STRANDS_{resource_id.upper().replace('-', '_')}"

            # Add physical ID (usually ARN)
            if resource.physical_id:
                env[env_var_name] = resource.physical_id

            # Add resource-specific properties
            if resource.type == 'AWS::DynamoDB::Table':
                table_name = resource.properties.get('TableName')
                if table_name:
                    env[f"{env_var_name}_NAME"] = table_name

            elif resource.type == 'AWS::S3::Bucket':
                bucket_name = resource.properties.get('BucketName')
                if bucket_name:
                    env[f"{env_var_name}_NAME"] = bucket_name

            elif resource.type == 'AWS::SQS::Queue':
                queue_url = resource.properties.get('QueueUrl')
                if queue_url:
                    env[f"{env_var_name}_URL"] = queue_url

            elif resource.type == 'AWS::SNS::Topic':
                topic_arn = resource.physical_id
                if topic_arn:
                    env[f"{env_var_name}_ARN"] = topic_arn

            elif resource.type == 'AWS::ApiGatewayV2::Api':
                api_endpoint = resource.properties.get('ApiEndpoint')
                if api_endpoint:
                    env[f"{env_var_name}_ENDPOINT"] = api_endpoint

        # Also check shared infrastructure stack
        shared_stack = self.state.get_stack('shared-infrastructure')
        if shared_stack:
            for resource_id, resource in shared_stack.resources.items():
                env_var_name = f"STRANDS_SHARED_{resource_id.upper().replace('-', '_')}"

                if resource.physical_id:
                    env[env_var_name] = resource.physical_id

        return env

    def get_status(self) -> Dict[str, Any]:
        """
        Get the current status of the local development server.

        Returns:
            Dictionary with status information
        """
        status = {
            'agent_name': self.agent_config.name,
            'is_running': self.is_running,
            'agent_path': str(self.agent_config.path),
            'process_id': self.agent_process.pid if self.agent_process else None,
            'watching': self.observer is not None,
        }

        # Check if process is actually running
        if self.agent_process:
            poll_result = self.agent_process.poll()
            status['process_alive'] = poll_result is None
            if poll_result is not None:
                status['exit_code'] = poll_result

        return status

    def __enter__(self):
        """Context manager entry."""
        self.start()
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        """Context manager exit."""
        self.stop()
