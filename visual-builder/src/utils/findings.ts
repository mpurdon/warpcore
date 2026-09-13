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
  /** The model's sentence on why it matters in this account. */
  why: string | null;
  rank: number | null;
}

export interface Review {
  window_hours: number;
  findings: Finding[];
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
  return review;
}

export const SEVERITY_RANK: Record<Severity, number> = { high: 0, medium: 1, low: 2 };

/** The findings that name each ARN. */
export function findingsByArn(review: Review | null): Map<string, Finding[]> {
  const map = new Map<string, Finding[]>();
  for (const f of review?.findings ?? []) {
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
