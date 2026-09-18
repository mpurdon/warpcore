// A review of the open project: what is wrong, wasteful or fragile, judged
// from what the resources are doing. The CLI's rules produce it; a model,
// when one is configured, ranks it. Read through Tauri.

import { invoke } from '@tauri-apps/api/core';

export type Severity = 'high' | 'medium' | 'low';
export type FindingKind = 'cost' | 'security' | 'reliability' | 'operability';

export interface Finding {
  id: string;
  kind: FindingKind;
  severity: Severity;
  title: string;
  detail: string;
  arns: string[];
  evidence: Record<string, unknown>;
  suggestion: string;
  /** What acting on it costs: none (a rule change), config, restart, or code. */
  effort: 'none' | 'config' | 'restart' | 'code';
  /** Monthly dollars the fix returns, when it follows from a known rate. */
  savings_usd_month: number | null;
  /** Every rule is advisory; a finding informs, it never blocks a deploy. */
  level: string;
  /** open, or muted by the team with a reason kept in .warpcore/findings-mutes.yaml. */
  status: 'open' | 'muted';
  mute_reason: string | null;
  /** The model's sentence on why it matters in this account. */
  why: string | null;
  rank: number | null;
}

/** One resource and everything found about it: one card, findings as traits. */
export interface FindingGroup {
  arn: string;
  node_id: string | null;
  name: string;
  type: string | null;
  severity: Severity;
  finding_ids: string[];
  savings_usd_month: number | null;
  effort: Finding['effort'];
}

export interface Review {
  window_hours: number;
  findings: Finding[];
  groups: FindingGroup[];
  summary: string | null;
  model: string | null;
  notes: string[];
  errors: Record<string, string>;
  /** When the review was read, set by the app. */
  at?: string;
}

export async function fetchFindings(
  profile: string,
  configPath: string,
  hours: number,
  llm?: { provider: string; model: string },
): Promise<Review> {
  const raw = await invoke<string>('project_findings', {
    profile, configPath, hours,
    llmProvider: llm?.provider || null,
    llmModel: llm?.model || null,
  });
  const review = JSON.parse(raw) as Review;
  review.at = new Date().toISOString();
  review.groups = review.groups ?? [];
  return review;
}

/** Mute a finding with a reason, or unmute it. Writes the project's mute file through the CLI. */
export async function setMuted(configPath: string, findingId: string, reason: string | null): Promise<void> {
  await invoke<string>('mute_finding', { configPath, findingId, reason, unmute: reason === null });
}

export const EFFORT_LABEL: Record<Finding['effort'], string> = { none: 'a rule change', config: 'a config change', restart: 'a restart', code: 'a code change' };

export function formatSavings(usd: number | null | undefined): string | null {
  if (usd == null || usd <= 0) return null;
  return usd >= 10 ? `~$${Math.round(usd)}/mo` : `~$${usd.toFixed(2)}/mo`;
}

export const SEVERITY_RANK: Record<Severity, number> = { high: 0, medium: 1, low: 2 };

/** The open findings that name each ARN. */
export function findingsByArn(review: Review | null): Map<string, Finding[]> {
  const map = new Map<string, Finding[]>();
  for (const f of review?.findings ?? []) {
    if (f.status === 'muted') continue;
    for (const arn of f.arns) {
      if (!arn) continue;
      const list = map.get(arn);
      if (list) list.push(f);
      else map.set(arn, [f]);
    }
  }
  return map;
}

/** The worst severity in a list, or null. */
export function worst(findings: Finding[] | undefined): Severity | null {
  if (!findings?.length) return null;
  return findings.reduce<Severity>((acc, f) => (SEVERITY_RANK[f.severity] < SEVERITY_RANK[acc] ? f.severity : acc), 'low');
}

export const SEVERITY_COLOR: Record<Severity, string> = { high: '#dc2626', medium: '#d97706', low: '#6b7280' };
export const KIND_LABEL: Record<FindingKind, string> = { cost: 'Cost', security: 'Security', reliability: 'Reliability', operability: 'Operability' };
