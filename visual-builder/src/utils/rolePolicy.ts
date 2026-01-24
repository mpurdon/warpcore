import { Edge, Node } from 'reactflow';

export interface PolicyStatement {
  effect: 'Allow' | 'Deny';
  actions: string[];
  resources: string[];
  resourceNodeId: string;
  resourceType: string;
  resourceLabel: string;
}

export interface RolePolicy {
  statements: PolicyStatement[];
}

// Define what permissions each resource type needs based on connection direction
interface ResourcePermissionMap {
  actions: string[];
  arnPattern: string;
}

// Permissions needed when a role grants access TO a resource (agent -> resource)
const targetResourcePermissions: Record<string, ResourcePermissionMap> = {
  's3': {
    actions: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject', 's3:ListBucket'],
    arnPattern: 'arn:aws:s3:::${bucketName}/*',
  },
  'dynamodb': {
    actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem', 'dynamodb:Query', 'dynamodb:Scan'],
    arnPattern: 'arn:aws:dynamodb:${region}:${account}:table/${tableName}',
  },
  'sqs': {
    actions: ['sqs:SendMessage'],
    arnPattern: 'arn:aws:sqs:${region}:${account}:${queueName}',
  },
  'sns': {
    actions: ['sns:Publish'],
    arnPattern: 'arn:aws:sns:${region}:${account}:${topicName}',
  },
  'eventbridge': {
    actions: ['events:PutEvents'],
    arnPattern: 'arn:aws:events:${region}:${account}:event-bus/${busName}',
  },
  'log-group': {
    actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
    arnPattern: 'arn:aws:logs:${region}:${account}:log-group:${logGroupName}:*',
  },
  'agent': {
    actions: ['lambda:InvokeFunction'],
    arnPattern: 'arn:aws:lambda:${region}:${account}:function:${functionName}',
  },
  'lambda': {
    actions: ['lambda:InvokeFunction'],
    arnPattern: 'arn:aws:lambda:${region}:${account}:function:${functionName}',
  },
  'secrets-manager': {
    actions: ['secretsmanager:GetSecretValue', 'secretsmanager:DescribeSecret'],
    arnPattern: 'arn:aws:secretsmanager:${region}:${account}:secret:${secretName}*',
  },
  'ssm-parameter': {
    actions: ['ssm:GetParameter', 'ssm:GetParameters', 'ssm:GetParametersByPath'],
    arnPattern: 'arn:aws:ssm:${region}:${account}:parameter/${parameterName}',
  },
  'step-functions': {
    actions: ['states:StartExecution', 'states:DescribeExecution', 'states:StopExecution'],
    arnPattern: 'arn:aws:states:${region}:${account}:stateMachine:${stateMachineName}',
  },
  'bedrock': {
    actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
    arnPattern: 'arn:aws:bedrock:${region}::foundation-model/${modelId}',
  },
  'cloudwatch-alarm': {
    actions: ['cloudwatch:DescribeAlarms', 'cloudwatch:PutMetricAlarm', 'cloudwatch:DeleteAlarms'],
    arnPattern: 'arn:aws:cloudwatch:${region}:${account}:alarm:${alarmName}',
  },
  'kinesis-stream': {
    actions: ['kinesis:PutRecord', 'kinesis:PutRecords', 'kinesis:DescribeStream'],
    arnPattern: 'arn:aws:kinesis:${region}:${account}:stream/${streamName}',
  },
  'kinesis-firehose': {
    actions: ['firehose:PutRecord', 'firehose:PutRecordBatch', 'firehose:DescribeDeliveryStream'],
    arnPattern: 'arn:aws:firehose:${region}:${account}:deliverystream/${deliveryStreamName}',
  },
  'ecr': {
    actions: ['ecr:GetDownloadUrlForLayer', 'ecr:BatchGetImage', 'ecr:BatchCheckLayerAvailability'],
    arnPattern: 'arn:aws:ecr:${region}:${account}:repository/${repositoryName}',
  },
  'cloudwatch-dashboard': {
    actions: ['cloudwatch:GetDashboard', 'cloudwatch:PutDashboard', 'cloudwatch:DeleteDashboards'],
    arnPattern: 'arn:aws:cloudwatch::${account}:dashboard/${dashboardName}',
  },
};

// Permissions needed when a resource triggers an agent (resource -> agent)
// The agent needs these permissions to read FROM the source resource
const sourceResourcePermissions: Record<string, ResourcePermissionMap> = {
  'sqs': {
    actions: ['sqs:ReceiveMessage', 'sqs:DeleteMessage', 'sqs:GetQueueAttributes'],
    arnPattern: 'arn:aws:sqs:${region}:${account}:${queueName}',
  },
  'dynamodb': {
    // DynamoDB Streams trigger - agent needs to read from the stream
    actions: ['dynamodb:GetRecords', 'dynamodb:GetShardIterator', 'dynamodb:DescribeStream', 'dynamodb:ListStreams'],
    arnPattern: 'arn:aws:dynamodb:${region}:${account}:table/${tableName}/stream/*',
  },
  'kinesis-stream': {
    // Lambda/Agent reading from Kinesis Data Stream (event source mapping)
    actions: ['kinesis:GetRecords', 'kinesis:GetShardIterator', 'kinesis:DescribeStream', 'kinesis:DescribeStreamSummary', 'kinesis:ListShards', 'kinesis:ListStreams'],
    arnPattern: 'arn:aws:kinesis:${region}:${account}:stream/${streamName}',
  },
};

// VPC permissions needed when an agent runs in a VPC
export const vpcPermissions: ResourcePermissionMap = {
  actions: [
    'ec2:CreateNetworkInterface',
    'ec2:DescribeNetworkInterfaces',
    'ec2:DeleteNetworkInterface',
    'ec2:AssignPrivateIpAddresses',
    'ec2:UnassignPrivateIpAddresses',
  ],
  arnPattern: '*', // VPC permissions typically use * for resource
};

// Permissions for EventBridge rules to invoke targets
const eventBridgeRuleTargetPermissions: Record<string, ResourcePermissionMap> = {
  'sqs': {
    actions: ['sqs:SendMessage'],
    arnPattern: 'arn:aws:sqs:${region}:${account}:${queueName}',
  },
  'sns': {
    actions: ['sns:Publish'],
    arnPattern: 'arn:aws:sns:${region}:${account}:${topicName}',
  },
  'step-functions': {
    actions: ['states:StartExecution'],
    arnPattern: 'arn:aws:states:${region}:${account}:stateMachine:${stateMachineName}',
  },
  'kinesis-stream': {
    actions: ['kinesis:PutRecord', 'kinesis:PutRecords'],
    arnPattern: 'arn:aws:kinesis:${region}:${account}:stream/${streamName}',
  },
  'kinesis-firehose': {
    actions: ['firehose:PutRecord', 'firehose:PutRecordBatch'],
    arnPattern: 'arn:aws:firehose:${region}:${account}:deliverystream/${deliveryStreamName}',
  },
  'log-group': {
    actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
    arnPattern: 'arn:aws:logs:${region}:${account}:log-group:${logGroupName}:*',
  },
  'api-gateway': {
    actions: ['execute-api:Invoke'],
    arnPattern: 'arn:aws:execute-api:${region}:${account}:${apiId}/*',
  },
  'eventbridge': {
    actions: ['events:PutEvents'],
    arnPattern: 'arn:aws:events:${region}:${account}:event-bus/${busName}',
  },
};

// Resources that can assume roles (principals)
export const roleAssumableSources = ['agent', 'lambda', 'api-gateway', 'eventbridge', 'eventbridge-rule', 'eventbridge-pipes', 'kinesis-firehose'];

// Connections that use resource-based policies instead of IAM roles
export const resourceBasedConnections: Array<[string, string]> = [
  ['api-gateway', 'agent'],      // API Gateway → Lambda uses resource policy
  ['api-gateway', 'lambda'],     // API Gateway → Lambda uses resource policy
  ['api-gateway', 'api-route'],  // API Gateway → Route is parent-child (no permissions needed)
  ['api-route', 'agent'],        // API Route → Lambda uses resource policy
  ['api-route', 'lambda'],       // API Route → Lambda uses resource policy
  ['eventbridge-rule', 'agent'], // EventBridge → Lambda uses resource policy
  ['eventbridge-rule', 'lambda'], // EventBridge → Lambda uses resource policy
  ['sns', 'agent'],              // SNS → Lambda uses resource policy
  ['sns', 'lambda'],             // SNS → Lambda uses resource policy
  ['sns', 'sqs'],                // SNS → SQS uses resource policy
  ['s3', 'agent'],               // S3 event notifications → Lambda uses resource policy
  ['s3', 'lambda'],              // S3 event notifications → Lambda uses resource policy
];

/**
 * Check if a connection uses resource-based policy (no role needed)
 */
export function isResourceBasedConnection(sourceType: string, targetType: string): boolean {
  return resourceBasedConnections.some(
    ([s, t]) => s === sourceType && t === targetType
  );
}

/**
 * Check if a source type can assume a role
 */
export function canAssumeRole(sourceType: string): boolean {
  return roleAssumableSources.includes(sourceType);
}

/**
 * Get the permissions needed for a resource type
 */
export function getResourcePermissions(resourceType: string): ResourcePermissionMap | undefined {
  return targetResourcePermissions[resourceType];
}

/**
 * Get filtered actions based on connection config and direction
 */
function getFilteredActions(resourceType: string, config: any, direction: 'source' | 'target'): string[] {
  const permissionsMap = direction === 'source' ? sourceResourcePermissions : targetResourcePermissions;
  const allPermissions = permissionsMap[resourceType];
  if (!allPermissions) return [];

  // For S3, filter based on read/write config (target only)
  if (resourceType === 's3' && direction === 'target') {
    const actions: string[] = [];
    if (config?.readAccess !== false) {
      actions.push('s3:GetObject', 's3:ListBucket');
    }
    if (config?.writeAccess !== false) {
      actions.push('s3:PutObject', 's3:DeleteObject');
    }
    return actions.length > 0 ? actions : allPermissions.actions;
  }

  // For DynamoDB as target, filter based on read/write config
  if (resourceType === 'dynamodb' && direction === 'target') {
    const actions: string[] = [];
    if (config?.readAccess !== false) {
      actions.push('dynamodb:GetItem', 'dynamodb:Query', 'dynamodb:Scan');
    }
    if (config?.writeAccess !== false) {
      actions.push('dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem');
    }
    return actions.length > 0 ? actions : allPermissions.actions;
  }

  // For SQS as target, filter based on send/receive config
  if (resourceType === 'sqs' && direction === 'target') {
    const actions: string[] = [];
    if (config?.sendMessages !== false) {
      actions.push('sqs:SendMessage');
    }
    if (config?.receiveMessages) {
      actions.push('sqs:ReceiveMessage', 'sqs:DeleteMessage', 'sqs:GetQueueAttributes');
    }
    return actions.length > 0 ? actions : ['sqs:SendMessage'];
  }

  // For source resources (event source mappings), return all permissions
  return allPermissions.actions;
}

/**
 * Get the resource name from a node based on its type
 */
function getResourceName(node: Node, nodeType: string): string {
  const config = node.data?.config || {};

  // Type-specific name fields
  const nameFields: Record<string, string[]> = {
    's3': ['bucketName', 'name'],
    'dynamodb': ['tableName', 'name'],
    'sqs': ['queueName', 'name'],
    'sns': ['topicName', 'name'],
    'kinesis-stream': ['streamName', 'name'],
    'kinesis-firehose': ['deliveryStreamName', 'name'],
    'lambda': ['functionName', 'name'],
    'agent': ['functionName', 'name'],
    'log-group': ['logGroupPath', 'logGroupName', 'name'],
    'secrets-manager': ['secretName', 'name'],
    'ssm-parameter': ['parameterName', 'name'],
    'step-functions': ['stateMachineName', 'name'],
    'bedrock': ['modelId', 'name'],
    'cloudwatch-alarm': ['alarmName', 'name'],
    'ecr': ['repositoryName', 'name'],
    'cloudwatch-dashboard': ['dashboardName', 'name'],
    'eventbridge': ['busName', 'name'],
    'api-gateway': ['apiId', 'name'],
  };

  const fields = nameFields[nodeType] || ['name'];
  for (const field of fields) {
    if (config[field]) return config[field];
  }

  return node.data?.label || node.id;
}

/**
 * Build an ARN from a pattern and resource name
 * Keeps ${region} and ${account} as placeholders for CDK/CloudFormation
 */
function buildArn(pattern: string, resourceName: string): string {
  // Replace only the resource-specific placeholder, keep region/account as placeholders
  // Common resource placeholders in our patterns
  const resourcePlaceholders = [
    '${bucketName}', '${tableName}', '${queueName}', '${topicName}',
    '${streamName}', '${deliveryStreamName}', '${functionName}',
    '${logGroupName}', '${secretName}', '${parameterName}',
    '${stateMachineName}', '${modelId}', '${alarmName}',
    '${repositoryName}', '${dashboardName}', '${busName}', '${apiId}',
  ];

  let arn = pattern;
  for (const placeholder of resourcePlaceholders) {
    arn = arn.replace(placeholder, resourceName);
  }

  return arn;
}

/**
 * Compute the aggregated policy for a role based on all edges that reference it
 * Deduplicates statements by merging actions for the same resource
 */
export function computeRolePolicy(roleId: string, edges: Edge[], nodes: Node[]): RolePolicy {
  // Use a Map to deduplicate by resourceNodeId
  // Key: resourceNodeId, Value: PolicyStatement with merged actions
  const statementMap = new Map<string, PolicyStatement>();

  // Helper to add or merge a statement
  const addStatement = (stmt: PolicyStatement) => {
    const key = stmt.resourceNodeId;
    const existing = statementMap.get(key);

    if (existing) {
      // Merge actions (deduplicate)
      const mergedActions = [...new Set([...existing.actions, ...stmt.actions])];
      // Merge resources (deduplicate)
      const mergedResources = [...new Set([...existing.resources, ...stmt.resources])];
      statementMap.set(key, {
        ...existing,
        actions: mergedActions,
        resources: mergedResources,
      });
    } else {
      statementMap.set(key, { ...stmt });
    }
  };

  // Find all edges that use this role
  const roleEdges = edges.filter(edge => edge.data?.roleId === roleId);

  for (const edge of roleEdges) {
    const sourceNode = nodes.find(n => n.id === edge.source);
    const targetNode = nodes.find(n => n.id === edge.target);

    if (!sourceNode || !targetNode) continue;

    const sourceType = sourceNode.type || '';
    const targetType = targetNode.type || '';
    const connectionConfig = edge.data?.config || {};

    // Check if this is an event source mapping (source triggers target, target needs to read from source)
    const isEventSourceMapping = ['sqs', 'dynamodb', 'kinesis-stream'].includes(sourceType) &&
                                  ['agent', 'lambda'].includes(targetType);

    // Case 1: Agent/Lambda -> Resource (agent needs permissions to access the resource)
    // Skip this for event source mappings - Lambda doesn't need permission to invoke itself
    const targetPermissions = targetResourcePermissions[targetType];
    if (targetPermissions && !isEventSourceMapping) {
      const resourceName = getResourceName(targetNode, targetType);
      const filteredActions = getFilteredActions(targetType, connectionConfig, 'target');

      let resourceArn = buildArn(targetPermissions.arnPattern, resourceName);
      if (targetType === 's3' && connectionConfig?.keyPrefix) {
        resourceArn = resourceArn.replace('/*', `/${connectionConfig.keyPrefix}*`);
      }

      addStatement({
        effect: 'Allow',
        actions: filteredActions,
        resources: [resourceArn],
        resourceNodeId: targetNode.id,
        resourceType: targetType,
        resourceLabel: targetNode.data?.label || targetType,
      });
    }

    // Case 2: Resource -> Agent/Lambda (needs permissions to read FROM the source resource)
    // This handles event source mappings like SQS -> Lambda, DynamoDB Streams -> Lambda, Kinesis -> Lambda
    const sourcePermissions = sourceResourcePermissions[sourceType];
    if (sourcePermissions && (targetType === 'agent' || targetType === 'lambda')) {
      const resourceName = getResourceName(sourceNode, sourceType);
      const filteredActions = getFilteredActions(sourceType, connectionConfig, 'source');
      const resourceArn = buildArn(sourcePermissions.arnPattern, resourceName);

      addStatement({
        effect: 'Allow',
        actions: filteredActions,
        resources: [resourceArn],
        resourceNodeId: sourceNode.id,
        resourceType: sourceType,
        resourceLabel: sourceNode.data?.label || sourceType,
      });
    }

    // Case 3: Agent/Lambda -> VPC (needs EC2 network interface permissions)
    if ((sourceType === 'agent' || sourceType === 'lambda') && targetType === 'vpc') {
      addStatement({
        effect: 'Allow',
        actions: vpcPermissions.actions,
        resources: ['*'],
        resourceNodeId: targetNode.id,
        resourceType: 'vpc',
        resourceLabel: targetNode.data?.label || 'VPC',
      });
    }

    // Case 4: EventBridge Rule -> Target (rule needs permissions to invoke target)
    const ruleTargetPermissions = eventBridgeRuleTargetPermissions[targetType];
    if (sourceType === 'eventbridge-rule' && ruleTargetPermissions) {
      const resourceName = getResourceName(targetNode, targetType);
      const resourceArn = buildArn(ruleTargetPermissions.arnPattern, resourceName);

      addStatement({
        effect: 'Allow',
        actions: ruleTargetPermissions.actions,
        resources: [resourceArn],
        resourceNodeId: targetNode.id,
        resourceType: targetType,
        resourceLabel: targetNode.data?.label || targetType,
      });
    }

    // Case 5: Data streaming connections (DynamoDB -> Kinesis, Kinesis -> Firehose, etc.)
    // These require write permissions to the target stream
    const streamingConnections: Array<[string, string]> = [
      ['dynamodb', 'kinesis-stream'],
      ['kinesis-stream', 'kinesis-firehose'],
      ['kinesis-firehose', 's3'],
    ];

    const isStreamingConnection = streamingConnections.some(
      ([src, tgt]) => src === sourceType && tgt === targetType
    );

    if (isStreamingConnection) {
      const streamTargetPermissions = targetResourcePermissions[targetType];
      if (streamTargetPermissions) {
        const resourceName = getResourceName(targetNode, targetType);
        const resourceArn = buildArn(streamTargetPermissions.arnPattern, resourceName);

        addStatement({
          effect: 'Allow',
          actions: streamTargetPermissions.actions,
          resources: [resourceArn],
          resourceNodeId: targetNode.id,
          resourceType: targetType,
          resourceLabel: targetNode.data?.label || targetType,
        });
      }
    }
  }

  // Case 6: DLQ Permissions - nodes with DLQ configs need permission to send to the DLQ
  // Find all source nodes that use this role
  const sourceNodeIds = new Set(roleEdges.map(e => e.source));

  for (const nodeId of sourceNodeIds) {
    const node = nodes.find(n => n.id === nodeId);
    if (!node) continue;

    const dlqConfig = node.data?.config?.dlq;
    if (dlqConfig?.enabled && dlqConfig?.targetId) {
      const dlqNode = nodes.find(n => n.id === dlqConfig.targetId);
      if (!dlqNode) continue;

      const dlqType = dlqNode.type || '';

      // Add permissions to send to the DLQ
      if (dlqType === 'sqs') {
        const queueName = getResourceName(dlqNode, 'sqs');
        addStatement({
          effect: 'Allow',
          actions: ['sqs:SendMessage'],
          resources: [`arn:aws:sqs:\${region}:\${account}:${queueName}`],
          resourceNodeId: dlqNode.id,
          resourceType: 'sqs',
          resourceLabel: `${dlqNode.data?.label || 'DLQ'} (Dead Letter Queue)`,
        });
      } else if (dlqType === 'sns') {
        const topicName = getResourceName(dlqNode, 'sns');
        addStatement({
          effect: 'Allow',
          actions: ['sns:Publish'],
          resources: [`arn:aws:sns:\${region}:\${account}:${topicName}`],
          resourceNodeId: dlqNode.id,
          resourceType: 'sns',
          resourceLabel: `${dlqNode.data?.label || 'DLQ'} (Dead Letter Queue)`,
        });
      }
    }
  }

  // Convert Map to array
  return { statements: Array.from(statementMap.values()) };
}

/**
 * Generate IAM policy JSON for a role
 */
export function generateIAMPolicyJSON(policy: RolePolicy): object {
  if (policy.statements.length === 0) {
    return {
      Version: '2012-10-17',
      Statement: [],
    };
  }

  return {
    Version: '2012-10-17',
    Statement: policy.statements.map(stmt => ({
      Effect: stmt.effect,
      Action: stmt.actions,
      Resource: stmt.resources,
    })),
  };
}

/**
 * Get a human-readable summary of a policy
 */
export function getPolicySummary(policy: RolePolicy): string {
  if (policy.statements.length === 0) {
    return 'No permissions configured';
  }

  const resourceTypes = [...new Set(policy.statements.map(s => s.resourceType))];
  return `Access to ${resourceTypes.join(', ')}`;
}
