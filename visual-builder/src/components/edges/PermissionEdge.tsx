import { BaseEdge, EdgeLabelRenderer, EdgeProps, getBezierPath, useReactFlow } from 'reactflow';
import { Eye, Pencil, Zap, Route, AlertTriangle } from 'lucide-react';

// Permission type colors
export const PERMISSION_COLORS = {
  read: '#3b82f6',    // Blue
  write: '#f59e0b',   // Amber
  execute: '#8b5cf6', // Purple
  admin: '#dc2626',   // Red: service:* or *
  none: '#d1d5db',    // Gray
  relationship: '#9ca3af', // Gray dashed: structure, not permission
};

// Determine permission types based on target resource and config
function getPermissionTypes(
  sourceType: string,
  targetType: string,
  config: Record<string, any>,
  isResourceBased: boolean
): { read: boolean; write: boolean; execute: boolean } {
  const perms = { read: false, write: false, execute: false };

  // Resource-based connections (API Gateway, EventBridge, SNS → Lambda)
  if (isResourceBased) {
    if (['api-gateway', 'api-route', 'eventbridge-rule', 'sns', 'sqs', 's3'].includes(sourceType) &&
        ['agent', 'lambda'].includes(targetType)) {
      perms.execute = true;
    }
    return perms;
  }

  // Agent/Lambda → Storage resources
  if (['agent', 'lambda'].includes(sourceType)) {
    switch (targetType) {
      case 's3':
        perms.read = config.readAccess !== false;
        perms.write = config.writeAccess !== false;
        break;
      case 'dynamodb':
        perms.read = config.readAccess !== false;
        perms.write = config.writeAccess !== false;
        break;
      case 'sqs':
        perms.write = config.sendMessages !== false;
        perms.read = config.receiveMessages === true;
        break;
      case 'sns':
        perms.write = true; // Publish
        break;
      case 'kinesis-stream':
      case 'kinesis-firehose':
        perms.write = true; // PutRecord
        break;
      case 'eventbridge':
        perms.write = true; // PutEvents
        break;
      case 'secrets-manager':
      case 'ssm-parameter':
        perms.read = true;
        break;
      case 'agent':
      case 'lambda':
        perms.execute = true;
        break;
      case 'step-functions':
        perms.execute = true;
        break;
      case 'bedrock':
        perms.execute = true;
        break;
      case 'log-group':
        perms.write = true;
        break;
      default:
        // Default to read+write for unknown resources
        perms.read = true;
        perms.write = true;
    }
  }

  // DynamoDB → Kinesis Stream (DynamoDB Streams to Kinesis Data Streams)
  if (sourceType === 'dynamodb' && targetType === 'kinesis-stream') {
    perms.write = true; // DynamoDB writes to Kinesis
  }

  // Kinesis Stream → Firehose
  if (sourceType === 'kinesis-stream' && targetType === 'kinesis-firehose') {
    perms.write = true;
  }

  // Kinesis Firehose → S3 (delivery)
  if (sourceType === 'kinesis-firehose' && targetType === 's3') {
    perms.write = true;
  }

  // Event source mappings (SQS, DynamoDB Streams, Kinesis → Lambda)
  if (['sqs', 'dynamodb', 'kinesis-stream'].includes(sourceType) &&
      ['agent', 'lambda'].includes(targetType)) {
    perms.read = true; // Reading from the source
    perms.execute = true; // Triggering the Lambda
  }

  // EventBridge Rule → targets (requires role-based permissions)
  if (sourceType === 'eventbridge-rule') {
    switch (targetType) {
      case 'sqs':
      case 'sns':
      case 'kinesis-stream':
      case 'kinesis-firehose':
      case 'log-group':
      case 'eventbridge':
        perms.write = true; // SendMessage, Publish, PutRecord, PutEvents
        break;
      case 'step-functions':
        perms.execute = true; // StartExecution
        break;
      case 'api-gateway':
        perms.execute = true; // Invoke
        break;
    }
  }

  return perms;
}

// Generate gradient ID and definition for mixed permissions
function getGradientInfo(perms: { read: boolean; write: boolean; execute: boolean }, edgeId: string) {
  const activePerms = [];
  if (perms.read) activePerms.push({ type: 'read', color: PERMISSION_COLORS.read });
  if (perms.write) activePerms.push({ type: 'write', color: PERMISSION_COLORS.write });
  if (perms.execute) activePerms.push({ type: 'execute', color: PERMISSION_COLORS.execute });

  if (activePerms.length === 0) {
    return { useGradient: false, color: PERMISSION_COLORS.none, gradientId: '', stops: [] };
  }

  if (activePerms.length === 1) {
    return { useGradient: false, color: activePerms[0].color, gradientId: '', stops: [] };
  }

  // Create gradient stops for multiple permissions
  const gradientId = `perm-gradient-${edgeId}`;
  const stops = activePerms.map((p, i) => ({
    offset: `${(i / (activePerms.length - 1)) * 100}%`,
    color: p.color,
  }));

  return { useGradient: true, color: '', gradientId, stops };
}

export default function PermissionEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  markerEnd,
  source,
  target,
}: EdgeProps) {
  const { getNodes } = useReactFlow();
  const nodes = getNodes();

  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  const roleId = data?.roleId;
  const isResourceBased = data?.isResourceBased;
  const isDLQ = data?.isDLQ;
  const config = data?.config || {};
  const status = data?.status || 'draft';
  // Discovered edges: what the relationship is and, for access, who grants it.
  const discovered = data?.meta?.discovered as { kind: string; detail: string } | undefined;
  const access = data?.meta?.access as { level: string; via: string; actions: string[] } | undefined;
  const dimmed = Boolean(data?.dimmed);

  // Get source and target node types
  const sourceNode = nodes.find(n => n.id === source);
  const targetNode = nodes.find(n => n.id === target);
  const sourceType = sourceNode?.type || '';
  const targetType = targetNode?.type || '';

  // Determine permission types for this connection. An access edge from a
  // policy document says exactly what it grants, in the legend's own terms:
  // read is blue, write is amber, both is the blue-to-amber gradient.
  const perms = access
    ? {
      read: access.level === 'read' || access.level === 'read/write' || access.level === 'admin',
      write: access.level === 'write' || access.level === 'read/write' || access.level === 'admin',
      execute: false,
    }
    : getPermissionTypes(sourceType, targetType, config, isResourceBased);
  const hasRole = !!roleId;

  // Get gradient info for the edge
  const gradientInfo = getGradientInfo(perms, id);

  // Determine edge style based on state
  let edgeStyle: React.CSSProperties;
  if (access) {
    if (access.level === 'admin') {
      edgeStyle = { stroke: PERMISSION_COLORS.admin, strokeWidth: 3 };
    } else if (gradientInfo.useGradient) {
      edgeStyle = { stroke: `url(#${gradientInfo.gradientId})`, strokeWidth: 3 };
    } else {
      edgeStyle = { stroke: gradientInfo.color, strokeWidth: 3 };
    }
  } else if (discovered && discovered.kind !== 'event-source' && discovered.kind !== 'event-target' && discovered.kind !== 'invokes') {
    edgeStyle = { stroke: PERMISSION_COLORS.relationship, strokeWidth: 1.5, strokeDasharray: '4 4' };
  } else if (isDLQ) {
    // DLQ edge - amber dashed line
    edgeStyle = { stroke: '#f59e0b', strokeWidth: 2, strokeDasharray: '5 5' };
  } else if (status === 'deployed') {
    edgeStyle = { stroke: '#10b981', strokeWidth: 2 };
  } else if (status === 'failed') {
    edgeStyle = { stroke: '#ef4444', strokeWidth: 2 };
  } else if (status === 'deploying') {
    edgeStyle = { stroke: '#3b82f6', strokeWidth: 2 };
  } else if (!hasRole && !isResourceBased) {
    // No role assigned - gray dashed line
    edgeStyle = { stroke: PERMISSION_COLORS.none, strokeWidth: 2, strokeDasharray: '5 5' };
  } else if (gradientInfo.useGradient) {
    edgeStyle = { stroke: `url(#${gradientInfo.gradientId})`, strokeWidth: 3 };
  } else {
    edgeStyle = { stroke: gradientInfo.color, strokeWidth: 3 };
  }

  // Get config summary for display
  const getConfigSummary = () => {
    // API Gateway → Lambda: show route
    if ((sourceType === 'api-gateway' || sourceType === 'api-route') &&
        (targetType === 'agent' || targetType === 'lambda')) {
      const method = config.method || 'ANY';
      const path = config.path || '/';
      return `${method} ${path}`;
    }
    // SQS → Lambda: show batch size
    if (sourceType === 'sqs' && (targetType === 'agent' || targetType === 'lambda')) {
      return `Batch: ${config.batchSize || 10}`;
    }
    return null;
  };

  const configSummary = getConfigSummary();

  // Build permission badge content
  const permissionBadges = [];
  if (perms.read) permissionBadges.push({ icon: Eye, color: PERMISSION_COLORS.read, label: 'R' });
  if (perms.write) permissionBadges.push({ icon: Pencil, color: PERMISSION_COLORS.write, label: 'W' });
  if (perms.execute) permissionBadges.push({ icon: Zap, color: PERMISSION_COLORS.execute, label: 'X' });

  return (
    <>
      {/* SVG gradient definitions - uses userSpaceOnUse to work with straight lines */}
      {gradientInfo.useGradient && (
        <svg style={{ position: 'absolute', width: 0, height: 0, overflow: 'visible' }}>
          <defs>
            <linearGradient
              id={gradientInfo.gradientId}
              gradientUnits="userSpaceOnUse"
              x1={sourceX}
              y1={sourceY}
              x2={targetX}
              y2={targetY}
            >
              {gradientInfo.stops.map((stop, i) => (
                <stop key={i} offset={stop.offset} stopColor={stop.color} />
              ))}
            </linearGradient>
          </defs>
        </svg>
      )}

      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={markerEnd}
        style={dimmed ? { ...edgeStyle, opacity: 0.3 } : edgeStyle}
      />

      <EdgeLabelRenderer>
        <div
          style={{
            position: 'absolute',
            transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
            pointerEvents: 'all',
          }}
          className="nodrag nopan"
        >
          {/* Discovered relationship: access verb, or what the arrow means */}
          {access ? (
            <div
              className={`flex items-center gap-1 bg-white/95 backdrop-blur-sm rounded-full px-2 py-0.5 shadow-sm border border-gray-200 ${dimmed ? 'opacity-40' : ''}`}
              title={`${access.level} via ${access.via}\n${access.actions.join('\n')}`}
            >
              {access.level === 'admin' ? (
                <span className="text-[10px] font-bold" style={{ color: PERMISSION_COLORS.admin }}>*</span>
              ) : (
                <>
                  {(access.level === 'read' || access.level === 'read/write') && <Eye size={11} style={{ color: PERMISSION_COLORS.read }} />}
                  {(access.level === 'write' || access.level === 'read/write') && <Pencil size={11} style={{ color: PERMISSION_COLORS.write }} />}
                </>
              )}
              <span className="text-[10px] font-medium" style={{ color: access.level === 'admin' ? PERMISSION_COLORS.admin : '#374151' }}>{access.level}</span>
              <span className="text-[10px] text-gray-400">via {access.via}</span>
            </div>
          ) : discovered ? (
            <div className={`bg-white/90 rounded-full px-2 py-0.5 shadow-sm border border-gray-200 text-[10px] text-gray-500 ${dimmed ? 'opacity-40' : ''}`}>
              {discovered.detail || discovered.kind}
            </div>
          ) : isDLQ ? (
            <div className="flex items-center gap-1 bg-amber-50 backdrop-blur-sm rounded-full px-2 py-0.5 shadow-sm border border-amber-300">
              <AlertTriangle size={12} className="text-amber-600" />
              <span className="text-[10px] text-amber-700 font-medium">
                DLQ ({data?.maxRetries || 3} retries)
              </span>
            </div>
          ) : (
            /* Permission badges */
            <div className="flex items-center gap-0.5 bg-white/90 backdrop-blur-sm rounded-full px-1.5 py-0.5 shadow-sm border border-gray-200">
              {permissionBadges.length > 0 ? (
                <>
                  {permissionBadges.map(({ icon: Icon, color, label }) => (
                    <div
                      key={label}
                      className="flex items-center justify-center w-5 h-5 rounded-full"
                      style={{ backgroundColor: `${color}20` }}
                      title={label === 'R' ? 'Read' : label === 'W' ? 'Write' : 'Execute'}
                    >
                      <Icon size={12} style={{ color }} />
                    </div>
                  ))}
                  {configSummary && (
                    <span className="text-[10px] text-gray-600 ml-1 font-medium">
                      {configSummary}
                    </span>
                  )}
                </>
              ) : !hasRole && !isResourceBased ? (
                <span className="text-[10px] text-gray-400 px-1">No role</span>
              ) : configSummary ? (
                <>
                  <Route size={12} className="text-gray-500" />
                  <span className="text-[10px] text-gray-600 font-medium">{configSummary}</span>
                </>
              ) : null}
            </div>
          )}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}
