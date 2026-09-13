import { describe, expect, it } from 'vitest';
import type { Edge, Node } from 'reactflow';
import { applyNames, graphForDraft, unnamedClusters } from './assistant';

const node = (id: string, type: string, app?: { id: string; name: string; reason: string }, extra: Record<string, unknown> = {}): Node => ({
  id, type, position: { x: 0, y: 0 }, data: { label: id, config: {}, meta: app ? { application: app } : {}, ...extra },
});

describe('unnamedClusters', () => {
  it('picks the tiles whose every member was placed by a guess', () => {
    const guessed = { id: 'vpc-09c3', name: 'vpc-09c3', reason: 'connected to 3 other resources with no application of their own' };
    const named = { id: 'shop', name: 'shop', reason: 'name prefix shop-' };
    const nodes = [
      node('application-vpc', 'application', { ...guessed, reason: 'application' }),
      node('vpc', 'vpc', guessed), node('web', 'ec2-instance', guessed),
      node('application-shop', 'application', { ...named, reason: 'application' }),
      node('shop-api', 'lambda', named), node('shop-db', 'dynamodb', { ...named, reason: 'wired to shop-api' }),
    ];
    const out = unnamedClusters(nodes);
    expect(out.map((c) => c.id)).toEqual(['vpc-09c3']);
    expect(out[0].members.map((m) => m.name)).toEqual(['vpc', 'web']);
  });
});

describe('applyNames', () => {
  it('renames the tile and the members application record, and says who named it', () => {
    const app = { id: 'vpc-09c3', name: 'vpc-09c3', reason: 'connected to 1 other resource' };
    const nodes = [node('application-vpc', 'application', { ...app, reason: 'application' }), node('web', 'ec2-instance', app)];
    const out = applyNames(nodes, [{ id: 'vpc-09c3', name: 'orders', reason: 'the orders database' }]);
    expect(out[0].data.label).toBe('orders');
    expect(out[0].data.config.name).toBe('orders');
    expect(out[0].data.meta.application.reason).toBe('named by the assistant: the orders database');
    expect(out[1].data.meta.application).toEqual({ ...app, name: 'orders' });
  });
});

describe('graphForDraft', () => {
  it('sends names, edges and the hops the checker allows, and leaves containers out', () => {
    const nodes = [node('application-x', 'application'), node('api', 'api-gateway'), node('fn', 'lambda'), node('tbl', 'dynamodb')];
    const edges: Edge[] = [
      { id: 'e1', source: 'api', target: 'fn', data: { isResourceBased: true, meta: { discovered: { kind: 'invokes', detail: 'POST /x' } } } },
      { id: 'e2', source: 'fn', target: 'tbl', data: { meta: { access: { level: 'write', via: 'role', actions: [] } } } },
    ];
    const g = graphForDraft(nodes, edges, { at: 'api', event: 'POST /x' });
    expect(g.nodes.map((n) => n.id)).toEqual(['api', 'fn', 'tbl']);
    expect(g.edges).toEqual([
      { source: 'api', target: 'fn', kind: 'invokes', detail: 'POST /x' },
      { source: 'fn', target: 'tbl', kind: 'access', detail: 'write' },
    ]);
    expect(g.hops.api).toEqual(['fn']);
    expect(g.hops.fn).toEqual(['tbl']);
    expect(g.trigger).toEqual({ at: 'api', event: 'POST /x' });
  });
});
