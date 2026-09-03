// A node that can be a container: a VPC with subnets as partitions inside
// it, a subnet holding what runs in it, or the synthetic vault and keyring.
// Without children a VPC is an ordinary resource node; a subnet inside a VPC
// is always a partition, and says so when it is empty rather than looking
// broken.

import { memo } from 'react';
import { Cloud, Layers, Lock, Plus } from 'lucide-react';
import { NodeStatus, useReadOnly, useStore } from '../../store/useStore';
import { addSubnet } from '../../utils/subnets';
import { ENCLOSURES, EnclosureKind, NodeMeta } from '../../utils/projectFromAccount';
import BidirectionalHandles from './BidirectionalHandles';
import ResourceNode from './ResourceNode';

interface Data {
  label: string;
  status?: NodeStatus;
  config?: Record<string, any>;
  region?: string;
  meta?: NodeMeta;
}

interface Props {
  id: string;
  data: Data;
  selected: boolean;
  type: string;
}

// VPCs and subnets have their own look; enclosures carry theirs in ENCLOSURES.
const CONTAINER_STYLE: Record<string, { border: string; bg: string; header: string; icon: typeof Cloud }> = {
  vpc: { border: 'border-indigo-300 border-dashed', bg: 'bg-indigo-50/40', header: 'text-indigo-800', icon: Cloud },
  subnet: { border: 'border-indigo-200', bg: 'bg-white/70', header: 'text-indigo-700', icon: Layers },
};

function styleFor(type: string, kind: string) {
  if (type === 'enclosure') {
    const info = ENCLOSURES[kind as EnclosureKind] ?? ENCLOSURES.other;
    return { border: `${info.border} border-dashed`, bg: info.bg, header: info.header, icon: info.icon };
  }
  return CONTAINER_STYLE[type] ?? CONTAINER_STYLE.vpc;
}

function ContainerNode({ id, data, selected, type }: Props) {
  const childCount = useStore((s) => s.nodes.filter((n) => n.parentNode === id && !n.hidden).length);
  const readOnly = useReadOnly();
  const meta = data.meta || {};
  if (!meta.isGroup) {
    return <ResourceNode id={id} data={data} selected={selected} type={type} />;
  }
  const kind = type === 'enclosure' ? (meta.enclosure || 'other') : type;
  const style = styleFor(type, kind);
  const Icon = style.icon;
  const cfg = data.config || {};
  const isDraft = data.status === 'draft';

  // A subnet with nothing in it is drawn as a slim column: the availability
  // zone down its spine, nothing else. A draft subnet keeps its full width
  // so there is somewhere to put things.
  if (type === 'subnet' && childCount === 0 && !isDraft) {
    const az = String(cfg.availabilityZone || '');
    const zone = az.replace(/^.*?(\d[a-z])$/, '$1') || az;
    return (
      <div
        className={`relative w-full h-full rounded-lg border ${style.border} bg-white/50 ${selected ? 'ring-2 ring-blue-500' : ''} flex flex-col items-center py-2 gap-1`}
        style={{ minWidth: 48, minHeight: 100 }}
        title={`${cfg.name || data.label} · ${cfg.public ? 'public' : 'private'} · ${az}${cfg.cidrBlock ? ' · ' + cfg.cidrBlock : ''} · empty`}
      >
        <BidirectionalHandles nodeId={id} />
        <Layers size={12} className="text-indigo-400 shrink-0" />
        <span className="text-[10px] font-semibold text-indigo-700">{zone || '—'}</span>
        <span className={`w-1.5 h-1.5 rounded-full ${cfg.public ? 'bg-sky-400' : 'bg-gray-300'}`} title={cfg.public ? 'public' : 'private'} />
        <span className="flex-1 flex items-center">
          <span className="text-[10px] text-gray-400 italic" style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)' }}>empty</span>
        </span>
      </div>
    );
  }

  let name: string;
  let subtitle: string;
  let idText: string | undefined;
  if (type === 'vpc') {
    name = cfg.name || data.label;
    subtitle = [cfg.cidrBlock, data.region].filter(Boolean).join(' · ');
    idText = cfg.vpcId && cfg.vpcId !== name ? cfg.vpcId : undefined;
  } else if (type === 'subnet') {
    name = cfg.name || data.label;
    subtitle = [cfg.public ? 'public' : 'private', cfg.availabilityZone, cfg.cidrBlock].filter(Boolean).join(' · ');
    idText = cfg.subnetId && cfg.subnetId !== name ? cfg.subnetId : undefined;
  } else {
    name = data.label;
    subtitle = [cfg.subtitle, data.region].filter(Boolean).join(' · ');
  }

  return (
    <div
      className={`relative w-full h-full rounded-xl border-2 ${style.border} ${style.bg} ${selected ? 'ring-2 ring-blue-500' : ''} ${isDraft ? 'border-dotted' : ''}`}
      style={{ minWidth: 200, minHeight: 100 }}
    >
      <BidirectionalHandles nodeId={id} />
      <div className={`flex items-baseline gap-2 px-3 pt-2 pb-1 ${style.header}`}>
        {kind === 'secrets' ? <Lock size={14} className="self-center" /> : <Icon size={14} className="self-center" />}
        {type === 'enclosure' && <span className="text-[10px] opacity-60 tabular-nums">{childCount}</span>}
        <span className="text-xs font-semibold truncate">{name}</span>
        {subtitle && <span className="text-[10px] opacity-70 truncate">{subtitle}</span>}
        {idText && <span className="text-[10px] font-mono opacity-50 truncate" title={idText}>{idText}</span>}
        {isDraft && <span className="text-[10px] uppercase tracking-wide opacity-70">draft</span>}
      </div>

      {type === 'subnet' && childCount === 0 && (
        <div className="absolute inset-x-3 top-10 bottom-3 rounded-lg border border-dashed border-gray-200 flex items-center justify-center pointer-events-none">
          <span className="text-[11px] text-gray-400 italic">{isDraft ? 'new subnet · nothing in it yet' : 'empty'}</span>
        </div>
      )}

      {type === 'vpc' && !readOnly && (
        <button
          onClick={(e) => { e.stopPropagation(); addSubnet(id); }}
          className="nodrag absolute right-3 top-10 bottom-3 w-10 rounded-lg border-2 border-dashed border-indigo-200 text-indigo-300 hover:text-indigo-600 hover:border-indigo-400 hover:bg-white/60 flex items-center justify-center"
          title="Add a subnet"
        >
          <Plus size={16} />
        </button>
      )}
    </div>
  );
}

export default memo(ContainerNode);
