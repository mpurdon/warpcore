import { Handle, Position } from 'reactflow';
import { Zap } from 'lucide-react';
import { NodeStatus } from '../../store/useStore';

interface EventBridgeNodeData {
  label: string;
  status?: NodeStatus;
  eventPattern?: string;
}

interface Props {
  data: EventBridgeNodeData;
  selected: boolean;
}

export default function EventBridgeNode({ data, selected }: Props) {
  const statusClass = data.status ? `node-${data.status}` : '';
  
  return (
    <div className={`px-4 py-3 min-w-[160px] ${statusClass} ${selected ? 'ring-2 ring-blue-500' : ''}`}>
      <Handle type="target" position={Position.Left} />
      
      <div className="flex items-center gap-2">
        <Zap size={18} className="text-orange-600" />
        <div className="font-semibold text-sm">{data.label}</div>
      </div>
      
      {data.eventPattern && (
        <div className="text-xs text-gray-600 mt-1">
          Pattern: {data.eventPattern}
        </div>
      )}
      
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
