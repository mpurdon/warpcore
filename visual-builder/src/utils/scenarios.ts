// Scenarios: a named event played step by step through the resources it
// touches. "A webhook arrives" lights the API, then the authorizer, then the
// key it decrypts with, then the function, then the table, while the log
// groups tick. A scenario is data in warpcore.yaml, so it is shared and
// reviewed with the project.
//
// What makes it more than an animation: every hop is checked against the
// wiring on the canvas. A step with no trigger, invocation or access edge
// behind it is flagged, and so is a compute step with no log group. A
// scenario is a runnable assertion: "this request can happen, and here is
// the policy that lets it."
//
// Log groups are never listed as steps. Every compute step's log edge is
// pulsed during playback and synthetic lines stream into the group; the
// lines show data moving and claim nothing about what the code logs.

import { Node, Edge } from 'reactflow';
import { displayNameFor } from './nodeName';

// ------------------------------------------------------------------ model

export interface ScenarioStep {
  /** Node id of the resource the request is at. */
  at: string;
  /** What happens there, in the author's words. */
  note?: string;
  /** How long the step takes, in milliseconds. */
  takes?: number;
  /** Fire and forget: the pulse leaves, the playhead does not wait. */
  detached?: boolean;
}

export interface Scenario {
  /** Stable within the project; derived from the name when the file has none. */
  id: string;
  name: string;
  trigger: { at: string; event?: string };
  steps: ScenarioStep[];
}

/** The `scenarios:` list as it appears in warpcore.yaml. */
export interface ScenarioYaml {
  name: string;
  trigger: { at: string; event?: string };
  steps?: Array<{ at: string; note?: string; takes?: string | number; detached?: boolean }>;
}

export function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'scenario';
}

/** A scenario id no other scenario in the list has. */
export function uniqueScenarioId(name: string, existing: Scenario[]): string {
  const base = slugify(name);
  const taken = new Set(existing.map((s) => s.id));
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

/** "40ms", "1.5s", "2 s", 40 → milliseconds; anything else → undefined. */
export function parseTakes(value: string | number | undefined): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'number') return value >= 0 ? value : undefined;
  const m = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m)?\s*$/i.exec(value);
  if (!m) return undefined;
  const n = parseFloat(m[1]);
  const unit = (m[2] || 'ms').toLowerCase();
  return unit === 's' ? n * 1000 : unit === 'm' ? n * 60000 : n;
}

/** Milliseconds as the shortest readable unit: "40ms", "1.5s". */
export function formatTakes(ms: number): string {
  if (ms >= 1000) {
    const s = ms / 1000;
    return `${Number.isInteger(s) ? s : s.toFixed(s < 10 ? 2 : 1).replace(/\.?0+$/, '')}s`;
  }
  return `${Math.round(ms)}ms`;
}

export function scenariosFromYaml(list: unknown): Scenario[] {
  if (!Array.isArray(list)) return [];
  const out: Scenario[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const y = raw as Partial<ScenarioYaml>;
    const name = typeof y.name === 'string' && y.name.trim() ? y.name.trim() : 'Untitled scenario';
    const at = typeof y.trigger?.at === 'string' ? y.trigger.at : '';
    if (!at) continue;
    const steps: ScenarioStep[] = [];
    for (const s of y.steps || []) {
      if (!s || typeof s !== 'object' || typeof (s as { at?: unknown }).at !== 'string') continue;
      const step: ScenarioStep = { at: (s as { at: string }).at };
      if (typeof s.note === 'string' && s.note) step.note = s.note;
      const takes = parseTakes(s.takes);
      if (takes !== undefined) step.takes = takes;
      if (s.detached) step.detached = true;
      steps.push(step);
    }
    out.push({
      id: uniqueScenarioId(name, out),
      name,
      trigger: { at, ...(typeof y.trigger?.event === 'string' && y.trigger.event ? { event: y.trigger.event } : {}) },
      steps,
    });
  }
  return out;
}

export function scenariosToYaml(scenarios: Scenario[]): ScenarioYaml[] {
  return scenarios.map((s) => ({
    name: s.name,
    trigger: { at: s.trigger.at, ...(s.trigger.event ? { event: s.trigger.event } : {}) },
    steps: s.steps.map((step) => ({
      at: step.at,
      ...(step.note ? { note: step.note } : {}),
      ...(step.takes !== undefined ? { takes: formatTakes(step.takes) } : {}),
      ...(step.detached ? { detached: true } : {}),
    })),
  }));
}

/** Types a request usually arrives at, best first, for a new scenario's default trigger. */
const ENTRY_TYPES = ['api-gateway', 'cloudfront', 'route53-zone', 'load-balancer', 'eventbridge-rule', 'sqs', 'sns', 'kinesis-stream', 's3', 'agent', 'lambda'];

/** A fresh scenario: named, triggered at the given node or the most entry-like one, no steps. */
export function createScenario(nodes: Node[], existing: Scenario[], triggerAt?: string): Scenario | null {
  let at = triggerAt;
  if (!at) {
    const usable = nodes.filter(canBeStep);
    for (const type of ENTRY_TYPES) {
      const found = usable.find((n) => n.type === type);
      if (found) { at = found.id; break; }
    }
    if (!at) at = usable[0]?.id;
  }
  if (!at) return null;
  const node = nodes.find((n) => n.id === at);
  const base = node ? `${displayNameFor(node)} request` : 'New scenario';
  let name = base;
  let n = 2;
  while (existing.some((s) => s.name === name)) name = `${base} ${n++}`;
  return { id: uniqueScenarioId(name, existing), name, trigger: { at }, steps: [] };
}

// ------------------------------------------------------------------ graph

/** Node types a request runs code on: they write logs and call things. */
export const COMPUTE_TYPES = new Set(['agent', 'lambda', 'ecs-service', 'ec2-instance', 'step-functions']);

/** Types that are never a step: structure, identity, and what watches. */
const NEVER_A_STEP = new Set([
  'log-group', 'iam-role', 'iam-user', 'iam-policy', 'iam-instance-profile', 'security-group',
  'vpc', 'subnet', 'internet-gateway', 'nat-gateway', 'route-table', 'vpc-endpoint', 'elastic-ip',
  'cloudwatch-alarm', 'cloudwatch-dashboard', 'acm-certificate', 'ebs-volume', 'ebs-snapshot',
  'application', 'band', 'enclosure',
]);

export function canBeStep(node: Node): boolean {
  if (node.hidden) return false;
  if (node.data?.meta?.isGroup) return false;
  return !NEVER_A_STEP.has(node.type || '');
}

/** Where the request can go next, for the recorder and the path finder. */
export type HopKind = 'trigger' | 'access' | 'reference' | 'drawn';

export interface Hop {
  /** The edge that carries the request. */
  edge: Edge;
  /** The node at the other end. */
  to: string;
  kind: HopKind;
  /** The edge's own words: "invokes", "read/write via role", "POST /webhook". */
  label: string;
  /** For the path finder: lower comes first. */
  rank: number;
}

const TRIGGER_KINDS = new Set(['invokes', 'event-source', 'event-target', 'origin', 'dns', 'dlq']);

function hopFor(edge: Edge, from: string): Hop | null {
  const meta = (edge.data?.meta || {}) as { discovered?: { kind: string; detail: string }; access?: { level: string; via: string; actions: string[] }; layer?: string };
  const outgoing = edge.source === from;
  const to = outgoing ? edge.target : edge.source;
  if (edge.data?.isDLQ) return outgoing ? { edge, to, kind: 'trigger', label: 'dead-letter queue', rank: 60 } : null;
  if (meta.access) {
    if (!outgoing) return null;
    const level = meta.access.level;
    const label = `${level} via ${meta.access.via}`;
    const rank = level === 'write' || level === 'read/write' || level === 'admin' ? 20 : 30;
    return { edge, to, kind: 'access', label, rank };
  }
  const d = meta.discovered;
  if (d) {
    if (TRIGGER_KINDS.has(d.kind)) {
      if (!outgoing) return null;
      const authorizer = /authori[sz]er/i.test(d.detail) || /authori[sz]er/i.test(to);
      return { edge, to, kind: 'trigger', label: d.detail || d.kind, rank: authorizer ? 5 : 10 };
    }
    if (d.kind === 'reference') {
      if (!outgoing) return null;
      if (d.detail === 'encrypted with') return { edge, to, kind: 'reference', label: 'encrypted with', rank: 40 };
      if (d.detail.startsWith('env ')) return { edge, to, kind: 'reference', label: d.detail, rank: 35 };
      return null;
    }
    // role, logs, vpc: structure and plumbing, never a hop.
    return null;
  }
  // Drawn by hand: a permission edge from source to target.
  if (!outgoing) return null;
  const cfg = (edge.data?.config || {}) as { method?: string; path?: string };
  const label = cfg.path ? `${cfg.method || 'ANY'} ${cfg.path}` : edge.data?.isResourceBased ? 'invokes' : edge.data?.roleId ? 'via role' : 'connection';
  return { edge, to, kind: 'drawn', label, rank: 25 };
}

/** The hops the graph allows from a node, best first. Never a log group or a role. */
export function hopsFrom(nodeId: string, nodes: Node[], edges: Edge[]): Hop[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const hops: Hop[] = [];
  for (const e of edges) {
    if (e.source !== nodeId && e.target !== nodeId) continue;
    const hop = hopFor(e, nodeId);
    if (!hop) continue;
    const target = byId.get(hop.to);
    if (!target || !canBeStep(target)) continue;
    hops.push(hop);
  }
  return hops.sort((a, b) => a.rank - b.rank || displayNameFor(byId.get(a.to)!).localeCompare(displayNameFor(byId.get(b.to)!)));
}

/**
 * Draft a path from the entry resource: a depth-first walk over triggers,
 * access and references, best hop first, so "API → authorizer → its key →
 * function → its table → its topic" comes out in request order. Capped so a
 * hairball does not become a forty-step scenario.
 */
export function suggestPath(startId: string, nodes: Node[], edges: Edge[], limit = 12): ScenarioStep[] {
  const steps: ScenarioStep[] = [];
  const seen = new Set<string>([startId]);
  const walk = (id: string) => {
    for (const hop of hopsFrom(id, nodes, edges)) {
      if (steps.length >= limit) return;
      if (seen.has(hop.to)) continue;
      seen.add(hop.to);
      steps.push({ at: hop.to });
      walk(hop.to);
    }
  };
  walk(startId);
  return steps;
}

// ----------------------------------------------------------------- checks

export interface StepEvidence {
  /** Which earlier resource the request came from. */
  from: string;
  /** The edge's own words. */
  label: string;
  /** Actions the policy names, for access edges. */
  actions?: string[];
  kind: HopKind;
  edgeId: string;
}

export interface StepCheck {
  index: number;
  at: string;
  /** The resource is on the canvas. */
  exists: boolean;
  evidence: StepEvidence | null;
  /** Log groups this compute step writes to. */
  logGroups: string[];
  problems: string[];
}

export interface ScenarioCheck {
  triggerExists: boolean;
  steps: StepCheck[];
  problems: string[];
  ok: boolean;
}

/** The node a hop into `stepId` most plausibly came from: the nearest earlier step wired to it. */
function evidenceFor(stepId: string, earlier: string[], nodes: Node[], edges: Edge[]): StepEvidence | null {
  for (let i = earlier.length - 1; i >= 0; i--) {
    const from = earlier[i];
    const hop = hopsFrom(from, nodes, edges).find((h) => h.to === stepId);
    if (hop) {
      const access = (hop.edge.data?.meta as { access?: { actions: string[] } } | undefined)?.access;
      return { from, label: hop.label, kind: hop.kind, edgeId: hop.edge.id, ...(access?.actions?.length ? { actions: access.actions } : {}) };
    }
  }
  return null;
}

/** The log groups a node writes to: log edges, and any log group it is wired to. */
export function logGroupsFor(nodeId: string, nodes: Node[], edges: Edge[]): string[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out: string[] = [];
  for (const e of edges) {
    if (e.source !== nodeId && e.target !== nodeId) continue;
    const other = e.source === nodeId ? e.target : e.source;
    const node = byId.get(other);
    if (node?.type === 'log-group' && !out.includes(other)) out.push(other);
  }
  return out;
}

export function checkScenario(scenario: Scenario, nodes: Node[], edges: Edge[]): ScenarioCheck {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const name = (id: string) => (byId.has(id) ? displayNameFor(byId.get(id)!) : id);
  const problems: string[] = [];
  const triggerExists = byId.has(scenario.trigger.at);
  if (!triggerExists) problems.push(`Trigger ${scenario.trigger.at} is not on the canvas`);
  const earlier: string[] = [scenario.trigger.at];
  const steps: StepCheck[] = scenario.steps.map((step, index) => {
    const node = byId.get(step.at);
    const exists = Boolean(node);
    const stepProblems: string[] = [];
    let evidence: StepEvidence | null = null;
    let logGroups: string[] = [];
    if (!exists) {
      stepProblems.push(`${step.at} is not on the canvas`);
    } else {
      evidence = evidenceFor(step.at, earlier, nodes, edges);
      if (!evidence) stepProblems.push(`No permission or trigger found from ${name(earlier[earlier.length - 1])} to ${name(step.at)}`);
      if (COMPUTE_TYPES.has(node!.type || '')) {
        logGroups = logGroupsFor(step.at, nodes, edges);
        if (logGroups.length === 0) stepProblems.push(`${name(step.at)} has no log group wired`);
      }
    }
    earlier.push(step.at);
    return { index, at: step.at, exists, evidence, logGroups, problems: stepProblems };
  });
  if (scenario.steps.length === 0) problems.push('No steps yet');
  for (const s of steps) problems.push(...s.problems);
  return { triggerExists, steps, problems, ok: problems.length === 0 };
}

// --------------------------------------------------------------- playback

/**
 * The playhead. Playback is discrete: the request is either travelling into
 * step `index` or dwelling on it. The continuous part (the pulse along the
 * edge, the progress fill) is animated by CSS from these two facts, so the
 * store changes a handful of times per scenario, not sixty times a second.
 * `index === -1` is the trigger alone; `phase === 'end'` is the last step
 * finished.
 */
export interface Playhead {
  scenarioId: string;
  index: number;
  phase: 'travel' | 'dwell' | 'end';
  playing: boolean;
  /** 0.5, 1, 2, 4. */
  speed: number;
}

/** Wall-clock milliseconds a pulse takes to cross an edge, at 1×. */
export const TRAVEL_MS = 700;
/** Wall-clock milliseconds a step stays lit, at 1×, before its `takes` is considered. */
export const DWELL_MIN_MS = 900;
export const DWELL_MAX_MS = 3000;
/** Modelled duration of a step with no `takes`. */
export const DEFAULT_TAKES_MS = 100;

/** How long the current phase runs on the wall clock, at the given speed. */
export function phaseDurationMs(scenario: Scenario, head: Pick<Playhead, 'index' | 'phase' | 'speed'>): number {
  if (head.phase === 'end') return 0;
  const speed = head.speed || 1;
  if (head.phase === 'travel') return TRAVEL_MS / speed;
  const step = scenario.steps[head.index];
  const takes = step?.takes ?? DEFAULT_TAKES_MS;
  // A 40 ms step still has to be seen; a 10 s step must not stall the show.
  const dwell = Math.min(DWELL_MAX_MS, Math.max(DWELL_MIN_MS, takes));
  return dwell / speed;
}

/** The playhead one phase later. */
export function advance(scenario: Scenario, head: Playhead): Playhead {
  if (head.phase === 'end') return head;
  const last = scenario.steps.length - 1;
  if (head.phase === 'travel') return { ...head, phase: 'dwell' };
  if (head.index >= last) return { ...head, phase: 'end', playing: false };
  return { ...head, index: head.index + 1, phase: 'travel' };
}

/** The playhead at the start of a step, or at the trigger for -1. */
export function seekTo(scenario: Scenario, head: Playhead, index: number): Playhead {
  const clamped = Math.max(-1, Math.min(scenario.steps.length - 1, index));
  if (clamped < 0) return { ...head, index: -1, phase: 'dwell' };
  return { ...head, index: clamped, phase: 'dwell' };
}

/** Modelled time into the request at the playhead: the `takes` of every step done so far. */
export function modelledTimeMs(scenario: Scenario, head: Pick<Playhead, 'index' | 'phase'>): number {
  let t = 0;
  const upTo = head.phase === 'end' ? scenario.steps.length : head.phase === 'dwell' ? head.index + 1 : head.index;
  for (let i = 0; i < Math.min(upTo, scenario.steps.length); i++) {
    if (scenario.steps[i].detached) continue;
    t += scenario.steps[i].takes ?? DEFAULT_TAKES_MS;
  }
  return t;
}

export type StepState = 'pending' | 'travelling' | 'active' | 'visited';

/** What every node on the canvas is doing at the playhead. */
export interface PlaybackMarks {
  /** Step numbers (1-based) each node carries; the trigger carries 0. */
  numbers: Map<string, number[]>;
  state: Map<string, StepState>;
  /** The edge the pulse is on, and the direction it travels. */
  pulse: { edgeId: string; reverse: boolean } | null;
  /** Edges into log groups that are lit right now. */
  logEdges: Set<string>;
  /** Log groups receiving lines right now. */
  logging: Set<string>;
  /** The node the request is at. */
  activeId: string | null;
}

export function playbackMarks(scenario: Scenario, head: Playhead | null, check: ScenarioCheck, nodes: Node[], edges: Edge[]): PlaybackMarks {
  const numbers = new Map<string, number[]>();
  const push = (id: string, n: number) => numbers.set(id, [...(numbers.get(id) || []), n]);
  push(scenario.trigger.at, 0);
  scenario.steps.forEach((s, i) => push(s.at, i + 1));
  const state = new Map<string, StepState>();
  const logEdges = new Set<string>();
  const logging = new Set<string>();
  let pulse: PlaybackMarks['pulse'] = null;
  let activeId: string | null = null;
  if (!head) return { numbers, state, pulse, logEdges, logging, activeId };

  const doneThrough = head.phase === 'end' ? scenario.steps.length - 1 : head.phase === 'dwell' ? head.index : head.index - 1;
  state.set(scenario.trigger.at, head.index < 0 && head.phase !== 'end' ? 'active' : 'visited');
  scenario.steps.forEach((s, i) => {
    const current = state.get(s.at);
    let next: StepState;
    if (i <= doneThrough) next = 'visited';
    else if (i === head.index && head.phase === 'travel') next = 'travelling';
    else next = 'pending';
    if (i === head.index && head.phase === 'dwell') next = 'active';
    // A node visited twice keeps its strongest state.
    const order: StepState[] = ['pending', 'travelling', 'visited', 'active'];
    if (!current || order.indexOf(next) > order.indexOf(current)) state.set(s.at, next);
  });

  if (head.phase !== 'end' && head.index >= 0) {
    const step = scenario.steps[head.index];
    const ev = check.steps[head.index]?.evidence;
    if (head.phase === 'travel' && ev) {
      const edge = edges.find((e) => e.id === ev.edgeId);
      if (edge) pulse = { edgeId: edge.id, reverse: edge.target === ev.from };
    }
    if (head.phase === 'dwell') {
      activeId = step.at;
      const node = nodes.find((n) => n.id === step.at);
      if (node && COMPUTE_TYPES.has(node.type || '')) {
        for (const g of logGroupsFor(step.at, nodes, edges)) {
          logging.add(g);
          for (const e of edges) {
            if ((e.source === step.at && e.target === g) || (e.target === step.at && e.source === g)) logEdges.add(e.id);
          }
        }
      }
    }
  } else if (head.index < 0) {
    activeId = scenario.trigger.at;
  }
  return { numbers, state, pulse, logEdges, logging, activeId };
}

// ------------------------------------------------------------ synthetic logs

/** Small deterministic PRNG so the same step always shows the same lines. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

export interface LogLine {
  /** Milliseconds into the request. */
  t: number;
  level: 'START' | 'INFO' | 'WARN' | 'END' | 'REPORT';
  text: string;
}

const VERB_BY_TYPE: Record<string, string[]> = {
  dynamodb: ['PutItem', 'GetItem', 'Query', 'UpdateItem'],
  s3: ['PutObject', 'GetObject', 'HeadObject'],
  sqs: ['SendMessage'],
  sns: ['Publish'],
  'kms-key': ['Decrypt', 'GenerateDataKey'],
  'secrets-manager': ['GetSecretValue'],
  'ssm-parameter': ['GetParameter'],
  lambda: ['Invoke'],
  agent: ['Invoke'],
  'step-functions': ['StartExecution'],
  'kinesis-stream': ['PutRecord'],
  'kinesis-firehose': ['PutRecord'],
  eventbridge: ['PutEvents'],
  bedrock: ['InvokeModel'],
  'rds-instance': ['SELECT', 'INSERT'],
  'rds-cluster': ['SELECT', 'INSERT'],
  'elasticache-cluster': ['GET', 'SET'],
};

/**
 * Plausible lines for one compute step: a START, something about the event,
 * one line per resource the request goes on to touch, an END and a REPORT.
 * Decoration that shows data moving; it never claims to be what the code logs.
 */
export function syntheticLogLines(scenario: Scenario, stepIndex: number, nodes: Node[], edges: Edge[]): LogLine[] {
  const step = scenario.steps[stepIndex];
  if (!step) return [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  // What this step is wired to directly; a queue fed by its topic is not its call.
  const direct = new Set(hopsFrom(step.at, nodes, edges).map((h) => h.to));
  const rnd = mulberry32(hash(`${scenario.id}/${stepIndex}/${step.at}`));
  const requestId = `${Math.floor(rnd() * 0xffff).toString(16).padStart(4, '0')}${Math.floor(rnd() * 0xffff).toString(16).padStart(4, '0')}…`;
  const start = modelledTimeMs(scenario, { index: stepIndex, phase: 'travel' });
  const takes = step.takes ?? DEFAULT_TAKES_MS;
  const lines: LogLine[] = [{ t: start, level: 'START', text: `RequestId: ${requestId}` }];
  let t = start + Math.max(1, Math.round(takes * 0.05));
  const eventText = stepIndex === 0 && scenario.trigger.event ? scenario.trigger.event : step.note;
  if (eventText) { lines.push({ t, level: 'INFO', text: eventText }); t += Math.max(1, Math.round(takes * 0.1)); }
  // The resources this compute step goes on to call itself, until the next compute step.
  const touched: string[] = [];
  for (let i = stepIndex + 1; i < scenario.steps.length; i++) {
    const n = byId.get(scenario.steps[i].at);
    if (!n) continue;
    if (COMPUTE_TYPES.has(n.type || '')) break;
    if (direct.has(scenario.steps[i].at)) touched.push(scenario.steps[i].at);
  }
  for (const id of touched) {
    const n = byId.get(id)!;
    const verbs = VERB_BY_TYPE[n.type || ''] || ['call'];
    const verb = verbs[Math.floor(rnd() * verbs.length)];
    const ms = Math.max(1, Math.round(scenario.steps.find((s) => s.at === id)?.takes ?? (5 + rnd() * 40)));
    lines.push({ t, level: rnd() < 0.08 ? 'WARN' : 'INFO', text: `${verb} ${displayNameFor(n)} ${ms} ms` });
    t += ms;
  }
  const end = start + takes;
  lines.push({ t: Math.max(t, end), level: 'END', text: `RequestId: ${requestId}` });
  const memory = 128 * (1 + Math.floor(rnd() * 8));
  const used = Math.round(memory * (0.3 + rnd() * 0.5));
  lines.push({ t: Math.max(t, end), level: 'REPORT', text: `Duration: ${takes} ms  Memory Size: ${memory} MB  Max Memory Used: ${used} MB` });
  return lines;
}

/** Lines for every compute step up to and including the playhead's. */
export function logLinesUpTo(scenario: Scenario, head: Playhead | null, nodes: Node[], edges: Edge[]): { at: string; lines: LogLine[] }[] {
  if (!head) return [];
  const upTo = head.phase === 'end' ? scenario.steps.length - 1 : head.phase === 'dwell' ? head.index : head.index - 1;
  const out: { at: string; lines: LogLine[] }[] = [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (let i = 0; i <= Math.min(upTo, scenario.steps.length - 1); i++) {
    const node = byId.get(scenario.steps[i].at);
    if (!node || !COMPUTE_TYPES.has(node.type || '')) continue;
    out.push({ at: scenario.steps[i].at, lines: syntheticLogLines(scenario, i, nodes, edges) });
  }
  return out;
}

/** A clock reading for a log line: "12:04:31.114" from a fixed base plus the modelled offset. */
export function clockFor(offsetMs: number, base = 43471000): string {
  const total = base + offsetMs;
  const h = Math.floor(total / 3600000) % 24;
  const m = Math.floor(total / 60000) % 60;
  const s = Math.floor(total / 1000) % 60;
  const ms = Math.floor(total % 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}
