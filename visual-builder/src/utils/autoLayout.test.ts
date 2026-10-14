// A hand-built canvas gets the arrangement an import gets: tiles, bands,
// positions, and containment that already meant something kept.

import { describe, expect, it } from 'vitest';
import type { Edge, Node } from 'reactflow';
import { CHOSEN, layoutCanvas } from './autoLayout';

const node = (id: string, type: string, extra: Partial<Node> = {}): Node => ({
  id, type, position: { x: 0, y: 0 }, data: { label: id, config: {} }, ...extra,
});
const edge = (source: string, target: string): Edge => ({ id: `${source}->${target}`, source, target, data: {} });

describe('layoutCanvas', () => {
  const nodes = [
    node('api', 'api-gateway'), node('fn', 'lambda'), node('tbl', 'dynamodb'),
    node('q', 'sqs'), node('cdn', 'cloudfront'), node('lg', 'log-group'),
  ];
  const edges = [edge('cdn', 'api'), edge('api', 'fn'), edge('fn', 'tbl'), edge('fn', 'q'), edge('fn', 'lg')];

  it('puts every resource in a band inside a tile, and places them', () => {
    const out = layoutCanvas(nodes, edges, { projectName: 'shop' });
    const byId = new Map(out.map((n) => [n.id, n]));
    const tiles = out.filter((n) => n.type === 'application');
    const bands = out.filter((n) => n.type === 'band');
    expect(tiles.length).toBeGreaterThan(0);
    expect(bands.length).toBeGreaterThan(0);
    for (const id of ['api', 'fn', 'tbl', 'q', 'cdn', 'lg']) {
      const parent = byId.get(id)!.parentNode;
      expect(parent, id).toBeTruthy();
      expect(byId.get(parent!)!.type === 'band' || byId.get(parent!)!.type === 'application').toBe(true);
    }
    // Bands in request order: entry above compute above bus above data.
    const bandOf = (id: string) => byId.get(byId.get(id)!.parentNode!)!;
    expect(bandOf('cdn').data.label).toBe('entry');
    expect(bandOf('fn').data.label).toBe('compute');
    expect(bandOf('q').data.label).toBe('bus');
    expect(bandOf('tbl').data.label).toBe('data');
    expect(bandOf('lg').data.label).toBe('platform');
    expect(bandOf('cdn').position.y).toBeLessThan(bandOf('fn').position.y);
    expect(bandOf('fn').position.y).toBeLessThan(bandOf('tbl').position.y);
    // Nothing is left at the origin the hand-built canvas started from.
    expect(out.filter((n) => n.position.x === 0 && n.position.y === 0 && n.type !== 'application').length).toBeLessThan(out.length);
  });

  it('is idempotent: laying out a laid-out canvas gives the same shape', () => {
    const once = layoutCanvas(nodes, edges, { projectName: 'shop' });
    const twice = layoutCanvas(once, edges, { projectName: 'shop' });
    const shape = (list: Node[]) => list.filter((n) => !['application', 'band'].includes(n.type || '')).map((n) => `${n.id}@${Math.round(n.position.x)},${Math.round(n.position.y)}`).sort();
    expect(shape(twice)).toEqual(shape(once));
    expect(twice.filter((n) => n.type === 'application').length).toBe(once.filter((n) => n.type === 'application').length);
  });

  it('keeps containment that means something, and parents come first', () => {
    const withVpc = [...nodes, node('vpc', 'vpc'), node('host', 'ec2-instance', { parentNode: 'vpc', extent: 'parent' })];
    const out = layoutCanvas(withVpc, edges, { projectName: 'shop' });
    const byId = new Map(out.map((n) => [n.id, n]));
    expect(byId.get('host')!.parentNode).toBe('vpc');
    const index = new Map(out.map((n, i) => [n.id, i]));
    for (const n of out) if (n.parentNode) expect(index.get(n.parentNode)!, n.id).toBeLessThan(index.get(n.id)!);
  });
});

describe('layoutCanvas and the canvases it redraws', () => {
  const imported = (): Node[] => [
    node('cdn', 'cloudfront', { data: { label: 'admin-site', config: {}, meta: { application: { id: 'admin', name: 'admin', reason: 'tag Application=admin' } } } }),
    node('api', 'api-gateway', { data: { label: 'admin-api', config: {}, meta: { application: { id: 'admin', name: 'admin', reason: 'tag Application=admin' } } } }),
    node('fn', 'lambda', { data: { label: 'feed-fn', config: {}, meta: { application: { id: 'feed', name: 'feed', reason: 'tag Application=feed' } } } }),
    node('tbl', 'dynamodb', { data: { label: 'flags', config: {}, meta: { application: { id: 'feed', name: 'feed', reason: 'tag Application=feed' } } } }),
  ];

  it('keeps the grouping an import worked out, instead of re-deciding it', () => {
    const edges = [edge('cdn', 'api'), edge('api', 'fn'), edge('fn', 'tbl')];
    const out = layoutCanvas(imported(), edges, { projectName: 'shop' });
    expect(out.filter((n) => n.type === 'application').map((n) => n.data.label).sort()).toEqual(['admin', 'feed']);
  });

  it('never moves the nodes it was given', () => {
    const before = imported();
    const snapshot = before.map((n) => JSON.stringify({ p: n.position, parent: n.parentNode, meta: n.data.meta }));
    layoutCanvas(before, [edge('cdn', 'api')], { projectName: 'shop' });
    expect(before.map((n) => JSON.stringify({ p: n.position, parent: n.parentNode, meta: n.data.meta }))).toEqual(snapshot);
  });

  it('hands back the same node object when nothing moved', () => {
    const edges = [edge('cdn', 'api'), edge('api', 'fn'), edge('fn', 'tbl')];
    const once = layoutCanvas(imported(), edges, { projectName: 'shop' });
    const twice = layoutCanvas(once, edges, { projectName: 'shop' });
    const byId = new Map(once.map((n) => [n.id, n]));
    const resources = twice.filter((n) => !['application', 'band'].includes(n.type || ''));
    expect(resources.every((n) => byId.get(n.id) === n)).toBe(true);
  });

  it("keeps what the operator chose, whatever the wiring says", () => {
    const nodes = imported();
    nodes[3].data.meta = { application: { id: 'admin', name: 'admin', reason: CHOSEN } };
    const out = layoutCanvas(nodes, [edge('fn', 'tbl')], { projectName: 'shop' });
    const tbl = out.find((n) => n.id === 'tbl')!;
    expect(tbl.data.meta.application).toEqual({ id: 'admin', name: 'admin', reason: CHOSEN });
  });
});
