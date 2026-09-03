// Account -> project: the app side of `warpcore discover project`.
//
// Two jobs. First, a live preview: the same glob semantics as the CLI, run
// over the inventory already in the Explorer, so the operator sees what a
// pattern selects before spending a scan. Second, the canvas: the CLI's
// payload becomes React Flow nodes and edges. The canvas is a map, not a
// list (DESIGN_GUIDANCE.md §9): VPCs and subnets are groups that contain
// what runs in them, security groups are badges on their members, secrets
// and keys sit in a vault and a keyring, sub-resources fold into their
// parent's inspector, and every edge carries the layer it belongs on.

import { Edge, Node } from 'reactflow';
import { invoke } from '@tauri-apps/api/core';
import { BASELINE_NAME_PREFIXES, BASELINE_TYPES, DiscoveredResource, formatBytes, shortType } from './accountExplorer';
import { isResourceBasedConnection } from './rolePolicy';
import { orderParentsFirst } from './nodeTree';
import { isOpenToWorld } from './nodeName';
import { Activity, Boxes, Cloud, Database, Globe, KeyRound, LucideIcon, Mail, Network, Settings, UserSquare, Vault } from 'lucide-react';
import { Layer, layerFor } from './layers';

// ---------------------------------------------------------------- payload

export interface ProjectItem {
  name: string;
  type: string;           // canvas node type
  arn: string;
  region: string | null;
  config: Record<string, unknown>;
  tags: Record<string, string>;
  role_arn?: string | null;
  attached_to?: string[];
  /** ARN of the resource this one belongs inside (a volume's instance). */
  folded_into?: string;
  /** What the service said about the resource's state, and why. */
  health?: { level: 'ok' | 'warn' | 'unknown'; reason: string };
}

export type ConnectionKind = 'role' | 'reference' | 'access' | 'event-source' | 'event-target' | 'dlq' | 'vpc' | 'logs' | 'invokes' | 'dns' | 'origin';

export interface ProjectConnection {
  from_arn: string;
  to_arn: string;
  kind: ConnectionKind;
  detail: string;
  /** Access edges: the role that grants it and a sample of the actions. */
  via?: string;
  actions?: string[];
}

export interface ProjectNote {
  level: 'warning' | 'info';
  physical_id: string;
  message: string;
}

export interface AccountProject {
  account: string;
  regions: Record<string, number>;
  project: { name: string; region: string };
  environment: { key: string; account: string; region: string };
  agents: ProjectItem[];
  resources: ProjectItem[];
  roles: ProjectItem[];
  connections: ProjectConnection[];
  counts: { included: number; shown: number; skipped: number; connections: number; excluded: number };
  skipped: Record<string, number>;
  notes: ProjectNote[];
  adopted: number | null;
  state_path?: string;
  explorer: boolean;
  errors: { physical_id: string; type: string; stage: string; message: string }[];
}

export interface CreateProjectOptions {
  profile: string;
  projectDir: string;
  projectName: string;
  environment: string;
  regions: string[];
  allRegions: boolean;
  include: string[];
  exclude: string[];
  lambdaAs: 'agent' | 'lambda';
  includeEnvValues: boolean;
  adopt: boolean;
  parallelism?: number;
}

export async function createProjectFromAccount(opts: CreateProjectOptions): Promise<AccountProject> {
  const raw = await invoke<string>('create_project_from_account', {
    profile: opts.profile,
    projectDir: opts.projectDir,
    projectName: opts.projectName,
    environment: opts.environment,
    regions: opts.regions,
    allRegions: opts.allRegions,
    include: opts.include,
    exclude: opts.exclude,
    lambdaAs: opts.lambdaAs,
    includeEnvValues: opts.includeEnvValues,
    adopt: opts.adopt,
    parallelism: opts.parallelism ?? null,
  });
  const parsed = JSON.parse(raw) as { event?: string; data?: AccountProject };
  const project = parsed.event === 'result' ? parsed.data : (parsed as AccountProject);
  if (!project || !Array.isArray(project.resources)) throw new Error('project scan returned no result');
  return project;
}

// -------------------------------------------------------------- selection
//
// Mirrors warpcore/discovery/project_emitter.py. Keep the two in step: the
// preview must select exactly what the CLI will.

/** AWS type -> canvas node type. Lambda is decided per run. */
export const CANVAS_TYPES: Record<string, string> = {
  'AWS::S3::Bucket': 's3',
  'AWS::DynamoDB::Table': 'dynamodb',
  'AWS::SQS::Queue': 'sqs',
  'AWS::SNS::Topic': 'sns',
  'AWS::Kinesis::Stream': 'kinesis-stream',
  'AWS::KinesisFirehose::DeliveryStream': 'kinesis-firehose',
  'AWS::Events::Rule': 'eventbridge-rule',
  'AWS::Events::EventBus': 'eventbridge',
  'AWS::Pipes::Pipe': 'eventbridge-pipes',
  'AWS::ApiGateway::RestApi': 'api-gateway',
  'AWS::ApiGatewayV2::Api': 'api-gateway',
  'AWS::IAM::Role': 'iam-role',
  'AWS::EC2::SecurityGroup': 'security-group',
  'AWS::EC2::VPC': 'vpc',
  'AWS::CloudWatch::Alarm': 'cloudwatch-alarm',
  'AWS::CloudWatch::Dashboard': 'cloudwatch-dashboard',
  'AWS::Logs::LogGroup': 'log-group',
  'AWS::SecretsManager::Secret': 'secrets-manager',
  'AWS::SSM::Parameter': 'ssm-parameter',
  'AWS::StepFunctions::StateMachine': 'step-functions',
  'AWS::ECR::Repository': 'ecr',
  // Infrastructure drawn from an account; see discoveredTypes.ts.
  'AWS::EC2::Instance': 'ec2-instance',
  'AWS::EC2::Subnet': 'subnet',
  'AWS::EC2::InternetGateway': 'internet-gateway',
  'AWS::EC2::NatGateway': 'nat-gateway',
  'AWS::EC2::RouteTable': 'route-table',
  'AWS::EC2::VPCEndpoint': 'vpc-endpoint',
  'AWS::EC2::EIP': 'elastic-ip',
  'AWS::EC2::Volume': 'ebs-volume',
  'AWS::EC2::Snapshot': 'ebs-snapshot',
  'AWS::ElasticLoadBalancingV2::LoadBalancer': 'load-balancer',
  'AWS::ElasticLoadBalancing::LoadBalancer': 'load-balancer',
  'AWS::CloudFront::Distribution': 'cloudfront',
  'AWS::Cloudfront::Distribution': 'cloudfront',
  'AWS::Route53::HostedZone': 'route53-zone',
  'AWS::Route53::Hostedzone': 'route53-zone',
  'AWS::KMS::Key': 'kms-key',
  'AWS::ACM::Certificate': 'acm-certificate',
  'AWS::Acm::Certificate': 'acm-certificate',
  'AWS::IAM::InstanceProfile': 'iam-instance-profile',
  'AWS::IAM::User': 'iam-user',
  'AWS::IAM::Policy': 'iam-policy',
  'AWS::RDS::DBInstance': 'rds-instance',
  'AWS::RDS::DBCluster': 'rds-cluster',
  'AWS::ECS::Cluster': 'ecs-cluster',
  'AWS::ECS::Service': 'ecs-service',
  'AWS::EKS::Cluster': 'eks-cluster',
  'AWS::ElastiCache::CacheCluster': 'elasticache-cluster',
  'AWS::Elasticache::Cluster': 'elasticache-cluster',
};
export const LAMBDA_TYPE = 'AWS::Lambda::Function';
/** Anything without a node of its own is still drawn, as a plain box. */
export const GENERIC_TYPE = 'aws-resource';

/** True when the type has a node of its own rather than the generic box. */
export function hasOwnNode(awsType: string): boolean {
  return awsType === LAMBDA_TYPE || awsType in CANVAS_TYPES;
}

function globToRegExp(glob: string): RegExp {
  let out = '^';
  for (const ch of glob) {
    if (ch === '*') out += '.*';
    else if (ch === '?') out += '.';
    else if (ch === '[' || ch === ']') out += ch;
    else out += ch.replace(/[.+^${}()|\\/]/g, '\\$&');
  }
  return new RegExp(out + '$', 'i');
}

function candidates(r: DiscoveredResource): Record<string, string[]> {
  const type = r.type || '';
  return {
    type: [type, type.replace(/^AWS::/, ''), CANVAS_TYPES[type] || '', type === LAMBDA_TYPE ? 'lambda' : ''],
    name: [r.id || ''],
    arn: [r.physical_id || ''],
    region: [r.region || ''],
    tag: Object.entries(r.tags || {}).map(([k, v]) => `${k}=${v}`),
  };
}

export function matchesPattern(pattern: string, r: DiscoveredResource): boolean {
  const p = pattern.trim();
  if (!p) return false;
  if (p === '*') return true;
  const fields = candidates(r);
  const lower = p.toLowerCase();
  for (const prefix of ['type:', 'name:', 'tag:', 'region:']) {
    if (lower.startsWith(prefix)) {
      const re = globToRegExp(lower.slice(prefix.length));
      return fields[prefix.slice(0, -1)].some((c) => c && re.test(c));
    }
  }
  const re = globToRegExp(lower);
  return Object.values(fields).some((values) => values.some((c) => c && re.test(c)));
}

export function selectResources(
  resources: DiscoveredResource[],
  include: string[],
  exclude: string[],
): { kept: DiscoveredResource[]; dropped: DiscoveredResource[] } {
  const inc = include.map((p) => p.trim()).filter(Boolean);
  const exc = exclude.map((p) => p.trim()).filter(Boolean);
  const effective = inc.length ? inc : ['*'];
  const kept: DiscoveredResource[] = [];
  const dropped: DiscoveredResource[] = [];
  for (const r of resources) {
    let wanted = effective.some((p) => matchesPattern(p, r));
    if (wanted && exc.some((p) => matchesPattern(p, r))) wanted = false;
    (wanted ? kept : dropped).push(r);
  }
  return { kept, dropped };
}

/** Exclude patterns that reproduce the Explorer's "hide baseline" filter. */
export function baselineExcludes(): string[] {
  return [
    ...[...BASELINE_TYPES].map((t) => `type:${t}`),
    ...BASELINE_NAME_PREFIXES.map((p) => `name:${p}*`),
  ];
}

// ----------------------------------------------------------------- canvas

/** What a node carries beyond its config. Persisted through warpcore.yaml. */
export interface NodeMeta {
  /** Security groups this node is a member of, for the badges. */
  securityGroups?: { id: string; name: string }[];
  /** Sub-resources folded into this node's inspector. */
  attachments?: { type: string; name: string; arn: string; detail?: string }[];
  /** Rendered as a container; children carry parentNode. */
  isGroup?: boolean;
  /** For synthetic enclosures: what they collect. */
  enclosure?: EnclosureKind;
  /** Why a node carries a warning status. */
  warning?: string;
  /** Where the node's colour came from. */
  health?: { level: 'ok' | 'warn' | 'unknown'; reason: string };
}

export interface EdgeMeta {
  layer: Layer;
  discovered?: { kind: ConnectionKind; detail: string };
  access?: { level: string; via: string; actions: string[] };
}

// Everything outside a VPC is collected into a labelled group by role, the
// way secrets already sat in a vault. Groups are laid out in columns, left
// to right in the order things happen: what reaches in, what runs, what it
// reads and writes, what protects it, what watches it.
export type EnclosureKind =
  | 'edge' | 'messaging' | 'compute' | 'data' | 'secrets' | 'keys' | 'config' | 'identity' | 'observability' | 'network' | 'other';

export interface EnclosureInfo {
  label: string;
  subtitle: string;
  column: number;
  types: string[];
  icon: LucideIcon;
  /** Tailwind classes for the container: border, background, header text. */
  border: string;
  bg: string;
  header: string;
}

export const ENCLOSURES: Record<EnclosureKind, EnclosureInfo> = {
  edge: { label: 'Edge & DNS', subtitle: 'CloudFront, Route 53, certificates, APIs', column: 0,
    types: ['cloudfront', 'route53-zone', 'acm-certificate', 'api-gateway', 'api-route', 'load-balancer'],
    icon: Globe, border: 'border-violet-300', bg: 'bg-violet-50/40', header: 'text-violet-800' },
  messaging: { label: 'Messaging & Events', subtitle: 'queues, topics, streams, rules', column: 0,
    types: ['sqs', 'sns', 'kinesis-stream', 'kinesis-firehose', 'eventbridge', 'eventbridge-rule', 'eventbridge-pipes'],
    icon: Mail, border: 'border-purple-300', bg: 'bg-purple-50/40', header: 'text-purple-800' },
  compute: { label: 'Compute', subtitle: 'agents, functions, state machines, clusters', column: 1,
    types: ['agent', 'lambda', 'step-functions', 'bedrock', 'ecs-cluster', 'ecs-service', 'eks-cluster', 'ec2-instance'],
    icon: Boxes, border: 'border-blue-300', bg: 'bg-blue-50/40', header: 'text-blue-800' },
  data: { label: 'Data & Storage', subtitle: 'buckets, tables, databases, registries', column: 2,
    types: ['s3', 'dynamodb', 'rds-instance', 'rds-cluster', 'elasticache-cluster', 'ecr', 'ebs-volume', 'ebs-snapshot'],
    icon: Database, border: 'border-orange-300', bg: 'bg-orange-50/40', header: 'text-orange-800' },
  secrets: { label: 'Secrets', subtitle: 'Secrets Manager and SecureString parameters', column: 3, types: ['secrets-manager'],
    icon: Vault, border: 'border-red-300', bg: 'bg-red-50/40', header: 'text-red-800' },
  keys: { label: 'Keys', subtitle: 'KMS keys', column: 3, types: ['kms-key'],
    icon: KeyRound, border: 'border-amber-300', bg: 'bg-amber-50/40', header: 'text-amber-800' },
  config: { label: 'Configuration', subtitle: 'SSM parameters', column: 3, types: ['ssm-parameter'],
    icon: Settings, border: 'border-gray-300', bg: 'bg-gray-50/60', header: 'text-gray-700' },
  identity: { label: 'Identity', subtitle: 'instance profiles, users, policies', column: 4,
    types: ['iam-instance-profile', 'iam-user', 'iam-policy'],
    icon: UserSquare, border: 'border-yellow-300', bg: 'bg-yellow-50/40', header: 'text-yellow-800' },
  observability: { label: 'Observability', subtitle: 'log groups, alarms, dashboards', column: 4,
    types: ['log-group', 'cloudwatch-alarm', 'cloudwatch-dashboard'],
    icon: Activity, border: 'border-emerald-300', bg: 'bg-emerald-50/40', header: 'text-emerald-800' },
  network: { label: 'Network', subtitle: 'outside any VPC', column: 4,
    types: ['internet-gateway', 'nat-gateway', 'route-table', 'vpc-endpoint', 'elastic-ip', 'security-group', 'subnet'],
    icon: Network, border: 'border-indigo-300', bg: 'bg-indigo-50/30', header: 'text-indigo-800' },
  other: { label: 'Other', subtitle: 'no node of their own yet', column: 4, types: ['aws-resource'],
    icon: Cloud, border: 'border-gray-300', bg: 'bg-gray-50/40', header: 'text-gray-700' },
};
const COLUMNS = 5;

const ENCLOSURE_OF_TYPE: Record<string, EnclosureKind> = Object.fromEntries(
  (Object.entries(ENCLOSURES) as [EnclosureKind, EnclosureInfo][]).flatMap(([kind, info]) => info.types.map((t) => [t, kind])),
);

/** Which group a top-level node belongs in. SecureString parameters are secrets. */
export function enclosureFor(node: Node): EnclosureKind {
  if (node.type === 'ssm-parameter') return node.data?.config?.secure ? 'secrets' : 'config';
  return ENCLOSURE_OF_TYPE[node.type || ''] ?? 'other';
}

const BAND_GAP = 140;

// Cells inside groups. Nodes measure themselves; these are the spacing the
// layout assumes, generous enough for the widest label. Exported so the
// "+ subnet" affordance in subnets.ts places new partitions on the same grid.
export const CELL_W = 250;
export const CELL_H = 84;
export const GROUP_HEADER = 44;
export const GROUP_PAD = 20;
export const GROUP_GAP = 12;
/** Room the VPC keeps on its right for the "+ subnet" column. */
export const ADD_COLUMN_W = 56;
const ADD_COLUMN_MIN_H = 120;
export const SUBNET_MIN_H = 150;
/** Slim column for a subnet with nothing in it. */
export const EMPTY_SUBNET_W = 64;
const EMPTY_SUBNET_H = 120;

/** Which layout band a node belongs to; global services join the busiest region. */
export function regionBand(node: Node): string {
  const raw = (node.data?.region as string | undefined) || '';
  return raw === 'global' || raw === 'aws-global' ? '' : raw;
}

/** Append to a map of lists without copying the list each time. */
function pushTo<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/**
 * Lowercase, hyphenated, trimmed. With `leadingLetter`, anything before the
 * first letter goes too, which is the project and agent name rule.
 */
export function slug(s: string, maxLength = 48, leadingLetter = false): string {
  let out = s.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  if (leadingLetter) out = out.replace(/^[^a-z]+/, '');
  return out.replace(/^-+|-+$/g, '').slice(0, maxLength);
}

export interface BuiltCanvas {
  nodes: Node[];
  edges: Edge[];
  /** How many connections could not be drawn because an end was missing. */
  droppedConnections: number;
}

interface Box { w: number; h: number }

export function buildCanvas(project: AccountProject): BuiltCanvas {
  const usedIds = new Set<string>();
  const idFor = (type: string, name: string): string => {
    const base = `${type}-${slug(name) || 'node'}`;
    let id = base;
    let n = 2;
    while (usedIds.has(id)) id = `${base}-${n++}`;
    usedIds.add(id);
    return id;
  };

  const byArn = new Map<string, Node>();
  const itemByArn = new Map<string, ProjectItem>();
  const nodes: Node[] = [];

  // ---- folding: a folded item becomes an attachment of its parent, transitively.
  const all = [...project.agents, ...project.resources];
  for (const item of all) itemByArn.set(item.arn, item);
  const foldTarget = (item: ProjectItem): ProjectItem | null => {
    let current = item;
    for (let hops = 0; hops < 4; hops++) {
      if (!current.folded_into) return current === item ? null : current;
      const parent = itemByArn.get(current.folded_into);
      if (!parent) return current === item ? null : current;
      current = parent;
    }
    return current;
  };
  const folded = new Map<string, ProjectItem>(); // folded arn -> drawn ancestor
  for (const item of all) {
    if (!item.folded_into) continue;
    const target = foldTarget(item);
    if (target && target !== item && !target.folded_into) folded.set(item.arn, target);
  }

  const metaOf = (node: Node): NodeMeta => (node.data.meta ||= {} as NodeMeta);

  for (const item of all) {
    if (folded.has(item.arn)) continue;
    // Colour is earned: green only when the service reported a running
    // state, amber when it reported something else, white when it said
    // nothing. The reason travels with the node.
    const health = item.health ?? { level: 'unknown' as const, reason: 'found in the account' };
    const status = health.level === 'ok' ? 'deployed' : health.level === 'warn' ? 'warning' : 'present';
    const node: Node = {
      id: idFor(item.type, item.name),
      type: item.type,
      position: { x: 0, y: 0 },
      data: {
        label: item.name,
        config: { ...item.config },
        status,
        arn: item.arn,
        region: item.region ?? undefined,
        meta: { health, ...(health.level === 'warn' ? { warning: health.reason } : {}) } as NodeMeta,
      },
    };
    byArn.set(item.arn, node);
    nodes.push(node);
  }
  for (const [arn, target] of folded) {
    const item = itemByArn.get(arn)!;
    const parent = byArn.get(target.arn);
    if (!parent) continue;
    const meta = metaOf(parent);
    (meta.attachments ||= []).push({
      type: item.type === GENERIC_TYPE ? String(item.config.awsType || item.type) : item.type,
      name: item.name,
      arn: item.arn,
      detail: describeAttachment(item),
    });
  }
  for (const role of project.roles) {
    const node: Node = {
      id: idFor('iam-role', role.name),
      type: 'iam-role',
      position: { x: 0, y: 0 },
      hidden: true,
      data: { label: role.name, config: { ...role.config }, status: 'deployed', arn: role.arn, meta: {} as NodeMeta },
    };
    byArn.set(role.arn, node);
    nodes.push(node);
  }

  // ---- containment and membership, read off the connections.
  const parentOf = new Map<string, string>();   // child id -> parent id
  const roleOf = new Map<string, string>();
  const sgMembers = new Map<string, Set<string>>();
  for (const c of project.connections) {
    const from = byArn.get(c.from_arn);
    const to = byArn.get(c.to_arn);
    if (!from || !to) continue;
    if (c.kind === 'role' && c.detail !== 'instance profile' && c.detail !== 'profile role') {
      roleOf.set(from.id, to.id);
    }
    if (c.kind === 'vpc') {
      if (c.detail === 'in subnet' && to.type === 'subnet') parentOf.set(from.id, to.id);
      else if ((c.detail === 'in VPC' || c.detail === 'attached to VPC') && to.type === 'vpc' && !parentOf.has(from.id)) parentOf.set(from.id, to.id);
      else if (c.detail === 'security group' && to.type === 'security-group') {
        sgMembers.set(to.id, (sgMembers.get(to.id) || new Set()).add(from.id));
        (metaOf(from).securityGroups ||= []).push({ id: to.id, name: String(to.data.config?.groupName || to.data.label) });
      }
    }
  }
  // Security-group members and the default-group warning.
  for (const node of nodes) {
    if (node.type !== 'security-group') continue;
    const members = sgMembers.get(node.id) || new Set();
    node.data.config = { ...node.data.config, memberCount: members.size };
    const cfg = node.data.config as Record<string, unknown>;
    const openRules = ((cfg.inboundRules as string[]) || []).filter(isOpenToWorld).join('; ');
    const warning = !cfg.openToWorld || members.size === 0
      ? null
      : cfg.isDefault
        ? `The default security group admits traffic from anywhere (${openRules}) and ${members.size} resource${members.size === 1 ? ' is' : 's are'} in it.`
        : `Open to the internet: ${openRules}.`;
    if (warning) {
      node.data.status = 'warning';
      const meta = metaOf(node);
      meta.warning = warning;
      meta.health = { level: 'warn', reason: warning };
    }
  }

  // ---- enclosures: every top-level node outside a VPC joins a group by role,
  // one group per role per region.
  const enclosures: Node[] = [];
  const loose = nodes.filter((n) => !n.hidden && n.type !== 'vpc' && !parentOf.has(n.id));
  // Global services (IAM, CloudFront, Route 53) join the busiest region's
  // groups rather than forming a second "Edge & DNS" of their own.
  const regionCounts = new Map<string, number>();
  for (const n of loose) { const r = regionBand(n); if (r) regionCounts.set(r, (regionCounts.get(r) || 0) + 1); }
  const primaryRegion = [...regionCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '';
  const buckets = new Map<string, Node[]>();
  for (const n of loose) {
    pushTo(buckets, `${enclosureFor(n)}|${regionBand(n) || primaryRegion}`, n);
  }
  for (const [key, members] of buckets) {
    const [kind, region] = key.split('|') as [EnclosureKind, string];
    const info = ENCLOSURES[kind];
    const node: Node = {
      id: idFor('enclosure', `${kind}-${region || 'global'}`),
      type: 'enclosure',
      position: { x: 0, y: 0 },
      data: {
        label: info.label,
        config: { name: info.label, subtitle: info.subtitle, kind },
        status: 'present',
        region: region || undefined,
        meta: { isGroup: true, enclosure: kind } as NodeMeta,
      },
    };
    enclosures.push(node);
    for (const m of members) parentOf.set(m.id, node.id);
  }
  nodes.push(...enclosures);

  // Mark groups.
  const childrenOf = new Map<string, Node[]>();
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  for (const [child, parent] of parentOf) {
    const c = nodeById.get(child);
    const p = nodeById.get(parent);
    if (!c || !p || c.hidden) continue;
    pushTo(childrenOf, parent, c);
  }
  for (const parent of childrenOf.keys()) metaOf(nodeById.get(parent)!).isGroup = true;
  for (const n of nodes) {
    if (n.type === 'subnet' && parentOf.has(n.id)) metaOf(n).isGroup = true;
  }

  // ---- edges
  const edges: Edge[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  // An edge to something folded away lands on the node it folded into: a
  // policy over a managed instance is a policy over the instance.
  const drawn = (arn: string): Node | undefined => byArn.get(folded.get(arn)?.arn ?? arn);
  for (const c of project.connections) {
    if (c.kind === 'role' && c.detail !== 'instance profile') continue;
    const source = drawn(c.from_arn);
    const target = drawn(c.to_arn);
    if (!source || !target) { dropped++; continue; }
    if (source.id === target.id) continue;
    // Containment is drawn as nesting, not as an arrow.
    if (c.kind === 'vpc' && (c.detail === 'in subnet' || c.detail === 'in VPC' || c.detail === 'attached to VPC') && parentOf.get(source.id) === target.id) continue;
    // Folded sub-resources are not edges from their own parent.
    if ((folded.has(c.from_arn) && folded.get(c.from_arn)!.arn === c.to_arn) || (folded.has(c.to_arn) && folded.get(c.to_arn)!.arn === c.from_arn)) continue;

    if (c.kind === 'dlq') {
      source.data.config = { ...source.data.config, dlq: { enabled: true, targetId: target.id, maxRetries: 3 } };
      continue;
    }

    const key = `${source.id}->${target.id}:${c.kind === 'access' ? 'access' : 'other'}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const resourceBased = isResourceBasedConnection(source.type || '', target.type || '');
    const roleId = resourceBased ? undefined : (roleOf.get(source.id) ?? roleOf.get(target.id));
    const meta: EdgeMeta = {
      layer: layerFor(c.kind, c.detail),
      discovered: { kind: c.kind, detail: c.detail },
      ...(c.kind === 'access' ? { access: { level: c.detail, via: c.via || '', actions: c.actions || [] } } : {}),
    };
    edges.push({
      id: `edge-${key}`,
      source: source.id,
      target: target.id,
      type: 'permission',
      data: { roleId, isResourceBased: resourceBased, config: {}, meta },
    });
  }

  // ---- layout
  layout(nodes, edges, childrenOf, parentOf);

  // Handles depend on final (absolute) positions.
  const absolute = (n: Node): { x: number; y: number } => {
    let x = n.position.x;
    let y = n.position.y;
    let p = n.parentNode ? nodeById.get(n.parentNode) : undefined;
    while (p) { x += p.position.x; y += p.position.y; p = p.parentNode ? nodeById.get(p.parentNode) : undefined; }
    return { x, y };
  };
  for (const e of edges) {
    const a = absolute(nodeById.get(e.source)!);
    const b = absolute(nodeById.get(e.target)!);
    if (b.x > a.x + 40) { e.sourceHandle = 'right-2-source'; e.targetHandle = 'left-2-target'; }
    else if (b.x < a.x - 40) { e.sourceHandle = 'left-2-source'; e.targetHandle = 'right-2-target'; }
    else if (b.y > a.y) { e.sourceHandle = 'bottom-2-source'; e.targetHandle = 'top-2-target'; }
    else { e.sourceHandle = 'top-2-source'; e.targetHandle = 'bottom-2-target'; }
  }

  // React Flow needs parents before children.
  return { nodes: orderParentsFirst(nodes), edges, droppedConnections: dropped };
}

function describeAttachment(item: ProjectItem): string {
  const c = item.config as Record<string, unknown>;
  if (item.type === 'ebs-volume') return [c.size ? `${c.size} GiB` : '', c.volumeType, c.encrypted ? 'encrypted' : ''].filter(Boolean).join(' · ');
  if (item.type === 'ebs-snapshot') return [c.size ? `${c.size} GiB` : '', c.description].filter(Boolean).join(' · ');
  if (item.type === 'log-group') {
    const size = typeof c.storedBytes === 'number' ? formatBytes(c.storedBytes) : '';
    return [c.retentionDays ? `${c.retentionDays}d retention` : 'never expires', size].filter(Boolean).join(' · ');
  }
  return c.awsType ? shortType(String(c.awsType)) : '';
}

/**
 * Layered layout with containment. Per region band: VPC groups on the left
 * (subnets inside them, public first, laid out in a grid; VPC-level things
 * such as security groups and gateways in a top strip), then the columns
 * for everything regional or global, then the vault and keyring.
 */
function layout(nodes: Node[], edges: Edge[], childrenOf: Map<string, Node[]>, parentOf: Map<string, string>): void {
  const isGroup = (n: Node) => Boolean(n.data?.meta?.isGroup);

  const neighbours = new Map<string, string[]>();
  for (const e of edges) {
    pushTo(neighbours, e.source, e.target);
    pushTo(neighbours, e.target, e.source);
  }

  // Size a group from its children, bottom-up.
  const sizeOf = new Map<string, Box>();
  const measure = (n: Node): Box => {
    if (sizeOf.has(n.id)) return sizeOf.get(n.id)!;
    let box: Box;
    if (!isGroup(n)) {
      box = { w: CELL_W, h: CELL_H };
    } else if (n.type === 'vpc') {
      box = layoutVpc(n, childrenOf, measure);
    } else if (n.type === 'enclosure') {
      box = layoutGrid(n, childrenOf.get(n.id) || [], measure, neighbours);
    } else {
      box = layoutStack(n, childrenOf.get(n.id) || [], measure);
    }
    sizeOf.set(n.id, box);
    n.style = { ...(n.style || {}), width: box.w, height: box.h };
    return box;
  };

  // Top-level nodes only; children are positioned by their group.
  const top = nodes.filter((n) => !n.hidden && !parentOf.has(n.id));
  const bands = new Map<string, Node[]>();
  for (const n of top) pushTo(bands, regionBand(n), n);
  const regionOrder = [...bands.keys()].filter((r) => r).sort((a, b) => bands.get(b)!.length - bands.get(a)!.length);
  const globals = bands.get('') || [];
  if (regionOrder.length === 0) regionOrder.push('');
  else bands.set(regionOrder[0], [...(bands.get(regionOrder[0]) || []), ...globals]);

  let bandTop = 60;
  for (const region of regionOrder) {
    const members = bands.get(region) || [];
    const vpcs = members.filter((n) => n.type === 'vpc');
    const enclosures = members.filter((n) => n.type === 'enclosure');

    // VPC groups, stacked on the left.
    let y = bandTop;
    let vpcWidth = 0;
    for (const vpc of vpcs) {
      const box = measure(vpc);
      vpc.position = { x: 60, y };
      y += box.h + 60;
      vpcWidth = Math.max(vpcWidth, box.w);
    }
    const columnsLeft = 60 + (vpcs.length ? vpcWidth + 120 : 0);

    // Enclosures, in their columns; a column stacks its groups vertically
    // and is as wide as its widest group.
    const encColumns: Node[][] = Array.from({ length: COLUMNS }, () => []);
    for (const enc of enclosures) encColumns[ENCLOSURES[(enc.data?.meta?.enclosure as EnclosureKind) || 'other'].column].push(enc);
    let ex = columnsLeft;
    let encBottom = bandTop;
    for (const col of encColumns) {
      col.sort((a, b) => ENCLOSURES[a.data.meta.enclosure as EnclosureKind].label.localeCompare(ENCLOSURES[b.data.meta.enclosure as EnclosureKind].label));
      let cy = bandTop;
      let colWidth = 0;
      for (const enc of col) {
        const box = measure(enc);
        enc.position = { x: ex, y: cy };
        cy += box.h + 40;
        colWidth = Math.max(colWidth, box.w);
      }
      if (col.length) {
        ex += colWidth + 60;
        encBottom = Math.max(encBottom, cy - 40);
      }
    }

    const bandHeight = Math.max(y - bandTop, encBottom - bandTop, CELL_H);
    bandTop += bandHeight + BAND_GAP;
  }
}

/**
 * Children in a grid inside a labelled box: one column for a few, up to
 * three for many. Rows are ordered so members with edges to the same
 * things sit together.
 */
function layoutGrid(group: Node, children: Node[], measure: (n: Node) => Box, neighbours: Map<string, string[]>): Box {
  const key = new Map(children.map((c) => [c.id, (neighbours.get(c.id) || []).slice().sort().join(',')]));
  children.sort((a, b) => {
    const na = key.get(a.id)!;
    const nb = key.get(b.id)!;
    return (nb ? 1 : 0) - (na ? 1 : 0) || na.localeCompare(nb) || String(a.data?.label).localeCompare(String(b.data?.label));
  });
  const cols = children.length <= 3 ? 1 : children.length <= 8 ? 2 : 3;
  let maxW = CELL_W;
  let maxH = CELL_H;
  for (const child of children) {
    const b = measure(child);
    maxW = Math.max(maxW, b.w);
    maxH = Math.max(maxH, b.h);
  }
  children.forEach((child, i) => {
    child.parentNode = group.id;
    child.extent = 'parent';
    child.position = { x: GROUP_PAD + (i % cols) * (maxW + GROUP_GAP), y: GROUP_HEADER + Math.floor(i / cols) * (maxH + GROUP_GAP) };
  });
  const rows = Math.ceil(children.length / cols);
  return { w: GROUP_PAD * 2 + cols * maxW + (cols - 1) * GROUP_GAP, h: GROUP_HEADER + GROUP_PAD + rows * maxH + Math.max(0, rows - 1) * GROUP_GAP };
}

/** Children stacked vertically inside a labelled box. */
function layoutStack(group: Node, children: Node[], measure: (n: Node) => Box): Box {
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

/** A VPC: a strip of VPC-level things on top, subnets in a grid below. */
function layoutVpc(vpc: Node, childrenOf: Map<string, Node[]>, measure: (n: Node) => Box): Box {
  const children = childrenOf.get(vpc.id) || [];
  const subnets = children.filter((n) => n.type === 'subnet');
  const strip = children.filter((n) => n.type !== 'subnet');
  const typeRank: Record<string, number> = { 'internet-gateway': 0, 'nat-gateway': 1, 'route-table': 2, 'vpc-endpoint': 3, 'security-group': 4 };
  strip.sort((a, b) => (typeRank[a.type || ''] ?? 9) - (typeRank[b.type || ''] ?? 9) || String(a.data?.label).localeCompare(String(b.data?.label)));

  let x = GROUP_PAD;
  let y = GROUP_HEADER;
  let width = 0;
  for (const n of strip) {
    const box = measure(n);
    n.parentNode = vpc.id;
    n.extent = 'parent';
    n.position = { x, y };
    x += box.w + 16;
    width = Math.max(width, x);
  }
  if (strip.length) y += CELL_H + 24;

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
  let cx = GROUP_PAD;
  subnets.forEach((subnet, i) => {
    subnet.parentNode = vpc.id;
    subnet.extent = 'parent';
    subnet.position = { x: cx, y };
    subnet.style = { ...(subnet.style || {}), width: boxes[i].w, height: columnHeight };
    cx += boxes[i].w + GROUP_GAP;
  });
  width = Math.max(width, cx + ADD_COLUMN_W);
  const bottom = subnets.length ? y + columnHeight : y + ADD_COLUMN_MIN_H;
  return { w: Math.max(width + GROUP_PAD, CELL_W + GROUP_PAD * 2), h: Math.max(bottom + GROUP_PAD, GROUP_HEADER + CELL_H) };
}
