// Lenses: whole-picture views of the canvas. A layer (layers.ts) shows or
// hides one kind of edge; a lens answers a question - "what is the security
// picture?", "how is this networked?", "where does data flow?", "what does it
// cost?" - by choosing the edge layers *and* deciding which nodes are the
// subject and which are context. Context nodes stay on the canvas, dimmed,
// so the map keeps its shape; nothing is ever hidden.
//
// The selected node and everything it touches are always the subject,
// whatever the lens: selection is the operator saying "this one".

import { Node, Edge } from 'reactflow';
import { DEFAULT_LAYERS, Layer } from './layers';

export type Lens = 'all' | 'security' | 'network' | 'dataflow' | 'cost';

export interface LensInfo {
  id: Lens;
  label: string;
  /** What the lens is for, in one line. Shown as the tooltip and in the palette. */
  description: string;
  /** Digit key that switches to it when nothing has keyboard focus. */
  key: string;
}

export const LENSES: LensInfo[] = [
  { id: 'all', label: 'All', description: 'Everything, with triggers and access drawn', key: '1' },
  { id: 'security', label: 'Security', description: 'Who can reach or read what: groups, roles, secrets, keys, and anything flagged', key: '2' },
  { id: 'network', label: 'Network', description: 'VPCs, subnets, gateways, routes, load balancers and what sits inside them', key: '3' },
  { id: 'dataflow', label: 'Data flow', description: 'Agents, functions, queues, topics, streams and stores, with what triggers what', key: '4' },
  { id: 'cost', label: 'Cost', description: 'Every resource with its monthly estimate on it', key: '5' },
];

export const DEFAULT_LENS: Lens = 'all';

/** The edge layers a lens turns on. Choosing a lens replaces the layer set. */
export const LENS_LAYERS: Record<Lens, Record<Layer, boolean>> = {
  all: { ...DEFAULT_LAYERS },
  security: { triggers: false, access: true, network: true, encryption: true, plumbing: false },
  network: { triggers: false, access: false, network: true, encryption: false, plumbing: false },
  dataflow: { triggers: true, access: true, network: false, encryption: false, plumbing: false },
  cost: { triggers: true, access: false, network: false, encryption: false, plumbing: false },
};

const SECURITY_TYPES = new Set([
  'security-group', 'iam-role', 'iam-user', 'iam-policy', 'iam-instance-profile',
  'secrets-manager', 'ssm-parameter', 'kms-key', 'acm-certificate',
]);

const NETWORK_TYPES = new Set([
  'vpc', 'subnet', 'internet-gateway', 'nat-gateway', 'route-table', 'vpc-endpoint', 'elastic-ip',
  'load-balancer', 'cloudfront', 'route53-zone', 'security-group', 'api-gateway', 'api-route',
]);

const DATAFLOW_TYPES = new Set([
  'agent', 'lambda', 'sqs', 'sns', 'kinesis-stream', 'kinesis-firehose', 'eventbridge', 'eventbridge-rule',
  'eventbridge-pipes', 'step-functions', 's3', 'dynamodb', 'api-gateway', 'api-route', 'bedrock',
  'ec2-instance', 'rds-instance', 'rds-cluster', 'ecs-service', 'load-balancer', 'cloudfront', 'elasticache-cluster',
]);

export type Emphasis = 'focus' | 'context';

export interface LensContext {
  /** Every node, so a node's parent can be looked up. */
  byId: Map<string, Node>;
  /** The selected node and its direct neighbours; always the subject. */
  pinned: Set<string>;
}

/** The nodes a selection pins: itself and everything one edge away. */
export function pinnedBySelection(selectedId: string | null, edges: Edge[]): Set<string> {
  const pinned = new Set<string>();
  if (!selectedId) return pinned;
  pinned.add(selectedId);
  for (const e of edges) {
    if (e.source === selectedId) pinned.add(e.target);
    if (e.target === selectedId) pinned.add(e.source);
  }
  return pinned;
}

function isGroup(node: Node): boolean {
  return Boolean(node.data?.meta?.isGroup);
}

function insideNetwork(node: Node, byId: Map<string, Node>): boolean {
  let parent = node.parentNode ? byId.get(node.parentNode) : undefined;
  while (parent) {
    if (parent.type === 'vpc' || parent.type === 'subnet') return true;
    parent = parent.parentNode ? byId.get(parent.parentNode) : undefined;
  }
  return false;
}

/**
 * Whether a node is the subject of the lens or context around it. Containers
 * (VPCs, subnets, the vault) are always drawn normally: they are the map.
 */
export function lensEmphasis(node: Node, lens: Lens, ctx: LensContext): Emphasis {
  if (lens === 'all' || lens === 'cost') return 'focus';
  if (ctx.pinned.has(node.id)) return 'focus';
  if (isGroup(node)) return 'focus';
  const type = node.type || '';
  switch (lens) {
    case 'security':
      if (SECURITY_TYPES.has(type)) return 'focus';
      if (node.data?.meta?.warning) return 'focus';
      if ((node.data?.meta?.securityGroups?.length ?? 0) > 0) return 'focus';
      return 'context';
    case 'network':
      if (NETWORK_TYPES.has(type)) return 'focus';
      if (insideNetwork(node, ctx.byId)) return 'focus';
      return 'context';
    case 'dataflow':
      return DATAFLOW_TYPES.has(type) ? 'focus' : 'context';
  }
  return 'focus';
}

/** How many nodes a lens would foreground, for the lens bar's counts. */
export function countFocus(nodes: Node[], edges: Edge[], lens: Lens, selectedId: string | null): number {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const pinned = pinnedBySelection(selectedId, edges);
  return nodes.filter((n) => !n.hidden && lensEmphasis(n, lens, { byId, pinned }) === 'focus').length;
}
