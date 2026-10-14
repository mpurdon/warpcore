// The Holodeck: a library of systems to load, walk through with scenarios,
// and copy to work from. An entry is a YAML file in visual-builder/holodeck/
// written in the account-project shape without coordinates: resources by
// name, connections by name, scenarios by name. The loader synthesises what
// buildCanvas needs (ARNs, ids, roles, log groups) so an entry stays short
// and the layout is the same stack an imported account gets.
//
// Nothing here touches the store; holodeckActions.ts does that.

import YAML from 'yaml';
import { Edge, Node } from 'reactflow';
import type { AccountProject, ConnectionKind, NodeMeta, ProjectConnection, ProjectItem } from './projectFromAccount';
import { buildCanvas, slug } from './projectFromAccount';
import { nameFieldFor } from './nodeName';
import { BAND_ORDER, bandFor } from './stackLayout';
import { checkScenario, COMPUTE_TYPES, hopIndex, isUnhappy, Scenario, scenariosFromYaml } from './scenarios';
import { stackThumbnail, thumbnailDataUrl } from './thumbnail';

// ------------------------------------------------------------------ model

export type HolodeckFamily = 'reference' | 'inspired' | 'classic' | 'starter' | 'designed';

export interface FamilyInfo {
  /** The hue its tag wears; one table, so a new family cannot be colourless. */
  tone: 'emerald' | 'violet' | 'sky' | 'gray' | 'amber';
  id: HolodeckFamily;
  label: string;
  /** The fidelity tag on the card. */
  tag: string;
  description: string;
}

export const FAMILIES: FamilyInfo[] = [
  { id: 'reference', label: 'AWS reference architectures', tag: 'reference', tone: 'emerald', description: "AWS's published patterns, drawn as they are usually built" },
  { id: 'inspired', label: 'In the style of', tag: 'inspired by', tone: 'violet', description: 'Systems as described in a public talk or post, rendered on AWS. Never the real thing.' },
  { id: 'classic', label: 'System design classics', tag: 'textbook', tone: 'sky', description: 'The interview and textbook systems, with the unhappy paths a diagram leaves out' },
  { id: 'starter', label: 'Warpcore starters', tag: 'starter', tone: 'gray', description: 'Small agent systems to deploy with warpcore' },
  { id: 'designed', label: 'Designed here', tag: 'designed', tone: 'amber', description: 'Systems designed in warpcore, kept beside the references with their scenarios' },
];

export interface HolodeckSource {
  title: string;
  url?: string;
  year?: number;
  by?: string;
}

export interface HolodeckMeta {
  id: string;
  name: string;
  family: HolodeckFamily;
  summary: string;
  /** What the entry is for; shown on the card and in the project inspector. */
  lookAt: string[];
  /** Inspired entries: the public source, with the year. */
  source?: HolodeckSource;
  /** 1 to 3. */
  difficulty: 1 | 2 | 3;
}

export interface HolodeckEntry {
  meta: HolodeckMeta;
  /** Laid out; ARNs and regions stripped so nothing claims to be in an account. */
  nodes: Node[];
  edges: Edge[];
  scenarios: Scenario[];
  /** Distinct node types on show, in band order. */
  services: string[];
  resourceCount: number;
  /** Scenarios with a failing or retried step. */
  unhappy: number;
  /** The laid-out canvas as an SVG data URL, for an <img>. */
  thumbnail: string;
}

// ------------------------------------------------------------------- yaml

interface ResourceYaml {
  name: string;
  type: string;
  config?: Record<string, unknown>;
  tags?: Record<string, string>;
  /** Shorthand for tags.Application: which tile the resource joins. */
  app?: string;
  /** The role the resource runs as; one is made when omitted for compute. */
  role?: string;
  /** The subnet or VPC the resource sits in. */
  in?: string;
  /** Security groups the resource is a member of. */
  groups?: string[];
  /** A teaching note; becomes meta.note. */
  note?: string;
}

interface ConnectionYaml {
  from: string;
  to: string;
  /** A ConnectionKind, or the sugar reads / writes / uses / admin for access. */
  kind?: string;
  detail?: string;
  via?: string;
  actions?: string[];
}

interface MetaYaml {
  id?: string; name?: string; family?: string; summary?: string; look_at?: string[];
  source?: HolodeckSource; difficulty?: number;
}

interface EntryYaml {
  holodeck: MetaYaml;
  project?: { name?: string; region?: string };
  resources?: ResourceYaml[];
  connections?: ConnectionYaml[];
  scenarios?: unknown;
}

const REGION = 'us-east-1';
const ACCOUNT = '000000000000';

/** A stable, unique ARN for a named resource. Never shown: it is the wiring key only. */
function arnFor(type: string, name: string): string {
  if (type === 'iam-role') return `arn:aws:iam::${ACCOUNT}:role/${name}`;
  return `arn:aws:holodeck:${REGION}:${ACCOUNT}:${type}/${name}`;
}

const DEFAULT_DETAIL: Record<ConnectionKind, string> = {
  access: 'read/write',
  invokes: 'invokes',
  'event-source': 'event source mapping',
  'event-target': 'target',
  dlq: 'dead-letter queue',
  reference: 'env var',
  logs: 'log group',
  dns: 'alias record',
  origin: 'origin',
  role: 'execution role',
  vpc: 'in VPC',
};

const ACCESS_SUGAR: Record<string, string> = { reads: 'read', writes: 'write', uses: 'read/write', admin: 'admin' };

const ACTIONS: Record<string, { read?: string[]; write?: string[] }> = {
  dynamodb: { read: ['dynamodb:GetItem', 'dynamodb:Query'], write: ['dynamodb:PutItem', 'dynamodb:UpdateItem'] },
  s3: { read: ['s3:GetObject', 's3:ListBucket'], write: ['s3:PutObject'] },
  sqs: { read: ['sqs:ReceiveMessage', 'sqs:DeleteMessage'], write: ['sqs:SendMessage'] },
  sns: { write: ['sns:Publish'] },
  'kms-key': { read: ['kms:Decrypt'], write: ['kms:GenerateDataKey'] },
  'secrets-manager': { read: ['secretsmanager:GetSecretValue'] },
  'ssm-parameter': { read: ['ssm:GetParameter'] },
  lambda: { read: ['lambda:InvokeFunction'], write: ['lambda:InvokeFunction'] },
  agent: { read: ['lambda:InvokeFunction'], write: ['lambda:InvokeFunction'] },
  'step-functions': { read: ['states:DescribeExecution'], write: ['states:StartExecution'] },
  'kinesis-stream': { read: ['kinesis:GetRecords'], write: ['kinesis:PutRecord'] },
  'kinesis-firehose': { write: ['firehose:PutRecord'] },
  eventbridge: { write: ['events:PutEvents'] },
  bedrock: { read: ['bedrock:InvokeModel'], write: ['bedrock:InvokeModel'] },
  opensearch: { read: ['es:ESHttpGet', 'es:ESHttpPost'], write: ['es:ESHttpPut', 'es:ESHttpPost'] },
  'elasticache-cluster': { read: ['elasticache:Connect'], write: ['elasticache:Connect'] },
  'rds-cluster': { read: ['rds-db:connect'], write: ['rds-db:connect'] },
  'rds-instance': { read: ['rds-db:connect'], write: ['rds-db:connect'] },
  cognito: { read: ['cognito-idp:GetUser'], write: ['cognito-idp:AdminUpdateUserAttributes'] },
  athena: { read: ['athena:GetQueryResults'], write: ['athena:StartQueryExecution'] },
  glue: { read: ['glue:GetTable'], write: ['glue:StartJobRun'] },
  'log-group': { write: ['logs:PutLogEvents'] },
  'api-gateway': { read: ['execute-api:Invoke'], write: ['execute-api:ManageConnections'] },
};

function actionsFor(type: string, level: string): string[] {
  const t = ACTIONS[type];
  if (level === 'admin') return [`${type.split('-')[0]}:*`];
  if (!t) return [];
  if (level === 'read') return t.read ?? t.write ?? [];
  if (level === 'write') return t.write ?? t.read ?? [];
  return [...new Set([...(t.read ?? []), ...(t.write ?? [])])];
}

function logGroupPathFor(type: string, name: string): string {
  if (type === 'ecs-service') return `/ecs/${name}`;
  if (type === 'ec2-instance') return `/ec2/${name}`;
  if (type === 'step-functions') return `/aws/vendedlogs/states/${name}`;
  return `/aws/lambda/${name}`;
}

const FAMILY_BY_ID = new Map(FAMILIES.map((f) => [f.id, f]));

export function familyInfo(id: HolodeckFamily): FamilyInfo {
  return FAMILY_BY_ID.get(id)!;
}

// ----------------------------------------------------------------- loader

export class HolodeckError extends Error {}

/** Parse one entry. Throws HolodeckError on a malformed file so a bad entry fails the tests, not the app. */
export function parseHolodeckEntry(text: string, fallbackId = 'entry'): HolodeckEntry {
  const raw = YAML.parse(text) as EntryYaml | null;
  if (!raw || typeof raw !== 'object' || !raw.holodeck || typeof raw.holodeck !== 'object') throw new HolodeckError(`${fallbackId}: no holodeck block`);
  const meta = metaFrom(raw.holodeck, fallbackId);
  const id = meta.id;
  if (!FAMILY_BY_ID.has(raw.holodeck.family as HolodeckFamily)) throw new HolodeckError(`${id}: unknown family ${raw.holodeck.family}`);
  const projectName = slug(String(raw.project?.name || id), 48, true) || id;

  // ---- items
  const items: ProjectItem[] = [];
  const roles: ProjectItem[] = [];
  const byName = new Map<string, ProjectItem>();
  const notes = new Map<string, string>();
  const define = (list: ProjectItem[], item: ProjectItem) => {
    if (byName.has(item.name)) throw new HolodeckError(`${id}: two resources named ${item.name}`);
    byName.set(item.name, item);
    list.push(item);
  };
  const tagsFor = (r: { tags?: Record<string, string>; app?: string }): Record<string, string> => ({
    Application: r.app || projectName,
    ...(r.tags || {}),
  });
  const roleItem = (name: string, tags: Record<string, string>): ProjectItem => (
    { name, type: 'iam-role', arn: arnFor('iam-role', name), region: null, config: { roleName: name }, tags }
  );

  const resources = (raw.resources || []).filter((r): r is ResourceYaml => Boolean(r && r.name && r.type));
  const roleOf = new Map<string, string>();
  for (const r of resources) {
    const type = String(r.type);
    const name = String(r.name);
    const config: Record<string, unknown> = { [nameFieldFor(type)]: name, ...(r.config || {}) };
    if ((type === 'lambda' || type === 'agent') && !config.runtime) config.runtime = 'python3.12';
    if (type === 'subnet' && config.public === undefined && /public/i.test(name)) config.public = true;
    const item: ProjectItem = { name, type, arn: arnFor(type, name), region: REGION, config, tags: tagsFor(r) };
    if (r.note) notes.set(item.arn, String(r.note));
    define(items, item);
    // Compute runs as a role: the one named, else one of its own.
    const role = r.role ? String(r.role) : COMPUTE_TYPES.has(type) ? `${name}-role` : undefined;
    if (role) {
      if (!byName.has(role)) define(roles, roleItem(role, tagsFor(r)));
      roleOf.set(name, role);
      item.role_arn = byName.get(role)!.arn;
    }
  }

  // ---- connections
  const connections: ProjectConnection[] = [];
  const need = (name: string, where: string): ProjectItem => {
    const found = byName.get(name);
    if (!found) throw new HolodeckError(`${id}: ${where} names ${name}, which is not a resource`);
    return found;
  };
  for (const r of resources) {
    const me = byName.get(r.name)!;
    const role = roleOf.get(r.name);
    if (role) connections.push({ from_arn: me.arn, to_arn: byName.get(role)!.arn, kind: 'role', detail: 'execution role' });
    if (r.in) {
      const container = need(String(r.in), `${r.name}.in`);
      connections.push({ from_arn: me.arn, to_arn: container.arn, kind: 'vpc', detail: container.type === 'subnet' ? 'in subnet' : 'in VPC' });
    }
    for (const g of r.groups || []) {
      connections.push({ from_arn: me.arn, to_arn: need(String(g), `${r.name}.groups`).arn, kind: 'vpc', detail: 'security group' });
    }
  }
  const explicitLogs = new Set<string>();
  for (const c of raw.connections || []) {
    if (!c || !c.from || !c.to) continue;
    const from = need(String(c.from), 'a connection');
    const to = need(String(c.to), 'a connection');
    let kind = String(c.kind || 'access');
    let detail = c.detail ? String(c.detail) : undefined;
    if (ACCESS_SUGAR[kind]) { detail = detail ?? ACCESS_SUGAR[kind]; kind = 'access'; }
    if (!(kind in DEFAULT_DETAIL)) throw new HolodeckError(`${id}: unknown connection kind ${kind}`);
    const k = kind as ConnectionKind;
    if (detail === undefined) detail = k === 'reference' && to.type === 'kms-key' ? 'encrypted with' : k === 'reference' ? `env ${slug(to.name).toUpperCase().replace(/-/g, '_')}` : DEFAULT_DETAIL[k];
    if (k === 'logs') explicitLogs.add(from.name);
    const conn: ProjectConnection = { from_arn: from.arn, to_arn: to.arn, kind: k, detail };
    if (k === 'access') {
      conn.via = c.via ? String(c.via) : (roleOf.get(from.name) ?? '');
      conn.actions = Array.isArray(c.actions) ? c.actions.map(String) : actionsFor(to.type, detail);
    }
    connections.push(conn);
  }
  // Every compute resource writes logs; one group each unless the entry wired one.
  for (const r of resources) {
    if (!COMPUTE_TYPES.has(String(r.type)) || explicitLogs.has(r.name)) continue;
    const me = byName.get(r.name)!;
    const path = logGroupPathFor(me.type, me.name);
    if (byName.has(path)) continue;
    const lg: ProjectItem = { name: path, type: 'log-group', arn: arnFor('log-group', path), region: REGION, config: { logGroupPath: path, retentionDays: 14 }, tags: tagsFor(r) };
    define(items, lg);
    connections.push({ from_arn: me.arn, to_arn: lg.arn, kind: 'logs', detail: 'function log group' });
  }

  const project: AccountProject = {
    account: ACCOUNT,
    regions: { [REGION]: items.length },
    project: { name: projectName, region: String(raw.project?.region || REGION) },
    environment: { key: 'dev', account: ACCOUNT, region: REGION },
    agents: items.filter((i) => i.type === 'agent'),
    resources: items.filter((i) => i.type !== 'agent'),
    roles,
    connections,
    counts: { included: items.length, shown: items.length, skipped: 0, connections: connections.length, excluded: 0 },
    skipped: {},
    notes: [],
    adopted: null,
    explorer: false,
    errors: [],
  };

  // ---- canvas
  const built = buildCanvas(project);
  const nameByArn = new Map([...byName.values()].map((i) => [i.arn, i.name]));
  const idByName = new Map<string, string>();
  for (const n of built.nodes) {
    const arn = n.data?.arn as string | undefined;
    if (!arn) continue;
    const name = nameByArn.get(arn);
    if (name) idByName.set(name, n.id);
    const note = notes.get(arn);
    if (note) ((n.data.meta ||= {}) as NodeMeta).note = note;
    // Nothing here is in an account.
    delete n.data.arn;
    delete n.data.region;
    if (n.data.meta) delete (n.data.meta as NodeMeta).health;
    if (n.type !== 'application' && n.type !== 'band') n.data.status = 'configured';
  }

  // ---- scenarios: steps by name or by id
  const ids = new Set(built.nodes.map((n) => n.id));
  const resolve = (at: string): string => (ids.has(at) ? at : idByName.get(at) ?? at);
  const scenarios = scenariosFromYaml(raw.scenarios).map((s) => ({
    ...s,
    trigger: { ...s.trigger, at: resolve(s.trigger.at) },
    steps: s.steps.map((st) => ({ ...st, at: resolve(st.at) })),
  }));

  const drawn = built.nodes.filter((n) => !n.hidden && !n.data?.meta?.isGroup && n.type !== 'log-group' && n.type !== 'iam-role');
  const services = [...new Set(drawn.map((n) => n.type || ''))]
    .sort((a, b) => BAND_ORDER.indexOf(bandFor({ type: a })) - BAND_ORDER.indexOf(bandFor({ type: b })) || a.localeCompare(b));
  return {
    meta,
    nodes: built.nodes,
    edges: built.edges,
    scenarios,
    services,
    resourceCount: drawn.length,
    unhappy: scenarios.filter(isUnhappy).length,
    thumbnail: thumbnailDataUrl(stackThumbnail(built.nodes)),
  };
}

/** Every problem the scenario check finds across an entry, prefixed by scenario name. Empty for a sound entry. */
export function entryProblems(entry: HolodeckEntry): string[] {
  const index = hopIndex(entry.nodes, entry.edges);
  return entry.scenarios.flatMap((s) => checkScenario(s, entry.nodes, entry.edges, index).problems.map((p) => `${s.name}: ${p}`));
}

// ------------------------------------------------- warpcore.yaml round trip

/** The `holodeck:` block a saved copy carries, so the notes survive the copy. */
export function holodeckMetaToYaml(meta: HolodeckMeta): Record<string, unknown> {
  return {
    id: meta.id,
    name: meta.name,
    family: meta.family,
    summary: meta.summary,
    ...(meta.lookAt.length ? { look_at: meta.lookAt } : {}),
    ...(meta.source ? { source: meta.source } : {}),
    difficulty: meta.difficulty,
  };
}

/** The metadata block as HolodeckMeta; an unknown family falls back to classic, the caller decides whether that is an error. */
function metaFrom(h: MetaYaml, fallbackId: string): HolodeckMeta {
  const id = slug(String(h.id || fallbackId));
  return {
    id,
    name: String(h.name || id),
    family: FAMILY_BY_ID.has(h.family as HolodeckFamily) ? (h.family as HolodeckFamily) : 'classic',
    summary: String(h.summary || ''),
    lookAt: Array.isArray(h.look_at) ? h.look_at.map(String) : [],
    ...(h.source && typeof h.source === 'object' ? { source: h.source } : {}),
    difficulty: Math.min(3, Math.max(1, Math.round(Number(h.difficulty ?? 1)))) as 1 | 2 | 3,
  };
}

export function holodeckMetaFromYaml(raw: unknown): HolodeckMeta | null {
  if (!raw || typeof raw !== 'object') return null;
  const h = raw as MetaYaml;
  if (!h.id || !h.name) return null;
  return metaFrom(h, String(h.id));
}

/** Human labels for the difficulty dots. */
export function difficultyLabel(d: 1 | 2 | 3): string {
  return d === 1 ? 'small' : d === 2 ? 'medium' : 'large';
}
