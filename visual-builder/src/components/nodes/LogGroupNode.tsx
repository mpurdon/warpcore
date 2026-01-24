import { FileText } from 'lucide-react';
import { NodeStatus } from '../../store/useStore';
import NodeWrapper from './NodeWrapper';
import BidirectionalHandles from './BidirectionalHandles';

interface LogGroupNodeData {
  label: string;
  status?: NodeStatus;
  config?: {
    logGroupPath?: string;
    logGroupName?: string; // legacy support
    retentionDays?: number | 'inherit';
    removalPolicy?: 'destroy' | 'retain' | 'inherit';
  };
}

interface Props {
  id: string;
  data: LogGroupNodeData;
  selected: boolean;
}

const retentionLabels: Record<number, string> = {
  1: '1 day',
  3: '3 days',
  7: '1 week',
  14: '2 weeks',
  30: '1 month',
  60: '2 months',
  90: '3 months',
  180: '6 months',
  365: '1 year',
  0: 'Never expire',
};

export default function LogGroupNode({ id, data, selected }: Props) {
  const statusClass = data.status ? `node-${data.status}` : '';
  const config = data.config || {};

  const getRetentionLabel = () => {
    if (config.retentionDays === 'inherit' || config.retentionDays === undefined) {
      return 'Inherit';
    }
    return retentionLabels[config.retentionDays] || `${config.retentionDays} days`;
  };

  const getRemovalLabel = () => {
    if (config.removalPolicy === 'inherit' || !config.removalPolicy) {
      return null;
    }
    return config.removalPolicy === 'destroy' ? 'DESTROY' : 'RETAIN';
  };

  const removalLabel = getRemovalLabel();

  // Use path if set, otherwise fall back to legacy name or label
  const logPath = config.logGroupPath || config.logGroupName;
  const hasPath = !!logPath;

  return (
    <NodeWrapper nodeId={id} selected={selected}>
      <div className={`node-inner px-4 py-3 min-w-[180px] ${statusClass}`}>
        <BidirectionalHandles nodeId={id} />

        <div className="flex items-center gap-2">
          <FileText size={18} className="text-emerald-600 flex-shrink-0" />
          <div className="min-w-0">
            {hasPath ? (
              <div className="font-mono text-xs text-gray-700 truncate" title={logPath}>
                {logPath}
              </div>
            ) : (
              <div className="font-semibold text-sm">{data.label}</div>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2 mt-1">
          <span className="text-xs text-gray-500">
            {getRetentionLabel()}
          </span>
          {removalLabel && (
            <span className={`text-[10px] px-1.5 py-0.5 rounded ${
              removalLabel === 'DESTROY'
                ? 'bg-red-100 text-red-700'
                : 'bg-blue-100 text-blue-700'
            }`}>
              {removalLabel}
            </span>
          )}
        </div>
      </div>
    </NodeWrapper>
  );
}
