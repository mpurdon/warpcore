// The frame every node shares: the delete affordance, the ambient status
// dot, and the cost badge when the Cost lens is on. Status is a small
// semantic dot in the corner rather than only a tint, so a node's state
// reads at a glance and survives the lens dimming.

import { useMemo, useState } from 'react';
import { STATUS_META } from '../../utils/nodeStatus';
import { MessageSquareText, X } from 'lucide-react';
import { Node } from 'reactflow';
import { NodeStatus, useReadOnly, useStore } from '../../store/useStore';
import { badgeLabel, badgeTone, formatTakes } from '../../utils/scenarios';
import { useScenarioMarks } from '../../hooks/useCanvasView';
import { estimateCost, formatCost } from '../../utils/costEstimation';
import { SEVERITY_COLOR, worst } from '../../utils/findings';

interface Props {
  nodeId: string;
  selected: boolean;
  children: React.ReactNode;
  className?: string;
  status?: NodeStatus;
  /** When given, the Cost lens draws this node's monthly estimate on it. */
  costNode?: { type?: string; data: any };
  /** A note on the resource (meta.note): a marker on the card, the text in the inspector. */
  note?: string;
  /** The AWS ARN, for a discovered resource: findings from the last review are keyed by it. */
  arn?: string;
}

export default function NodeWrapper({ nodeId, selected, children, className = '', status, costNode, note, arn }: Props) {
  const [isHovered, setIsHovered] = useState(false);
  const setSelectedNode = useStore((s) => s.setSelectedNode);
  const lens = useStore((s) => s.lens);
  const executionsPerMonth = useStore((s) => s.executionsPerMonth);
  const readOnly = useReadOnly();
  // Findings from the last review that name this resource.
  const findings = useStore((s) => (arn ? s.reviewByArn.get(arn) : undefined));
  const worstSeverity = worst(findings);
  // The scenario on show, if any: step numbers, the node's state at the
  // playhead, and whether it is a log group being written to.
  const marks = useScenarioMarks();
  const numbers = marks?.numbers.get(nodeId);
  const state = marks?.state.get(nodeId);
  const logging = marks?.logging.has(nodeId) ?? false;
  const card = marks?.card && marks.card.nodeId === nodeId ? marks.card : null;

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation(); // Prevent node selection
    const { nodes, edges, setNodes, setEdges } = useStore.getState();
    setNodes(nodes.filter(n => n.id !== nodeId));
    setEdges(edges.filter(e => e.source !== nodeId && e.target !== nodeId));
    setSelectedNode(null);
  };

  const cost = useMemo(() => {
    if (lens !== 'cost' || !costNode) return null;
    const pseudo = { id: nodeId, type: costNode.type, data: costNode.data, position: { x: 0, y: 0 } } as Node;
    return estimateCost([pseudo], executionsPerMonth).total;
  }, [lens, costNode, nodeId, executionsPerMonth]);

  const showDelete = (isHovered || selected) && !readOnly;
  const dot = status ? STATUS_META[status] : undefined;

  return (
    <div
      className={`relative ${className}`}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {children}

      {card && (
        <div className={`scn-card ${card.outcome && card.outcome !== 'ok' && card.phase === 'dwell' ? 'scn-card-bad' : ''}`} role="status" aria-live="polite">
          <div className="scn-card-head">
            <span>{card.number === 0 ? 'Request' : `Step ${card.number} of ${card.total}`}</span>
            {card.phase === 'travel' && <span className="scn-card-dim">on its way{card.attempt > 0 ? ` · retry ${card.attempt}` : ''}</span>}
            {card.phase === 'dwell' && card.takes != null && <span className="scn-card-dim">{formatTakes(card.takes)}</span>}
            {card.detached && <span className="scn-card-dim">detached</span>}
          </div>
          {card.text && <div className="scn-card-text">{card.text}</div>}
          {card.from && <div className="scn-card-from">from {card.from}{card.via ? ` · ${card.via}` : ''}</div>}
          {card.outcome && card.outcome !== 'ok' && card.phase === 'dwell' && (
            <div className="scn-card-outcome">{card.outcome === 'fail' ? 'fails here' : 'times out here'}{card.retry ? ` · ${card.attempt < card.retry ? 'retrying' : 'out of retries'}` : ''}</div>
          )}
        </div>
      )}
      {numbers && numbers.length > 0 && (
        <span className="scn-badges" aria-label={`Scenario step ${numbers.join(', ')}`}>
          {numbers.slice(0, 3).map((n) => (
            <span key={n} className={`scn-badge ${n === 0 ? 'trigger' : badgeTone(state)}`} title={n === 0 ? 'Where the request arrives' : `Step ${n}`}>
              {badgeLabel(n)}
            </span>
          ))}
          {numbers.length > 3 && <span className="scn-badge pending">+{numbers.length - 3}</span>}
        </span>
      )}
      {logging && (
        <span className="scn-writing" title="Receiving log lines (synthetic)">
          <span /><span /><span />
        </span>
      )}
      {findings && findings.length > 0 && worstSeverity && (
        <span
          className="node-finding-marker"
          style={{ backgroundColor: SEVERITY_COLOR[worstSeverity] }}
          title={findings.map((f) => `${f.severity}: ${f.title}`).join('\n')}
        >
          {findings.length}
        </span>
      )}
      {note && (
        <span className="node-note-marker" title={note}>
          <MessageSquareText size={9} />
        </span>
      )}

      {dot && (
        <span
          className={`node-status-dot ${dot.pulse ? 'animate-pulse' : ''}`}
          style={{ backgroundColor: dot.dot }}
          title={dot.label}
        />
      )}

      {cost != null && (
        <span
          className="absolute -bottom-2.5 right-2 text-[10px] font-semibold tabular-nums bg-surface border border-gray-200 rounded-full px-1.5 py-px shadow-sm text-gray-700 z-10"
          title={`Estimated ${formatCost(cost)} per month at the project's executions-per-month setting`}
        >
          {cost === 0 ? 'free' : `${formatCost(cost)}/mo`}
        </span>
      )}

      {/* Delete button - appears on hover or selection */}
      {showDelete && (
        <button
          onClick={handleDelete}
          className="absolute -top-2 -right-2 w-5 h-5 bg-red-500 hover:bg-red-600 rounded-full flex items-center justify-center shadow-md transition-colors z-10"
          title="Delete resource"
        >
          <X size={12} className="text-white" />
        </button>
      )}
    </div>
  );
}
