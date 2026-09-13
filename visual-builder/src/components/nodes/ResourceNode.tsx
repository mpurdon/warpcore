import { Database, Mail, Globe, Lock, Cloud, Key, Settings, Workflow, Brain, Radio, Activity, Package, LayoutDashboard, Cpu, Flame, GitBranch, Paperclip, ShieldAlert } from 'lucide-react';
import { useStore } from '../../store/useStore';
import { NodeStatus } from '../../store/useStore';
import NodeWrapper from './NodeWrapper';
import BidirectionalHandles from './BidirectionalHandles';
import { DISCOVERED_TYPES, discoveredTypeLabel } from '../../utils/discoveredTypes';
import { nameFieldFor } from '../../utils/nodeName';
import type { NodeMeta } from '../../utils/projectFromAccount';
import { CHIP_W } from '../../utils/stackLayout';

interface ResourceNodeData {
  /** Set on a discovered resource. */
  arn?: string;
  label: string;
  status?: NodeStatus;
  type?: string;
  config?: {
    name?: string;
    [key: string]: any;
  };
  meta?: NodeMeta;
}

interface Props {
  id: string;
  data: ResourceNodeData;
  selected: boolean;
  type: string;
}

const iconMap: Record<string, any> = {
  's3': Database,
  'dynamodb': Database,
  'sqs': Mail,
  'sns': Mail,
  'api-gateway': Globe,
  'api-route': Globe,
  'iam-role': Lock,
  'security-group': Lock,
  'vpc': Cloud,
  'kinesis-stream': Radio,
  'kinesis-firehose': Flame,
  'secrets-manager': Key,
  'ssm-parameter': Settings,
  'step-functions': Workflow,
  'bedrock': Brain,
  'cloudwatch-alarm': Activity,
  'ecr': Package,
  'cloudwatch-dashboard': LayoutDashboard,
  'lambda': Cpu,
  'eventbridge-pipes': GitBranch,
};

const colorMap: Record<string, string> = {
  's3': 'text-orange-600',
  'dynamodb': 'text-blue-600',
  'sqs': 'text-purple-600',
  'sns': 'text-pink-600',
  'api-gateway': 'text-green-600',
  'api-route': 'text-green-500',
  'iam-role': 'text-yellow-600',
  'security-group': 'text-red-600',
  'vpc': 'text-indigo-600',
  'kinesis-stream': 'text-orange-500',
  'kinesis-firehose': 'text-red-500',
  'secrets-manager': 'text-red-500',
  'ssm-parameter': 'text-gray-600',
  'step-functions': 'text-pink-500',
  'bedrock': 'text-violet-600',
  'cloudwatch-alarm': 'text-amber-500',
  'ecr': 'text-orange-600',
  'cloudwatch-dashboard': 'text-blue-500',
  'lambda': 'text-orange-500',
  'eventbridge-pipes': 'text-orange-500',
};

const typeLabelMap: Record<string, string> = {
  's3': 'S3 Bucket',
  'dynamodb': 'DynamoDB Table',
  'sqs': 'SQS Queue',
  'sns': 'SNS Topic',
  'api-gateway': 'API Gateway',
  'api-route': 'API Route',
  'iam-role': 'IAM Role',
  'security-group': 'Security Group',
  'vpc': 'VPC',
  'kinesis-stream': 'Kinesis Stream',
  'kinesis-firehose': 'Kinesis Firehose',
  'secrets-manager': 'Secrets Manager',
  'ssm-parameter': 'SSM Parameter',
  'step-functions': 'Step Functions',
  'bedrock': 'Bedrock Model',
  'cloudwatch-alarm': 'CloudWatch Alarm',
  'ecr': 'ECR Repository',
  'cloudwatch-dashboard': 'CloudWatch Dashboard',
  'lambda': 'Lambda Function',
  'eventbridge-pipes': 'EventBridge Pipes',
};


// HTTP method colors for API routes
const methodColors: Record<string, string> = {
  'GET': 'bg-green-500 text-white',
  'POST': 'bg-blue-500 text-white',
  'PUT': 'bg-amber-500 text-white',
  'PATCH': 'bg-orange-500 text-white',
  'DELETE': 'bg-red-500 text-white',
  'ANY': 'bg-purple-500 text-white',
};

export default function ResourceNode({ id, data, selected, type }: Props) {
  const selectNode = useStore((s) => s.selectNode);
  const statusClass = data.status ? `node-${data.status}` : '';
  const groups = data.meta?.securityGroups || [];
  // AWS-generated ids are clutter next to a real name; keep them, quietly.
  const awsId = ['vpcId', 'subnetId', 'routeTableId', 'gatewayId', 'natGatewayId', 'groupId', 'instanceId', 'keyId']
    .map((k) => data.config?.[k])
    .find((v) => typeof v === 'string' && v && v !== (data.config?.name ?? data.label)) as string | undefined;
  const attachments = data.meta?.attachments || [];
  const isSecure = type === 'ssm-parameter' ? Boolean(data.config?.secure) : type === 'secrets-manager';
  const warning = data.meta?.warning;
  const discovered = DISCOVERED_TYPES[type];
  const Icon = iconMap[type] || discovered?.icon || Database;
  const iconColor = colorMap[type] || discovered?.color || 'text-gray-600';
  const typeLabel = typeLabelMap[type] || discoveredTypeLabel(type, data.config) || type;

  // Get the custom name from the type-specific config field
  const nameField = nameFieldFor(type);
  const customName = data.config?.[nameField];
  const displayName = customName || data.label;
  const hasCustomName = !!customName;

  // For API routes, get the HTTP method
  const httpMethod = type === 'api-route' ? (data.config?.method || 'ANY') : null;
  const methodColorClass = httpMethod ? methodColors[httpMethod] || methodColors['ANY'] : '';

  // A platform chip: one line, icon and name, the type in the tooltip. What
  // everything stands on is numerous and rarely the subject.
  if (data.meta?.compact) {
    return (
      <NodeWrapper nodeId={id} selected={selected} status={data.status} note={data.meta?.note} arn={data.arn}>
        <div className={`node-inner px-2.5 py-2 ${statusClass}`} style={{ width: CHIP_W - 4 }} title={`${typeLabel}${awsId ? ' · ' + awsId : ''}`}>
          <BidirectionalHandles nodeId={id} />
          <div className="flex items-center gap-1.5">
            <Icon size={13} className={`${iconColor} shrink-0`} />
            <span className="text-[11px] font-medium truncate">{displayName}</span>
            {isSecure && <Lock size={10} className="text-red-500 shrink-0" />}
            {warning && <ShieldAlert size={11} className="text-amber-600 shrink-0" />}
            {attachments.length > 0 && <span className="text-[10px] text-gray-400 shrink-0">+{attachments.length}</span>}
          </div>
        </div>
      </NodeWrapper>
    );
  }

  return (
    <NodeWrapper nodeId={id} selected={selected} status={data.status} costNode={{ type, data }} note={data.meta?.note} arn={data.arn}>
      <div className={`node-inner px-4 py-3 min-w-[160px] ${statusClass}`}>
        <BidirectionalHandles nodeId={id} />

        <div className="flex items-center gap-2">
          {httpMethod ? (
            // API Route: show method badge instead of icon
            <span className={`px-1.5 py-0.5 text-[10px] font-bold rounded ${methodColorClass}`}>
              {httpMethod}
            </span>
          ) : (
            <Icon size={18} className={iconColor} />
          )}
          <div className="min-w-0">
            <div className="font-semibold text-sm flex items-center gap-1.5">
              <span className="truncate">{displayName}</span>
              {isSecure && <Lock size={11} className="text-red-500 shrink-0" />}
              {warning && <ShieldAlert size={13} className="text-amber-600 shrink-0" />}
              {attachments.length > 0 && (
                <span className="inline-flex items-center gap-0.5 text-[10px] text-gray-500 shrink-0" title={attachments.map((a) => `${a.name} (${a.type})`).join('\n')}>
                  <Paperclip size={10} /> {attachments.length}
                </span>
              )}
            </div>
            {(hasCustomName || awsId) && (
              <div className="text-xs text-gray-500">
                {typeLabel}
                {awsId && <span className="font-mono text-[10px] text-gray-400"> · {awsId}</span>}
              </div>
            )}
            {type === 'security-group' && typeof data.config?.memberCount === 'number' && (
              <div className="text-[10px] text-gray-500">{data.config.memberCount} member{data.config.memberCount === 1 ? '' : 's'}{data.config.isDefault ? ' · default' : ''}</div>
            )}
          </div>
        </div>
        {groups.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-1.5 -mb-0.5">
            {groups.slice(0, 4).map((g) => (
              <button
                key={g.id}
                onClick={(e) => { e.stopPropagation(); selectNode(g.id); }}
                className="text-[10px] leading-4 px-1.5 rounded-full bg-red-50 text-red-700 border border-red-200 hover:bg-red-100"
                title={`In security group ${g.name}. Click to inspect.`}
              >
                {g.name}
              </button>
            ))}
            {groups.length > 4 && <span className="text-[10px] text-gray-400">+{groups.length - 4}</span>}
          </div>
        )}
      </div>
    </NodeWrapper>
  );
}
