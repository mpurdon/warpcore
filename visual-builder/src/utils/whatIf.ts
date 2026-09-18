// What if: a scenario played against a canvas with something taken away.
// The same checker, over the same wiring minus the resources named, so the
// hops that break are the ones that really depended on them. Two askers:
// the scenario inspector ("what if this queue went away?") and the deploy
// plan ("which scenarios would this plan's deletes break?").

import { Edge, Node } from 'reactflow';
import { checkScenario, hopIndex, Scenario, ScenarioCheck } from './scenarios';

export interface WhatIf {
  scenario: Scenario;
  /** The check as it stands today. */
  before: ScenarioCheck;
  /** The check with the resources removed. */
  after: ScenarioCheck;
  /** Steps (0-based) that lose their evidence, or sit on a removed resource. */
  brokenSteps: number[];
  /** Problems that appear only after the removal. */
  newProblems: string[];
}

/** The canvas without `removed`: their nodes and every edge that touched them. */
export function without(nodes: Node[], edges: Edge[], removed: Set<string>): { nodes: Node[]; edges: Edge[] } {
  return {
    nodes: nodes.filter((n) => !removed.has(n.id)),
    edges: edges.filter((e) => !removed.has(e.source) && !removed.has(e.target)),
  };
}

/** Every problem a check found, the scenario's own and each step's. */
export function allProblems(check: ScenarioCheck): string[] {
  // The scenario's list already carries its steps' problems; the union is for checkers that do not.
  return [...new Set([...check.problems, ...check.steps.flatMap((s) => s.problems)])];
}

export function whatIf(scenario: Scenario, nodes: Node[], edges: Edge[], removed: Set<string>): WhatIf {
  const before = checkScenario(scenario, nodes, edges, hopIndex(nodes, edges));
  const less = without(nodes, edges, removed);
  const after = checkScenario(scenario, less.nodes, less.edges, hopIndex(less.nodes, less.edges));
  const brokenSteps = scenario.steps.flatMap((step, i) => {
    const was = before.steps[i];
    const now = after.steps[i];
    if (!was || !now) return [];
    if (removed.has(step.at)) return [i];
    if (was.evidence && !now.evidence) return [i];
    return [];
  });
  const had = new Set(allProblems(before));
  const newProblems = allProblems(after).filter((p) => !had.has(p));
  return { scenario, before, after, brokenSteps, newProblems };
}

/** Every scenario the removal breaks, worst first. */
export function scenariosBrokenBy(scenarios: Scenario[], nodes: Node[], edges: Edge[], removed: Set<string>): WhatIf[] {
  if (removed.size === 0) return [];
  return scenarios
    .map((s) => whatIf(s, nodes, edges, removed))
    .filter((w) => w.brokenSteps.length > 0 || (removed.has(w.scenario.trigger.at)))
    .sort((a, b) => b.brokenSteps.length - a.brokenSteps.length);
}

/** The resources a scenario passes through, in order, for the what-if picker. */
export function resourcesOnPath(scenario: Scenario): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of [scenario.trigger.at, ...scenario.steps.map((s) => s.at)]) {
    if (!seen.has(id)) { seen.add(id); out.push(id); }
  }
  return out;
}
