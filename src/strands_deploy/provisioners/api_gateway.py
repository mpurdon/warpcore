"""API Gateway provisioner for HTTP APIs with Lambda integration."""

from typing import Optional, List, Dict, Any
from botocore.exceptions import ClientError

from .base import BaseProvisioner, Resource, ProvisionPlan, ChangeType


class APIGatewayProvisioner(BaseProvisioner):
    """Provisioner for API Gateway HTTP APIs."""

    def __init__(self, boto_session):
        """Initialize API Gateway provisioner.
        
        Args:
            boto_session: Configured boto3 session
        """
        super().__init__(boto_session)
        self.apigatewayv2_client = boto_session.client('apigatewayv2')
        self.lambda_client = boto_session.client('lambda')

    def plan(self, desired: Resource, current: Optional[Resource]) -> ProvisionPlan:
        """Determine what changes are needed for the API Gateway.
        
        Args:
            desired: Desired API Gateway state
            current: Current API Gateway state (None if doesn't exist)
            
        Returns:
            ProvisionPlan with change type
        """
        if current is None:
            return ProvisionPlan(
                resource=desired,
                change_type=ChangeType.CREATE,
                current_state=None
            )
        
        if self._needs_update(desired, current):
            return ProvisionPlan(
                resource=desired,
                change_type=ChangeType.UPDATE,
                current_state=current
            )
        
        return ProvisionPlan(
            resource=desired,
            change_type=ChangeType.NO_CHANGE,
            current_state=current
        )

    def provision(self, plan: ProvisionPlan) -> Resource:
        """Execute the API Gateway provisioning plan.
        
        Args:
            plan: Provisioning plan to execute
            
        Returns:
            Resource with physical_id set to API ID
        """
        if plan.change_type == ChangeType.CREATE:
            return self._create_api(plan.resource)
        elif plan.change_type == ChangeType.UPDATE:
            return self._update_api(plan.resource)
        else:
            return plan.resource

    def destroy(self, resource: Resource) -> None:
        """Destroy the API Gateway.
        
        Args:
            resource: API Gateway resource to destroy
        """
        api_id = resource.physical_id
        if not api_id:
            return
        
        try:
            # Remove Lambda permissions first
            integration_ids = resource.properties.get('IntegrationIds', [])
            for integration_id in integration_ids:
                # Lambda permissions are automatically cleaned up
                pass
            
            # Delete the API
            self.apigatewayv2_client.delete_api(ApiId=api_id)
            
        except ClientError as e:
            if e.response['Error']['Code'] != 'NotFoundException':
                raise

    def get_current_state(self, resource_id: str) -> Optional[Resource]:
        """Fetch current API Gateway state from AWS.
        
        Args:
            resource_id: Logical resource ID
            
        Returns:
            Current resource state or None if doesn't exist
        """
        try:
            # Find API by tag
            apis_response = self.apigatewayv2_client.get_apis()
            
            for api in apis_response.get('Items', []):
                api_id = api['ApiId']
                tags = api.get('Tags', {})
                
                if tags.get('strands:resource-id') == resource_id:
                    # Get routes
                    routes_response = self.apigatewayv2_client.get_routes(ApiId=api_id)
                    routes = routes_response.get('Items', [])
                    
                    # Get integrations
                    integrations_response = self.apigatewayv2_client.get_integrations(ApiId=api_id)
                    integrations = integrations_response.get('Items', [])
                    
                    # Get stages
                    stages_response = self.apigatewayv2_client.get_stages(ApiId=api_id)
                    stages = stages_response.get('Items', [])
                    
                    return Resource(
                        id=resource_id,
                        type='AWS::ApiGatewayV2::Api',
                        physical_id=api_id,
                        properties={
                            'Name': api['Name'],
                            'ProtocolType': api['ProtocolType'],
                            'ApiEndpoint': api.get('ApiEndpoint'),
                            'CorsConfiguration': api.get('CorsConfiguration'),
                            'Routes': routes,
                            'Integrations': integrations,
                            'IntegrationIds': [i['IntegrationId'] for i in integrations],
                            'Stages': stages,
                        },
                        dependencies=[],
                        tags=tags
                    )
            
            return None
            
        except ClientError:
            return None

    def _create_api(self, resource: Resource) -> Resource:
        """Create a new API Gateway HTTP API.
        
        Args:
            resource: Resource definition
            
        Returns:
            Resource with physical_id set
        """
        api_name = resource.properties['Name']
        
        # Create API
        create_params = {
            'Name': api_name,
            'ProtocolType': 'HTTP',
        }
        
        # Add CORS configuration
        cors_config = resource.properties.get('CorsConfiguration')
        if cors_config:
            create_params['CorsConfiguration'] = cors_config
        
        # Add tags
        if resource.tags:
            create_params['Tags'] = {
                **resource.tags,
                'strands:resource-id': resource.id
            }
        
        response = self.apigatewayv2_client.create_api(**create_params)
        api_id = response['ApiId']
        api_endpoint = response['ApiEndpoint']
        
        # Create integrations and routes
        integration_ids = []
        routes = resource.properties.get('Routes', [])
        
        for route_config in routes:
            # Create integration
            integration_id = self._create_integration(api_id, route_config)
            integration_ids.append(integration_id)
            
            # Create route
            self._create_route(api_id, route_config, integration_id)
        
        # Create default stage
        stage_name = resource.properties.get('StageName', '$default')
        self.apigatewayv2_client.create_stage(
            ApiId=api_id,
            StageName=stage_name,
            AutoDeploy=True
        )
        
        # Update resource
        resource.physical_id = api_id
        resource.properties['ApiEndpoint'] = api_endpoint
        resource.properties['IntegrationIds'] = integration_ids
        
        return resource

    def _update_api(self, resource: Resource) -> Resource:
        """Update an existing API Gateway.
        
        Args:
            resource: Resource definition with updates
            
        Returns:
            Updated resource
        """
        api_id = resource.physical_id
        
        # Update API configuration
        update_params = {}
        
        if 'Name' in resource.properties:
            update_params['Name'] = resource.properties['Name']
        
        if 'CorsConfiguration' in resource.properties:
            update_params['CorsConfiguration'] = resource.properties['CorsConfiguration']
        
        if update_params:
            self.apigatewayv2_client.update_api(ApiId=api_id, **update_params)
        
        # Update routes (simplified - full implementation would diff routes)
        # For now, we'll recreate routes if they changed
        
        # Update tags
        if resource.tags:
            self.apigatewayv2_client.tag_resource(
                ResourceArn=f"arn:aws:apigateway:{self.session.region_name}::/apis/{api_id}",
                Tags=resource.tags
            )
        
        return resource

    def _needs_update(self, desired: Resource, current: Resource) -> bool:
        """Check if API Gateway needs updates.
        
        Args:
            desired: Desired state
            current: Current state
            
        Returns:
            True if updates are needed
        """
        # Compare basic properties
        if desired.properties.get('Name') != current.properties.get('Name'):
            return True
        
        if desired.properties.get('CorsConfiguration') != current.properties.get('CorsConfiguration'):
            return True
        
        # Compare routes (simplified)
        desired_routes = desired.properties.get('Routes', [])
        current_routes = current.properties.get('Routes', [])
        if len(desired_routes) != len(current_routes):
            return True
        
        # Compare tags
        if desired.tags != current.tags:
            return True
        
        return False

    def _create_integration(self, api_id: str, route_config: Dict[str, Any]) -> str:
        """Create an integration for a route.
        
        Args:
            api_id: API Gateway ID
            route_config: Route configuration
            
        Returns:
            Integration ID
        """
        integration_type = route_config.get('IntegrationType', 'AWS_PROXY')
        integration_uri = route_config['IntegrationUri']
        
        # Create integration
        response = self.apigatewayv2_client.create_integration(
            ApiId=api_id,
            IntegrationType=integration_type,
            IntegrationUri=integration_uri,
            PayloadFormatVersion='2.0',
            TimeoutInMillis=route_config.get('TimeoutInMillis', 30000)
        )
        
        integration_id = response['IntegrationId']
        
        # Add Lambda permission if it's a Lambda integration
        if integration_uri.startswith('arn:aws:lambda:'):
            self._add_lambda_permission(api_id, integration_uri)
        
        return integration_id

    def _create_route(self, api_id: str, route_config: Dict[str, Any], integration_id: str) -> str:
        """Create a route.
        
        Args:
            api_id: API Gateway ID
            route_config: Route configuration
            integration_id: Integration ID
            
        Returns:
            Route ID
        """
        route_key = route_config['RouteKey']
        
        response = self.apigatewayv2_client.create_route(
            ApiId=api_id,
            RouteKey=route_key,
            Target=f"integrations/{integration_id}"
        )
        
        return response['RouteId']

    def _add_lambda_permission(self, api_id: str, lambda_arn: str) -> None:
        """Add permission for API Gateway to invoke Lambda function.
        
        Args:
            api_id: API Gateway ID
            lambda_arn: Lambda function ARN
        """
        # Extract function name from ARN
        function_name = lambda_arn.split(':')[-1]
        
        # Create statement ID
        statement_id = f"apigateway-{api_id}"
        
        try:
            self.lambda_client.add_permission(
                FunctionName=function_name,
                StatementId=statement_id,
                Action='lambda:InvokeFunction',
                Principal='apigateway.amazonaws.com',
                SourceArn=f"arn:aws:execute-api:{self.session.region_name}:*:{api_id}/*"
            )
        except ClientError as e:
            # Permission might already exist
            if e.response['Error']['Code'] != 'ResourceConflictException':
                raise

    @staticmethod
    def build_cors_configuration(
        allow_origins: List[str] = None,
        allow_methods: List[str] = None,
        allow_headers: List[str] = None,
        max_age: int = 300
    ) -> Dict[str, Any]:
        """Build CORS configuration for API Gateway.
        
        Args:
            allow_origins: List of allowed origins (default: ['*'])
            allow_methods: List of allowed methods (default: ['*'])
            allow_headers: List of allowed headers (default: ['*'])
            max_age: Max age for preflight cache in seconds
            
        Returns:
            CORS configuration dictionary
        """
        if allow_origins is None:
            allow_origins = ['*']
        if allow_methods is None:
            allow_methods = ['*']
        if allow_headers is None:
            allow_headers = ['*']
        
        return {
            'AllowOrigins': allow_origins,
            'AllowMethods': allow_methods,
            'AllowHeaders': allow_headers,
            'MaxAge': max_age
        }

    @staticmethod
    def build_route(
        route_key: str,
        lambda_arn: str,
        timeout_ms: int = 30000
    ) -> Dict[str, Any]:
        """Build a route configuration for Lambda integration.
        
        Args:
            route_key: Route key (e.g., 'GET /users', 'POST /items')
            lambda_arn: Lambda function ARN
            timeout_ms: Integration timeout in milliseconds
            
        Returns:
            Route configuration dictionary
        """
        return {
            'RouteKey': route_key,
            'IntegrationType': 'AWS_PROXY',
            'IntegrationUri': lambda_arn,
            'TimeoutInMillis': timeout_ms
        }

    @staticmethod
    def build_catch_all_route(lambda_arn: str) -> Dict[str, Any]:
        """Build a catch-all route that forwards all requests to Lambda.
        
        Args:
            lambda_arn: Lambda function ARN
            
        Returns:
            Route configuration dictionary
        """
        return APIGatewayProvisioner.build_route(
            route_key='$default',
            lambda_arn=lambda_arn
        )

    @staticmethod
    def build_rest_api_routes(lambda_arn: str, base_path: str = '') -> List[Dict[str, Any]]:
        """Build standard REST API routes for a resource.
        
        Args:
            lambda_arn: Lambda function ARN
            base_path: Base path for routes (e.g., '/users')
            
        Returns:
            List of route configurations
        """
        if base_path and not base_path.startswith('/'):
            base_path = f'/{base_path}'
        
        return [
            APIGatewayProvisioner.build_route(f'GET {base_path}', lambda_arn),
            APIGatewayProvisioner.build_route(f'POST {base_path}', lambda_arn),
            APIGatewayProvisioner.build_route(f'GET {base_path}/{{id}}', lambda_arn),
            APIGatewayProvisioner.build_route(f'PUT {base_path}/{{id}}', lambda_arn),
            APIGatewayProvisioner.build_route(f'DELETE {base_path}/{{id}}', lambda_arn),
        ]
