// What the canvas and the system view both derive from the store: the
// lens re-flow of an imported account, the scenario on show with its marks
// at the playhead, and how each edge is drawn given the layers, the
// selection and the scenario. Derived, never stored (DESIGN_GUIDANCE.md
// §12). The marks reach the node components through a context, so the
// view nodes carry only class names.

import { createContext, useContext, useMemo } from 'react';
import { Edge } from 'reactflow';
import { useStore } from '../store/useStore';
import { Layer } from '../utils/layers';
import { lensEmphasis, pinnedBySelection, Emphasis } from '../utils/lenses';
import { isStackCanvas, reflowStack, Reflow } from '../utils/stackLayout';
import { checkScenario, hopIndex, playbackMarks, PlaybackMarks, Playhead, Scenario, ScenarioCheck, TRAVEL_MS } from '../utils/scenarios';

export interface LensView {
  /** Per node, or null when the lens keeps everything. */
  emphasis: Map<string, Emphasis> | null;
  /** On a computed layout with a lens on: what went and where the rest sits. */
  reflow: Reflow | null;
}

export function useLensView(): LensView {
  const nodes = useStore((s) => s.nodes);
  const edges = useStore((s) => s.edges);
  const lens = useStore((s) => s.lens);
  const selectedNode = useStore((s) => s.selectedNode);
  const emphasis = useMemo(() => {
    if (lens === 'all' || lens === 'cost') return null;
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const pinned = pinnedBySelection(selectedNode, edges);
    return new Map(nodes.map((n) => [n.id, lensEmphasis(n, lens, { byId, pinned })]));
  }, [nodes, edges, lens, selectedNode]);
  const reflow = useMemo(() => {
    if (!emphasis || !isStackCanvas(nodes)) return null;
    return reflowStack(nodes, (n) => emphasis.get(n.id) !== 'context');
  }, [nodes, emphasis]);
  return { emphasis, reflow };
}

export interface ScenarioView {
  scenario: Scenario;
  check: ScenarioCheck;
  /** The playhead when this scenario is the one playing. */
  head: Playhead | null;
  marks: PlaybackMarks;
  /** Edges that carry a hop of the scenario. */
  pathEdges: Set<string>;
  /** Edges from a compute step to its log groups. */
  logEdges: Set<string>;
  /** Where the request is: the node it is at or heading to, and the one it left. */
  focus: { at: string; from?: string } | null;
  /** Display name for any node id. */
  name: (id: string) => string;
}

/** The scenario on show: the one playing, else the one in the inspector. */
export function useScenarioView(): ScenarioView | null {
  const nodes = useStore((s) => s.nodes);
  const edges = useStore((s) => s.edges);
  const scenarios = useStore((s) => s.scenarios);
  const inspectedScenario = useStore((s) => s.inspectedScenario);
  const playhead = useStore((s) => s.playhead);
  const id = playhead?.scenarioId ?? inspectedScenario;
  const scenario = useMemo(() => (id ? scenarios.find((s) => s.id === id) ?? null : null), [scenarios, id]);
  // The check depends on the wiring only; the playhead ticks without it.
  const index = useMemo(() => hopIndex(nodes, edges), [nodes, edges]);
  const check = useMemo(() => (scenario ? checkScenario(scenario, nodes, edges, index) : null), [scenario, nodes, edges, index]);
  return useMemo(() => {
    if (!scenario || !check) return null;
    const head = playhead && playhead.scenarioId === scenario.id ? playhead : null;
    const marks = playbackMarks(scenario, head, check);
    const pathEdges = new Set(check.steps.flatMap((st) => (st.evidence ? [st.evidence.edgeId] : [])));
    const logEdges = new Set(check.steps.flatMap((st) => st.logEdges));
    let focus: ScenarioView['focus'] = null;
    if (head && head.phase !== 'end') {
      if (head.index < 0) focus = { at: scenario.trigger.at };
      else {
        const step = check.steps[head.index];
        focus = step ? { at: step.at, from: step.evidence?.from } : null;
      }
    }
    return { scenario, check, head, marks, pathEdges, logEdges, focus, name: index.name };
  }, [scenario, check, playhead, index]);
}

/** Node marks for the node components; null when no scenario is on show. */
export const ScenarioMarksContext = createContext<PlaybackMarks | null>(null);
export const useScenarioMarks = (): PlaybackMarks | null => useContext(ScenarioMarksContext);

// ------------------------------------------------------------------ edges

/** How an edge is drawn: the one rule for the canvas and the system view. */
export interface EdgeView {
  /** Off-layer edges are hidden unless they touch the selection or tell the scenario's story. */
  visible: boolean;
  /** normal; dimmed: on a layer that is off, shown for the selection; background: not part of the scenario playing. */
  emphasis: 'normal' | 'dimmed' | 'background';
  /** Carries a hop of the scenario on show. */
  onPath: boolean;
  /** Carries log writes of the step the request is at. */
  logging: boolean;
  /** The request is travelling this edge. */
  pulse: { reverse: boolean; durationMs: number } | null;
}

export const PLAIN_EDGE: EdgeView = { visible: true, emphasis: 'normal', onPath: false, logging: false, pulse: null };

export function edgeView(e: Edge, layers: Record<Layer, boolean>, selectedNode: string | null, sv: ScenarioView | null): EdgeView {
  const layer = e.data?.meta?.layer as Layer | undefined;
  const layerOn = !layer || layers[layer];
  const onPath = sv ? sv.pathEdges.has(e.id) : false;
  const isLog = sv ? sv.logEdges.has(e.id) : false;
  const touchesSelection = selectedNode !== null && (e.source === selectedNode || e.target === selectedNode);
  const visible = layerOn || touchesSelection || onPath || isLog;
  const emphasis: EdgeView['emphasis'] = !layerOn && !onPath && !isLog ? 'dimmed' : sv?.head && !onPath && !isLog ? 'background' : 'normal';
  const pulse = sv?.marks.pulse?.edgeId === e.id ? { reverse: sv.marks.pulse.reverse, durationMs: TRAVEL_MS / (sv.head?.speed || 1) } : null;
  const logging = sv ? sv.marks.logEdges.has(e.id) : false;
  return { visible, emphasis, onPath, logging, pulse };
}

/** Whether an edge view is the plain one, so the edge can keep its identity. */
export function isPlainEdge(v: EdgeView): boolean {
  return v.visible && v.emphasis === 'normal' && !v.onPath && !v.logging && !v.pulse;
}
