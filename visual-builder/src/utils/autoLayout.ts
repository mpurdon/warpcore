// Laying a canvas out: resources clustered into application tiles, each
// tile's members in bands in request order, the whole thing stacked.
//
// One arrangement, two callers: an imported account (buildCanvas ends
// here) and a canvas built by hand or by commands (`canvas.layout`, and
// the dispatcher after any edit). So nothing has to place a node by eye,
// and an import and an edit arrange the same canvas the same way.
//
// Grouping has one home: `meta.application` on the node. The import works
// it out from tags, names and wiring; the operator overrides it by name
// (canvas.setApplication); a later layout keeps what is already decided
// and clusters only what has no home yet. It is canvas state, never an
// AWS tag: the compiler reads `config.tags`, and a view choice must not
// show up in a deploy plan.
//
// Containment that already means something, a VPC's subnets and what sits
// in them, is kept; only the tiles and bands are rebuilt.

import type { Edge, Node } from 'reactflow';
import { clusterApplications, ClusterItem, ClusterLink, SHARED_ID } from './applications';
import { assignHandles, bandFor, BandKind, BAND_ORDER, isStackCanvas, layoutStackCanvas, pushTo } from './stackLayout';
import type { NodeMeta } from './projectFromAccount';
import { orderParentsFirst } from './nodeTree';

/** Containers the layout owns: it removes them and makes them again. */
export const LAYOUT_CONTAINERS: ReadonlySet<string> = new Set(['application', 'band']);

/** The VPC and its plumbing travel together whatever they are wired to. */
export const NETWORK_PLUMBING: ReadonlySet<string> = new Set(['vpc', 'subnet', 'security-group', 'internet-gateway', 'nat-gateway', 'route-table', 'vpc-endpoint', 'elastic-ip']);

/** Why a node is in the application it is in, when the operator said so. Outlives a re-layout. */
export const CHOSEN = 'chosen by you';

export const metaOf = (node: Node): NodeMeta => ((node.data.meta ||= {} as NodeMeta) as NodeMeta);

/**
 * Whether the canvas is one the layout arranges. A canvas that has been
 * laid out (or imported, or opened from the Holodeck) keeps its tiles, so
 * every later edit is placed for the operator; a freehand sketch with no
 * tiles is left exactly where its author put things.
 */
export const isArranged = isStackCanvas;

export interface LayoutOptions {
  /** Names the tile that holds whatever belongs to no application of its own. */
  projectName?: string;
  /** The region each node shows, for a tile's subtitle. */
  regionOf?: (node: Node) => string;
  /** The tags a node carries, when the caller knows them better than the canvas does. */
  tagsOf?: (node: Node) => Record<string, string> | undefined;
  /** What the clusterer votes on, when the drawn edges are not the whole story (an import keeps its hidden ones). */
  links?: ClusterLink[];
}

/** The layout's own fields on a node's meta, compared for "did anything move". */
function sameMeta(a: NodeMeta | undefined, b: NodeMeta | undefined): boolean {
  const x = (a ?? {}) as NodeMeta;
  const y = (b ?? {}) as NodeMeta;
  return Boolean(x.isGroup) === Boolean(y.isGroup)
    && Boolean(x.compact) === Boolean(y.compact)
    && x.band === y.band
    && x.application?.id === y.application?.id
    && x.application?.name === y.application?.name
    && x.application?.reason === y.application?.reason;
}

/**
 * The canvas, laid out: tiles, bands, positions and edge handles. Returns
 * the nodes parents-first, as React Flow wants. Edge handles are written
 * in place, so hand React Flow a fresh edges array afterwards.
 */
export function layoutCanvas(nodes: Node[], edges: Edge[], opts: LayoutOptions = {}): Node[] {
  const projectName = opts.projectName || 'project';
  const regionOf = opts.regionOf ?? (() => '');
  const tagsOf = opts.tagsOf ?? ((n: Node) => (n.data?.config as { tags?: Record<string, string> } | undefined)?.tags);

  // Start from the resources: the layout's own containers go, and with them
  // any parent link into one. Containment that means something stays.
  // Everything below works on copies, so a caller's nodes are never moved
  // under it; what did not move is handed back as the original object at
  // the end, so React Flow re-renders only what changed.
  const goneIds = new Set(nodes.filter((n) => LAYOUT_CONTAINERS.has(n.type || '')).map((n) => n.id));
  const original = new Map(nodes.map((n) => [n.id, n]));
  const working = nodes
    .filter((n) => !LAYOUT_CONTAINERS.has(n.type || ''))
    .map((n) => ({ ...n, position: { ...n.position }, data: { ...n.data, meta: { ...(n.data?.meta ?? {}) } } }));
  const parentOf = new Map<string, string>();
  for (const n of working) if (n.parentNode && !goneIds.has(n.parentNode)) parentOf.set(n.id, n.parentNode);
  const byId = new Map(working.map((n) => [n.id, n]));
  const topLevelOf = (n: Node): Node => {
    let cur = n;
    for (let hops = 0; hops < 6 && parentOf.has(cur.id); hops++) cur = byId.get(parentOf.get(cur.id)!) ?? cur;
    return cur;
  };

  // ---- applications: every resource keeps the home it has, and whatever
  // has none is clustered by its tags, its name and its wiring. A home
  // already decided is handed to the clusterer as a tag, the evidence it
  // trusts most, so neighbours can still be drawn in.
  const clusterItems: ClusterItem[] = working.map((n) => {
    const decided = metaOf(n).application?.name;
    return {
      id: n.id,
      name: String(n.data?.label ?? n.id),
      type: n.type || '',
      tags: decided ? { Application: decided } : tagsOf(n),
      platform: bandFor(n) === 'platform' || NETWORK_PLUMBING.has(n.type || ''),
      parent: parentOf.get(n.id),
    };
  });
  const links = opts.links ?? edges.filter((e) => byId.has(e.source) && byId.has(e.target)).map((e) => ({ source: e.source, target: e.target }));
  const clustering = clusterApplications(clusterItems, links, projectName);

  // Who belongs where, in one pass: the top-level members a tile holds, and
  // everything counted against it, including what sits inside a VPC.
  const appOf = (n: Node): string => clustering.assignments.get(topLevelOf(n).id)?.id ?? SHARED_ID;
  const membersByApp = new Map<string, Node[]>();
  const countByApp = new Map<string, number>();
  for (const n of working) {
    if (n.hidden) continue;
    const app = appOf(n);
    countByApp.set(app, (countByApp.get(app) ?? 0) + 1);
    if (!parentOf.has(n.id)) pushTo(membersByApp, app, n);
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
    const members = membersByApp.get(app.id);
    if (!members?.length) continue;
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
    const total = countByApp.get(app.id) ?? members.length;
    tile.data.config.subtitle = [
      `${total} resource${total === 1 ? '' : 's'}`,
      [...regions].sort().join(', ') || 'global',
    ].join(' · ');
  }

  // A resource clustered into a tile remembers it, so the next layout keeps
  // it there and the inspector can say why it is where it is. What the
  // operator chose themselves is never overwritten.
  for (const n of working) {
    const a = clustering.assignments.get(n.id);
    if (a && metaOf(n).application?.reason !== CHOSEN) metaOf(n).application = a;
  }

  const all = [...working, ...containers];
  const allById = new Map(all.map((n) => [n.id, n]));
  for (const [child, parent] of parentOf) {
    const c = allById.get(child);
    const p = allById.get(parent);
    if (c && !c.hidden && p) metaOf(p).isGroup = true;
  }
  for (const n of all) {
    if (n.type === 'subnet' && parentOf.has(n.id)) metaOf(n).isGroup = true;
    // Gateways, route tables and endpoints: the VPC's own plumbing, one line each.
    if (n.type !== 'subnet' && allById.get(parentOf.get(n.id) || '')?.type === 'vpc') metaOf(n).compact = true;
  }
  // parentNode is what the layout reads, so set it before measuring.
  for (const n of all) {
    const parent = parentOf.get(n.id);
    if (parent && allById.has(parent) && !n.hidden) { n.parentNode = parent; n.extent = 'parent'; }
    else if (n.parentNode && goneIds.has(n.parentNode)) { delete n.parentNode; delete n.extent; }
  }

  layoutStackCanvas(all);
  assignHandles(all, edges);
  // A node that ended up exactly where it was keeps its identity, so the
  // canvas re-renders the few that moved rather than all of them.
  const settled = all.map((n) => {
    const was = original.get(n.id);
    if (!was || was === n) return n;
    const same = was.parentNode === n.parentNode && was.extent === n.extent
      && was.position.x === n.position.x && was.position.y === n.position.y
      && (was.style?.width ?? null) === (n.style?.width ?? null) && (was.style?.height ?? null) === (n.style?.height ?? null)
      && sameMeta(was.data?.meta, n.data?.meta);
    return same ? was : n;
  });
  return orderParentsFirst(settled);
}
