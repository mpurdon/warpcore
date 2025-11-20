"""AWS client management and session handling."""

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError, NoCredentialsError, PartialCredentialsError
from typing import Optional, Dict, Any
from dataclasses import dataclass
from strands_deploy.utils.logging import get_logger

logger = get_logger(__name__)


@dataclass
class AWSCredentials:
    """AWS credential information."""
    account_id: str
    user_arn: str
    user_id: str
    region: str
    profile: Optional[str] = None


@dataclass
class AssumeRoleConfig:
    """Configuration for IAM role assumption."""
    role_arn: str
    session_name: str
    external_id: Optional[str] = None
    duration_seconds: int = 3600
    mfa_serial: Optional[str] = None
    mfa_token: Optional[str] = None


class AWSClientManager:
    """Manages boto3 sessions and clients with credential management."""
    
    def __init__(
        self,
        profile: Optional[str] = None,
        region: Optional[str] = None,
        assume_role_config: Optional[AssumeRoleConfig] = None,
        max_pool_connections: int = 50
    ):
        """Initialize AWS client manager.
        
        Args:
            profile: AWS profile name to use
            region: AWS region to use
            assume_role_config: Configuration for assuming an IAM role
            max_pool_connections: Maximum number of connections in the connection pool
        """
        self.profile = profile
        self.region = region
        self.assume_role_config = assume_role_config
        self.max_pool_connections = max_pool_connections
        self._session: Optional[boto3.Session] = None
        self._assumed_session: Optional[boto3.Session] = None
        self._clients: Dict[str, Any] = {}
        self._credentials: Optional[AWSCredentials] = None
        
        # Configure boto3 with connection pooling and retry strategy
        self._boto_config = Config(
            max_pool_connections=max_pool_connections,
            retries={
                'mode': 'adaptive',  # Use adaptive retry mode for better handling
                'max_attempts': 5
            },
            connect_timeout=10,
            read_timeout=60
        )
    
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
            logger.info(f"Created AWS session - Region: {self._session.region_name}, "
                       f"Profile: {self.profile or 'default'}")
        
        return self._session
    
    def get_client(self, service_name: str, use_assumed_role: bool = True):
        """Get boto3 client for a service with connection pooling.
        
        Args:
            service_name: AWS service name (e.g., 'lambda', 'iam')
            use_assumed_role: Whether to use assumed role credentials if available
            
        Returns:
            Boto3 client for the service
        """
        # Create cache key
        cache_key = f"{service_name}:{'assumed' if use_assumed_role and self._assumed_session else 'base'}"
        
        # Return cached client if available
        if cache_key in self._clients:
            return self._clients[cache_key]
        
        # Determine which session to use
        session = self._assumed_session if (use_assumed_role and self._assumed_session) else self.session
        
        # Create new client with connection pooling config
        client = session.client(service_name, config=self._boto_config)
        
        # Cache the client
        self._clients[cache_key] = client
        
        logger.debug(f"Created {service_name} client (cached: {cache_key})")
        
        return client
    
    def validate_credentials(self) -> AWSCredentials:
        """Validate AWS credentials and return credential information.
        
        Returns:
            AWSCredentials object with account and user information
            
        Raises:
            NoCredentialsError: If no credentials are found
            PartialCredentialsError: If credentials are incomplete
            ClientError: If credentials are invalid
        """
        if self._credentials is not None:
            return self._credentials
        
        try:
            sts = self.get_client('sts', use_assumed_role=False)
            identity = sts.get_caller_identity()
            
            self._credentials = AWSCredentials(
                account_id=identity['Account'],
                user_arn=identity['Arn'],
                user_id=identity['UserId'],
                region=self.session.region_name,
                profile=self.profile
            )
            
            logger.info(f"AWS credentials validated - Account: {self._credentials.account_id}, "
                       f"User: {self._credentials.user_arn}, Region: {self._credentials.region}")
            
            return self._credentials
            
        except NoCredentialsError as e:
            logger.error("No AWS credentials found. Please configure credentials using "
                        "AWS CLI, environment variables, or IAM role.")
            raise
        except PartialCredentialsError as e:
            logger.error(f"Incomplete AWS credentials: {e}")
            raise
        except ClientError as e:
            error_code = e.response.get('Error', {}).get('Code', 'Unknown')
            if error_code == 'InvalidClientTokenId':
                logger.error("AWS credentials are invalid or expired")
            elif error_code == 'SignatureDoesNotMatch':
                logger.error("AWS credential signature is invalid")
            else:
                logger.error(f"Failed to validate AWS credentials: {e}")
            raise
    
    def assume_role(self, config: Optional[AssumeRoleConfig] = None) -> AWSCredentials:
        """Assume an IAM role for cross-account or elevated access.
        
        Args:
            config: Role assumption configuration. If None, uses self.assume_role_config
            
        Returns:
            AWSCredentials object for the assumed role
            
        Raises:
            ValueError: If no assume role configuration is provided
            ClientError: If role assumption fails
        """
        config = config or self.assume_role_config
        
        if config is None:
            raise ValueError("No assume role configuration provided")
        
        logger.info(f"Assuming IAM role: {config.role_arn}")
        
        try:
            sts = self.get_client('sts', use_assumed_role=False)
            
            # Build assume role parameters
            assume_role_params = {
                'RoleArn': config.role_arn,
                'RoleSessionName': config.session_name,
                'DurationSeconds': config.duration_seconds
            }
            
            if config.external_id:
                assume_role_params['ExternalId'] = config.external_id
            
            if config.mfa_serial and config.mfa_token:
                assume_role_params['SerialNumber'] = config.mfa_serial
                assume_role_params['TokenCode'] = config.mfa_token
            
            # Assume the role
            response = sts.assume_role(**assume_role_params)
            credentials = response['Credentials']
            
            # Create new session with assumed role credentials
            self._assumed_session = boto3.Session(
                aws_access_key_id=credentials['AccessKeyId'],
                aws_secret_access_key=credentials['SecretAccessKey'],
                aws_session_token=credentials['SessionToken'],
                region_name=self.region or self.session.region_name
            )
            
            # Clear client cache since we have new credentials
            self._clients.clear()
            
            # Get identity of assumed role
            assumed_sts = self._assumed_session.client('sts', config=self._boto_config)
            identity = assumed_sts.get_caller_identity()
            
            assumed_credentials = AWSCredentials(
                account_id=identity['Account'],
                user_arn=identity['Arn'],
                user_id=identity['UserId'],
                region=self._assumed_session.region_name,
                profile=self.profile
            )
            
            logger.info(f"Successfully assumed role - Account: {assumed_credentials.account_id}, "
                       f"Role: {assumed_credentials.user_arn}")
            
            return assumed_credentials
            
        except ClientError as e:
            error_code = e.response.get('Error', {}).get('Code', 'Unknown')
            error_message = e.response.get('Error', {}).get('Message', str(e))
            
            if error_code == 'AccessDenied':
                logger.error(f"Access denied when assuming role {config.role_arn}. "
                           f"Check that the role exists and your user has sts:AssumeRole permission.")
            elif error_code == 'InvalidClientTokenId':
                logger.error("Base credentials are invalid or expired")
            else:
                logger.error(f"Failed to assume role: {error_message}")
            
            raise
    
    def get_account_id(self) -> str:
        """Get the AWS account ID.
        
        Returns:
            AWS account ID
        """
        credentials = self.validate_credentials()
        return credentials.account_id
    
    def get_region(self) -> str:
        """Get the AWS region.
        
        Returns:
            AWS region name
        """
        return self.session.region_name
    
    def clear_cache(self):
        """Clear cached clients and sessions."""
        self._clients.clear()
        self._session = None
        self._assumed_session = None
        self._credentials = None
        logger.debug("Cleared AWS client cache")
