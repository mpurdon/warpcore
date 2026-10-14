// The application stack: how an imported account is drawn.
//
// One tile per application, five bands inside it in request order - entry,
// compute (with the VPC inside it), bus, data, platform - each band a grid
// of bounded width, so the tile reads top to bottom the way a request flows
// and fits a screen at a legible zoom. Platform resources are chips: many,
// rarely the subject, one click from the inspector.
//
// Everything here is pure geometry over React Flow nodes: it reads
// `parentNode` to find containment and writes `position` and `style`.
// buildCanvas() calls it on a fresh import; the canvas calls it again on a
// visible subset when a lens removes nodes, so the tile re-flows.

import { Edge, Node } from 'reactflow';
import { Activity, Boxes, Database, Globe, LucideIcon, Mail } from 'lucide-react';

export type BandKind = 'entry' | 'compute' | 'bus' | 'data' | 'platform';

export interface BandInfo {
  label: string;
  subtitle: string;
  types: string[];
  icon: LucideIcon;
  /** Tailwind classes for the container: border, background, header text. */
  border: string;
  bg: string;
  header: string;
}

export const BAND_ORDER: BandKind[] = ['entry', 'compute', 'bus', 'data', 'platform'];

export const BANDS: Record<BandKind, BandInfo> = {
  entry: { label: 'Entry', subtitle: 'where traffic arrives',
    types: ['cloudfront', 'route53-zone', 'acm-certificate', 'api-gateway', 'api-route', 'load-balancer', 'cognito', 'waf'],
    icon: Globe, border: 'border-violet-200', bg: 'bg-violet-50/60', header: 'text-violet-800' },
  compute: { label: 'Compute', subtitle: 'what serves it',
    types: ['agent', 'lambda', 'step-functions', 'bedrock', 'ecs-cluster', 'ecs-service', 'eks-cluster', 'ec2-instance', 'vpc',
      'internet-gateway', 'nat-gateway', 'route-table', 'vpc-endpoint', 'security-group', 'subnet', 'glue', 'athena'],
    icon: Boxes, border: 'border-sky-200', bg: 'bg-sky-50/60', header: 'text-sky-800' },
  bus: { label: 'Bus', subtitle: 'queues, topics, streams, rules',
    types: ['sqs', 'sns', 'kinesis-stream', 'kinesis-firehose', 'eventbridge', 'eventbridge-rule', 'eventbridge-pipes'],
    icon: Mail, border: 'border-purple-200', bg: 'bg-purple-50/60', header: 'text-purple-800' },
  data: { label: 'Data', subtitle: 'what it owns',
    types: ['s3', 'dynamodb', 'rds-instance', 'rds-cluster', 'elasticache-cluster', 'ecr', 'ebs-volume', 'ebs-snapshot', 'opensearch'],
    icon: Database, border: 'border-orange-200', bg: 'bg-orange-50/60', header: 'text-orange-800' },
  platform: { label: 'Platform', subtitle: 'roles, secrets, keys, parameters, logs, alarms',
    types: ['secrets-manager', 'kms-key', 'ssm-parameter', 'iam-instance-profile', 'iam-user', 'iam-policy', 'iam-role',
      'log-group', 'cloudwatch-alarm', 'cloudwatch-dashboard', 'elastic-ip', 'aws-resource'],
    icon: Activity, border: 'border-gray-200', bg: 'bg-gray-50/80', header: 'text-gray-600' },
};

const BAND_OF_TYPE: Record<string, BandKind> = Object.fromEntries(
  (Object.entries(BANDS) as [BandKind, BandInfo][]).flatMap(([kind, info]) => info.types.map((t) => [t, kind])),
);

/** Which band a resource belongs in. */
export function bandFor(node: Pick<Node, 'type'>): BandKind {
  return BAND_OF_TYPE[node.type || ''] ?? 'platform';
}

// ------------------------------------------------------------------ sizes

// Cells inside groups. Nodes measure themselves; these are the spacing the
// layout assumes, generous enough for the widest label. subnets.ts uses the
// same grid for the "+ subnet" affordance.
export const CELL_W = 250;
export const CELL_H = 84;
/** A platform chip: compact, one line. */
export const CHIP_W = 160;
export const CHIP_H = 40;
export const GROUP_HEADER = 44;
export const GROUP_PAD = 20;
export const GROUP_GAP = 12;
/** Room the VPC keeps on its right for the "+ subnet" column. */
export const ADD_COLUMN_W = 56;
const ADD_COLUMN_MIN_H = 120;
export const SUBNET_MIN_H = 150;
/** Slim column for a subnet with nothing in it. */
export const EMPTY_SUBNET_W = 64;
/** Chips across the VPC's plumbing strip when there are no subnets to set the width. */
const STRIP_MIN_COLS = 3;
const EMPTY_SUBNET_H = 120;

/** Columns of full cells across a tile. Sets the tile's width. */
export const TILE_COLS = 4;
const TILE_GAP = 80;
const TILE_TOP = 60;
const TILE_LEFT = 60;
const BAND_HEADER = 32;
const BAND_PAD = 14;

export interface Box { w: number; h: number }

const isGroup = (n: Node) => Boolean(n.data?.meta?.isGroup);
const isCompact = (n: Node) => Boolean(n.data?.meta?.compact);

export function pushTo<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/** Parent and children maps read off `parentNode`, for the given nodes only. */
export function containment(nodes: Node[]): { parentOf: Map<string, string>; childrenOf: Map<string, Node[]> } {
  const ids = new Set(nodes.map((n) => n.id));
  const parentOf = new Map<string, string>();
  const childrenOf = new Map<string, Node[]>();
  for (const n of nodes) {
    if (n.parentNode && ids.has(n.parentNode)) {
      parentOf.set(n.id, n.parentNode);
      pushTo(childrenOf, n.parentNode, n);
    }
  }
  return { parentOf, childrenOf };
}

/**
 * Lay out every node in place. Application tiles are placed side by side;
 * anything else at top level (a hand-drawn canvas, an old import) is left
 * where it is.
 */
export function layoutStackCanvas(nodes: Node[]): void {
  const { parentOf, childrenOf } = containment(nodes);
  const sizeOf = new Map<string, Box>();

  const measure = (n: Node): Box => {
    const cached = sizeOf.get(n.id);
    if (cached) return cached;
    let box: Box;
    if (!isGroup(n)) {
      box = isCompact(n) ? { w: CHIP_W, h: CHIP_H } : { w: CELL_W, h: CELL_H };
    } else if (n.type === 'vpc') {
      box = layoutVpc(n, childrenOf, measure);
    } else if (n.type === 'application') {
      box = layoutTile(n, childrenOf, measure);
    } else if (n.type === 'band') {
      // Bands are sized by their tile so every band is the same width.
      box = layoutBand(n, childrenOf.get(n.id) || [], measure, tileInnerWidth(n, childrenOf, measure));
    } else {
      box = layoutStack(n, childrenOf.get(n.id) || [], measure);
    }
    sizeOf.set(n.id, box);
    n.style = { ...(n.style || {}), width: box.w, height: box.h };
    return box;
  };

  const tiles = nodes.filter((n) => !n.hidden && n.type === 'application' && !parentOf.has(n.id));
  let x = TILE_LEFT;
  for (const tile of tiles) {
    const box = measure(tile);
    tile.position = { x, y: TILE_TOP };
    x += box.w + TILE_GAP;
  }
}

/** The widest thing a tile has to hold: four columns, or its widest VPC. */
function tileInnerWidth(band: Node, childrenOf: Map<string, Node[]>, measure: (n: Node) => Box): number {
  const tileId = band.type === 'application' ? band.id : band.parentNode;
  const bands = tileId ? childrenOf.get(tileId) || [] : [band];
  let inner = TILE_COLS * CELL_W + (TILE_COLS - 1) * GROUP_GAP;
  const widest = (children: Node[]) => {
    for (const child of children) if (child.type === 'vpc') inner = Math.max(inner, measure(child).w);
  };
  widest(bands);
  for (const b of bands) widest(childrenOf.get(b.id) || []);
  return inner;
}

/**
 * A tile: its bands stacked in request order. A tile with a single band
 * holds the members itself (buildCanvas skips the band), laid out the same
 * way under the tile's own header.
 */
function layoutTile(tile: Node, childrenOf: Map<string, Node[]>, measure: (n: Node) => Box): Box {
  const children = childrenOf.get(tile.id) || [];
  const bands = children.filter((b) => b.type === 'band');
  const members = children.filter((b) => b.type !== 'band');
  bands.sort((a, b) => BAND_ORDER.indexOf(a.data?.meta?.band) - BAND_ORDER.indexOf(b.data?.meta?.band));
  const inner = tileInnerWidth(tile, childrenOf, measure);
  let y = GROUP_HEADER;
  for (const band of bands) {
    const box = measure(band);
    band.parentNode = tile.id;
    band.extent = 'parent';
    band.position = { x: GROUP_PAD, y };
    y += box.h + GROUP_GAP;
  }
  if (members.length) {
    const kind = (tile.data?.meta?.band as BandKind) || 'compute';
    y = layoutMembers(tile, members, kind, measure, GROUP_PAD + BAND_PAD, y, inner) + GROUP_GAP;
  }
  const w = inner + GROUP_PAD * 2 + BAND_PAD * 2;
  const h = Math.max(y - GROUP_GAP + GROUP_PAD, GROUP_HEADER + CELL_H);
  return { w, h };
}

/**
 * A band: a grid of its members across the tile's inner width. Compute puts
 * its VPCs on the right and the loose compute on the left; platform wraps
 * chips. Height follows content.
 */
function layoutBand(band: Node, children: Node[], measure: (n: Node) => Box, inner: number): Box {
  const kind = (band.data?.meta?.band as BandKind) || 'platform';
  const bottom = Math.max(layoutMembers(band, children, kind, measure, BAND_PAD, BAND_HEADER, inner), BAND_HEADER + (children.length ? 0 : 24));
  return { w: inner + BAND_PAD * 2, h: bottom + BAND_PAD };
}

/** Members of a band (or a one-band tile) from (left, top) across `width`; returns the bottom edge. */
function layoutMembers(container: Node, children: Node[], kind: BandKind, measure: (n: Node) => Box, left: number, top: number, width: number): number {
  const vpcs = children.filter((c) => c.type === 'vpc');
  const loose = children.filter((c) => c.type !== 'vpc');
  loose.sort((a, b) => String(a.data?.label).localeCompare(String(b.data?.label)));

  const place = (c: Node, x: number, y: number) => {
    c.parentNode = container.id;
    c.extent = 'parent';
    c.position = { x, y };
  };

  // VPCs: full rows on the right side, stacked.
  let vpcWidth = 0;
  for (const vpc of vpcs) vpcWidth = Math.max(vpcWidth, measure(vpc).w);
  let vy = top;
  for (const vpc of vpcs) {
    const box = measure(vpc);
    place(vpc, left + width - box.w, vy);
    vy += box.h + GROUP_GAP;
  }
  const vpcBottom = vpcs.length ? vy - GROUP_GAP : top;

  // The grid of everything else, in the room the VPCs leave.
  const cellW = kind === 'platform' ? CHIP_W : CELL_W;
  const cellH = kind === 'platform' ? CHIP_H : CELL_H;
  const room = vpcs.length ? Math.max(cellW, width - vpcWidth - GROUP_GAP) : width;
  const cols = Math.max(1, Math.floor((room + GROUP_GAP) / (cellW + GROUP_GAP)));
  loose.forEach((c, i) => {
    measure(c);
    place(c, left + (i % cols) * (cellW + GROUP_GAP), top + Math.floor(i / cols) * (cellH + GROUP_GAP));
  });
  const rows = Math.ceil(loose.length / cols);
  const looseBottom = rows ? top + rows * cellH + (rows - 1) * GROUP_GAP : top;
  return Math.max(looseBottom, vpcBottom);
}

/** Children stacked vertically inside a labelled box. */
export function layoutStack(group: Node, children: Node[], measure: (n: Node) => Box): Box {
  children.sort((a, b) => String(a.data?.label).localeCompare(String(b.data?.label)));
  let y = GROUP_HEADER;
  let w = CELL_W;
  for (const child of children) {
    const box = measure(child);
    child.parentNode = group.id;
    child.extent = 'parent';
    child.position = { x: GROUP_PAD, y };
    y += box.h + GROUP_GAP;
    w = Math.max(w, box.w);
  }
  return { w: w + GROUP_PAD * 2, h: Math.max(y + GROUP_PAD - GROUP_GAP, GROUP_HEADER + CELL_H) };
}

/**
 * A VPC: subnets in a row, with the VPC's own plumbing (gateways, route
 * tables, endpoints) as a strip of chips above them. The subnets set the
 * width; the strip wraps to it, so a VPC with many route tables is tall
 * rather than wide.
 */
export function layoutVpc(vpc: Node, childrenOf: Map<string, Node[]>, measure: (n: Node) => Box): Box {
  const children = childrenOf.get(vpc.id) || [];
  const subnets = children.filter((n) => n.type === 'subnet');
  const strip = children.filter((n) => n.type !== 'subnet');
  const typeRank: Record<string, number> = { 'internet-gateway': 0, 'nat-gateway': 1, 'vpc-endpoint': 2, 'route-table': 3, 'security-group': 4 };
  strip.sort((a, b) => (typeRank[a.type || ''] ?? 9) - (typeRank[b.type || ''] ?? 9) || String(a.data?.label).localeCompare(String(b.data?.label)));

  // Subnets are partitions: side-by-side columns of equal height, public
  // first, then by availability zone, the way a table editor shows columns.
  // A trailing gap is left for the "+ subnet" affordance the VPC draws.
  const isEmpty = (sn: Node) => (childrenOf.get(sn.id) || []).length === 0 && sn.data?.status !== 'draft';
  subnets.sort((a, b) => {
    const pa = a.data?.config?.public ? 0 : 1;
    const pb = b.data?.config?.public ? 0 : 1;
    // Populated first, so the slim empty ones gather at the right.
    return Number(isEmpty(a)) - Number(isEmpty(b)) || pa - pb
      || String(a.data?.config?.availabilityZone || '').localeCompare(String(b.data?.config?.availabilityZone || ''))
      || String(a.data?.label).localeCompare(String(b.data?.label));
  });
  // An empty subnet is a slim column with a vertical label: still a
  // partition, but it does not get the width of a populated one. The row's
  // height follows the populated subnets; with none, it is the slim height.
  const boxes = subnets.map((sn) => (isEmpty(sn) ? { w: EMPTY_SUBNET_W, h: EMPTY_SUBNET_H } : measure(sn)));
  const populated = boxes.filter((_, i) => !isEmpty(subnets[i]));
  const columnHeight = populated.length ? Math.max(SUBNET_MIN_H, ...populated.map((b) => b.h)) : EMPTY_SUBNET_H;
  const subnetsWidth = boxes.reduce((w, b) => w + b.w + GROUP_GAP, 0) - (boxes.length ? GROUP_GAP : 0);

  // The strip wraps to the subnets' width; with no subnets, to a few chips.
  const stripWidth = Math.max(subnetsWidth, STRIP_MIN_COLS * CHIP_W + (STRIP_MIN_COLS - 1) * GROUP_GAP);
  let y = GROUP_HEADER;
  if (strip.length) {
    const cols = Math.max(1, Math.floor((stripWidth + GROUP_GAP) / (CHIP_W + GROUP_GAP)));
    strip.forEach((n, i) => {
      const box = measure(n);
      n.parentNode = vpc.id;
      n.extent = 'parent';
      n.position = { x: GROUP_PAD + (i % cols) * (CHIP_W + GROUP_GAP), y: y + Math.floor(i / cols) * (box.h + GROUP_GAP) };
    });
    const rows = Math.ceil(strip.length / cols);
    y += rows * (measure(strip[0]).h + GROUP_GAP) + 8;
  }

  let cx = GROUP_PAD;
  subnets.forEach((subnet, i) => {
    subnet.parentNode = vpc.id;
    subnet.extent = 'parent';
    subnet.position = { x: cx, y };
    subnet.style = { ...(subnet.style || {}), width: boxes[i].w, height: columnHeight };
    cx += boxes[i].w + GROUP_GAP;
  });
  const width = Math.max(GROUP_PAD + stripWidth, cx) + ADD_COLUMN_W;
  const bottom = subnets.length ? y + columnHeight : y + ADD_COLUMN_MIN_H;
  return { w: Math.max(width + GROUP_PAD, CELL_W + GROUP_PAD * 2), h: Math.max(bottom + GROUP_PAD, GROUP_HEADER + CELL_H) };
}

/** Absolute position of a node, through its parents. */
export function absolutePosition(n: Node, byId: Map<string, Node>): { x: number; y: number } {
  let x = n.position.x;
  let y = n.position.y;
  let p = n.parentNode ? byId.get(n.parentNode) : undefined;
  while (p) { x += p.position.x; y += p.position.y; p = p.parentNode ? byId.get(p.parentNode) : undefined; }
  return { x, y };
}

/** Pick each edge's handles from where its ends ended up. */
export function assignHandles(nodes: Node[], edges: Edge[]): void {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const e of edges) {
    const s = byId.get(e.source);
    const t = byId.get(e.target);
    if (!s || !t) continue;
    const a = absolutePosition(s, byId);
    const b = absolutePosition(t, byId);
    const sw = Number(s.style?.width) || CELL_W;
    const tw = Number(t.style?.width) || CELL_W;
    // Vertical when the boxes overlap horizontally, which in a stack is
    // most of the time; sideways only when they clearly sit side by side.
    const overlap = Math.min(a.x + sw, b.x + tw) - Math.max(a.x, b.x);
    if (overlap > -40) {
      if (b.y > a.y) { e.sourceHandle = 'bottom-2-source'; e.targetHandle = 'top-2-target'; }
      else { e.sourceHandle = 'top-2-source'; e.targetHandle = 'bottom-2-target'; }
    } else if (b.x > a.x) { e.sourceHandle = 'right-2-source'; e.targetHandle = 'left-2-target'; }
    else { e.sourceHandle = 'left-2-source'; e.targetHandle = 'right-2-target'; }
  }
}

/** True when the canvas was laid out as application tiles. */
export function isStackCanvas(nodes: Node[]): boolean {
  return nodes.some((n) => n.type === 'application');
}

export interface Reflow {
  /** Ids that the lens removed. */
  hidden: Set<string>;
  /** New positions and sizes for what remains, keyed by id. */
  placed: Map<string, { position: { x: number; y: number }; style: Record<string, unknown> }>;
  /** Per band (and tile): how many nodes were removed inside it. */
  hiddenCount: Map<string, number>;
}

/**
 * Re-flow a stack canvas with some nodes removed by a lens. A container
 * with nothing visible inside it goes too; what remains is laid out again
 * as if the removed nodes never existed. Nothing is written to the input.
 */
export function reflowStack(nodes: Node[], keep: (n: Node) => boolean): Reflow {
  const { childrenOf } = containment(nodes);
  const visible = new Map<string, boolean>();
  const isVisible = (n: Node): boolean => {
    const cached = visible.get(n.id);
    if (cached !== undefined) return cached;
    let v: boolean;
    if (n.hidden) v = false;
    else if (isGroup(n)) v = (childrenOf.get(n.id) || []).some(isVisible);
    else v = keep(n);
    visible.set(n.id, v);
    return v;
  };
  for (const n of nodes) isVisible(n);

  const hidden = new Set(nodes.filter((n) => !n.hidden && !visible.get(n.id)).map((n) => n.id));
  const hiddenCount = new Map<string, number>();
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const id of hidden) {
    // Containers that went with their contents are not resources; only
    // count the resources.
    if (isGroup(byId.get(id)!)) continue;
    let p = byId.get(id)?.parentNode;
    while (p) {
      hiddenCount.set(p, (hiddenCount.get(p) || 0) + 1);
      p = byId.get(p)?.parentNode;
    }
  }

  const clones = nodes
    .filter((n) => visible.get(n.id))
    .map((n) => ({ ...n, position: { ...n.position }, style: { ...(n.style || {}) }, data: n.data }));
  layoutStackCanvas(clones);
  const placed = new Map<string, { position: { x: number; y: number }; style: Record<string, unknown> }>();
  for (const c of clones) placed.set(c.id, { position: c.position, style: (c.style || {}) as Record<string, unknown> });
  return { hidden, placed, hiddenCount };
}
