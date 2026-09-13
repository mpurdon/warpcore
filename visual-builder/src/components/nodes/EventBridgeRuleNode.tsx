import { Filter, Clock } from 'lucide-react';
import { NodeStatus } from '../../store/useStore';
import NodeWrapper from './NodeWrapper';
import BidirectionalHandles from './BidirectionalHandles';

interface EventBridgeRuleNodeData {
  /** Set on a discovered resource. */
  arn?: string;
  meta?: { note?: string };
  label: string;
  status?: NodeStatus;
  config?: {
    ruleType?: 'pattern' | 'schedule';
    eventPattern?: string;
    schedule?: { type: 'rate' | 'cron'; expression: string };
    ruleName?: string;
  };
}

interface Props {
  id: string;
  data: EventBridgeRuleNodeData;
  selected: boolean;
}

export default function EventBridgeRuleNode({ id, data, selected }: Props) {
  const statusClass = data.status ? `node-${data.status}` : '';
  const config = data.config || {};
  const ruleType = config.ruleType || 'pattern';

  // Parse event pattern to get a summary
  const getPatternSummary = () => {
    if (!config.eventPattern) return null;
    try {
      const parsed = JSON.parse(config.eventPattern);
      const source = parsed.source?.[0];
      const detailType = parsed['detail-type']?.[0];
      if (source && detailType) return `${source}: ${detailType}`;
      if (source) return source;
      if (detailType) return detailType;
      return 'Custom pattern';
    } catch {
      return 'Pattern configured';
    }
  };

  // Get schedule summary
  const getScheduleSummary = () => {
    if (!config.schedule?.expression) return null;
    return config.schedule.expression;
  };

  const isScheduleRule = ruleType === 'schedule';
  const summary = isScheduleRule ? getScheduleSummary() : getPatternSummary();
  const displayName = config.ruleName || data.label;
  const hasCustomName = !!config.ruleName;
  const typeLabel = isScheduleRule ? 'Schedule Rule' : 'Event Rule';

  return (
    <NodeWrapper nodeId={id} selected={selected} status={data.status} note={data.meta?.note} arn={data.arn}>
      <div className={`node-inner px-4 py-3 min-w-[180px] ${statusClass}`}>
        <BidirectionalHandles nodeId={id} />

        <div className="flex items-center gap-2">
          {isScheduleRule ? (
            <Clock size={18} className="text-orange-500" />
          ) : (
            <Filter size={18} className="text-purple-600" />
          )}
          <div>
            <div className="font-semibold text-sm">{displayName}</div>
            {hasCustomName && (
              <div className="text-xs text-gray-500">{typeLabel}</div>
            )}
          </div>
        </div>

        {summary && (
          <div className="text-xs text-gray-500 mt-1 truncate max-w-[160px]">
            {summary}
          </div>
        )}

        {!summary && !hasCustomName && (
          <div className="text-xs text-gray-400 mt-1 italic">
            {isScheduleRule ? 'No schedule set' : 'No pattern set'}
          </div>
        )}
      </div>
    </NodeWrapper>
  );
}
