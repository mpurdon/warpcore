import { describe, expect, it } from 'vitest';
import type { Node } from 'reactflow';
import { applyRunEvent, appendOutput, isActive, matchNodeForResource, newRun, nodeStatusFor, RunState } from './deployEvents';

function play(events: Record<string, unknown>[], start = 1000): RunState {
  let run = newRun('deploy', 'dev', start);
  let t = start;
  for (const ev of events) {
    t += 100;
    run = applyRunEvent(run, ev as { event: string }, t);
  }
  return run;
}

const plan = {
  event: 'plan', kind: 'deploy', total: 2,
  changes: [
    { id: 'exec-role', type: 'AWS::IAM::Role', change: 'create', wave: 0 },
    { id: 'api-agent', type: 'AWS::Lambda::Function', change: 'update', wave: 1, reason: 'code changed' },
  ],
};

describe('applyRunEvent', () => {
  it('follows a successful run from plan to complete', () => {
    const run = play([
      { event: 'started' },
      plan,
      { event: 'resource', id: 'exec-role', status: 'in_progress' },
      { event: 'resource', id: 'exec-role', status: 'success', duration: 1.2 },
      { event: 'resource', id: 'api-agent', status: 'in_progress' },
      { event: 'resource', id: 'api-agent', status: 'success', duration: 3.4 },
      { event: 'complete', status: 'success', total: 2, successful: 2, failed: 0, duration: 4.7 },
      { event: 'exit', code: 0, success: true },
    ]);
    expect(run.phase).toBe('done');
    expect(run.outcome).toBe('success');
    expect(run.planned).toBe(true);
    expect(run.resources.map((r) => [r.id, r.status, r.duration])).toEqual([
      ['exec-role', 'success', 1.2],
      ['api-agent', 'success', 3.4],
    ]);
    expect(run.resources[0].startedAt).toBe(1300);
    expect(run.resources[0].endedAt).toBe(1400);
    expect(run.counts).toEqual({ total: 2, successful: 2, failed: 0, skipped: 0 });
    expect(run.duration).toBe(4.7);
    expect(run.exitCode).toBe(0);
    expect(run.message).toBeUndefined();
    expect(isActive(run)).toBe(false);
  });

  it('records a failure with its error and marks the rest skipped', () => {
    const run = play([
      plan,
      { event: 'resource', id: 'exec-role', status: 'in_progress' },
      { event: 'resource', id: 'exec-role', status: 'failed', error: 'AccessDenied', duration: 0.3 },
      { event: 'complete', status: 'failed', total: 2, successful: 0, failed: 1, failures: { 'exec-role': 'AccessDenied' } },
      { event: 'exit', code: 1, success: false },
    ]);
    expect(run.outcome).toBe('failed');
    expect(run.resources[0]).toMatchObject({ status: 'failed', error: 'AccessDenied' });
    expect(run.resources[1].status).toBe('skipped');
    expect(run.counts.skipped).toBe(1);
  });

  it('treats an empty plan as a finished run with nothing in it', () => {
    const run = play([
      { event: 'plan', total: 0, changes: [] },
      { event: 'complete', status: 'success', total: 0, successful: 0, failed: 0 },
      { event: 'exit', code: 0, success: true },
    ]);
    expect(run.planned).toBe(true);
    expect(run.resources).toEqual([]);
    expect(run.outcome).toBe('success');
  });

  it('explains an exit with no complete event', () => {
    const crashed = play([{ event: 'started' }, { event: 'exit', code: 2, success: false }]);
    expect(crashed.phase).toBe('done');
    expect(crashed.outcome).toBe('failed');
    expect(crashed.message).toMatch(/status 2/);

    const oldCli = play([{ event: 'started' }, { event: 'exit', code: 0, success: true }]);
    expect(oldCli.outcome).toBe('success');
    expect(oldCli.message).toMatch(/--progress/);
  });

  it('keeps an error message through the exit', () => {
    const run = play([
      { event: 'error', message: 'no credentials' },
      { event: 'exit', code: 1, success: false },
    ]);
    expect(run.message).toBe('no credentials');
    expect(run.outcome).toBe('failed');
  });

  it('accepts a resource event for something the plan did not list', () => {
    const run = play([plan, { event: 'resource', id: 'surprise', status: 'in_progress' }]);
    expect(run.resources.map((r) => r.id)).toContain('surprise');
  });
});

describe('appendOutput', () => {
  it('appends and caps output', () => {
    let run = newRun('destroy', 'prod');
    for (let i = 0; i < 2100; i++) run = appendOutput(run, `line ${i}`, 'out');
    expect(run.output.length).toBe(2000);
    expect(run.output[0].text).toBe('line 100');
  });
});

describe('nodeStatusFor', () => {
  it('maps deploy states onto node statuses', () => {
    expect(nodeStatusFor('deploy', 'planned')).toBe('configured');
    expect(nodeStatusFor('deploy', 'in_progress')).toBe('deploying');
    expect(nodeStatusFor('deploy', 'success')).toBe('deployed');
    expect(nodeStatusFor('deploy', 'failed')).toBe('failed');
    expect(nodeStatusFor('deploy', 'skipped')).toBeNull();
  });
  it('a destroyed resource goes back to draft', () => {
    expect(nodeStatusFor('destroy', 'success')).toBe('draft');
    expect(nodeStatusFor('destroy', 'planned')).toBeNull();
  });
});

describe('matchNodeForResource', () => {
  const nodes: Node[] = [
    { id: 'agent-1700000000', type: 'agent', position: { x: 0, y: 0 }, data: { label: 'Python Agent', config: { name: 'api-agent' } } },
    { id: 's3-1700000001', type: 's3', position: { x: 0, y: 0 }, data: { label: 'Uploads', config: { bucketName: 'shop-uploads' } } },
    { id: 'sqs-1', type: 'sqs', position: { x: 0, y: 0 }, data: { label: 'Order Queue' } },
  ];
  it('matches by id, config name, display name and label slug', () => {
    expect(matchNodeForResource('sqs-1', nodes)?.id).toBe('sqs-1');
    expect(matchNodeForResource('api-agent', nodes)?.id).toBe('agent-1700000000');
    expect(matchNodeForResource('shop-uploads', nodes)?.id).toBe('s3-1700000001');
    expect(matchNodeForResource('order-queue', nodes)?.id).toBe('sqs-1');
    expect(matchNodeForResource('nothing', nodes)).toBeUndefined();
  });
});
