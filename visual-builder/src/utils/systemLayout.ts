// The system view's geometry, derived from the canvas. Nothing here knows
// about WebGL: it turns the nodes and edges (and, when a lens is on, the
// re-flowed positions) into plates, cards and links in world units, so the
// scene can be rebuilt from it and the numbers can be tested.
//
// An imported account's bands become terraces: the entry band is the
// highest plate, platform the lowest, and each keeps its footprint from
// the canvas, so the request walks down the stairs the way it reads on
// the canvas. VPCs and subnets are thin slabs on their band. A hand-drawn
// canvas is one sheet with every card on it.

import { Node, Edge } from 'reactflow';
import { BandKind, BAND_ORDER, CHIP_W, CHIP_H } from './stackLayout';

/** Canvas pixels per world unit. */
export const UNIT = 100;
/** Vertical distance between one band's plate and the next. */
export const LEVEL_H = 0.9;
export const PLATE_T = 0.08;
export const CARD_H = 0.2;
/** Height of a VPC or subnet slab, and how far a card inside one is raised. */
export const SLAB_T = 0.04;

export const BAND_COLORS: Record<BandKind, number> = {
  entry: 0xddd6fe, compute: 0xbae6fd, bus: 0xe9d5ff, data: 0xfed7aa, platform: 0xe5e7eb,
};
export const BAND_TITLES: Record<BandKind, string> = {
  entry: 'Entry', compute: 'Compute', bus: 'Bus', data: 'Data', platform: 'Platform',
};

export type SlabKind = 'band' | 'vpc' | 'subnet' | 'sheet';

export interface Slab {
  id: string;
  kind: SlabKind;
  label: string;
  band?: BandKind;
  /** Centre of the slab, world units. */
  x: number; y: number; z: number;
  w: number; d: number; t: number;
  color: number;
}

export interface Card {
  id: string;
  label: string;
  type: string;
  /** Centre of the card's base, world units. */
  x: number; y: number; z: number;
  w: number; d: number;
  compact: boolean;
  band?: BandKind;
}

export interface Caption {
  id: string;
  text: string;
  x: number; y: number; z: number;
}

export type LinkKind = 'flow' | 'access' | 'logs' | 'structure' | 'drawn';

export interface Link {
  id: string;
  from: string;
  to: string;
  kind: LinkKind;
}

export interface SystemLayout {
  slabs: Slab[];
  cards: Card[];
  links: Link[];
  captions: Caption[];
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number; minY: number; maxY: number };
}

export interface ViewOverrides {
  placed?: Map<string, { position: { x: number; y: number }; style: Record<string, unknown> }>;
  hidden?: Set<string>;
}

const FLOW_KINDS = new Set(['event-source', 'event-target', 'invokes', 'dns', 'origin', 'dlq']);
const DEFAULT_W = 200;
const DEFAULT_H = 72;

function levelY(band: BandKind | undefined): number {
  if (!band) return 0;
  return (BAND_ORDER.length - 1 - BAND_ORDER.indexOf(band)) * LEVEL_H;
}

export function linkKind(edge: Edge): LinkKind {
  const meta = (edge.data?.meta || {}) as { discovered?: { kind: string }; access?: unknown };
  if (meta.access) return 'access';
  if (edge.data?.isDLQ) return 'flow';
  const kind = meta.discovered?.kind;
  if (!kind) return 'drawn';
  if (kind === 'logs') return 'logs';
  if (FLOW_KINDS.has(kind)) return 'flow';
  return 'structure';
}

export function layoutSystem(nodes: Node[], edges: Edge[], view: ViewOverrides = {}): SystemLayout {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const visible = (n: Node): boolean => !n.hidden && !view.hidden?.has(n.id) && (!n.parentNode || (byId.has(n.parentNode) && visible(byId.get(n.parentNode)!)));
  const position = (n: Node) => view.placed?.get(n.id)?.position ?? n.position;
  const size = (n: Node): { w: number; h: number } => {
    const style = { ...(n.style || {}), ...(view.placed?.get(n.id)?.style || {}) } as { width?: unknown; height?: unknown };
    const w = typeof style.width === 'number' ? style.width : n.width ?? (n.data?.meta?.compact ? CHIP_W : DEFAULT_W);
    const h = typeof style.height === 'number' ? style.height : n.height ?? (n.data?.meta?.compact ? CHIP_H : DEFAULT_H);
    return { w, h };
  };
  const absolute = (n: Node): { x: number; y: number } => {
    const p = position(n);
    const parent = n.parentNode ? byId.get(n.parentNode) : undefined;
    if (!parent) return { x: p.x, y: p.y };
    const pp = absolute(parent);
    return { x: pp.x + p.x, y: pp.y + p.y };
  };
  const bandOf = (n: Node): BandKind | undefined => {
    let cur: Node | undefined = n;
    while (cur) {
      if (cur.type === 'band' && cur.data?.meta?.band) return cur.data.meta.band as BandKind;
      cur = cur.parentNode ? byId.get(cur.parentNode) : undefined;
    }
    return undefined;
  };
  /** How many VPC/subnet slabs a node sits on within its band. */
  const depth = (n: Node): number => {
    let d = 0;
    let cur = n.parentNode ? byId.get(n.parentNode) : undefined;
    while (cur) {
      if (cur.type === 'vpc' || cur.type === 'subnet') d += 1;
      cur = cur.parentNode ? byId.get(cur.parentNode) : undefined;
    }
    return d;
  };

  const slabs: Slab[] = [];
  const cards: Card[] = [];
  const captions: Caption[] = [];
  const cardIds = new Set<string>();
  const shown = nodes.filter(visible);
  const stack = shown.some((n) => n.type === 'band');

  for (const n of shown) {
    const { x, y } = absolute(n);
    const { w, h } = size(n);
    const band = bandOf(n);
    const base = levelY(band);
    const isGroup = Boolean(n.data?.meta?.isGroup);
    const cx = (x + w / 2) / UNIT;
    const cz = (y + h / 2) / UNIT;
    if (n.type === 'application') {
      captions.push({ id: n.id, text: String(n.data?.config?.name || n.data?.label || n.id), x: x / UNIT, y: levelY('entry') + 0.6, z: y / UNIT });
      continue;
    }
    if (n.type === 'band' && band) {
      slabs.push({ id: n.id, kind: 'band', label: BAND_TITLES[band], band, x: cx, y: base, z: cz, w: w / UNIT, d: h / UNIT, t: PLATE_T, color: BAND_COLORS[band] });
      continue;
    }
    if (isGroup && (n.type === 'vpc' || n.type === 'subnet')) {
      const lift = PLATE_T / 2 + depth(n) * SLAB_T + SLAB_T / 2;
      slabs.push({
        id: n.id, kind: n.type, label: String(n.data?.config?.name || n.data?.label || n.id), band,
        x: cx, y: base + lift, z: cz, w: w / UNIT, d: h / UNIT, t: SLAB_T, color: n.type === 'vpc' ? 0xc7d2fe : 0xe0e7ff,
      });
      continue;
    }
    if (isGroup) continue; // enclosures and anything else that only contains
    const lift = (stack ? PLATE_T / 2 : 0) + depth(n) * SLAB_T;
    cards.push({
      id: n.id, label: String(n.data?.config?.name || n.data?.label || n.id), type: n.type || 'resource',
      x: cx, y: base + lift, z: cz, w: w / UNIT, d: h / UNIT, compact: Boolean(n.data?.meta?.compact), band,
    });
    cardIds.add(n.id);
  }

  // A band plate is as wide as its tile on the canvas, where the grid needs
  // it; here it is trimmed to what sits on it, so a terrace with two cards
  // is not a runway.
  if (stack) {
    const rightOf = new Map<string, number>();
    const note = (n: Node, right: number) => {
      const band = bandOf(n);
      if (!band) return;
      let cur: Node | undefined = n;
      while (cur && cur.type !== 'band') cur = cur.parentNode ? byId.get(cur.parentNode) : undefined;
      if (cur) rightOf.set(cur.id, Math.max(rightOf.get(cur.id) ?? 0, right));
    };
    for (const c of cards) { const n = byId.get(c.id); if (n) note(n, c.x + c.w / 2); }
    for (const sl of slabs) { if (sl.kind === 'vpc' || sl.kind === 'subnet') { const n = byId.get(sl.id); if (n) note(n, sl.x + sl.w / 2); } }
    for (const sl of slabs) {
      if (sl.kind !== 'band') continue;
      const right = rightOf.get(sl.id);
      if (right === undefined) continue;
      const left = sl.x - sl.w / 2;
      const w = Math.max(2, right + 0.25 - left);
      if (w < sl.w) { sl.w = w; sl.x = left + w / 2; }
    }
  }

  // A hand-drawn canvas: one sheet under everything.
  if (!stack && cards.length) {
    const minX = Math.min(...cards.map((c) => c.x - c.w / 2)) - 0.5;
    const maxX = Math.max(...cards.map((c) => c.x + c.w / 2)) + 0.5;
    const minZ = Math.min(...cards.map((c) => c.z - c.d / 2)) - 0.5;
    const maxZ = Math.max(...cards.map((c) => c.z + c.d / 2)) + 0.5;
    slabs.push({ id: 'sheet', kind: 'sheet', label: '', x: (minX + maxX) / 2, y: -PLATE_T / 2, z: (minZ + maxZ) / 2, w: maxX - minX, d: maxZ - minZ, t: PLATE_T, color: 0xf3f4f6 });
  }

  const links: Link[] = [];
  for (const e of edges) {
    if (!cardIds.has(e.source) || !cardIds.has(e.target)) continue;
    links.push({ id: e.id, from: e.source, to: e.target, kind: linkKind(e) });
  }

  const xs = [...slabs.map((s) => s.x - s.w / 2), ...slabs.map((s) => s.x + s.w / 2), ...cards.map((c) => c.x)];
  const zs = [...slabs.map((s) => s.z - s.d / 2), ...slabs.map((s) => s.z + s.d / 2), ...cards.map((c) => c.z)];
  const ys = [...slabs.map((s) => s.y), ...cards.map((c) => c.y + CARD_H)];
  const bounds = xs.length
    ? { minX: Math.min(...xs), maxX: Math.max(...xs), minZ: Math.min(...zs), maxZ: Math.max(...zs), minY: Math.min(...ys), maxY: Math.max(...ys) }
    : { minX: -1, maxX: 1, minZ: -1, maxZ: 1, minY: 0, maxY: 1 };
  return { slabs, cards, links, captions, bounds };
}
