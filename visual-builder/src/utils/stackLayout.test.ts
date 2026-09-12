import { describe, expect, it } from 'vitest';
import type { Node } from 'reactflow';
import { bandFor, BAND_ORDER, CELL_W, CHIP_W, GROUP_GAP, layoutStackCanvas, reflowStack, TILE_COLS } from './stackLayout';

const node = (id: string, type: string, parent?: string, meta: Record<string, unknown> = {}): Node => ({
  id, type, position: { x: 0, y: 0 }, data: { label: id, meta }, ...(parent ? { parentNode: parent } : {}),
});

function tile(): Node[] {
  const nodes: Node[] = [
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
    node('sg', 'security-group', 'vpc'),
  ];
  for (let i = 0; i < 6; i++) nodes.push(node(`bucket-${i}`, 's3', 'b-data'));
  for (let i = 0; i < 9; i++) nodes.push(node(`param-${i}`, 'ssm-parameter', 'b-platform', { compact: true }));
  return nodes;
}

describe('bandFor', () => {
  it('sorts types into the five bands', () => {
    expect(bandFor({ type: 'cloudfront' })).toBe('entry');
    expect(bandFor({ type: 'agent' })).toBe('compute');
    expect(bandFor({ type: 'sqs' })).toBe('bus');
    expect(bandFor({ type: 'dynamodb' })).toBe('data');
    expect(bandFor({ type: 'kms-key' })).toBe('platform');
    expect(bandFor({ type: 'something-new' })).toBe('platform');
  });
});

describe('layoutStackCanvas', () => {
  it('stacks bands in request order at one width and wraps the data grid', () => {
    const nodes = tile();
    layoutStackCanvas(nodes);
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const bands = BAND_ORDER.map((k) => byId.get(`b-${k}`)).filter((b): b is Node => Boolean(b));
    // Same width, increasing y, no overlap.
    const widths = new Set(bands.map((b) => Number(b.style?.width)));
    expect(widths.size).toBe(1);
    for (let i = 1; i < bands.length; i++) {
      const prev = bands[i - 1];
      expect(bands[i].position.y).toBeGreaterThanOrEqual(prev.position.y + Number(prev.style?.height));
    }
    // Four columns of buckets, then a second row.
    const buckets = [0, 1, 2, 3, 4, 5].map((i) => byId.get(`bucket-${i}`)!);
    expect(new Set(buckets.slice(0, 4).map((b) => b.position.y)).size).toBe(1);
    expect(buckets[4].position.y).toBeGreaterThan(buckets[0].position.y);
    expect(buckets[1].position.x - buckets[0].position.x).toBe(CELL_W + GROUP_GAP);
    // The tile is bounded: no wider than its bands plus padding.
    const app = byId.get('app')!;
    expect(Number(app.style?.width)).toBeLessThan(TILE_COLS * CELL_W + 200);
  });

  it('puts the VPC on the right of the compute band and chips in more columns', () => {
    const nodes = tile();
    layoutStackCanvas(nodes);
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const vpc = byId.get('vpc')!;
    const fn = byId.get('fn')!;
    expect(vpc.position.x).toBeGreaterThan(fn.position.x);
    expect(byId.get('web')!.parentNode).toBe('subnet');
    const p0 = byId.get('param-0')!;
    const p1 = byId.get('param-1')!;
    expect(p1.position.x - p0.position.x).toBe(CHIP_W + GROUP_GAP);
    const perRow = nodes.filter((n) => n.id.startsWith('param-') && n.position.y === p0.position.y).length;
    expect(perRow).toBeGreaterThan(TILE_COLS);
  });

  it('wraps the VPC plumbing strip as chips to the width of the subnets', () => {
    const nodes = [
      node('app', 'application', undefined, { isGroup: true, band: 'compute' }),
      node('vpc', 'vpc', 'app', { isGroup: true }),
      node('sn-a', 'subnet', 'vpc', { isGroup: true }), node('sn-b', 'subnet', 'vpc', { isGroup: true }),
      node('web', 'ec2-instance', 'sn-a'),
    ];
    for (let i = 0; i < 8; i++) nodes.push(node(`rtb-${i}`, 'route-table', 'vpc', { compact: true }));
    layoutStackCanvas(nodes);
    const byId = new Map(nodes.map((n) => [n.id, n]));
    // A one-band tile holds the VPC directly.
    expect(byId.get('vpc')!.parentNode).toBe('app');
    const strip = nodes.filter((n) => n.id.startsWith('rtb-'));
    const rows = new Set(strip.map((n) => n.position.y));
    expect(rows.size).toBeGreaterThan(1);
    const vpcW = Number(byId.get('vpc')!.style!.width);
    expect(Math.max(...strip.map((n) => n.position.x + CHIP_W))).toBeLessThan(vpcW);
    // Subnets sit below the strip.
    expect(byId.get('sn-a')!.position.y).toBeGreaterThan(Math.max(...rows));
  });

  it('places tiles side by side', () => {
    const nodes = [...tile(), node('app2', 'application', undefined, { isGroup: true }), node('b2', 'band', 'app2', { isGroup: true, band: 'data' }), node('t', 'dynamodb', 'b2')];
    layoutStackCanvas(nodes);
    const byId = new Map(nodes.map((n) => [n.id, n]));
    expect(byId.get('app2')!.position.x).toBeGreaterThan(byId.get('app')!.position.x + Number(byId.get('app')!.style?.width));
  });
});

describe('reflowStack', () => {
  it('removes context nodes, drops empty containers, and counts what went', () => {
    const nodes = tile();
    layoutStackCanvas(nodes);
    const security = new Set(['sg', 'web', 'subnet', 'vpc', 'param-0']);
    const r = reflowStack(nodes, (n) => security.has(n.id));
    // Buckets and the api go; their bands go with them.
    expect(r.hidden.has('bucket-0')).toBe(true);
    expect(r.hidden.has('b-data')).toBe(true);
    expect(r.hidden.has('b-entry')).toBe(true);
    // Compute keeps the VPC, loses the function; platform keeps one chip.
    expect(r.hidden.has('b-compute')).toBe(false);
    expect(r.hidden.has('fn')).toBe(true);
    expect(r.hidden.has('param-3')).toBe(true);
    expect(r.hiddenCount.get('b-platform')).toBe(8);
    expect(r.hiddenCount.get('b-compute')).toBe(1);
    expect(r.hiddenCount.get('app')).toBe(1 + 1 + 6 + 8);
    // What remains is laid out again: the platform band moved up.
    const before = nodes.find((n) => n.id === 'b-platform')!.position.y;
    expect(r.placed.get('b-platform')!.position.y).toBeLessThan(before);
    // The input was not touched.
    expect(nodes.find((n) => n.id === 'b-platform')!.position.y).toBe(before);
  });

  it('keeps everything when the lens keeps everything', () => {
    const nodes = tile();
    layoutStackCanvas(nodes);
    const r = reflowStack(nodes, () => true);
    expect(r.hidden.size).toBe(0);
    expect(r.hiddenCount.size).toBe(0);
  });
});
