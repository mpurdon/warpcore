// What the canvas and the system view both derive from the store: the
// lens re-flow of an imported account, and the scenario on show with its
// marks at the playhead. Derived, never stored (DESIGN_GUIDANCE.md §12).

import { useMemo } from 'react';
import { useStore } from '../store/useStore';
import { lensEmphasis, pinnedBySelection, Emphasis } from '../utils/lenses';
import { isStackCanvas, reflowStack, Reflow } from '../utils/stackLayout';
import { checkScenario, playbackMarks, PlaybackMarks, Playhead, Scenario, ScenarioCheck } from '../utils/scenarios';

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
  speed: number;
}

/** The scenario on show: the one playing, else the one in the inspector. */
export function useScenarioView(): ScenarioView | null {
  const nodes = useStore((s) => s.nodes);
  const edges = useStore((s) => s.edges);
  const scenarios = useStore((s) => s.scenarios);
  const inspectedScenario = useStore((s) => s.inspectedScenario);
  const playhead = useStore((s) => s.playhead);
  return useMemo(() => {
    const id = playhead?.scenarioId ?? inspectedScenario;
    const scenario = id ? scenarios.find((s) => s.id === id) : undefined;
    if (!scenario) return null;
    const check = checkScenario(scenario, nodes, edges);
    const head = playhead && playhead.scenarioId === scenario.id ? playhead : null;
    const marks = playbackMarks(scenario, head, check, nodes, edges);
    const pathEdges = new Set(check.steps.flatMap((st) => (st.evidence ? [st.evidence.edgeId] : [])));
    const logEdges = new Set<string>();
    for (const st of check.steps) {
      for (const g of st.logGroups) {
        for (const e of edges) {
          if ((e.source === st.at && e.target === g) || (e.target === st.at && e.source === g)) logEdges.add(e.id);
        }
      }
    }
    return { scenario, check, head, marks, pathEdges, logEdges, speed: head?.speed ?? 1 };
  }, [scenarios, inspectedScenario, playhead, nodes, edges]);
}
