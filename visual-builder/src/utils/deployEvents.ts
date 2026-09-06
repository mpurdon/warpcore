// The state of one deploy or destroy run, and how the CLI's events change
// it. Pure: the runner (deployRunner.ts) feeds events in, the Activity
// drawer reads the result. Nothing here touches Tauri or the store, so the
// whole protocol is unit-testable.
//
// Event shapes come from `warpcore deploy --progress` (run_progress.py) and
// the Rust host's `started` / `exit` framing around it.

import { Node } from 'reactflow';
import { NodeStatus } from '../store/useStore';
import { displayNameFor } from './nodeName';

export type RunKind = 'deploy' | 'destroy';
export type RunPhase = 'starting' | 'running' | 'done';
export type RunOutcome = 'success' | 'partial' | 'failed';
export type RunResourceStatus = 'planned' | 'in_progress' | 'success' | 'failed' | 'skipped';

export interface RunResource {
  id: string;
  type?: string | null;
  /** create · update · delete, from the plan. */
  change?: string | null;
  wave?: number;
  reason?: string | null;
  status: RunResourceStatus;
  /** Milliseconds since epoch, from when the event arrived. */
  startedAt?: number;
  endedAt?: number;
  /** Seconds, measured by the CLI. */
  duration?: number | null;
  error?: string | null;
}

export interface RunLine {
  at: number;
  stream: 'out' | 'err';
  text: string;
}

export interface RunState {
  kind: RunKind;
  environment: string;
  startedAt: number;
  endedAt?: number;
  phase: RunPhase;
  outcome?: RunOutcome;
  /** True once the CLI has said what it will touch. */
  planned: boolean;
  resources: RunResource[];
  counts: { total: number; successful: number; failed: number; skipped: number };
  /** Seconds, as reported by the CLI's complete event. */
  duration?: number;
  exitCode?: number | null;
  /** A fatal message: the CLI could not start, or died before completing. */
  message?: string;
  output: RunLine[];
}

const MAX_OUTPUT_LINES = 2000;

export function newRun(kind: RunKind, environment: string, now = Date.now()): RunState {
  return {
    kind,
    environment,
    startedAt: now,
    phase: 'starting',
    planned: false,
    resources: [],
    counts: { total: 0, successful: 0, failed: 0, skipped: 0 },
    output: [],
  };
}

export function isActive(run: RunState | null | undefined): boolean {
  return Boolean(run && run.phase !== 'done');
}

/** Loose shape of what arrives on `deployment-update`. */
export interface RunEvent {
  event: string;
  [key: string]: unknown;
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}
function asNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** Fold one event into the run. Returns a new object; never mutates. */
export function applyRunEvent(run: RunState, ev: RunEvent, now = Date.now()): RunState {
  switch (ev.event) {
    case 'started':
      return { ...run, phase: 'starting' };

    case 'plan': {
      const changes = Array.isArray(ev.changes) ? (ev.changes as Record<string, unknown>[]) : [];
      const resources: RunResource[] = changes.map((c) => ({
        id: String(c.id),
        type: asString(c.type) ?? null,
        change: asString(c.change) ?? null,
        wave: asNumber(c.wave),
        reason: asString(c.reason) ?? null,
        status: 'planned',
      }));
      return {
        ...run,
        phase: 'running',
        planned: true,
        resources,
        counts: { ...run.counts, total: asNumber(ev.total) ?? resources.length },
      };
    }

    case 'resource': {
      const id = String(ev.id);
      const status = asString(ev.status) as RunResourceStatus | undefined;
      if (!status) return run;
      const existing = run.resources.find((r) => r.id === id);
      const patch: Partial<RunResource> = status === 'in_progress'
        ? { status, startedAt: now }
        : {
          status,
          endedAt: now,
          duration: asNumber(ev.duration) ?? null,
          error: asString(ev.error) ?? null,
        };
      const resources = existing
        ? run.resources.map((r) => (r.id === id ? { ...r, ...patch } : r))
        : [...run.resources, { id, status: 'planned', ...patch } as RunResource];
      return { ...run, phase: 'running', resources };
    }

    case 'complete': {
      const status = asString(ev.status);
      const outcome: RunOutcome = status === 'success' ? 'success' : status === 'partial' ? 'partial' : 'failed';
      const failures = (ev.failures && typeof ev.failures === 'object') ? (ev.failures as Record<string, string>) : {};
      // Anything still marked planned when the CLI is done was skipped by it.
      const resources = run.resources.map((r) => {
        if (failures[r.id] && r.status !== 'failed') return { ...r, status: 'failed' as const, error: failures[r.id], endedAt: r.endedAt ?? now };
        if (r.status === 'planned' || r.status === 'in_progress') return { ...r, status: 'skipped' as const, endedAt: now };
        return r;
      });
      return {
        ...run,
        phase: 'done',
        outcome,
        endedAt: now,
        resources,
        duration: asNumber(ev.duration),
        counts: {
          total: asNumber(ev.total) ?? run.counts.total,
          successful: asNumber(ev.successful) ?? resources.filter((r) => r.status === 'success').length,
          failed: asNumber(ev.failed) ?? resources.filter((r) => r.status === 'failed').length,
          skipped: asNumber(ev.skipped) ?? resources.filter((r) => r.status === 'skipped').length,
        },
      };
    }

    case 'error':
      return {
        ...run,
        phase: 'done',
        outcome: 'failed',
        endedAt: run.endedAt ?? now,
        message: asString(ev.message) ?? 'The CLI reported an error',
      };

    case 'exit': {
      const code = ev.code === null ? null : asNumber(ev.code) ?? null;
      const success = ev.success === true;
      if (run.phase === 'done') return { ...run, exitCode: code };
      // The process ended without a complete event: it crashed, or an older
      // CLI without --progress ran. Say so rather than spinning forever.
      return {
        ...run,
        phase: 'done',
        outcome: success ? 'success' : 'failed',
        endedAt: now,
        exitCode: code,
        message: run.message ?? (success
          ? 'The CLI exited without reporting a plan. It may be an older build without --progress.'
          : `The CLI exited with status ${code ?? 'unknown'} before completing.`),
      };
    }

    default:
      return run;
  }
}

export function appendOutput(run: RunState, text: string, stream: 'out' | 'err', now = Date.now()): RunState {
  const output = [...run.output, { at: now, stream, text }];
  if (output.length > MAX_OUTPUT_LINES) output.splice(0, output.length - MAX_OUTPUT_LINES);
  return { ...run, output };
}

/** What a run resource's state means for the node that represents it. */
export function nodeStatusFor(kind: RunKind, status: RunResourceStatus): NodeStatus | null {
  if (kind === 'destroy') {
    if (status === 'in_progress') return 'deploying';
    if (status === 'success') return 'draft';
    if (status === 'failed') return 'failed';
    return null;
  }
  switch (status) {
    case 'planned': return 'configured';
    case 'in_progress': return 'deploying';
    case 'success': return 'deployed';
    case 'failed': return 'failed';
    default: return null;
  }
}

/**
 * The canvas node a CLI resource id refers to. The orchestrator names
 * resources after config names (an agent's name, a bucket's name), the
 * canvas keys nodes by id, so try id, display name, config name and a
 * slug of the label, in that order.
 */
export function matchNodeForResource(resourceId: string, nodes: Node[]): Node | undefined {
  const wanted = resourceId.toLowerCase();
  const slug = (s: string) => s.toLowerCase().replace(/\s+/g, '-');
  return nodes.find((n) => n.id.toLowerCase() === wanted)
    ?? nodes.find((n) => displayNameFor(n).toLowerCase() === wanted)
    ?? nodes.find((n) => typeof n.data?.config?.name === 'string' && n.data.config.name.toLowerCase() === wanted)
    ?? nodes.find((n) => typeof n.data?.label === 'string' && slug(n.data.label) === wanted);
}

/** Elapsed seconds for a run, live while it is active. */
export function runElapsedSeconds(run: RunState, now = Date.now()): number {
  return Math.max(0, ((run.endedAt ?? now) - run.startedAt) / 1000);
}
