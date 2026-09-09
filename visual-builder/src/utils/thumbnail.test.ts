import { describe, expect, it } from 'vitest';
import type { Node } from 'reactflow';
import { stackThumbnail, thumbnailRects } from './thumbnail';

const node = (id: string, type: string, parent?: string, meta: Record<string, unknown> = {}, pos = { x: 0, y: 0 }, size?: { w: number; h: number }): Node => ({
  id, type, position: pos, parentNode: parent, data: { label: id, meta },
  ...(size ? { style: { width: size.w, height: size.h } } : {}),
});

describe('stackThumbnail', () => {
  it('draws containers before cards and fits the view box to them', () => {
    const nodes = [
      node('app', 'application', undefined, { isGroup: true }, { x: 60, y: 60 }, { w: 1000, h: 400 }),
      node('b-entry', 'band', 'app', { isGroup: true, band: 'entry' }, { x: 20, y: 44 }, { w: 960, h: 140 }),
      node('api', 'api-gateway', 'b-entry', {}, { x: 14, y: 32 }),
      node('role', 'iam-role', undefined, {}, { x: 0, y: 0 }),
    ];
    nodes[3].hidden = true;
    const rects = thumbnailRects(nodes);
    expect(rects).toHaveLength(3);
    expect(rects[0].fill).toBe('#ffffff');
    // The card sits inside its band inside its tile, in absolute coordinates.
    expect(rects[2].x).toBe(60 + 20 + 14);
    const svg = stackThumbnail(nodes);
    expect(svg.startsWith('<svg')).toBe(true);
    expect((svg.match(/<rect/g) || []).length).toBe(3);
    expect(svg).toContain('viewBox=');
  });

  it('draws a hand-placed canvas from its positions', () => {
    const nodes = [node('a', 'agent', undefined, {}, { x: 100, y: 100 }), node('b', 's3', undefined, {}, { x: 400, y: 100 })];
    const rects = thumbnailRects(nodes);
    expect(rects).toHaveLength(2);
    expect(rects[1].x).toBe(400);
  });

  it('draws an empty box for an empty canvas', () => {
    expect(stackThumbnail([])).toContain('<rect');
  });
});
