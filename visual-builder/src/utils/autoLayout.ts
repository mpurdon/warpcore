// Laying a canvas out: resources clustered into application tiles, each
// tile's members in bands in request order, the whole thing stacked.
//
// This is what an imported account gets (projectFromAccount.ts calls it at
// the end of buildCanvas) and what a Holodeck entry gets. A canvas built by
// hand or by commands gets it on demand, from `canvas.layout`, so nothing
// has to place a node by eye.
//
// Containment that already means something, a VPC's subnets and what sits
// in them, is kept; only the tiles and bands are rebuilt.

import type { Edge, Node } from 'reactflow';
import { clusterApplications, ClusterItem, SHARED_ID } from './applications';
import { assignHandles, bandFor, BandKind, BAND_ORDER, layoutStackCanvas } from './stackLayout';
import type { NodeMeta } from './projectFromAccount';
import { orderParentsFirst } from './nodeTree';

/** Containers the layout owns: it removes them and makes them again. */
export const LAYOUT_CONTAINERS: ReadonlySet<string> = new Set(['application', 'band']);

/**
 * Whether the canvas is one the layout arranges. A canvas that has been
 * laid out (or imported, or opened from the Holodeck) keeps its tiles, so
 * every later edit is placed for the operator; a freehand sketch with no
 * tiles is left exactly where its author put things.
 */
export function isArranged(nodes: { type?: string }[]): boolean {
  return nodes.some((n) => n.type === 'application');
}

/** The application a node belongs to, as the tag the clusterer reads. */
export function appTagOf(node: { data?: { config?: Record<string, unknown> } }): string | undefined {
  const tags = (node.data?.config as { tags?: Record<string, string> } | undefined)?.tags;
  if (!tags) return undefined;
  const hit = Object.entries(tags).find(([k]) => k.toLowerCase() === 'application');
  return hit?.[1];
}

const NETWORK_PLUMBING: ReadonlySet<string> = new Set(['vpc', 'subnet', 'security-group', 'internet-gateway', 'nat-gateway', 'route-table', 'vpc-endpoint', 'elastic-ip']);

function pushTo<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

const metaOf = (node: Node): NodeMeta => ((node.data.meta ||= {} as NodeMeta) as NodeMeta);

export interface LayoutOptions {
  /** Names the tile that holds whatever belongs to no application of its own. */
  projectName?: string;
  /** The region each node shows, for a tile's subtitle. */
  regionOf?: (node: Node) => string;
}

/**
 * The canvas, laid out: tiles, bands, positions and edge handles. Returns
 * new nodes (parents first, as React Flow wants); the edges are given
 * handles in place.
 */
export function layoutCanvas(nodes: Node[], edges: Edge[], opts: LayoutOptions = {}): Node[] {
  const projectName = opts.projectName || 'project';
  const regionOf = opts.regionOf ?? ((n: Node) => String(n.data?.region ?? ''));

  // Start from the resources: the layout's own containers go, and with them
  // any parent link into one. Containment that means something stays.
  const kept = nodes.filter((n) => !LAYOUT_CONTAINERS.has(n.type || ''));
  const goneIds = new Set(nodes.filter((n) => LAYOUT_CONTAINERS.has(n.type || '')).map((n) => n.id));
  const working = kept.map((n) => {
    const copy: Node = { ...n, data: { ...n.data, meta: { ...(n.data?.meta ?? {}) } } };
    if (copy.parentNode && goneIds.has(copy.parentNode)) { delete copy.parentNode; delete copy.extent; }
    delete (copy.data.meta as NodeMeta).application;
    return copy;
  });

  const parentOf = new Map<string, string>();
  for (const n of working) if (n.parentNode) parentOf.set(n.id, n.parentNode);
  const byId = new Map(working.map((n) => [n.id, n]));
  const topLevelOf = (n: Node): Node => {
    let cur = n;
    for (let hops = 0; hops < 6 && parentOf.has(cur.id); hops++) cur = byId.get(parentOf.get(cur.id)!) ?? cur;
    return cur;
  };

  // ---- applications: every resource gets a home and a reason.
  const clusterItems: ClusterItem[] = working.map((n) => ({
    id: n.id,
    name: String(n.data?.label ?? n.id),
    type: n.type || '',
    tags: (n.data?.config as { tags?: Record<string, string> } | undefined)?.tags,
    platform: bandFor(n) === 'platform' || NETWORK_PLUMBING.has(n.type || ''),
    parent: parentOf.get(n.id),
  }));
  const clusterLinks = edges
    .filter((e) => byId.has(e.source) && byId.has(e.target))
    .map((e) => ({ source: e.source, target: e.target }));
  const clustering = clusterApplications(clusterItems, clusterLinks, projectName);
  for (const n of working) {
    const a = clustering.assignments.get(n.id);
    if (a) metaOf(n).application = a;
  }

  // ---- one tile per application, one band per kind that has members.
  const containers: Node[] = [];
  const taken = new Set(working.map((n) => n.id));
  const idFor = (type: string, name: string): string => {
    const base = `${type}-${name}`;
    let id = base;
    let n = 2;
    while (taken.has(id)) id = `${base}-${n++}`;
    taken.add(id);
    return id;
  };
  for (const app of clustering.applications) {
    const members = working.filter((n) => !n.hidden && !parentOf.has(n.id) && (metaOf(topLevelOf(n)).application?.id ?? SHARED_ID) === app.id);
    if (members.length === 0) continue;
    const tileId = idFor('application', app.id);
    const regions = new Set<string>();
    for (const m of members) { const r = regionOf(m); if (r) regions.add(r); }
    const tile: Node = {
      id: tileId,
      type: 'application',
      position: { x: 0, y: 0 },
      data: {
        label: app.name,
        config: { name: app.name, subtitle: '' },
        status: 'present',
        meta: { isGroup: true, application: { id: app.id, name: app.name, reason: app.id === SHARED_ID ? 'used by more than one application' : 'application' } } as NodeMeta,
      },
    };
    containers.push(tile);
    const total = working.filter((n) => !n.hidden && (metaOf(topLevelOf(n)).application?.id ?? SHARED_ID) === app.id).length;
    const byBand = new Map<BandKind, Node[]>();
    for (const m of members) pushTo(byBand, bandFor(m), m);
    // One band is no band: a tile with members of a single kind holds them
    // directly rather than under a heading that repeats the tile.
    if (byBand.size === 1) {
      const [kind, list] = [...byBand.entries()][0];
      (tile.data.meta as NodeMeta).band = kind;
      for (const m of list) {
        parentOf.set(m.id, tile.id);
        if (kind === 'platform') metaOf(m).compact = true;
      }
    }
    for (const kind of byBand.size === 1 ? [] : BAND_ORDER) {
      const list = byBand.get(kind);
      if (!list?.length) continue;
      const band: Node = {
        id: idFor('band', `${app.id}-${kind}`),
        type: 'band',
        position: { x: 0, y: 0 },
        data: { label: kind, config: { name: kind }, status: 'present', meta: { isGroup: true, band: kind } as NodeMeta },
      };
      containers.push(band);
      parentOf.set(band.id, tileId);
      for (const m of list) {
        parentOf.set(m.id, band.id);
        if (kind === 'platform') metaOf(m).compact = true;
      }
    }
    tile.data.config.subtitle = [
      `${total} resource${total === 1 ? '' : 's'}`,
      [...regions].sort().join(', ') || 'global',
    ].join(' · ');
  }

  const all = [...working, ...containers];
  const allById = new Map(all.map((n) => [n.id, n]));
  // Anything with children is a group; the layout reads parentNode.
  const childrenOf = new Map<string, Node[]>();
  for (const [child, parent] of parentOf) {
    const c = allById.get(child);
    if (!c || c.hidden || !allById.has(parent)) continue;
    pushTo(childrenOf, parent, c);
  }
  for (const parent of childrenOf.keys()) metaOf(allById.get(parent)!).isGroup = true;
  for (const [child, parent] of parentOf) {
    const c = allById.get(child);
    if (c && !c.hidden && allById.has(parent)) { c.parentNode = parent; c.extent = 'parent'; }
  }

  layoutStackCanvas(all);
  assignHandles(all, edges);
  return orderParentsFirst(all);
}
