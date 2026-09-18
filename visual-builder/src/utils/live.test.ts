import { describe, expect, it } from 'vitest';
import { countLevels, fusedLevel, fusedReason, importDiffIsEmpty, isStale } from './live';
import type { Finding } from './findings';

const finding = (severity: Finding['severity'], status: Finding['status'] = 'open'): Finding => ({
  id: `f-${severity}`, kind: 'security', severity, title: `${severity} thing`, detail: '', arns: ['arn:x'], evidence: {}, suggestion: '',
  effort: 'config', savings_usd_month: null, level: 'advisory', status, mute_reason: null, why: null, rank: null, reasoning: [],
});

describe('fusedLevel', () => {
  it('starts from the live level', () => {
    expect(fusedLevel({ level: 'ok', reason: 'running', checked_at: '' }, undefined)).toBe('ok');
    expect(fusedLevel(undefined, undefined)).toBe('unknown');
  });
  it('is bad when the account no longer has the resource, whatever the review said', () => {
    expect(fusedLevel({ level: 'warn', reason: 'gone', missing: true, checked_at: '' }, [finding('low')])).toBe('bad');
  });
  it('worsens ok to warn on a medium or high finding, never to bad', () => {
    expect(fusedLevel({ level: 'ok', reason: '', checked_at: '' }, [finding('medium')])).toBe('warn');
    expect(fusedLevel({ level: 'ok', reason: '', checked_at: '' }, [finding('high')])).toBe('warn');
    expect(fusedLevel({ level: 'ok', reason: '', checked_at: '' }, [finding('low')])).toBe('ok');
    expect(fusedLevel({ level: 'bad', reason: '', checked_at: '' }, [finding('high')])).toBe('bad');
  });
  it('ignores muted findings in the reason and counts', () => {
    expect(fusedReason({ level: 'ok', reason: 'running', checked_at: '' }, [finding('high', 'muted')])).toBe('running');
    const health = { checked_at: '', resources: { 'arn:x': { level: 'ok' as const, reason: '', checked_at: '' } } };
    expect(countLevels(health, new Map([['arn:x', [finding('high')]]]), ['arn:x', 'arn:y'])).toEqual({ ok: 0, warn: 1, bad: 0, unknown: 1 });
  });
});

describe('isStale', () => {
  it('is stale with nothing read, or after the window', () => {
    const now = Date.parse('2026-09-18T10:00:00Z');
    expect(isStale(null, now)).toBe(true);
    expect(isStale({ checked_at: '2026-09-18T09:50:00Z', resources: {} }, now)).toBe(false);
    expect(isStale({ checked_at: '2026-09-18T09:30:00Z', resources: {} }, now)).toBe(true);
  });
});

describe('importDiffIsEmpty', () => {
  it('treats a diff with nothing in any list as empty', () => {
    expect(importDiffIsEmpty(null)).toBe(true);
    expect(importDiffIsEmpty({ before_at: '', after_at: '', added: [], removed: [], changed: [], connections_added: [], connections_removed: [] })).toBe(true);
    expect(importDiffIsEmpty({ before_at: '', after_at: '', added: [{ arn: 'a', name: 'a', type: 'sqs' }], removed: [], changed: [], connections_added: [], connections_removed: [] })).toBe(false);
  });
});
