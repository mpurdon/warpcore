// Canvas commands: the resources and the wiring. Every edit goes through
// the store's setNodes/setEdges, so it lands in the undo history and marks
// the project dirty the way a drag or a drop does. The drop handler, the
// radial menu, the configuration form and the Delete key all call these.

import type { Edge, Node } from 'reactflow';
import { useStore, type StoreState } from '../store/useStore';
import { resourceCategories } from '../utils/connectionRules';
import { DISCOVERED_TYPES } from '../utils/discoveredTypes';
import { generateLogGroupPath } from '../utils/logGroupPath';
import { displayNameFor } from '../utils/nodeName';
import { isResourceBasedConnection } from '../utils/rolePolicy';
import { define } from './registry';
import { findNode, nameOf } from './view';
import { isArranged, layoutCanvas } from '../utils/autoLayout';

/** Every type a node can be: the palette's resources and the discovered types. */
export const NODE_TYPES: Record<string, string> = {
  ...Object.fromEntries(Object.entries(DISCOVERED_TYPES).map(([t, info]) => [t, info.label])),
  ...Object.fromEntries(resourceCategories.flatMap((c) => c.resources.map((r) => [r.type, r.label]))),
};

let counter = 0;
/** Ids the way the canvas mints them, kept unique within a burst. */
export function newNodeId(type: string, taken: Set<string>): string {
  let id = `${type}-${Date.now()}`;
  while (taken.has(id)) id = `${type}-${Date.now()}-${++counter}`;
  return id;
}

const need = (state: StoreState, ref: string): Node => {
  const node = findNode(state, ref);
  if (!node) throw new Error(`no resource ${ref} on the canvas`);
  return node;
};

/**
 * Draw the canvas again after a change, when it is one the layout
 * arranges: a resource added, wired or removed finds its own place, so no
 * caller has to know where anything goes. A freehand canvas is left alone.
 */
function redraw(): void {
  const s = useStore.getState();
  if (!isArranged(s.nodes)) return;
  s.setNodes(layoutCanvas(s.nodes, s.edges, { projectName: s.projectName ?? undefined }));
}

/** Remove nodes and every edge that touched them; the selection and the open form follow. */
function removeNodeIds(ids: string[]): void {
  const gone = new Set(ids);
  const s = useStore.getState();
  s.setNodes((nodes) => nodes.filter((n) => !gone.has(n.id)));
  s.setEdges((edges) => edges.filter((e) => !gone.has(e.source) && !gone.has(e.target)));
  if (s.selectedNode && gone.has(s.selectedNode)) s.setSelectedNode(null);
  if (s.editingNode && gone.has(s.editingNode)) s.setEditingNode(null);
}

/** The edge a connection makes, with the data the canvas gives it. */
export function makeEdge(source: Node, target: Node, handles?: { sourceHandle?: string | null; targetHandle?: string | null }): Edge {
  return {
    id: `${source.id}-${target.id}-${Date.now()}`,
    source: source.id,
    target: target.id,
    sourceHandle: handles?.sourceHandle ?? null,
    targetHandle: handles?.targetHandle ?? null,
    type: 'permission',
    data: { isResourceBased: isResourceBasedConnection(source.type || '', target.type || '') },
  };
}

define({
  id: 'canvas.addNode', title: 'Add a resource', description: 'Put a new resource on the canvas. Types are the palette\'s (lambda, sqs, dynamodb, s3, api-gateway, …). It is placed for you: say which application it belongs to with `app`, or just wire it up and the canvas arranges itself. Returns the new node id.', group: 'Canvas', kind: 'project', hidden: true,
  params: {
    type: { type: 'string', description: 'The resource type', required: true },
    label: { type: 'string', description: 'Its name on the canvas; defaults to the type\'s label' },
    app: { type: 'string', description: 'The application it belongs to, e.g. "admin" or "delivery". The canvas groups resources by this and places the new one in that tile; leave it out and the wiring decides.' },
    config: { type: 'object', description: 'Initial configuration fields' },
    id: { type: 'string', description: 'A node id to use; defaults to type-timestamp' },
    x: { type: 'number', description: 'Canvas x. Rarely needed: an arranged canvas places what it is given. Only for a drop at the pointer.' },
    y: { type: 'number', description: 'Canvas y, with x' },
  },
  describe: (a) => `Add ${a.type}${a.label ? ` "${a.label}"` : ''}`,
  run: (a, { state }) => {
    const type = a.type as string;
    if (!NODE_TYPES[type]) throw new Error(`unknown resource type ${type}; one of ${Object.keys(NODE_TYPES).sort().join(', ')}`);
    const taken = new Set(state.nodes.map((n) => n.id));
    const id = (a.id as string | undefined) ?? newNodeId(type, taken);
    if (taken.has(id)) throw new Error(`a resource with id ${id} already exists`);
    const x = (a.x as number | undefined) ?? 80 + (state.nodes.length % 6) * 220;
    const y = (a.y as number | undefined) ?? 80 + Math.floor(state.nodes.length / 6) * 140;
    const config = { ...((a.config as Record<string, unknown>) ?? {}) };
    if (a.app) config.tags = { ...((config.tags as Record<string, string>) ?? {}), Application: String(a.app) };
    const node: Node = {
      id, type, position: { x, y },
      data: { label: (a.label as string | undefined) ?? NODE_TYPES[type], status: 'draft', ...(Object.keys(config).length ? { config } : {}) },
    };
    useStore.getState().setNodes((nodes) => [...nodes, node]);
    // An arranged canvas places it; coordinates given by a drop are kept.
    if (a.x === undefined && a.y === undefined) redraw();
    return { id };
  },
});

define({
  id: 'canvas.removeNodes', title: 'Remove resources', description: 'Remove resources from the canvas with every edge that touched them.', group: 'Canvas', kind: 'project', hidden: true,
  params: { ids: { type: 'string[]', description: 'Node ids (or unique labels)', required: true } },
  describe: (a, s) => { const ids = a.ids as string[]; return `Remove ${ids.length === 1 ? nameOf(s, ids[0]) : `${ids.length} resources`}`; },
  run: (a, { state }) => {
    const ids = (a.ids as string[]).map((r) => need(state, r).id);
    removeNodeIds(ids);
    redraw();
    return { removed: ids };
  },
});

define({
  id: 'canvas.removeSelected', title: 'Delete the selection', description: 'Remove the selected resources, or the selected connection.', group: 'Canvas', kind: 'project', hidden: true, notForModel: true,
  shortcut: { keys: ['delete', 'backspace'], label: '⌫' },
  available: (s) => (s.nodes.some((n) => n.selected) || s.selectedEdge ? null : 'Nothing selected'),
  describe: (_a, s) => {
    const ids = s.nodes.filter((n) => n.selected).map((n) => n.id);
    return ids.length ? `Remove ${ids.length === 1 ? nameOf(s, ids[0]) : `${ids.length} resources`}` : 'Remove a connection';
  },
  run: (_a, { state }) => {
    const ids = state.nodes.filter((n) => n.selected).map((n) => n.id);
    if (ids.length) {
      removeNodeIds(ids);
      return { removed: ids };
    }
    const edgeId = state.selectedEdge!;
    const s = useStore.getState();
    s.setEdges((edges) => edges.filter((e) => e.id !== edgeId));
    s.setSelectedEdge(null);
    return { removed: [edgeId] };
  },
});

define({
  id: 'canvas.connect', title: 'Connect two resources', description: 'Draw a connection from one resource to another: a trigger, an access grant or a relationship, as the canvas infers from the two types. Returns the edge id.', group: 'Canvas', kind: 'project', hidden: true,
  params: {
    source: { type: 'string', description: 'Source node id or unique label', required: true },
    target: { type: 'string', description: 'Target node id or unique label', required: true },
    sourceHandle: { type: 'string', description: 'Handle id on the source, from a drag' },
    targetHandle: { type: 'string', description: 'Handle id on the target' },
  },
  describe: (a, s) => `Connect ${nameOf(s, a.source as string)} → ${nameOf(s, a.target as string)}`,
  run: (a, { state }) => {
    const source = need(state, a.source as string);
    const target = need(state, a.target as string);
    if (source.id === target.id) throw new Error('a resource cannot connect to itself');
    if (state.edges.some((e) => e.source === source.id && e.target === target.id)) throw new Error(`${displayNameFor(source)} is already connected to ${displayNameFor(target)}`);
    const edge = makeEdge(source, target, { sourceHandle: a.sourceHandle as string | undefined, targetHandle: a.targetHandle as string | undefined });
    const s = useStore.getState();
    // A log group gets its path from what feeds it, the first time.
    if (target.type === 'log-group' && !target.data?.config?.logGroupPath) {
      const path = generateLogGroupPath(source, s.projectName);
      if (path) s.setNodes((nodes) => nodes.map((n) => (n.id === target.id ? { ...n, data: { ...n.data, config: { ...(n.data?.config ?? {}), logGroupPath: path } } } : n)));
    }
    useStore.getState().setEdges((edges) => [...edges, edge]);
    // A new connection can change which application a resource belongs to.
    redraw();
    return { id: edge.id };
  },
});

define({
  id: 'canvas.disconnect', title: 'Remove a connection', description: 'Remove an edge, by its id or by its two ends.', group: 'Canvas', kind: 'project', hidden: true,
  params: {
    edgeId: { type: 'string', description: 'The edge id' },
    source: { type: 'string', description: 'Source node, when no edge id' },
    target: { type: 'string', description: 'Target node, when no edge id' },
  },
  describe: (a) => (a.edgeId ? `Remove connection ${a.edgeId}` : `Disconnect ${a.source} → ${a.target}`),
  run: (a, { state }) => {
    let edge: Edge | undefined;
    if (a.edgeId) edge = state.edges.find((e) => e.id === a.edgeId);
    else if (a.source && a.target) {
      const source = need(state, a.source as string);
      const target = need(state, a.target as string);
      edge = state.edges.find((e) => e.source === source.id && e.target === target.id);
    } else throw new Error('give edgeId, or source and target');
    if (!edge) throw new Error('no such connection');
    const id = edge.id;
    useStore.getState().setEdges((edges) => edges.filter((e) => e.id !== id));
    return { removed: id };
  },
});

define({
  id: 'canvas.setApplication', title: 'Move a resource to an application', description: 'Put a resource in an application tile, e.g. "admin" or "delivery". The canvas redraws with it in that group.', group: 'Canvas', kind: 'project', hidden: true,
  params: { id: { type: 'string', description: 'Node id or unique label', required: true }, app: { type: 'string', description: 'The application name; empty lets the wiring decide again', required: true } },
  describe: (a, s) => `Move ${nameOf(s, a.id as string)} to ${a.app || 'no application'}`,
  run: (a, { state }) => {
    const node = need(state, a.id as string);
    const app = String(a.app).trim();
    useStore.getState().setNodes((nodes) => nodes.map((n) => {
      if (n.id !== node.id) return n;
      const tags = { ...((n.data?.config?.tags as Record<string, string>) ?? {}) };
      if (app) tags.Application = app; else delete tags.Application;
      return { ...n, data: { ...n.data, config: { ...(n.data?.config ?? {}), tags } } };
    }));
    redraw();
    return { id: node.id, app: app || null };
  },
});

define({
  id: 'canvas.setConfig', title: 'Set configuration', description: 'Set one or more configuration fields on a resource (memory, timeout, runtime, handler, environment variables, …). Fields merge into the existing config.', group: 'Canvas', kind: 'project', hidden: true,
  params: {
    id: { type: 'string', description: 'Node id or unique label', required: true },
    config: { type: 'object', description: 'Fields to set', required: true },
  },
  describe: (a, s) => `Configure ${nameOf(s, a.id as string)}: ${Object.keys(a.config as object).join(', ')}`,
  run: (a, { state }) => {
    const node = need(state, a.id as string);
    const patch = a.config as Record<string, unknown>;
    useStore.getState().setNodes((nodes) => nodes.map((n) => (n.id === node.id ? { ...n, data: { ...n.data, config: { ...(n.data?.config ?? {}), ...patch } } } : n)));
    return { id: node.id };
  },
});

define({
  id: 'canvas.rename', title: 'Rename a resource', description: 'Change a resource\'s label on the canvas.', group: 'Canvas', kind: 'project', hidden: true,
  params: { id: { type: 'string', description: 'Node id or unique label', required: true }, label: { type: 'string', description: 'The new label', required: true } },
  describe: (a) => `Rename ${a.id} to "${a.label}"`,
  run: (a, { state }) => {
    const node = need(state, a.id as string);
    useStore.getState().setNodes((nodes) => nodes.map((n) => (n.id === node.id ? { ...n, data: { ...n.data, label: a.label } } : n)));
  },
});

define({
  id: 'canvas.move', title: 'Move a resource', description: 'Place a resource at canvas coordinates. Only for a drag: on an arranged canvas the layout decides where things go, and the next edit puts this one back.', group: 'Canvas', kind: 'project', hidden: true, notForModel: true,
  params: { id: { type: 'string', description: 'Node id or unique label', required: true }, x: { type: 'number', description: 'x', required: true }, y: { type: 'number', description: 'y', required: true } },
  describe: (a) => `Move ${a.id} to ${a.x},${a.y}`,
  run: (a, { state }) => {
    const node = need(state, a.id as string);
    useStore.getState().setNodes((nodes) => nodes.map((n) => (n.id === node.id ? { ...n, position: { x: a.x as number, y: a.y as number } } : n)));
  },
});
