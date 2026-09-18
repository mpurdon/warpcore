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
import { clusterApplications, ClusterItem, SHARED_ID } from './applications';
import {
  assignHandles, bandFor, BandKind, BAND_ORDER, layoutStackCanvas,
  CELL_W, CELL_H, GROUP_HEADER, GROUP_PAD, GROUP_GAP, ADD_COLUMN_W, SUBNET_MIN_H, EMPTY_SUBNET_W,
} from './stackLayout';

// The grid constants moved to stackLayout.ts; re-exported for older callers.
export { CELL_W, CELL_H, GROUP_HEADER, GROUP_PAD, GROUP_GAP, ADD_COLUMN_W, SUBNET_MIN_H, EMPTY_SUBNET_W };

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
  /** Who deployed it, as the CLI worked out from tags, stacks and state files. */
  provenance?: NodeMeta['provenance'];
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
  /** Where the CLI kept this import's snapshot, and what changed since the previous one. */
  snapshot_path?: string | null;
  since_last_import?: import('./live').ImportDiff | null;
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
  'AWS::Cognito::UserPool': 'cognito',
  'AWS::OpenSearchService::Domain': 'opensearch',
  'AWS::Glue::Job': 'glue',
  'AWS::Athena::WorkGroup': 'athena',
  'AWS::WAFv2::WebACL': 'waf',
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
  /** The application this resource was clustered into, and why. */
  application?: { id: string; name: string; reason: string };
  /** For band containers: which band. */
  band?: BandKind;
  /** Drawn as a one-line chip (platform resources). */
  compact?: boolean;
  /** Set by the lens re-flow on containers: how many members it removed. Not persisted. */
  hiddenCount?: number;
  /** A note on the resource: the design decision worth teaching, in the author's words. */
  note?: string;
  /** Who deployed a discovered resource, as the import worked it out. */
  provenance?: { manager: string; stack?: string; address?: string; app?: string; stage?: string; logical_id?: string; urn?: string; evidence?: string };
  /** A discovered resource warpcore has taken over: its config is what a deploy enforces. */
  managed?: boolean;
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
    types: ['cloudfront', 'route53-zone', 'acm-certificate', 'api-gateway', 'api-route', 'load-balancer', 'cognito', 'waf'],
    icon: Globe, border: 'border-violet-300', bg: 'bg-violet-50/40', header: 'text-violet-800' },
  messaging: { label: 'Messaging & Events', subtitle: 'queues, topics, streams, rules', column: 0,
    types: ['sqs', 'sns', 'kinesis-stream', 'kinesis-firehose', 'eventbridge', 'eventbridge-rule', 'eventbridge-pipes'],
    icon: Mail, border: 'border-purple-300', bg: 'bg-purple-50/40', header: 'text-purple-800' },
  compute: { label: 'Compute', subtitle: 'agents, functions, state machines, clusters', column: 1,
    types: ['agent', 'lambda', 'step-functions', 'bedrock', 'ecs-cluster', 'ecs-service', 'eks-cluster', 'ec2-instance', 'glue', 'athena'],
    icon: Boxes, border: 'border-blue-300', bg: 'bg-blue-50/40', header: 'text-blue-800' },
  data: { label: 'Data & Storage', subtitle: 'buckets, tables, databases, registries', column: 2,
    types: ['s3', 'dynamodb', 'rds-instance', 'rds-cluster', 'elasticache-cluster', 'ecr', 'ebs-volume', 'ebs-snapshot', 'opensearch'],
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
const ENCLOSURE_OF_TYPE: Record<string, EnclosureKind> = Object.fromEntries(
  (Object.entries(ENCLOSURES) as [EnclosureKind, EnclosureInfo][]).flatMap(([kind, info]) => info.types.map((t) => [t, kind])),
);

/** Which legacy group a top-level node belongs in. SecureString parameters are secrets. */
export function enclosureFor(node: Node): EnclosureKind {
  if (node.type === 'ssm-parameter') return node.data?.config?.secure ? 'secrets' : 'config';
  return ENCLOSURE_OF_TYPE[node.type || ''] ?? 'other';
}

/** The VPC and what it is made of: these belong to whatever runs in them, and are never an application by themselves. */
const NETWORK_PLUMBING: ReadonlySet<string> = new Set(['vpc', 'subnet', 'security-group', 'internet-gateway', 'nat-gateway', 'route-table', 'vpc-endpoint', 'elastic-ip']);

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
        meta: {
          health,
          ...(health.level === 'warn' ? { warning: health.reason } : {}),
          ...(item.provenance ? { provenance: item.provenance } : {}),
        } as NodeMeta,
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
  // Security-group members and the default-group warning. A group is a
  // policy its members are in, not a box they connect to (DESIGN_GUIDANCE
  // §9.3): it stays in the store for the badges and the inspector, and is
  // never a card on the canvas.
  for (const node of nodes) {
    if (node.type !== 'security-group') continue;
    node.hidden = true;
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

  // ---- applications: every resource gets a home and a reason. VPCs and
  // what is inside them travel together; roles are hidden but still vote.
  const topLevelOf = (n: Node): Node => {
    let cur = n;
    for (let hops = 0; hops < 6 && parentOf.has(cur.id); hops++) cur = nodeById0.get(parentOf.get(cur.id)!) ?? cur;
    return cur;
  };
  const nodeById0 = new Map(nodes.map((n) => [n.id, n]));
  const tagsByNodeId = new Map<string, Record<string, string>>();
  for (const item of all) { const n = byArn.get(item.arn); if (n) tagsByNodeId.set(n.id, item.tags || {}); }
  for (const role of project.roles) { const n = byArn.get(role.arn); if (n) tagsByNodeId.set(n.id, role.tags || {}); }
  const clusterItems: ClusterItem[] = nodes.map((n) => ({
    id: n.id,
    name: String(n.data?.label ?? n.id),
    type: n.type || '',
    tags: tagsByNodeId.get(n.id),
    platform: bandFor(n) === 'platform' || NETWORK_PLUMBING.has(n.type || ''),
    parent: parentOf.get(n.id),
  }));
  const clusterLinks = project.connections.flatMap((c) => {
    const from = byArn.get(c.from_arn);
    const to = byArn.get(c.to_arn);
    return from && to ? [{ source: from.id, target: to.id }] : [];
  });
  const clustering = clusterApplications(clusterItems, clusterLinks, project.project.name);
  for (const n of nodes) {
    const a = clustering.assignments.get(n.id);
    if (a) metaOf(n).application = a;
  }

  // One tile per application, one band per kind that has members. A VPC
  // is a member of its application's compute band; things inside the VPC
  // stay inside it wherever it goes.
  const containers: Node[] = [];
  const regionsOf = new Map<string, Set<string>>();
  for (const app of clustering.applications) {
    const tileId = idFor('application', app.id);
    const members = nodes.filter((n) => !n.hidden && !parentOf.has(n.id) && (metaOf(topLevelOf(n)).application?.id ?? SHARED_ID) === app.id);
    if (members.length === 0) continue;
    const regions = new Set<string>();
    for (const m of members) { const r = regionBand(m); if (r) regions.add(r); }
    regionsOf.set(tileId, regions);
    const tile: Node = {
      id: tileId,
      type: 'application',
      position: { x: 0, y: 0 },
      data: {
        label: app.name,
        config: { name: app.name, subtitle: '' },
        status: 'present',
        meta: { isGroup: true, application: { id: app.id, name: app.name, reason: app.id === SHARED_ID ? 'used by more than one application' : 'application' } } as NodeMeta,
      },
    };
    containers.push(tile);
    // Every resource whose top-level ancestor is in this application,
    // counted before the bands take over as parents.
    const total = nodes.filter((n) => !n.hidden && n.type !== 'application' && n.type !== 'band'
      && (metaOf(topLevelOf(n)).application?.id ?? SHARED_ID) === app.id).length;
    const byBand = new Map<BandKind, Node[]>();
    for (const m of members) pushTo(byBand, bandFor(m), m);
    // One band is no band: a tile that is only a VPC, or only chips, holds
    // its members directly rather than under a heading that repeats the tile.
    if (byBand.size === 1) {
      const [kind, list] = [...byBand.entries()][0];
      tile.data.meta.band = kind;
      for (const m of list) {
        parentOf.set(m.id, tile.id);
        if (kind === 'platform') metaOf(m).compact = true;
      }
    }
    for (const kind of byBand.size === 1 ? [] : BAND_ORDER) {
      const list = byBand.get(kind);
      if (!list?.length) continue;
      const band: Node = {
        id: idFor('band', `${app.id}-${kind}`),
        type: 'band',
        position: { x: 0, y: 0 },
        data: { label: kind, config: { name: kind }, status: 'present', meta: { isGroup: true, band: kind } as NodeMeta },
      };
      containers.push(band);
      parentOf.set(band.id, tile.id);
      for (const m of list) {
        parentOf.set(m.id, band.id);
        if (kind === 'platform') metaOf(m).compact = true;
      }
    }
    tile.data.config.subtitle = [
      `${total} resource${total === 1 ? '' : 's'}`,
      [...regions].sort().join(', ') || 'global',
    ].join(' · ');
  }
  nodes.push(...containers);

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
    // Gateways, route tables and endpoints: the VPC's own plumbing, one line each.
    if (n.type !== 'subnet' && nodeById.get(parentOf.get(n.id) || '')?.type === 'vpc') metaOf(n).compact = true;
  }

  // ---- edges
  const isInside = (id: string, ancestor: string): boolean => {
    let p = parentOf.get(id);
    for (let hops = 0; p && hops < 8; hops++) { if (p === ancestor) return true; p = parentOf.get(p); }
    return false;
  };
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
    // Containment is drawn as nesting, not as an arrow: an instance in a
    // subnet of the VPC is inside the VPC.
    if (c.kind === 'vpc' && (c.detail === 'in subnet' || c.detail === 'in VPC' || c.detail === 'attached to VPC') && isInside(source.id, target.id)) continue;
    // Membership is the badge on the member.
    if (c.kind === 'vpc' && c.detail === 'security group' && target.type === 'security-group') continue;
    // Trust between groups is drawn between their members: "the bastion may
    // reach the hosts", on the network layer.
    if (c.kind === 'vpc' && source.type === 'security-group' && target.type === 'security-group') {
      const via = String(source.data.config?.groupName || source.data.label);
      for (const a of sgMembers.get(source.id) || []) {
        for (const b of sgMembers.get(target.id) || []) {
          if (a === b) continue;
          const pairKey = `${a}->${b}:other`;
          if (seen.has(pairKey)) continue;
          seen.add(pairKey);
          const meta: EdgeMeta = { layer: layerFor(c.kind, c.detail), discovered: { kind: c.kind, detail: `${c.detail} via ${via}` } };
          edges.push({ id: `edge-${pairKey}`, source: a, target: b, type: 'permission', data: { isResourceBased: true, config: {}, meta } });
        }
      }
      continue;
    }
    // Folded sub-resources are not edges from their own parent.
    if ((folded.has(c.from_arn) && folded.get(c.from_arn)!.arn === c.to_arn) || (folded.has(c.to_arn) && folded.get(c.to_arn)!.arn === c.from_arn)) continue;

    const key = `${source.id}->${target.id}:${c.kind === 'access' ? 'access' : 'other'}`;
    if (seen.has(key)) continue;
    seen.add(key);

    // A dead-letter queue is an edge of its own: amber, dashed, and a hop
    // a scenario can take when a step gives up.
    if (c.kind === 'dlq') {
      const meta: EdgeMeta = { layer: layerFor(c.kind, c.detail), discovered: { kind: c.kind, detail: c.detail || 'dead-letter queue' } };
      edges.push({
        id: `edge-${key}`,
        source: source.id,
        target: target.id,
        type: 'permission',
        data: { isResourceBased: true, isDLQ: true, maxRetries: 3, config: {}, meta },
      });
      continue;
    }

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

  // ---- layout: parentNode is what the layout reads, so set it first.
  for (const [child, parent] of parentOf) {
    const c = nodeById.get(child);
    if (c && !c.hidden) { c.parentNode = parent; c.extent = 'parent'; }
  }
  layoutStackCanvas(nodes);
  assignHandles(nodes, edges);
  void childrenOf;

  // React Flow needs parents before children.
  return { nodes: orderParentsFirst(nodes), edges, droppedConnections: dropped };
}

function describeAttachment(item: ProjectItem): string {
  const c = item.config as Record<string, unknown>;
  if (item.type === 'elastic-ip') return String(c.publicIp || c.name || '');
  if (item.type === 'ebs-volume') return [c.size ? `${c.size} GiB` : '', c.volumeType, c.encrypted ? 'encrypted' : ''].filter(Boolean).join(' · ');
  if (item.type === 'ebs-snapshot') return [c.size ? `${c.size} GiB` : '', c.description].filter(Boolean).join(' · ');
  if (item.type === 'log-group') {
    const size = typeof c.storedBytes === 'number' ? formatBytes(c.storedBytes) : '';
    return [c.retentionDays ? `${c.retentionDays}d retention` : 'never expires', size].filter(Boolean).join(' · ');
  }
  return c.awsType ? shortType(String(c.awsType)) : '';
}
