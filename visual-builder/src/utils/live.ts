// The live lens and drift: what the account says about the canvas right now,
// fused with the last review, and the deployment state checked against
// the account. Mirrors warpcore/discovery/health.py and snapshots.py.
//
// Health is read on demand and kept for the session; it goes stale, and the
// canvas says so rather than pretending. Nothing here writes anywhere.

import { invoke } from '@tauri-apps/api/core';
import { Finding, worst } from './findings';
import { useStore } from '../store/useStore';
import { projectProfile } from './accountExplorer';

export type HealthLevel = 'ok' | 'warn' | 'bad' | 'unknown';

export interface HealthEntry {
  level: HealthLevel;
  reason: string;
  missing?: boolean;
  checked_at: string;
  /** When warpcore last deployed it, from the state file. */
  deployed_at?: string | null;
}

export interface CanvasHealth {
  checked_at: string;
  resources: Record<string, HealthEntry>;
}

export interface DriftItem {
  id: string;
  type: string;
  physical_id: string;
  kind: 'missing' | 'modified' | 'ok' | 'unchecked';
  managed: boolean;
  differences: { key: string; recorded: unknown; live: unknown }[];
  note?: string | null;
}

export interface DriftReport {
  checked_at: string;
  counts: { ok: number; modified: number; missing: number; unchecked: number };
  items: DriftItem[];
  /** Set when the check itself failed (no state yet, no profile, the CLI). */
  error?: string;
}

export interface ImportDiff {
  before_at: string;
  after_at: string;
  added: { arn: string; name: string; type: string }[];
  removed: { arn: string; name: string; type: string }[];
  changed: { arn: string; name: string; type: string; changes: { key: string; before: unknown; after: unknown }[] }[];
  connections_added: { from: string; to: string; kind: string | null }[];
  connections_removed: { from: string; to: string; kind: string | null }[];
}

/** Health older than this is drawn faded until it is read again. */
export const STALE_AFTER_MS = 15 * 60 * 1000;

export function isStale(health: CanvasHealth | null, now = Date.now()): boolean {
  if (!health) return true;
  const t = Date.parse(health.checked_at);
  return !Number.isFinite(t) || now - t > STALE_AFTER_MS;
}

export const LEVEL_RANK: Record<HealthLevel, number> = { bad: 0, warn: 1, unknown: 2, ok: 3 };

/**
 * One colour per resource: the live level, worsened by what the review
 * found. A running host with a high finding is not "ok"; a host the account
 * no longer has is bad whatever the review said.
 */
export function fusedLevel(entry: HealthEntry | undefined, findings: Finding[] | undefined): HealthLevel {
  let level: HealthLevel = entry?.level ?? 'unknown';
  if (entry?.missing) level = 'bad';
  const sev = worst(findings);
  if (sev === 'high' && level !== 'bad') level = level === 'ok' || level === 'unknown' ? 'warn' : level;
  if (sev === 'medium' && level === 'ok') level = 'warn';
  return level;
}

/** Why a resource wears its colour, for the tooltip. */
export function fusedReason(entry: HealthEntry | undefined, findings: Finding[] | undefined): string {
  const parts: string[] = [];
  if (entry) parts.push(entry.reason);
  const open = (findings ?? []).filter((f) => f.status !== 'muted');
  if (open.length) parts.push(`${open.length} ${open.length === 1 ? 'finding' : 'findings'}: ${open.map((f) => f.title).join('; ')}`);
  return parts.join(' · ') || 'not checked';
}

export function countLevels(health: CanvasHealth | null, byArn: Map<string, Finding[]>, arns: string[]): Record<HealthLevel, number> {
  const out: Record<HealthLevel, number> = { ok: 0, warn: 0, bad: 0, unknown: 0 };
  for (const arn of arns) out[fusedLevel(health?.resources[arn], byArn.get(arn))] += 1;
  return out;
}

// ------------------------------------------------------------------ fetch

export async function fetchHealth(profile: string, configPath: string, environment: string | null): Promise<CanvasHealth> {
  const raw = await invoke<string>('project_health', { profile, configPath, environment });
  return JSON.parse(raw) as CanvasHealth;
}

export async function fetchDrift(profile: string, configPath: string, environment: string): Promise<DriftReport> {
  const raw = await invoke<string>('project_drift', { profile, configPath, environment });
  return JSON.parse(raw) as DriftReport;
}

export async function fetchImportHistory(configPath: string): Promise<{ snapshots: { path: string; taken_at: string }[]; since_last_import: ImportDiff | null }> {
  const raw = await invoke<string>('import_history', { configPath });
  return JSON.parse(raw) as { snapshots: { path: string; taken_at: string }[]; since_last_import: ImportDiff | null };
}

/** Read the live health of the open project into the store. A no-op without a saved project and a profile. */
export async function refreshLive(): Promise<void> {
  const s = useStore.getState();
  const profile = projectProfile(s.environmentExtras, s.currentEnvironment);
  if (!profile || !s.configPath || s.liveBusy) return;
  s.setLiveBusy(true);
  try {
    s.setLiveHealth(await fetchHealth(profile, s.configPath, s.currentEnvironment));
  } catch (e) {
    s.setLiveHealth({ checked_at: new Date().toISOString(), resources: {}, error: String(e) } as CanvasHealth & { error: string });
  } finally {
    useStore.getState().setLiveBusy(false);
  }
}

/** Compare the deployment state with the account. Quiet when there is nothing to compare. */
export async function refreshDrift(): Promise<void> {
  const s = useStore.getState();
  const profile = projectProfile(s.environmentExtras, s.currentEnvironment);
  if (!profile || !s.configPath || s.driftBusy) return;
  s.setDriftBusy(true);
  try {
    s.setDrift(await fetchDrift(profile, s.configPath, s.currentEnvironment));
  } catch (e) {
    s.setDrift({ checked_at: new Date().toISOString(), counts: { ok: 0, modified: 0, missing: 0, unchecked: 0 }, items: [], error: String(e) });
  } finally {
    useStore.getState().setDriftBusy(false);
  }
}

/** What changed since the previous import of this project, from the snapshots beside it. */
export async function loadImportHistory(configPath: string): Promise<void> {
  try {
    const history = await fetchImportHistory(configPath);
    useStore.getState().setImportDiff(history.since_last_import);
  } catch {
    useStore.getState().setImportDiff(null);
  }
}

export function importDiffIsEmpty(d: ImportDiff | null): boolean {
  return !d || (d.added.length + d.removed.length + d.changed.length + d.connections_added.length + d.connections_removed.length) === 0;
}
