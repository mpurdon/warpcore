import { describe, expect, it } from 'vitest';
import type { Edge, Node } from 'reactflow';
import { scenariosBrokenBy, whatIf } from './whatIf';
import type { Scenario } from './scenarios';

const node = (id: string, type: string): Node => ({ id, type, position: { x: 0, y: 0 }, data: { label: id, config: {} } });
const edge = (id: string, source: string, target: string, kind = 'invokes'): Edge => ({
  id, source, target, data: { isResourceBased: true, meta: { discovered: { kind, detail: kind } } },
});
const nodes = [
  node('api', 'api-gateway'), node('fn', 'lambda'), node('q', 'sqs'), node('worker', 'lambda'), node('tbl', 'dynamodb'),
  node('fn-logs', 'log-group'), node('worker-logs', 'log-group'),
];
const edges = [
  edge('e1', 'api', 'fn'),
  edge('l1', 'fn', 'fn-logs', 'logs'),
  edge('l2', 'worker', 'worker-logs', 'logs'),
  { id: 'e2', source: 'fn', target: 'q', data: { meta: { access: { level: 'write', via: 'r', actions: ['sqs:SendMessage'] } } } } as Edge,
  edge('e3', 'q', 'worker', 'event-source'),
  { id: 'e4', source: 'worker', target: 'tbl', data: { meta: { access: { level: 'write', via: 'r', actions: ['dynamodb:PutItem'] } } } } as Edge,
];
const scenario: Scenario = { id: 's', name: 'Order', trigger: { at: 'api' }, steps: [{ at: 'fn' }, { at: 'q' }, { at: 'worker' }, { at: 'tbl' }] };

describe('whatIf', () => {
  it('names the steps that lose their evidence when a resource goes', () => {
    const w = whatIf(scenario, nodes, edges, new Set(['q']));
    expect(w.before.ok).toBe(true);
    expect(w.brokenSteps).toEqual([1, 2]);  // the queue itself, and the worker that was fed by it
    expect(w.newProblems.some((p) => p.includes('q is not on the canvas'))).toBe(true);
    expect(new Set(w.newProblems).size).toBe(w.newProblems.length);
  });
  it('is quiet when the removal is off the path', () => {
    const w = whatIf(scenario, [...nodes, node('other', 's3')], edges, new Set(['other']));
    expect(w.brokenSteps).toEqual([]);
    expect(w.newProblems).toEqual([]);
  });
  it('lists the scenarios a plan would break, worst first', () => {
    const short: Scenario = { id: 't', name: 'Health', trigger: { at: 'api' }, steps: [{ at: 'fn' }] };
    const broken = scenariosBrokenBy([scenario, short], nodes, edges, new Set(['fn']));
    expect(broken.map((w) => w.scenario.id)).toEqual(['s', 't']);
    expect(broken[0].brokenSteps).toEqual([0, 1]);
  });
});
