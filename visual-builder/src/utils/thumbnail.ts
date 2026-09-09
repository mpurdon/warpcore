// A canvas as a small picture: the application tile, its bands, its cards,
// no text. Drawn from the same positions and sizes the layout wrote, so it
// is always the picture the canvas would show. Holodeck cards use it; the
// recent-projects list can later.

import { Node } from 'reactflow';
import { absolutePosition, bandFor, BandKind, CELL_H, CELL_W, CHIP_H, CHIP_W } from './stackLayout';

const BAND_FILL: Record<BandKind, { band: string; card: string }> = {
  entry: { band: '#f5f3ff', card: '#8b5cf6' },
  compute: { band: '#f0f9ff', card: '#0ea5e9' },
  bus: { band: '#faf5ff', card: '#a855f7' },
  data: { band: '#fff7ed', card: '#f97316' },
  platform: { band: '#f9fafb', card: '#c4c9d1' },
};

interface Rect { x: number; y: number; w: number; h: number; fill: string; stroke: string; rx: number; width: number; opacity?: number }

function sizeOf(n: Node): { w: number; h: number } {
  const w = Number(n.style?.width) || n.width || (n.data?.meta?.compact ? CHIP_W : CELL_W);
  const h = Number(n.style?.height) || n.height || (n.data?.meta?.compact ? CHIP_H : CELL_H);
  return { w, h };
}

/** The rectangles a thumbnail draws, containers first, in canvas coordinates. */
export function thumbnailRects(nodes: Node[]): Rect[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const containers: Rect[] = [];
  const cards: Rect[] = [];
  for (const n of nodes) {
    if (n.hidden) continue;
    const { x, y } = absolutePosition(n, byId);
    const { w, h } = sizeOf(n);
    const isGroup = Boolean(n.data?.meta?.isGroup);
    if (n.type === 'application') containers.push({ x, y, w, h, fill: '#ffffff', stroke: '#d1d5db', rx: 14, width: 3 });
    else if (n.type === 'band') {
      const band = (n.data?.meta?.band as BandKind) || 'platform';
      containers.push({ x, y, w, h, fill: BAND_FILL[band].band, stroke: '#e5e7eb', rx: 10, width: 2 });
    } else if (isGroup || n.type === 'vpc' || n.type === 'subnet') {
      containers.push({ x, y, w, h, fill: n.type === 'subnet' ? '#eef2ff' : '#e0e7ff', stroke: '#a5b4fc', rx: 8, width: 2, opacity: 0.8 });
    } else {
      const band = bandFor(n);
      cards.push({ x, y, w, h, fill: BAND_FILL[band].card, stroke: 'none', rx: n.data?.meta?.compact ? 6 : 10, width: 0, opacity: n.data?.meta?.compact ? 0.55 : 0.9 });
    }
  }
  return [...containers, ...cards];
}

/** An SVG of the canvas, as a string, fitted to the given box. */
export function stackThumbnail(nodes: Node[], width = 240, height = 160): string {
  const rects = thumbnailRects(nodes);
  if (rects.length === 0) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="${width}" height="${height}" fill="#f9fafb"/></svg>`;
  }
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
  for (const r of rects) {
    minX = Math.min(minX, r.x); minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.w); maxY = Math.max(maxY, r.y + r.h);
  }
  const pad = Math.max(24, (maxX - minX) * 0.04);
  const vb = `${(minX - pad).toFixed(0)} ${(minY - pad).toFixed(0)} ${(maxX - minX + pad * 2).toFixed(0)} ${(maxY - minY + pad * 2).toFixed(0)}`;
  const body = rects.map((r) => (
    `<rect x="${r.x.toFixed(0)}" y="${r.y.toFixed(0)}" width="${r.w.toFixed(0)}" height="${r.h.toFixed(0)}" rx="${r.rx}" fill="${r.fill}" stroke="${r.stroke}" stroke-width="${r.width}"${r.opacity !== undefined ? ` opacity="${r.opacity}"` : ''}/>`
  )).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${vb}" preserveAspectRatio="xMidYMid meet">${body}</svg>`;
}

/** The SVG as an <img> source. */
export function thumbnailDataUrl(svg: string): string {
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}
