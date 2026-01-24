import { Database, Mail, Globe, Lock, Cloud, Key, Settings, Workflow, Brain, Radio, Activity, Package, LayoutDashboard, Cpu, Flame, GitBranch } from 'lucide-react';
import { NodeStatus } from '../../store/useStore';
import NodeWrapper from './NodeWrapper';
import BidirectionalHandles from './BidirectionalHandles';

interface ResourceNodeData {
  label: string;
  status?: NodeStatus;
  type?: string;
  config?: {
    name?: string;
    [key: string]: any;
  };
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

// Map of config key names for each resource type
const nameFieldMap: Record<string, string> = {
  's3': 'bucketName',
  'dynamodb': 'tableName',
  'sqs': 'queueName',
  'sns': 'topicName',
  'api-gateway': 'apiName',
  'api-route': 'path',
  'iam-role': 'roleName',
  'security-group': 'groupName',
  'vpc': 'name',
  'kinesis-stream': 'streamName',
  'kinesis-firehose': 'deliveryStreamName',
  'secrets-manager': 'secretName',
  'ssm-parameter': 'parameterName',
  'step-functions': 'stateMachineName',
  'bedrock': 'modelId',
  'cloudwatch-alarm': 'alarmName',
  'ecr': 'repositoryName',
  'cloudwatch-dashboard': 'dashboardName',
  'eventbridge': 'busName',
  'eventbridge-rule': 'ruleName',
  'eventbridge-pipes': 'pipeName',
  'log-group': 'logGroupName',
  'lambda': 'functionName',
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
  const statusClass = data.status ? `node-${data.status}` : '';
  const Icon = iconMap[type] || Database;
  const iconColor = colorMap[type] || 'text-gray-600';
  const typeLabel = typeLabelMap[type] || type;

  // Get the custom name from the type-specific config field
  const nameField = nameFieldMap[type] || 'name';
  const customName = data.config?.[nameField];
  const displayName = customName || data.label;
  const hasCustomName = !!customName;

  // For API routes, get the HTTP method
  const httpMethod = type === 'api-route' ? (data.config?.method || 'ANY') : null;
  const methodColorClass = httpMethod ? methodColors[httpMethod] || methodColors['ANY'] : '';

  return (
    <NodeWrapper nodeId={id} selected={selected}>
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
          <div>
            <div className="font-semibold text-sm">{displayName}</div>
            {hasCustomName && (
              <div className="text-xs text-gray-500">{typeLabel}</div>
            )}
          </div>
        </div>
      </div>
    </NodeWrapper>
  );
}
