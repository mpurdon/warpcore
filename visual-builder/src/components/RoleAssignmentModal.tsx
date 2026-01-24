import { useState, useMemo } from 'react';
import { X, Shield, Plus, ArrowRight, Sparkles, Info, Route, Zap, Star, CheckCircle2 } from 'lucide-react';
import { useStore } from '../store/useStore';
import {
  isResourceBasedConnection,
  getResourcePermissions,
  canAssumeRole,
  computeRolePolicy,
} from '../utils/rolePolicy';

interface Props {
  edgeId: string;
  onClose: () => void;
}

// Connection configuration schemas based on source → target types
interface ConnectionConfig {
  [key: string]: any;
}

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD', 'ANY'];
const AUTH_TYPES = ['NONE', 'AWS_IAM', 'JWT', 'CUSTOM'];

// Map resource types to their permission prefixes for matching
const resourceTypeToPermissionPrefix: Record<string, string[]> = {
  's3': ['s3:'],
  'dynamodb': ['dynamodb:'],
  'sqs': ['sqs:'],
  'sns': ['sns:'],
  'kinesis-stream': ['kinesis:'],
  'kinesis-firehose': ['firehose:'],
  'eventbridge': ['events:'],
  'lambda': ['lambda:'],
  'agent': ['lambda:'],
  'secrets-manager': ['secretsmanager:'],
  'ssm-parameter': ['ssm:'],
  'step-functions': ['states:'],
  'bedrock': ['bedrock:'],
  'log-group': ['logs:'],
};

export default function RoleAssignmentModal({ edgeId, onClose }: Props) {
  const { edges, setEdges, nodes, setNodes } = useStore();
  const edge = edges.find(e => e.id === edgeId);

  const [selectedRoleId, setSelectedRoleId] = useState<string | null>(edge?.data?.roleId || null);
  const [showCreateRole, setShowCreateRole] = useState(false);
  const [newRoleName, setNewRoleName] = useState('');
  const [connectionConfig, setConnectionConfig] = useState<ConnectionConfig>(edge?.data?.config || {});

  if (!edge) return null;

  const sourceNode = nodes.find(n => n.id === edge.source);
  const targetNode = nodes.find(n => n.id === edge.target);

  if (!sourceNode || !targetNode) return null;

  const sourceType = sourceNode.type || '';
  const targetType = targetNode.type || '';

  // Check if this connection uses resource-based policy
  const isResourceBased = isResourceBasedConnection(sourceType, targetType);

  // Event source mapping patterns where the TARGET needs the role to read from SOURCE
  const isEventSourceMapping = ['sqs', 'dynamodb', 'kinesis-stream'].includes(sourceType) &&
                                ['agent', 'lambda'].includes(targetType);

  // Check if source can assume roles, OR if it's an event source mapping (target assumes role)
  const sourceCanAssumeRole = canAssumeRole(sourceType);
  const targetCanAssumeRole = canAssumeRole(targetType);
  const needsRole = sourceCanAssumeRole || (isEventSourceMapping && targetCanAssumeRole);

  // Get all IAM Role nodes
  const roleNodes = nodes.filter(n => n.type === 'iam-role');

  // Get the permissions that would be added to a role for this connection
  const targetPermissions = getResourcePermissions(targetType);

  // Categorize roles: suggested (already have permissions for this resource type) vs other
  const { suggestedRoles, otherRoles } = useMemo(() => {
    const suggested: typeof roleNodes = [];
    const other: typeof roleNodes = [];

    const targetPrefixes = resourceTypeToPermissionPrefix[targetType] || [];

    roleNodes.forEach(roleNode => {
      const policy = computeRolePolicy(roleNode.id, edges, nodes);

      // Check if this role already has permissions for the target resource type
      const hasMatchingPermissions = policy.statements.some(stmt =>
        stmt.actions.some(action =>
          targetPrefixes.some(prefix => action.startsWith(prefix))
        )
      );

      // Check if this role is already used by the source node for other connections
      const isUsedBySource = edges.some(e =>
        e.source === sourceNode?.id &&
        e.data?.roleId === roleNode.id &&
        e.id !== edgeId
      );

      if (hasMatchingPermissions || isUsedBySource) {
        suggested.push(roleNode);
      } else {
        other.push(roleNode);
      }
    });

    return { suggestedRoles: suggested, otherRoles: other };
  }, [roleNodes, edges, nodes, targetType, sourceNode?.id, edgeId]);

  const handleCreateRole = () => {
    if (!newRoleName.trim()) return;

    const roleId = `iam-role-${Date.now()}`;
    const newRoleNode = {
      id: roleId,
      type: 'iam-role',
      position: {
        x: (sourceNode.position.x + targetNode.position.x) / 2,
        y: Math.min(sourceNode.position.y, targetNode.position.y) - 100,
      },
      hidden: true, // Roles are hidden by default, managed via RolesPanel
      data: {
        label: newRoleName,
        config: {
          roleName: newRoleName,
        },
      },
    };

    setNodes([...nodes, newRoleNode]);
    setSelectedRoleId(roleId);
    setShowCreateRole(false);
    setNewRoleName('');
  };

  const handleSave = () => {
    const updatedEdges = edges.map(e =>
      e.id === edgeId
        ? {
            ...e,
            data: {
              ...e.data,
              roleId: selectedRoleId,
              isResourceBased,
              config: connectionConfig,
            },
          }
        : e
    );
    setEdges(updatedEdges);
    onClose();
  };

  const updateConfig = (key: string, value: any) => {
    setConnectionConfig(prev => ({ ...prev, [key]: value }));
  };

  // Render connection-specific configuration
  const renderConnectionConfig = () => {
    // API Gateway → Lambda
    if (sourceType === 'api-gateway' && targetType === 'agent') {
      return (
        <div className="mb-6">
          <div className="flex items-center gap-2 mb-3">
            <Route size={16} className="text-green-600" />
            <h3 className="text-sm font-semibold">Route Configuration</h3>
          </div>
          <div className="space-y-3">
            <div className="grid grid-cols-3 gap-3">
              <div className="col-span-1">
                <label className="block text-xs font-medium text-gray-600 mb-1">Method</label>
                <select
                  value={connectionConfig.method || 'ANY'}
                  onChange={(e) => updateConfig('method', e.target.value)}
                  className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm"
                >
                  {HTTP_METHODS.map(m => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
              </div>
              <div className="col-span-2">
                <label className="block text-xs font-medium text-gray-600 mb-1">Route Path</label>
                <input
                  type="text"
                  value={connectionConfig.path || '/'}
                  onChange={(e) => updateConfig('path', e.target.value)}
                  placeholder="/users/{id}"
                  className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm"
                />
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Authorization</label>
              <select
                value={connectionConfig.authType || 'NONE'}
                onChange={(e) => updateConfig('authType', e.target.value)}
                className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm"
              >
                {AUTH_TYPES.map(a => (
                  <option key={a} value={a}>{a}</option>
                ))}
              </select>
            </div>
          </div>
        </div>
      );
    }

    // Kinesis Stream → Lambda (Event Source Mapping)
    if (sourceType === 'kinesis-stream' && ['agent', 'lambda'].includes(targetType)) {
      return (
        <div className="mb-6">
          <div className="flex items-center gap-2 mb-3">
            <Zap size={16} className="text-orange-600" />
            <h3 className="text-sm font-semibold">Kinesis Event Source Mapping</h3>
          </div>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Batch Size</label>
                <select
                  value={connectionConfig.batchSize || 100}
                  onChange={(e) => updateConfig('batchSize', parseInt(e.target.value))}
                  className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm"
                >
                  {[1, 10, 25, 50, 100, 200, 500, 1000, 10000].map(n => (
                    <option key={n} value={n}>{n} records</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Batch Window</label>
                <select
                  value={connectionConfig.batchWindow || 0}
                  onChange={(e) => updateConfig('batchWindow', parseInt(e.target.value))}
                  className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm"
                >
                  <option value={0}>No batching window</option>
                  <option value={5}>5 seconds</option>
                  <option value={10}>10 seconds</option>
                  <option value={30}>30 seconds</option>
                  <option value={60}>1 minute</option>
                  <option value={300}>5 minutes</option>
                </select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Starting Position</label>
                <select
                  value={connectionConfig.startingPosition || 'LATEST'}
                  onChange={(e) => updateConfig('startingPosition', e.target.value)}
                  className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm"
                >
                  <option value="LATEST">Latest</option>
                  <option value="TRIM_HORIZON">Trim horizon (oldest)</option>
                  <option value="AT_TIMESTAMP">At timestamp</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Parallelization</label>
                <select
                  value={connectionConfig.parallelization || 1}
                  onChange={(e) => updateConfig('parallelization', parseInt(e.target.value))}
                  className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm"
                >
                  {[1, 2, 5, 10].map(n => (
                    <option key={n} value={n}>{n} concurrent batches per shard</option>
                  ))}
                </select>
              </div>
            </div>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={connectionConfig.bisectBatchOnError || false}
                onChange={(e) => updateConfig('bisectBatchOnError', e.target.checked)}
                className="rounded border-gray-300"
              />
              <span className="text-xs text-gray-700">Bisect batch on function error</span>
            </label>
          </div>
        </div>
      );
    }

    // DynamoDB Streams → Lambda (Event Source Mapping)
    if (sourceType === 'dynamodb' && ['agent', 'lambda'].includes(targetType)) {
      return (
        <div className="mb-6">
          <div className="flex items-center gap-2 mb-3">
            <Zap size={16} className="text-blue-600" />
            <h3 className="text-sm font-semibold">DynamoDB Streams Event Source</h3>
          </div>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Batch Size</label>
                <select
                  value={connectionConfig.batchSize || 100}
                  onChange={(e) => updateConfig('batchSize', parseInt(e.target.value))}
                  className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm"
                >
                  {[1, 10, 25, 50, 100, 500, 1000].map(n => (
                    <option key={n} value={n}>{n} records</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Starting Position</label>
                <select
                  value={connectionConfig.startingPosition || 'LATEST'}
                  onChange={(e) => updateConfig('startingPosition', e.target.value)}
                  className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm"
                >
                  <option value="LATEST">Latest</option>
                  <option value="TRIM_HORIZON">Trim horizon (oldest)</option>
                </select>
              </div>
            </div>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={connectionConfig.bisectBatchOnError || false}
                onChange={(e) => updateConfig('bisectBatchOnError', e.target.checked)}
                className="rounded border-gray-300"
              />
              <span className="text-xs text-gray-700">Bisect batch on function error</span>
            </label>
          </div>
        </div>
      );
    }

    // DynamoDB → Kinesis Stream (Kinesis Data Streams for DynamoDB)
    if (sourceType === 'dynamodb' && targetType === 'kinesis-stream') {
      return (
        <div className="mb-6">
          <div className="flex items-center gap-2 mb-3">
            <Zap size={16} className="text-orange-600" />
            <h3 className="text-sm font-semibold">Kinesis Data Streams for DynamoDB</h3>
          </div>
          <p className="text-xs text-gray-500 mb-3">
            This enables change data capture from DynamoDB to the Kinesis stream. All changes (inserts, updates, deletes) will be sent to the stream.
          </p>
        </div>
      );
    }

    // SQS → Lambda (Event Source Mapping)
    if (sourceType === 'sqs' && ['agent', 'lambda'].includes(targetType)) {
      return (
        <div className="mb-6">
          <div className="flex items-center gap-2 mb-3">
            <Zap size={16} className="text-purple-600" />
            <h3 className="text-sm font-semibold">SQS Event Source Mapping</h3>
          </div>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Batch Size</label>
                <select
                  value={connectionConfig.batchSize || 10}
                  onChange={(e) => updateConfig('batchSize', parseInt(e.target.value))}
                  className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm"
                >
                  {[1, 5, 10, 25, 50, 100].map(n => (
                    <option key={n} value={n}>{n} messages</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Batch Window</label>
                <select
                  value={connectionConfig.batchWindow || 0}
                  onChange={(e) => updateConfig('batchWindow', parseInt(e.target.value))}
                  className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm"
                >
                  <option value={0}>No batching window</option>
                  <option value={5}>5 seconds</option>
                  <option value={10}>10 seconds</option>
                  <option value={30}>30 seconds</option>
                  <option value={60}>1 minute</option>
                  <option value={300}>5 minutes</option>
                </select>
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Concurrent Batches</label>
              <select
                value={connectionConfig.concurrency || 1}
                onChange={(e) => updateConfig('concurrency', parseInt(e.target.value))}
                className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm"
              >
                {[1, 2, 5, 10].map(n => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
            </div>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={connectionConfig.reportBatchFailures || false}
                onChange={(e) => updateConfig('reportBatchFailures', e.target.checked)}
                className="rounded border-gray-300"
              />
              <span className="text-xs text-gray-700">Report batch item failures</span>
            </label>
          </div>
        </div>
      );
    }

    // EventBridge Rule → Lambda
    if (sourceType === 'eventbridge-rule' && targetType === 'agent') {
      return (
        <div className="mb-6">
          <div className="flex items-center gap-2 mb-3">
            <Zap size={16} className="text-orange-600" />
            <h3 className="text-sm font-semibold">Target Configuration</h3>
          </div>
          <div className="space-y-3">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Input Transformation</label>
              <select
                value={connectionConfig.inputTransform || 'matched-event'}
                onChange={(e) => updateConfig('inputTransform', e.target.value)}
                className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm"
              >
                <option value="matched-event">Matched event</option>
                <option value="part-of-event">Part of matched event</option>
                <option value="constant">Constant (JSON text)</option>
                <option value="input-transformer">Input transformer</option>
              </select>
            </div>
            {connectionConfig.inputTransform === 'constant' && (
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Constant Input (JSON)</label>
                <textarea
                  value={connectionConfig.constantInput || '{}'}
                  onChange={(e) => updateConfig('constantInput', e.target.value)}
                  placeholder='{"key": "value"}'
                  className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm font-mono h-20"
                />
              </div>
            )}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Retry Attempts</label>
                <select
                  value={connectionConfig.retryAttempts ?? 2}
                  onChange={(e) => updateConfig('retryAttempts', parseInt(e.target.value))}
                  className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm"
                >
                  {[0, 1, 2, 3, 5, 10].map(n => (
                    <option key={n} value={n}>{n}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Max Event Age</label>
                <select
                  value={connectionConfig.maxEventAge || 3600}
                  onChange={(e) => updateConfig('maxEventAge', parseInt(e.target.value))}
                  className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm"
                >
                  <option value={60}>1 minute</option>
                  <option value={300}>5 minutes</option>
                  <option value={3600}>1 hour</option>
                  <option value={21600}>6 hours</option>
                  <option value={86400}>24 hours</option>
                </select>
              </div>
            </div>
          </div>
        </div>
      );
    }

    // SNS → Lambda
    if (sourceType === 'sns' && targetType === 'agent') {
      return (
        <div className="mb-6">
          <div className="flex items-center gap-2 mb-3">
            <Zap size={16} className="text-pink-600" />
            <h3 className="text-sm font-semibold">Subscription Configuration</h3>
          </div>
          <div className="space-y-3">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={connectionConfig.rawMessageDelivery || false}
                onChange={(e) => updateConfig('rawMessageDelivery', e.target.checked)}
                className="rounded border-gray-300"
              />
              <span className="text-xs text-gray-700">Raw message delivery</span>
            </label>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Filter Policy (optional)</label>
              <textarea
                value={connectionConfig.filterPolicy || ''}
                onChange={(e) => updateConfig('filterPolicy', e.target.value)}
                placeholder='{"attribute": ["value1", "value2"]}'
                className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm font-mono h-20"
              />
              <p className="text-xs text-gray-400 mt-1">Leave empty for no filtering</p>
            </div>
          </div>
        </div>
      );
    }

    // Lambda → DynamoDB
    if (sourceType === 'agent' && targetType === 'dynamodb') {
      return (
        <div className="mb-6">
          <div className="flex items-center gap-2 mb-3">
            <Zap size={16} className="text-blue-600" />
            <h3 className="text-sm font-semibold">Access Configuration</h3>
          </div>
          <div className="space-y-2">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={connectionConfig.readAccess !== false}
                onChange={(e) => updateConfig('readAccess', e.target.checked)}
                className="rounded border-gray-300"
              />
              <span className="text-xs text-gray-700">Read access (GetItem, Query, Scan)</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={connectionConfig.writeAccess !== false}
                onChange={(e) => updateConfig('writeAccess', e.target.checked)}
                className="rounded border-gray-300"
              />
              <span className="text-xs text-gray-700">Write access (PutItem, UpdateItem, DeleteItem)</span>
            </label>
          </div>
        </div>
      );
    }

    // Lambda → S3
    if (sourceType === 'agent' && targetType === 's3') {
      return (
        <div className="mb-6">
          <div className="flex items-center gap-2 mb-3">
            <Zap size={16} className="text-orange-600" />
            <h3 className="text-sm font-semibold">Access Configuration</h3>
          </div>
          <div className="space-y-2">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={connectionConfig.readAccess !== false}
                onChange={(e) => updateConfig('readAccess', e.target.checked)}
                className="rounded border-gray-300"
              />
              <span className="text-xs text-gray-700">Read access (GetObject, ListBucket)</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={connectionConfig.writeAccess !== false}
                onChange={(e) => updateConfig('writeAccess', e.target.checked)}
                className="rounded border-gray-300"
              />
              <span className="text-xs text-gray-700">Write access (PutObject, DeleteObject)</span>
            </label>
          </div>
          <div className="mt-3">
            <label className="block text-xs font-medium text-gray-600 mb-1">Key Prefix (optional)</label>
            <input
              type="text"
              value={connectionConfig.keyPrefix || ''}
              onChange={(e) => updateConfig('keyPrefix', e.target.value)}
              placeholder="uploads/"
              className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm"
            />
            <p className="text-xs text-gray-400 mt-1">Restrict access to specific prefix</p>
          </div>
        </div>
      );
    }

    // Lambda → SQS
    if (sourceType === 'agent' && targetType === 'sqs') {
      return (
        <div className="mb-6">
          <div className="flex items-center gap-2 mb-3">
            <Zap size={16} className="text-purple-600" />
            <h3 className="text-sm font-semibold">Access Configuration</h3>
          </div>
          <div className="space-y-2">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={connectionConfig.sendMessages !== false}
                onChange={(e) => updateConfig('sendMessages', e.target.checked)}
                className="rounded border-gray-300"
              />
              <span className="text-xs text-gray-700">Send messages</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={connectionConfig.receiveMessages || false}
                onChange={(e) => updateConfig('receiveMessages', e.target.checked)}
                className="rounded border-gray-300"
              />
              <span className="text-xs text-gray-700">Receive messages</span>
            </label>
          </div>
        </div>
      );
    }

    return null;
  };

  const handleRemoveRole = () => {
    const updatedEdges = edges.map(e =>
      e.id === edgeId
        ? {
            ...e,
            data: {
              ...e.data,
              roleId: undefined,
            },
          }
        : e
    );
    setEdges(updatedEdges);
    setSelectedRoleId(null);
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-xl w-[550px] max-h-[80vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="p-4 border-b border-gray-200 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Connection Settings</h2>
          <button
            onClick={onClose}
            className="p-1 hover:bg-gray-100 rounded"
          >
            <X size={20} />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4">
          {/* Connection Info */}
          <div className="mb-6 p-4 bg-gray-50 rounded-lg border border-gray-200">
            <div className="flex items-center justify-center gap-3">
              <div className="text-center">
                <div className="font-medium text-sm">{sourceNode.data?.label}</div>
                <div className="text-xs text-gray-500">{sourceType}</div>
              </div>
              <ArrowRight size={20} className="text-gray-400" />
              <div className="text-center">
                <div className="font-medium text-sm">{targetNode.data?.label}</div>
                <div className="text-xs text-gray-500">{targetType}</div>
              </div>
            </div>
          </div>

          {/* Connection-specific configuration */}
          {renderConnectionConfig()}

          {/* Resource-based policy info */}
          {isResourceBased && (
            <div className="mb-6 p-4 bg-blue-50 rounded-lg border border-blue-200">
              <div className="flex items-start gap-3">
                <Info size={18} className="text-blue-600 mt-0.5 flex-shrink-0" />
                <div>
                  <div className="font-medium text-sm text-blue-800">
                    {sourceType === 'api-gateway' && targetType === 'api-route'
                      ? 'Parent-Child Relationship'
                      : 'Resource-Based Policy'}
                  </div>
                  <div className="text-xs text-blue-600 mt-1">
                    {sourceType === 'api-gateway' && targetType === 'api-route' && 'The API Route is part of the API Gateway configuration. No permissions are needed.'}
                    {sourceType === 'api-gateway' && targetType === 'agent' && 'API Gateway will be granted permission to invoke the Lambda function.'}
                    {sourceType === 'api-route' && targetType === 'agent' && 'The API Route will invoke this Lambda function. A resource policy will be added to the Lambda.'}
                    {sourceType === 'eventbridge-rule' && ' EventBridge will be granted permission to invoke the target.'}
                    {sourceType === 'sns' && ' SNS will be granted permission to send messages to the target.'}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* IAM Role selection (only for role-based connections) */}
          {!isResourceBased && needsRole && (
            <>
              <div className="mb-4">
                <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
                  <Shield size={16} className="text-yellow-600" />
                  Assign IAM Role
                </h3>
                <p className="text-xs text-gray-500 mb-3">
                  {isEventSourceMapping
                    ? `Select or create an IAM Role for ${targetNode.data?.label} to read from ${sourceNode.data?.label}.`
                    : `Select or create an IAM Role that will be assumed by ${sourceNode.data?.label} to access ${targetNode.data?.label}.`
                  }
                </p>

                {/* Suggested roles (have matching permissions or used by source) */}
                {suggestedRoles.length > 0 && (
                  <div className="mb-3">
                    <div className="flex items-center gap-1.5 mb-2">
                      <Star size={12} className="text-amber-500" />
                      <span className="text-xs font-medium text-gray-600">Suggested Roles</span>
                    </div>
                    <div className="space-y-2">
                      {suggestedRoles.map(role => {
                        const isSelected = selectedRoleId === role.id;
                        const policy = computeRolePolicy(role.id, edges, nodes);
                        const permCount = policy.statements.reduce((acc, s) => acc + s.actions.length, 0);

                        return (
                          <button
                            key={role.id}
                            onClick={() => setSelectedRoleId(isSelected ? null : role.id)}
                            className={`w-full p-3 text-left rounded-lg border transition-all ${
                              isSelected
                                ? 'border-yellow-400 bg-yellow-50 ring-2 ring-yellow-200'
                                : 'border-amber-200 bg-amber-50/50 hover:border-amber-300 hover:bg-amber-50'
                            }`}
                          >
                            <div className="flex items-center gap-2">
                              <Shield size={16} className={isSelected ? 'text-yellow-600' : 'text-amber-500'} />
                              <span className="font-medium text-sm">
                                {role.data?.config?.roleName || role.data?.label}
                              </span>
                              {isSelected ? (
                                <CheckCircle2 size={14} className="ml-auto text-yellow-600" />
                              ) : (
                                <span className="ml-auto text-xs text-amber-600 bg-amber-100 px-1.5 py-0.5 rounded">
                                  {permCount} perm
                                </span>
                              )}
                            </div>
                            {!isSelected && (
                              <p className="text-xs text-amber-600 mt-1">
                                Already has {targetType} permissions
                              </p>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Other existing roles */}
                {otherRoles.length > 0 && (
                  <div className="mb-3">
                    {suggestedRoles.length > 0 && (
                      <div className="flex items-center gap-1.5 mb-2">
                        <Shield size={12} className="text-gray-400" />
                        <span className="text-xs font-medium text-gray-600">Other Roles</span>
                      </div>
                    )}
                    <div className="space-y-2">
                      {otherRoles.map(role => {
                        const isSelected = selectedRoleId === role.id;
                        return (
                          <button
                            key={role.id}
                            onClick={() => setSelectedRoleId(isSelected ? null : role.id)}
                            className={`w-full p-3 text-left rounded-lg border transition-all ${
                              isSelected
                                ? 'border-yellow-400 bg-yellow-50 ring-2 ring-yellow-200'
                                : 'border-gray-200 hover:border-gray-300 hover:bg-gray-50'
                            }`}
                          >
                            <div className="flex items-center gap-2">
                              <Shield size={16} className={isSelected ? 'text-yellow-600' : 'text-gray-400'} />
                              <span className="font-medium text-sm">
                                {role.data?.config?.roleName || role.data?.label}
                              </span>
                              {isSelected && (
                                <CheckCircle2 size={14} className="ml-auto text-yellow-600" />
                              )}
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Create new role */}
                {showCreateRole ? (
                  <div className="p-3 bg-gray-50 rounded-lg border border-gray-200">
                    <input
                      type="text"
                      value={newRoleName}
                      onChange={(e) => setNewRoleName(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && handleCreateRole()}
                      placeholder="Enter role name..."
                      className="w-full px-3 py-2 border border-gray-300 rounded text-sm mb-2"
                      autoFocus
                    />
                    <div className="flex gap-2">
                      <button
                        onClick={handleCreateRole}
                        disabled={!newRoleName.trim()}
                        className="flex-1 px-3 py-1.5 bg-yellow-500 text-white text-sm rounded hover:bg-yellow-600 disabled:opacity-50"
                      >
                        Create Role
                      </button>
                      <button
                        onClick={() => {
                          setShowCreateRole(false);
                          setNewRoleName('');
                        }}
                        className="px-3 py-1.5 bg-gray-200 text-gray-700 text-sm rounded hover:bg-gray-300"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    onClick={() => setShowCreateRole(true)}
                    className="w-full p-3 border-2 border-dashed border-gray-300 rounded-lg text-gray-500 hover:border-yellow-400 hover:text-yellow-600 transition-colors flex items-center justify-center gap-2"
                  >
                    <Plus size={16} />
                    <span className="text-sm">Create New Role</span>
                  </button>
                )}
              </div>

              {/* Permissions preview */}
              {selectedRoleId && targetPermissions && (
                <div className="p-4 bg-green-50 rounded-lg border border-green-200">
                  <div className="flex items-start gap-2 mb-2">
                    <Sparkles size={16} className="text-green-600 mt-0.5" />
                    <div className="font-medium text-sm text-green-800">
                      Permissions to be added to role:
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {targetPermissions.actions.map(action => (
                      <code
                        key={action}
                        className="px-2 py-0.5 bg-green-100 text-green-700 text-xs rounded"
                      >
                        {action}
                      </code>
                    ))}
                  </div>
                </div>
              )}

              {/* No role selected warning */}
              {!selectedRoleId && !isResourceBased && (
                <div className="p-4 bg-amber-50 rounded-lg border border-amber-200">
                  <div className="flex items-start gap-2">
                    <Info size={16} className="text-amber-600 mt-0.5" />
                    <div className="text-xs text-amber-700">
                      {isEventSourceMapping
                        ? `No role assigned. ${targetNode.data?.label} won't have permission to read from ${sourceNode.data?.label} until you assign a role.`
                        : `No role assigned. ${sourceNode.data?.label} won't have permission to access ${targetNode.data?.label} until you assign a role.`
                      }
                    </div>
                  </div>
                </div>
              )}
            </>
          )}

          {/* Non-role connection info */}
          {!isResourceBased && !needsRole && (
            <div className="p-4 bg-gray-50 rounded-lg border border-gray-200">
              <div className="flex items-start gap-2">
                <Info size={16} className="text-gray-500 mt-0.5" />
                <div className="text-xs text-gray-600">
                  This connection type doesn't require explicit IAM permissions.
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-gray-200 flex justify-between">
          <div>
            {selectedRoleId && (
              <button
                onClick={handleRemoveRole}
                className="px-3 py-2 text-red-600 hover:bg-red-50 rounded text-sm"
              >
                Remove Role
              </button>
            )}
          </div>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="px-4 py-2 border border-gray-300 rounded hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
            >
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
