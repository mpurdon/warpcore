"""AWS client management and session handling."""

import boto3
from typing import Optional
from strands_deploy.utils.logging import get_logger

logger = get_logger(__name__)


class AWSClientManager:
    """Manages boto3 sessions and clients."""
    
    def __init__(self, profile: Optional[str] = None, region: Optional[str] = None):
        """Initialize AWS client manager.
        
        Args:
            profile: AWS profile name to use
            region: AWS region to use
        """
        self.profile = profile
        self.region = region
        self._session: Optional[boto3.Session] = None
    
    @property
    def session(self) -> boto3.Session:
        """Get or create boto3 session.
        
        Returns:
            Configured boto3 session
        """
        if self._session is None:
            kwargs = {}
            if self.profile:
                kwargs['profile_name'] = self.profile
            if self.region:
                kwargs['region_name'] = self.region
            
            self._session = boto3.Session(**kwargs)
            logger.info(f"Created AWS session - Region: {self._session.region_name}")
        
        return self._session
    
    def get_client(self, service_name: str):
        """Get boto3 client for a service.
        
        Args:
            service_name: AWS service name (e.g., 'lambda', 'iam')
            
        Returns:
            Boto3 client for the service
        """
        return self.session.client(service_name)
    
    def validate_credentials(self) -> bool:
        """Validate AWS credentials.
        
        Returns:
            True if credentials are valid, False otherwise
        """
        try:
            sts = self.get_client('sts')
            identity = sts.get_caller_identity()
            logger.info(f"AWS credentials validated - Account: {identity['Account']}, "
                       f"User: {identity['Arn']}")
            return True
        except Exception as e:
            logger.error(f"Failed to validate AWS credentials: {e}")
            return False
