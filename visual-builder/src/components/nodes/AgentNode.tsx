import { Handle, Position } from 'reactflow';
import { Bot } from 'lucide-react';
import { NodeStatus } from '../../store/useStore';

interface AgentNodeData {
  label: string;
  status?: NodeStatus;
  runtime?: string;
  memory?: number;
}

interface Props {
  data: AgentNodeData;
  selected: boolean;
}

export default function AgentNode({ data, selected }: Props) {
  const statusClass = data.status ? `node-${data.status}` : '';
  
  return (
    <div className={`px-4 py-3 min-w-[180px] ${statusClass} ${selected ? 'ring-2 ring-blue-500' : ''}`}>
      <Handle type="target" position={Position.Left} />
      
      <div className="flex items-center gap-2 mb-2">
        <Bot size={20} className="text-blue-600" />
        <div className="font-semibold text-sm">{data.label}</div>
      </div>
      
      {data.runtime && (
        <div className="text-xs text-gray-600">
          Runtime: {data.runtime}
        </div>
      )}
      
      {data.memory && (
        <div className="text-xs text-gray-600">
          Memory: {data.memory}MB
        </div>
      )}
      
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
