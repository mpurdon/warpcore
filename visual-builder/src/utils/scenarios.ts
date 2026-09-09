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
import { displayNameById, displayNameFor } from './nodeName';
import { layerFor, TRAFFIC_KINDS } from './layers';
import { slugId } from './applications';
import { BANDS } from './stackLayout';

// ------------------------------------------------------------------ model

/** How a step ends. `ok` is the default and is never written. */
export type StepOutcome = 'ok' | 'fail' | 'timeout';

export interface ScenarioStep {
  /** Node id of the resource the request is at. */
  at: string;
  /** What happens there, in the author's words. */
  note?: string;
  /** How long the step takes, in milliseconds. */
  takes?: number;
  /** Fire and forget: the pulse leaves, the playhead does not wait. */
  detached?: boolean;
  /**
   * The unhappy path. A failing step pulses red; with `retry` the hop is
   * replayed that many times first. `outcome` is what the last attempt
   * does: `ok` after retries means the retry got through.
   */
  outcome?: StepOutcome;
  /** Attempts after the first, before the outcome. */
  retry?: number;
}

/** How many times the request arrives at the step. */
export function attemptsOf(step: Pick<ScenarioStep, 'retry'>): number {
  return (step.retry ?? 0) + 1;
}

/** True when the step's last attempt fails or times out. */
export function stepFails(step: Pick<ScenarioStep, 'outcome'>): boolean {
  return step.outcome === 'fail' || step.outcome === 'timeout';
}

/** True when the given attempt (0-based) fails: every attempt before the last, and the last when the step fails. */
export function attemptFails(step: Pick<ScenarioStep, 'outcome' | 'retry'>, attempt: number): boolean {
  return attempt < (step.retry ?? 0) || stepFails(step);
}

/** "fails" or "times out", for labels. */
export function outcomeLabel(step: Pick<ScenarioStep, 'outcome'>): string {
  return step.outcome === 'timeout' ? 'times out' : 'fails';
}

/** A scenario with a failing or retried step: what a diagram leaves out. */
export function isUnhappy(scenario: Pick<Scenario, 'steps'>): boolean {
  return scenario.steps.some((st) => stepFails(st) || Boolean(st.retry));
}

/** A dead-letter edge, whether drawn from a connection (`meta.discovered`, which is what a saved file keeps) or from a node's config. */
export function isDlqEdge(edge: Pick<Edge, 'data'>): boolean {
  return Boolean(edge.data?.isDLQ) || edge.data?.meta?.discovered?.kind === 'dlq';
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
  steps?: Array<{ at: string; note?: string; takes?: string | number; detached?: boolean; outcome?: string; retry?: number }>;
}

/** A scenario id no other scenario in the list has. */
export function uniqueScenarioId(name: string, existing: Scenario[]): string {
  const base = slugId(name) || 'scenario';
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
      if (s.outcome === 'fail' || s.outcome === 'timeout') step.outcome = s.outcome;
      if (typeof s.retry === 'number' && s.retry > 0) step.retry = Math.floor(s.retry);
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
      ...(stepFails(step) ? { outcome: step.outcome } : {}),
      ...(step.retry ? { retry: step.retry } : {}),
    })),
  }));
}

/** Types a request usually arrives at, best first, for a new scenario's default trigger. */
const ENTRY_TYPES = [...BANDS.entry.types, ...BANDS.bus.types, 's3', 'agent', 'lambda'];

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

function hopFor(edge: Edge, from: string): Hop | null {
  const meta = (edge.data?.meta || {}) as { discovered?: { kind: string; detail: string }; access?: { level: string; via: string; actions: string[] }; layer?: string };
  const outgoing = edge.source === from;
  const to = outgoing ? edge.target : edge.source;
  if (isDlqEdge(edge)) return outgoing ? { edge, to, kind: 'trigger', label: 'dead-letter queue', rank: 60 } : null;
  if (meta.access) {
    if (!outgoing) return null;
    const level = meta.access.level;
    const label = `${level} via ${meta.access.via}`;
    const rank = level === 'write' || level === 'read/write' || level === 'admin' ? 20 : 30;
    return { edge, to, kind: 'access', label, rank };
  }
  const d = meta.discovered;
  if (d) {
    if (!outgoing) return null;
    if (TRAFFIC_KINDS.has(d.kind)) {
      const authorizer = /authori[sz]er/i.test(d.detail) || /authori[sz]er/i.test(to);
      return { edge, to, kind: 'trigger', label: d.detail || d.kind, rank: authorizer ? 5 : 10 };
    }
    // A reference is a hop when the layer table puts it on access (an env
    // var naming a resource) or encryption (a key); roles, logs and VPC
    // membership are structure and plumbing, never a hop.
    if (d.kind === 'reference') {
      const layer = layerFor(d.kind, d.detail);
      if (layer === 'encryption') return { edge, to, kind: 'reference', label: d.detail, rank: 40 };
      if (layer === 'access') return { edge, to, kind: 'reference', label: d.detail, rank: 35 };
    }
    return null;
  }
  // Drawn by hand: a permission edge from source to target.
  if (!outgoing) return null;
  const cfg = (edge.data?.config || {}) as { method?: string; path?: string };
  const label = cfg.path ? `${cfg.method || 'ANY'} ${cfg.path}` : edge.data?.isResourceBased ? 'invokes' : edge.data?.roleId ? 'via role' : 'connection';
  return { edge, to, kind: 'drawn', label, rank: 25 };
}

/**
 * The graph as the request sees it: for every node, the hops it can take,
 * best first, and the log groups it writes to. Built once per (nodes,
 * edges) and handed to everything below, so a check over a ten-step
 * scenario is one pass over the edges, not ten.
 */
export interface HopIndex {
  hops: Map<string, Hop[]>;
  /** Per node: the log groups wired to it, and the edges that wire them. */
  logs: Map<string, { groups: string[]; edgeIds: string[] }>;
  name: (id: string) => string;
}

export function hopIndex(nodes: Node[], edges: Edge[]): HopIndex {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const name = displayNameById(nodes);
  const hops = new Map<string, Hop[]>();
  const logs = new Map<string, { groups: string[]; edgeIds: string[] }>();
  const push = (from: string, hop: Hop) => hops.set(from, [...(hops.get(from) || []), hop]);
  const log = (nodeId: string, group: string, edgeId: string) => {
    const entry = logs.get(nodeId) || { groups: [], edgeIds: [] };
    if (!entry.groups.includes(group)) entry.groups.push(group);
    entry.edgeIds.push(edgeId);
    logs.set(nodeId, entry);
  };
  for (const e of edges) {
    const source = byId.get(e.source);
    const target = byId.get(e.target);
    if (!source || !target) continue;
    if (target.type === 'log-group') log(e.source, e.target, e.id);
    if (source.type === 'log-group') log(e.target, e.source, e.id);
    for (const from of [e.source, e.target]) {
      const hop = hopFor(e, from);
      if (hop && canBeStep(byId.get(hop.to)!)) push(from, hop);
    }
  }
  for (const list of hops.values()) list.sort((a, b) => a.rank - b.rank || name(a.to).localeCompare(name(b.to)));
  return { hops, logs, name };
}

/** The hops the graph allows from a node, best first. Never a log group or a role. */
export function hopsFrom(nodeId: string, nodes: Node[], edges: Edge[], index = hopIndex(nodes, edges)): Hop[] {
  return index.hops.get(nodeId) || [];
}

/**
 * Draft a path from the entry resource: a depth-first walk over triggers,
 * access and references, best hop first, so "API → authorizer → its key →
 * function → its table → its topic" comes out in request order. Capped so a
 * hairball does not become a forty-step scenario.
 */
export function suggestPath(startId: string, nodes: Node[], edges: Edge[], limit = 12, index = hopIndex(nodes, edges)): ScenarioStep[] {
  const steps: ScenarioStep[] = [];
  const seen = new Set<string>([startId]);
  const walk = (id: string) => {
    for (const hop of index.hops.get(id) || []) {
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
  edgeId: string;
  /** The edge is drawn the other way round (the hop runs target to source). */
  reverse: boolean;
}

export interface StepCheck {
  at: string;
  evidence: StepEvidence | null;
  /** Log groups this compute step writes to, and the edges that carry the writes. */
  logGroups: string[];
  logEdges: string[];
  problems: string[];
  /** Worth knowing, not wrong: a failure nothing catches. */
  notes: string[];
}

export interface ScenarioCheck {
  triggerExists: boolean;
  steps: StepCheck[];
  problems: string[];
  notes: string[];
  ok: boolean;
}

/** The node a hop into `stepId` most plausibly came from: the nearest earlier step wired to it. */
function evidenceFor(stepId: string, earlier: string[], index: HopIndex): StepEvidence | null {
  for (let i = earlier.length - 1; i >= 0; i--) {
    const from = earlier[i];
    const hop = (index.hops.get(from) || []).find((h) => h.to === stepId);
    if (hop) {
      const access = (hop.edge.data?.meta as { access?: { actions: string[] } } | undefined)?.access;
      return { from, label: hop.label, edgeId: hop.edge.id, reverse: hop.edge.target === from, ...(access?.actions?.length ? { actions: access.actions } : {}) };
    }
  }
  return null;
}

/** The log groups a node writes to: log edges, and any log group it is wired to. */
export function logGroupsFor(nodeId: string, nodes: Node[], edges: Edge[], index = hopIndex(nodes, edges)): string[] {
  return index.logs.get(nodeId)?.groups ?? [];
}

export function checkScenario(scenario: Scenario, nodes: Node[], edges: Edge[], index = hopIndex(nodes, edges)): ScenarioCheck {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const { name } = index;
  const problems: string[] = [];
  const triggerExists = byId.has(scenario.trigger.at);
  if (!triggerExists) problems.push(`Trigger ${scenario.trigger.at} is not on the canvas`);
  const earlier: string[] = [scenario.trigger.at];
  // A failing step is caught when a later step is reached over a dead-letter
  // hop from it or from anything before it: the queue's redrive, the
  // function's own DLQ.
  const caught = (i: number): boolean => {
    const sources = [scenario.trigger.at, ...scenario.steps.slice(0, i + 1).map((s) => s.at)];
    const later = new Set(scenario.steps.slice(i + 1).map((s) => s.at));
    return sources.some((from) => (index.hops.get(from) || []).some((h) => isDlqEdge(h.edge) && later.has(h.to)));
  };
  const steps: StepCheck[] = scenario.steps.map((step, i) => {
    const node = byId.get(step.at);
    const stepProblems: string[] = [];
    const notes: string[] = [];
    let evidence: StepEvidence | null = null;
    let logs = { groups: [] as string[], edgeIds: [] as string[] };
    if (!node) {
      stepProblems.push(`${step.at} is not on the canvas`);
    } else {
      evidence = evidenceFor(step.at, earlier, index);
      if (!evidence) stepProblems.push(`No permission or trigger found from ${name(earlier[earlier.length - 1])} to ${name(step.at)}`);
      if (COMPUTE_TYPES.has(node.type || '')) {
        logs = index.logs.get(step.at) ?? logs;
        if (logs.groups.length === 0) stepProblems.push(`${name(step.at)} has no log group wired`);
      }
      if (stepFails(step) && !caught(i)) {
        const what = outcomeLabel(step);
        notes.push(step.retry
          ? `${name(step.at)} ${what} after ${step.retry} ${step.retry === 1 ? 'retry' : 'retries'} and no dead-letter queue catches it`
          : `${name(step.at)} ${what} here; nothing retries it and no dead-letter queue catches it`);
      }
    }
    earlier.push(step.at);
    return { at: step.at, evidence, logGroups: logs.groups, logEdges: logs.edgeIds, problems: stepProblems, notes };
  });
  if (scenario.steps.length === 0) problems.push('No steps yet');
  for (const s of steps) problems.push(...s.problems);
  const notes = steps.flatMap((s) => s.notes);
  return { triggerExists, steps, problems, notes, ok: problems.length === 0 };
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
  /** Which arrival at the step this is: 0 the first, then one per retry. */
  attempt: number;
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

/** The playhead one phase later. A step with retries is travelled to again before the request moves on. */
export function advance(scenario: Scenario, head: Playhead): Playhead {
  if (head.phase === 'end') return head;
  const last = scenario.steps.length - 1;
  if (head.phase === 'travel') return { ...head, phase: 'dwell' };
  const step = scenario.steps[head.index];
  if (step && head.attempt < (step.retry ?? 0)) return { ...head, phase: 'travel', attempt: head.attempt + 1 };
  if (head.index >= last) return { ...head, phase: 'end', playing: false };
  return { ...head, index: head.index + 1, phase: 'travel', attempt: 0 };
}

/** The playhead at the start of a step, or at the trigger for -1. */
export function seekTo(scenario: Scenario, head: Playhead, index: number): Playhead {
  const clamped = Math.max(-1, Math.min(scenario.steps.length - 1, index));
  if (clamped < 0) return { ...head, index: -1, phase: 'dwell', attempt: 0 };
  return { ...head, index: clamped, phase: 'dwell', attempt: 0 };
}

/** How many steps the request has reached at the playhead: a dwelling step counts, one being travelled to does not. */
export function stepsDone(scenario: Scenario, head: Pick<Playhead, 'index' | 'phase'>): number {
  if (head.phase === 'end') return scenario.steps.length;
  return Math.max(0, Math.min(scenario.steps.length, head.phase === 'dwell' ? head.index + 1 : head.index));
}

/**
 * Modelled time into the request at the playhead: the `takes` of every
 * attempt made so far. A timed-out attempt costs its full `takes` too.
 */
export function modelledTimeMs(scenario: Scenario, head: Pick<Playhead, 'index' | 'phase'> & { attempt?: number }): number {
  let t = 0;
  const upTo = stepsDone(scenario, head);
  for (let i = 0; i < upTo; i++) {
    const step = scenario.steps[i];
    if (step.detached) continue;
    const attempts = i === head.index && head.phase === 'dwell' ? (head.attempt ?? 0) + 1 : attemptsOf(step);
    t += (step.takes ?? DEFAULT_TAKES_MS) * attempts;
  }
  return t;
}

/**
 * What a node is doing at the playhead. `failing` is the request dying on
 * it right now; `failed` is a step whose last attempt failed, once passed.
 */
export type StepState = 'pending' | 'travelling' | 'active' | 'visited' | 'failed' | 'failing';

const STATE_RANK: Record<StepState, number> = { pending: 0, travelling: 1, visited: 2, failed: 3, active: 4, failing: 5 };

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
}

export function playbackMarks(scenario: Scenario, head: Playhead | null, check: ScenarioCheck): PlaybackMarks {
  const numbers = new Map<string, number[]>();
  const push = (id: string, n: number) => numbers.set(id, [...(numbers.get(id) || []), n]);
  push(scenario.trigger.at, 0);
  scenario.steps.forEach((s, i) => push(s.at, i + 1));
  const state = new Map<string, StepState>();
  const logEdges = new Set<string>();
  const logging = new Set<string>();
  let pulse: PlaybackMarks['pulse'] = null;
  if (!head) return { numbers, state, pulse, logEdges, logging };

  const doneThrough = stepsDone(scenario, head) - 1;
  state.set(scenario.trigger.at, head.index < 0 && head.phase !== 'end' ? 'active' : 'visited');
  scenario.steps.forEach((s, i) => {
    const current = state.get(s.at);
    let next: StepState;
    if (i <= doneThrough) next = stepFails(s) ? 'failed' : 'visited';
    else if (i === head.index && head.phase === 'travel') next = 'travelling';
    else next = 'pending';
    if (i === head.index && head.phase === 'dwell') next = attemptFails(s, head.attempt) ? 'failing' : 'active';
    // A node visited twice keeps its strongest state.
    if (!current || STATE_RANK[next] > STATE_RANK[current]) state.set(s.at, next);
  });

  const current = head.phase !== 'end' ? check.steps[head.index] : undefined;
  if (current) {
    const ev = current.evidence;
    if (head.phase === 'travel' && ev) pulse = { edgeId: ev.edgeId, reverse: ev.reverse };
    if (head.phase === 'dwell') {
      for (const g of current.logGroups) logging.add(g);
      for (const e of current.logEdges) logEdges.add(e);
    }
  }
  return { numbers, state, pulse, logEdges, logging };
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
  level: 'START' | 'INFO' | 'WARN' | 'ERROR' | 'END' | 'REPORT';
  text: string;
}

const FAILURES = [
  'Unhandled exception: ServiceUnavailable',
  'Unhandled exception: ThrottlingException: Rate exceeded',
  'Unhandled exception: ConnectionResetError',
  'Unhandled exception: ValidationError',
];

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
  'elasticache-cluster': ['GET', 'SET', 'INCR', 'ZADD'],
  opensearch: ['Search', 'Index'],
  cognito: ['InitiateAuth', 'GetUser'],
  athena: ['StartQueryExecution'],
  glue: ['StartJobRun'],
  'ecs-service': ['HTTP GET'],
  'load-balancer': ['HTTP GET'],
  cloudfront: ['GET'],
};

/**
 * Plausible lines for one compute step: per attempt a START, something
 * about the event, one line per resource the request goes on to touch, an
 * END and a REPORT; a failing attempt ends in an ERROR instead. Decoration
 * that shows data moving; it never claims to be what the code logs.
 * `attempts` caps how many arrivals are shown, for the playhead mid-retry.
 */
export function syntheticLogLines(scenario: Scenario, stepIndex: number, nodes: Node[], edges: Edge[], index = hopIndex(nodes, edges), attempts = Infinity): LogLine[] {
  const step = scenario.steps[stepIndex];
  if (!step) return [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  // What this step is wired to directly; a queue fed by its topic is not its call.
  const direct = new Set((index.hops.get(step.at) || []).map((h) => h.to));
  const rnd = mulberry32(hash(`${scenario.id}/${stepIndex}/${step.at}`));
  const takes = step.takes ?? DEFAULT_TAKES_MS;
  const eventText = stepIndex === 0 && scenario.trigger.event ? scenario.trigger.event : step.note;
  // The resources this compute step goes on to call itself, until the next compute step.
  const touched: string[] = [];
  for (let i = stepIndex + 1; i < scenario.steps.length; i++) {
    const n = byId.get(scenario.steps[i].at);
    if (!n) continue;
    if (COMPUTE_TYPES.has(n.type || '')) break;
    if (direct.has(scenario.steps[i].at)) touched.push(scenario.steps[i].at);
  }
  const total = attemptsOf(step);
  const shown = Math.min(total, Math.max(1, attempts));
  const arrival = modelledTimeMs(scenario, { index: stepIndex, phase: 'travel' });
  const lines: LogLine[] = [];
  for (let attempt = 0; attempt < shown; attempt++) {
    const start = arrival + attempt * takes;
    const requestId = `${Math.floor(rnd() * 0xffff).toString(16).padStart(4, '0')}${Math.floor(rnd() * 0xffff).toString(16).padStart(4, '0')}…`;
    lines.push({ t: start, level: 'START', text: `RequestId: ${requestId}${attempt ? `  (retry ${attempt} of ${total - 1})` : ''}` });
    let t = start + Math.max(1, Math.round(takes * 0.05));
    if (eventText) { lines.push({ t, level: 'INFO', text: eventText }); t += Math.max(1, Math.round(takes * 0.1)); }
    const fails = attemptFails(step, attempt);
    // A timeout dies before it gets to its calls; a failure gets partway.
    const calls = step.outcome === 'timeout' && fails ? touched.slice(0, Math.floor(touched.length / 2)) : touched;
    for (const id of calls) {
      const n = byId.get(id)!;
      const verbs = VERB_BY_TYPE[n.type || ''] || ['call'];
      const verb = verbs[Math.floor(rnd() * verbs.length)];
      const ms = Math.max(1, Math.round(scenario.steps.find((s) => s.at === id)?.takes ?? (5 + rnd() * 40)));
      lines.push({ t, level: rnd() < 0.08 ? 'WARN' : 'INFO', text: `${verb} ${displayNameFor(n)} ${ms} ms` });
      t += ms;
    }
    const end = start + takes;
    if (fails) {
      const text = step.outcome === 'timeout'
        ? `Task timed out after ${(takes / 1000).toFixed(2)} seconds`
        : FAILURES[Math.floor(rnd() * FAILURES.length)];
      lines.push({ t: Math.max(t, end), level: 'ERROR', text });
    }
    lines.push({ t: Math.max(t, end), level: 'END', text: `RequestId: ${requestId}` });
    const memory = 128 * (1 + Math.floor(rnd() * 8));
    const used = Math.round(memory * (0.3 + rnd() * 0.5));
    lines.push({ t: Math.max(t, end), level: 'REPORT', text: `Duration: ${takes} ms  Memory Size: ${memory} MB  Max Memory Used: ${used} MB${fails ? '  Status: error' : ''}` });
  }
  return lines;
}

/** Lines for every compute step up to and including the playhead's, and only the attempts made so far. */
export function logLinesUpTo(scenario: Scenario, head: Playhead | null, nodes: Node[], edges: Edge[]): { at: string; lines: LogLine[] }[] {
  if (!head) return [];
  const out: { at: string; lines: LogLine[] }[] = [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const index = hopIndex(nodes, edges);
  for (let i = 0; i < stepsDone(scenario, head); i++) {
    const node = byId.get(scenario.steps[i].at);
    if (!node || !COMPUTE_TYPES.has(node.type || '')) continue;
    const attempts = i === head.index && head.phase === 'dwell' ? head.attempt + 1 : Infinity;
    out.push({ at: scenario.steps[i].at, lines: syntheticLogLines(scenario, i, nodes, edges, index, attempts) });
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

// ------------------------------------------------------------------ badges

/** What a step badge shows: the trigger is a play mark, steps their number. */
export function badgeLabel(n: number): string {
  return n === 0 ? '▶' : String(n);
}

/** The badge's tone class for a node's state at the playhead. */
export function badgeTone(state: StepState | undefined): '' | 'active' | 'pending' | 'failed' {
  if (state === 'active') return 'active';
  if (state === 'failed' || state === 'failing') return 'failed';
  if (state === 'pending' || state === 'travelling') return 'pending';
  return '';
}
