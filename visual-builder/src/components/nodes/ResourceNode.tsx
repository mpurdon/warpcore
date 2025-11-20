import { Handle, Position } from 'reactflow';
import { Database, Mail, Globe, Lock, Cloud } from 'lucide-react';
import { NodeStatus } from '../../store/useStore';

interface ResourceNodeData {
  label: string;
  status?: NodeStatus;
  type?: string;
}

interface Props {
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
  'iam-role': Lock,
  'security-group': Lock,
  'vpc': Cloud,
};

const colorMap: Record<string, string> = {
  's3': 'text-orange-600',
  'dynamodb': 'text-blue-600',
  'sqs': 'text-purple-600',
  'sns': 'text-pink-600',
  'api-gateway': 'text-green-600',
  'iam-role': 'text-yellow-600',
  'security-group': 'text-red-600',
  'vpc': 'text-indigo-600',
};

export default function ResourceNode({ data, selected, type }: Props) {
  const statusClass = data.status ? `node-${data.status}` : '';
  const Icon = iconMap[type] || Database;
  const iconColor = colorMap[type] || 'text-gray-600';
  
  return (
    <div className={`px-4 py-3 min-w-[160px] ${statusClass} ${selected ? 'ring-2 ring-blue-500' : ''}`}>
      <Handle type="target" position={Position.Left} />
      
      <div className="flex items-center gap-2">
        <Icon size={18} className={iconColor} />
        <div className="font-semibold text-sm">{data.label}</div>
      </div>
      
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
