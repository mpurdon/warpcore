import { Bot } from 'lucide-react';
import { NodeStatus } from '../../store/useStore';
import NodeWrapper from './NodeWrapper';
import BidirectionalHandles from './BidirectionalHandles';

interface AgentNodeData {
  label: string;
  status?: NodeStatus;
  runtime?: string;
  memory?: number;
  config?: {
    name?: string;
    [key: string]: any;
  };
}

interface Props {
  id: string;
  data: AgentNodeData;
  selected: boolean;
}

export default function AgentNode({ id, data, selected }: Props) {
  const statusClass = data.status ? `node-${data.status}` : '';
  const displayName = data.config?.name || data.label;
  const hasCustomName = !!data.config?.name;

  return (
    <NodeWrapper nodeId={id} selected={selected}>
      <div className={`node-inner px-4 py-3 min-w-[180px] ${statusClass}`}>
        <BidirectionalHandles nodeId={id} />

        <div className="flex items-center gap-2">
          <Bot size={20} className="text-blue-600" />
          <div>
            <div className="font-semibold text-sm">{displayName}</div>
            {hasCustomName && (
              <div className="text-xs text-gray-500">Agent</div>
            )}
          </div>
        </div>

        {(data.runtime || data.memory) && (
          <div className="mt-1 text-xs text-gray-600">
            {data.runtime && <span>Runtime: {data.runtime}</span>}
            {data.runtime && data.memory && <span> · </span>}
            {data.memory && <span>{data.memory}MB</span>}
          </div>
        )}
      </div>
    </NodeWrapper>
  );
}
