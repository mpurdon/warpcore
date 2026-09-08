import { describe, expect, it } from 'vitest';
import type { Edge, Node } from 'reactflow';
import { BAND_ORDER, layoutStackCanvas, reflowStack } from './stackLayout';
import { CARD_H, layoutSystem, LEVEL_H, linkKind, PLATE_T, UNIT } from './systemLayout';

const node = (id: string, type: string, parent?: string, meta: Record<string, unknown> = {}): Node => ({
  id, type, position: { x: 0, y: 0 }, data: { label: id, meta }, ...(parent ? { parentNode: parent } : {}),
});

function tile(): Node[] {
  return [
    node('app', 'application', undefined, { isGroup: true }),
    node('b-entry', 'band', 'app', { isGroup: true, band: 'entry' }),
    node('b-compute', 'band', 'app', { isGroup: true, band: 'compute' }),
    node('b-data', 'band', 'app', { isGroup: true, band: 'data' }),
    node('b-platform', 'band', 'app', { isGroup: true, band: 'platform' }),
    node('api', 'api-gateway', 'b-entry'),
    node('fn', 'lambda', 'b-compute'),
    node('vpc', 'vpc', 'b-compute', { isGroup: true }),
    node('subnet', 'subnet', 'vpc', { isGroup: true }),
    node('web', 'ec2-instance', 'subnet'),
    node('table', 'dynamodb', 'b-data'),
    node('key', 'kms-key', 'b-platform', { compact: true }),
  ];
}

const edge = (id: string, source: string, target: string, data: Record<string, unknown> = {}): Edge => ({ id, source, target, data });

describe('layoutSystem on an application stack', () => {
  it('turns bands into terraces, highest first, and puts cards on them', () => {
    const nodes = tile();
    layoutStackCanvas(nodes);
    const { slabs, cards, captions } = layoutSystem(nodes, []);
    const bands = slabs.filter((s) => s.kind === 'band');
    expect(bands.map((b) => b.band)).toEqual(['entry', 'compute', 'data', 'platform']);
    expect(bands[0].y).toBe((BAND_ORDER.length - 1) * LEVEL_H);
    expect(bands[3].y).toBe(0);
    for (let i = 1; i < bands.length; i++) expect(bands[i].y).toBeLessThan(bands[i - 1].y);
    // Footprints come from the canvas, in world units, trimmed to what sits on the plate.
    const entry = nodes.find((n) => n.id === 'b-entry')!;
    expect(bands[0].w).toBeLessThanOrEqual(Number(entry.style?.width) / UNIT);
    const api = cards.find((c) => c.id === 'api')!;
    expect(bands[0].x + bands[0].w / 2).toBeGreaterThan(api.x + api.w / 2);
    expect(bands[0].x - bands[0].w / 2).toBeCloseTo((entry.position.x + nodes.find((n) => n.id === 'app')!.position.x) / UNIT);
    expect(api.y).toBeCloseTo(bands[0].y + PLATE_T / 2);
    const fn = cards.find((c) => c.id === 'fn')!;
    expect(fn.y).toBeLessThan(api.y);
    expect(captions[0].text).toBe('app');
  });

  it('draws the VPC and subnet as slabs and raises what is inside them', () => {
    const nodes = tile();
    layoutStackCanvas(nodes);
    const { slabs, cards } = layoutSystem(nodes, []);
    const vpc = slabs.find((s) => s.id === 'vpc')!;
    const subnet = slabs.find((s) => s.id === 'subnet')!;
    const compute = slabs.find((s) => s.id === 'b-compute')!;
    expect(vpc.kind).toBe('vpc');
    expect(subnet.y).toBeGreaterThan(vpc.y);
    expect(vpc.y).toBeGreaterThan(compute.y);
    const web = cards.find((c) => c.id === 'web')!;
    const fn = cards.find((c) => c.id === 'fn')!;
    expect(web.y).toBeGreaterThan(fn.y);
    // The instance's world position includes its parents' offsets.
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const abs = ['web', 'subnet', 'vpc', 'b-compute', 'app'].reduce((acc, id) => acc + byId.get(id)!.position.x, 0);
    expect(web.x).toBeCloseTo((abs + Number(byId.get('web')!.style?.width ?? 200) / 2) / UNIT);
  });

  it('honours a lens re-flow: hidden nodes go, and the rest use the placed positions', () => {
    const nodes = tile();
    layoutStackCanvas(nodes);
    const keep = new Set(['api', 'fn', 'table']);
    const reflow = reflowStack(nodes, (n) => keep.has(n.id));
    const { slabs, cards } = layoutSystem(nodes, [], reflow);
    expect(cards.map((c) => c.id).sort()).toEqual(['api', 'fn', 'table']);
    expect(slabs.some((s) => s.id === 'b-platform')).toBe(false);
    expect(slabs.some((s) => s.id === 'vpc')).toBe(false);
    const data = slabs.find((s) => s.id === 'b-data')!;
    const placed = reflow.placed.get('b-data')!;
    expect(data.z).toBeCloseTo((placed.position.y + nodes.find((n) => n.id === 'app')!.position.y + Number(placed.style.height) / 2) / UNIT);
  });
});

describe('layoutSystem on a hand-drawn canvas', () => {
  it('puts every card on one sheet at level zero', () => {
    const nodes = [
      { ...node('a', 'agent'), position: { x: 100, y: 100 }, width: 180, height: 80 },
      { ...node('b', 's3'), position: { x: 500, y: 300 }, width: 160, height: 70 },
    ];
    const { slabs, cards, bounds } = layoutSystem(nodes, []);
    expect(slabs).toHaveLength(1);
    expect(slabs[0].kind).toBe('sheet');
    expect(cards.every((c) => c.y === 0)).toBe(true);
    expect(cards[1].x).toBeCloseTo((500 + 80) / UNIT);
    expect(bounds.maxY).toBeCloseTo(CARD_H);
  });
});

describe('links', () => {
  it('keeps edges between cards and classes them', () => {
    const nodes = tile();
    layoutStackCanvas(nodes);
    const edges = [
      edge('e1', 'api', 'fn', { meta: { discovered: { kind: 'invokes', detail: 'POST /' } } }),
      edge('e2', 'fn', 'table', { meta: { access: { level: 'write', via: 'r', actions: [] } } }),
      edge('e3', 'fn', 'key', { meta: { discovered: { kind: 'reference', detail: 'encrypted with' } } }),
      edge('e4', 'fn', 'vpc', { meta: { discovered: { kind: 'vpc', detail: 'attached to VPC' } } }),
      edge('e5', 'api', 'table'),
    ];
    const { links } = layoutSystem(nodes, edges);
    expect(links.map((l) => [l.id, l.kind])).toEqual([['e1', 'flow'], ['e2', 'access'], ['e3', 'structure'], ['e5', 'drawn']]);
    expect(linkKind(edge('x', 'a', 'b', { meta: { discovered: { kind: 'logs', detail: 'function log group' } } }))).toBe('logs');
  });
});
