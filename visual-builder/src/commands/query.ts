// Queries: exact answers from what the app already holds. An assistant
// that can ask these never has to guess at the graph, and a person at the
// palette never sees them: they are for callers with arguments.

import type { Edge, Node } from 'reactflow';
import type { StoreState } from '../store/useStore';
import { estimateCost } from '../utils/costEstimation';
import { displayNameFor } from '../utils/nodeName';
import { validateCanvas } from '../utils/validation';
import { define } from './registry';
import { findNode } from './view';

const CONTAINERS = new Set(['application', 'band', 'enclosure']);

function brief(n: Node) {
  const meta = (n.data?.meta ?? {}) as Record<string, unknown>;
  return {
    id: n.id, type: n.type, name: displayNameFor(n), arn: n.data?.arn ?? null, parent: n.parentNode ?? null,
    status: n.data?.status ?? null, managed: Boolean(meta.managed), provenance: meta.provenance ?? null,
    application: (meta.application as { name?: string } | undefined)?.name ?? null,
  };
}

function edgeBrief(e: Edge, state: StoreState) {
  const name = (id: string) => { const n = state.nodes.find((x) => x.id === id); return n ? displayNameFor(n) : id; };
  const meta = (e.data?.meta ?? {}) as Record<string, unknown>;
  return { id: e.id, source: e.source, sourceName: name(e.source), target: e.target, targetName: name(e.target), layer: meta.layer ?? 'access', meta, config: e.data?.config ?? null, isResourceBased: Boolean(e.data?.isResourceBased) };
}

define({
  id: 'query.project', title: 'Project summary', description: 'The project: name, file, environments, lock state, counts of resources by type, scenarios, what is running.', group: 'Queries', kind: 'query', hidden: true,
  run: (_a, { state }) => {
    const byType: Record<string, number> = {};
    for (const n of state.nodes) { if (CONTAINERS.has(n.type || '') || n.hidden) continue; byType[n.type || '?'] = (byType[n.type || '?'] ?? 0) + 1; }
    return {
      name: state.projectName, path: state.configPath, locked: state.locked, preview: state.holodeckPreview, unsaved: state.hasUnsavedChanges,
      environment: state.currentEnvironment, environments: Object.keys(state.environmentConfigs),
      resourcesByType: byType, edges: state.edges.length, scenarios: state.scenarios.map((s) => ({ id: s.id, name: s.name, steps: s.steps.length })),
      discovered: state.nodes.filter((n) => n.data?.arn).length, selected: state.selectedNode, lens: state.lens,
      run: state.run ? { kind: state.run.kind, environment: state.run.environment, phase: state.run.phase, outcome: state.run.outcome } : null,
      review: state.review ? { at: state.review.at, findings: state.review.findings.length } : null,
      live: state.liveHealth ? { checked_at: state.liveHealth.checked_at } : null,
      drift: state.drift ? state.drift.counts : null,
    };
  },
});

define({
  id: 'query.nodes', title: 'List resources', description: 'Resources on the canvas, optionally by type or a substring of the name.', group: 'Queries', kind: 'query', hidden: true,
  params: { type: { type: 'string', description: 'A node type, e.g. lambda' }, q: { type: 'string', description: 'Substring of the name or id' } },
  run: (a, { state }) => state.nodes
    .filter((n) => !n.hidden && !CONTAINERS.has(n.type || ''))
    .filter((n) => !a.type || n.type === a.type)
    .filter((n) => !a.q || displayNameFor(n).toLowerCase().includes(String(a.q).toLowerCase()) || n.id.toLowerCase().includes(String(a.q).toLowerCase()))
    .map(brief),
});

define({
  id: 'query.node', title: 'Describe a resource', description: 'One resource in full: its config, metadata, position, and every edge in and out.', group: 'Queries', kind: 'query', hidden: true,
  params: { id: { type: 'string', description: 'Node id or unique label', required: true } },
  run: (a, { state }) => {
    const n = findNode(state, a.id as string) as Node | undefined;
    if (!n) throw new Error(`no resource ${a.id} on the canvas`);
    return {
      ...brief(n), position: n.position, config: n.data?.config ?? {}, meta: n.data?.meta ?? {},
      edges: state.edges.filter((e) => e.source === n.id || e.target === n.id).map((e) => edgeBrief(e, state)),
      findings: (state.reviewByArn.get(n.data?.arn as string) ?? []).map((f) => ({ id: f.id, severity: f.severity, title: f.title, status: f.status })),
      health: n.data?.arn ? state.liveHealth?.resources[n.data.arn as string] ?? null : null,
    };
  },
});

define({
  id: 'query.edges', title: 'List connections', description: 'Every edge on the canvas, or those touching one resource.', group: 'Queries', kind: 'query', hidden: true,
  params: { id: { type: 'string', description: 'Only edges touching this node' } },
  run: (a, { state }) => {
    const n = a.id ? (findNode(state, a.id as string) as Node | undefined) : undefined;
    if (a.id && !n) throw new Error(`no resource ${a.id} on the canvas`);
    return state.edges.filter((e) => !n || e.source === n.id || e.target === n.id).map((e) => edgeBrief(e, state));
  },
});

define({
  id: 'query.path', title: 'Path between resources', description: 'The shortest chain of connections from one resource to another, following edges in their drawn direction (or either way with `undirected`).', group: 'Queries', kind: 'query', hidden: true,
  params: {
    from: { type: 'string', description: 'Start node id or label', required: true },
    to: { type: 'string', description: 'End node id or label', required: true },
    undirected: { type: 'boolean', description: 'Ignore edge direction' },
  },
  run: (a, { state }) => {
    const from = findNode(state, a.from as string) as Node | undefined;
    const to = findNode(state, a.to as string) as Node | undefined;
    if (!from || !to) throw new Error(`no resource ${!from ? a.from : a.to} on the canvas`);
    const path = shortestPath(state.edges, from.id, to.id, Boolean(a.undirected));
    if (!path) return { found: false, hops: [] };
    return { found: true, hops: path.map((e) => edgeBrief(e, state)) };
  },
});

define({
  id: 'query.reach', title: 'What a resource reaches', description: 'Everything reachable from a resource over the drawn edges, with the distance in hops. `inbound` walks the other way: everything that reaches it.', group: 'Queries', kind: 'query', hidden: true,
  params: { id: { type: 'string', description: 'Node id or label', required: true }, inbound: { type: 'boolean', description: 'Walk edges backwards' } },
  run: (a, { state }) => {
    const n = findNode(state, a.id as string) as Node | undefined;
    if (!n) throw new Error(`no resource ${a.id} on the canvas`);
    const dist = new Map<string, number>([[n.id, 0]]);
    const queue = [n.id];
    while (queue.length) {
      const cur = queue.shift()!;
      for (const e of state.edges) {
        const next = a.inbound ? (e.target === cur ? e.source : null) : (e.source === cur ? e.target : null);
        if (next && !dist.has(next)) { dist.set(next, dist.get(cur)! + 1); queue.push(next); }
      }
    }
    dist.delete(n.id);
    return [...dist.entries()].map(([id, hops]) => { const x = state.nodes.find((m) => m.id === id); return { id, name: x ? displayNameFor(x) : id, type: x?.type, hops }; }).sort((p, q) => p.hops - q.hops);
  },
});

define({
  id: 'query.validate', title: 'Validate the canvas', description: 'Every validation error and warning on the canvas, with the resource each is about.', group: 'Queries', kind: 'query', hidden: true,
  run: (_a, { state }) => validateCanvas(state.nodes, state.edges),
});

define({
  id: 'query.cost', title: 'Cost estimate', description: 'The monthly estimate for the canvas at the configured executions per month, per resource.', group: 'Queries', kind: 'query', hidden: true,
  run: (_a, { state }) => estimateCost(state.nodes, state.executionsPerMonth),
});

define({
  id: 'query.findings', title: 'Findings', description: 'The last review\'s findings, open ones by default.', group: 'Queries', kind: 'query', hidden: true,
  params: { includeMuted: { type: 'boolean', description: 'Include muted findings' } },
  run: (a, { state }) => (state.review ? { at: state.review.at, window_hours: state.review.window_hours, summary: state.review.summary, findings: state.review.findings.filter((f) => a.includeMuted || f.status !== 'muted') } : null),
});

define({
  id: 'query.receipts', title: 'What ran', description: 'The commands run this session, newest last: what, by whom, and whether it worked.', group: 'Queries', kind: 'query', hidden: true,
  params: { last: { type: 'number', description: 'How many; default 50' } },
  run: (a, { state }) => state.receipts.slice(-((a.last as number | undefined) ?? 50)),
});

/** Breadth-first over the edges; the path as the edges crossed. */
export function shortestPath(edges: Edge[], from: string, to: string, undirected: boolean): Edge[] | null {
  if (from === to) return [];
  const prev = new Map<string, Edge>();
  const seen = new Set([from]);
  const queue = [from];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const e of edges) {
      const next = e.source === cur ? e.target : undirected && e.target === cur ? e.source : null;
      if (!next || seen.has(next)) continue;
      seen.add(next);
      prev.set(next, e);
      if (next === to) {
        const path: Edge[] = [];
        let at = to;
        while (at !== from) { const edge = prev.get(at)!; path.unshift(edge); at = edge.source === at ? edge.target : edge.source; }
        return path;
      }
      queue.push(next);
    }
  }
  return null;
}
