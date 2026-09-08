// A node that can be a container: an application tile with bands inside
// it, a band holding what it is about, a VPC with subnets as partitions, a
// subnet holding what runs in it, or (from older imports) an enclosure.
// Without children a VPC is an ordinary resource node; a subnet inside a
// VPC is always a partition, and says so when it is empty rather than
// looking broken.

import { memo } from 'react';
import { Cloud, EyeOff, Layers, Lock, Plus, LayoutGrid } from 'lucide-react';
import { NodeStatus, useReadOnly, useStore } from '../../store/useStore';
import { addSubnet } from '../../utils/subnets';
import { ENCLOSURES, EnclosureKind, NodeMeta } from '../../utils/projectFromAccount';
import { BANDS, BandKind } from '../../utils/stackLayout';
import BidirectionalHandles from './BidirectionalHandles';
import ResourceNode from './ResourceNode';

interface Data {
  label: string;
  status?: NodeStatus;
  config?: Record<string, any>;
  region?: string;
  meta?: NodeMeta & { band?: BandKind; hiddenCount?: number; compact?: boolean };
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
  application: { border: 'border-gray-300', bg: 'bg-white', header: 'text-gray-900', icon: LayoutGrid },
};

function styleFor(type: string, kind: string) {
  if (type === 'enclosure') {
    const info = ENCLOSURES[kind as EnclosureKind] ?? ENCLOSURES.other;
    return { border: `${info.border} border-dashed`, bg: info.bg, header: info.header, icon: info.icon };
  }
  if (type === 'band') {
    const info = BANDS[kind as BandKind] ?? BANDS.platform;
    return { border: info.border, bg: info.bg, header: info.header, icon: info.icon };
  }
  return CONTAINER_STYLE[type] ?? CONTAINER_STYLE.vpc;
}

function ContainerNode({ id, data, selected, type }: Props) {
  const childCount = useStore((s) => s.nodes.filter((n) => n.parentNode === id && !n.hidden).length);
  const lens = useStore((s) => s.lens);
  const setLens = useStore((s) => s.setLens);
  const readOnly = useReadOnly();
  const meta = data.meta || {};
  if (!meta.isGroup) {
    return <ResourceNode id={id} data={data} selected={selected} type={type} />;
  }
  const kind = type === 'enclosure' ? (meta.enclosure || 'other') : type === 'band' ? (meta.band || 'platform') : type;
  const style = styleFor(type, kind);
  const Icon = style.icon;
  const cfg = data.config || {};
  const isDraft = data.status === 'draft';
  const hiddenCount = meta.hiddenCount || 0;

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

  // The application tile: a plain bounded frame with a title row. Bands
  // inside it carry the colour.
  if (type === 'application') {
    return (
      <div
        className={`relative w-full h-full rounded-xl border ${style.border} ${style.bg} shadow-sm ${selected ? 'ring-2 ring-blue-500' : ''}`}
        style={{ minWidth: 200, minHeight: 100 }}
      >
        <BidirectionalHandles nodeId={id} />
        <div className="flex items-baseline gap-3 px-4 pt-2.5 pb-1">
          <Icon size={14} className="self-center text-gray-400" />
          <span className="text-sm font-semibold text-gray-900 truncate">{cfg.name || data.label}</span>
          {cfg.subtitle && <span className="text-[11px] text-gray-500 truncate">{cfg.subtitle}</span>}
          {hiddenCount > 0 && (
            <button
              onClick={(e) => { e.stopPropagation(); setLens('all'); }}
              className="nodrag ml-auto inline-flex items-center gap-1 text-[10px] text-gray-500 hover:text-gray-800 bg-gray-100 hover:bg-gray-200 rounded-full px-2 py-0.5"
              title={`${hiddenCount} resource${hiddenCount === 1 ? '' : 's'} hidden by the ${lens} lens. Click to show everything.`}
            >
              <EyeOff size={10} /> {hiddenCount} hidden
            </button>
          )}
        </div>
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
  } else if (type === 'band') {
    const info = BANDS[kind as BandKind] ?? BANDS.platform;
    name = info.label;
    subtitle = info.subtitle;
  } else {
    name = data.label;
    subtitle = [cfg.subtitle, data.region].filter(Boolean).join(' · ');
  }

  const band = type === 'band';
  return (
    <div
      className={`relative w-full h-full ${band ? 'rounded-lg border' : 'rounded-xl border-2'} ${style.border} ${style.bg} ${selected ? 'ring-2 ring-blue-500' : ''} ${isDraft ? 'border-dotted' : ''}`}
      style={{ minWidth: 200, minHeight: band ? 56 : 100 }}
    >
      <BidirectionalHandles nodeId={id} />
      <div className={`flex items-baseline gap-2 ${band ? 'px-3.5 pt-1.5 pb-0.5' : 'px-3 pt-2 pb-1'} ${style.header}`}>
        {kind === 'secrets' ? <Lock size={14} className="self-center" /> : <Icon size={band ? 12 : 14} className="self-center" />}
        {band
          ? <span className="text-[10px] font-semibold uppercase tracking-wider">{name}</span>
          : <span className="text-xs font-semibold truncate">{name}</span>}
        {(type === 'enclosure' || band) && <span className="text-[10px] opacity-60 tabular-nums">{childCount}</span>}
        {subtitle && <span className="text-[10px] opacity-70 truncate">{subtitle}</span>}
        {idText && <span className="text-[10px] font-mono opacity-50 truncate" title={idText}>{idText}</span>}
        {isDraft && <span className="text-[10px] uppercase tracking-wide opacity-70">draft</span>}
        {band && hiddenCount > 0 && (
          <button
            onClick={(e) => { e.stopPropagation(); setLens('all'); }}
            className="nodrag ml-auto inline-flex items-center gap-1 text-[10px] normal-case tracking-normal font-medium opacity-80 hover:opacity-100 bg-white/70 rounded-full px-2 py-px border border-current/20"
            title={`${hiddenCount} hidden by the ${lens} lens. Click to show everything.`}
          >
            <EyeOff size={10} /> {hiddenCount} hidden
          </button>
        )}
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
