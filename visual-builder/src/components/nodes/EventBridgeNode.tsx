import { Zap } from 'lucide-react';
import { NodeStatus } from '../../store/useStore';
import NodeWrapper from './NodeWrapper';
import BidirectionalHandles from './BidirectionalHandles';

interface EventBridgeNodeData {
  label: string;
  status?: NodeStatus;
  eventPattern?: string;
  config?: {
    name?: string;
    [key: string]: any;
  };
}

interface Props {
  id: string;
  data: EventBridgeNodeData;
  selected: boolean;
}

export default function EventBridgeNode({ id, data, selected }: Props) {
  const statusClass = data.status ? `node-${data.status}` : '';
  const displayName = data.config?.name || data.label;
  const hasCustomName = !!data.config?.name;

  return (
    <NodeWrapper nodeId={id} selected={selected} status={data.status}>
      <div className={`node-inner px-4 py-3 min-w-[160px] ${statusClass}`}>
        <BidirectionalHandles nodeId={id} />

        <div className="flex items-center gap-2">
          <Zap size={18} className="text-orange-600" />
          <div>
            <div className="font-semibold text-sm">{displayName}</div>
            {hasCustomName && (
              <div className="text-xs text-gray-500">EventBridge</div>
            )}
          </div>
        </div>

        {data.eventPattern && (
          <div className="text-xs text-gray-600 mt-1">
            Pattern: {data.eventPattern}
          </div>
        )}
      </div>
    </NodeWrapper>
  );
}
