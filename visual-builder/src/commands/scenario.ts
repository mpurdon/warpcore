// Scenario commands. Editing one is a project change; playing one is not.

import type { Node } from 'reactflow';
import { useStore, type StoreState } from '../store/useStore';
import { canBeStep, checkScenario, createScenario, hopIndex, stepFromRaw, suggestPath, uniqueScenarioId, type Scenario, type ScenarioStep } from '../utils/scenarios';
import { displayNameFor } from '../utils/nodeName';
import { scenariosBrokenBy, whatIf } from '../utils/whatIf';
import { define } from './registry';
import { findNode } from './view';

const SPEEDS = [0.5, 1, 2, 4, 8];

function needScenario(state: StoreState, ref: string): Scenario {
  const byId = state.scenarios.find((s) => s.id === ref);
  if (byId) return byId;
  const byName = state.scenarios.filter((s) => s.name === ref);
  if (byName.length === 1) return byName[0];
  throw new Error(`no scenario ${ref}; have ${state.scenarios.map((s) => `${s.id} (${s.name})`).join(', ') || 'none'}`);
}

function needStepNode(state: StoreState, ref: string): Node {
  const node = findNode(state, ref);
  if (!node) throw new Error(`no resource ${ref} on the canvas`);
  if (!canBeStep(node)) throw new Error(`${displayNameFor(node)} cannot be a step (log groups and roles never are)`);
  return node;
}

const instances = (verb: string) => (s: StoreState) => s.scenarios.map((sc) => ({
  key: sc.id, args: { id: sc.id }, title: `${verb} scenario: ${sc.name}`, keywords: ['scenario'],
  subtitle: sc.steps.length ? `${sc.steps.length} steps from ${sc.trigger.at}` : 'No steps yet',
}));

define({
  id: 'scenario.new', title: 'New scenario', description: 'Add a scenario: a named event played step by step through the resources it touches. Opens in the inspector; steps can be drafted from the wiring.', group: 'Scenarios', kind: 'project',
  params: {
    triggerAt: { type: 'string', description: 'Where the request starts (node id or label); defaults to the most entry-like resource' },
    name: { type: 'string', description: 'A name; defaults to one derived from the trigger' },
    event: { type: 'string', description: 'The event at the trigger, e.g. "POST /orders"' },
    draft: { type: 'boolean', description: 'Draft the steps from the wiring, best hop first' },
  },
  keywords: ['scenario', 'simulate', 'record'],
  available: (s) => (s.nodes.length ? null : 'Nothing on the canvas yet'),
  describe: (a) => `New scenario${a.name ? ` "${a.name}"` : ''}${a.triggerAt ? ` from ${a.triggerAt}` : ''}`,
  run: (a, { state }) => {
    const at = a.triggerAt ? needStepNode(state, a.triggerAt as string).id : undefined;
    const scenario = createScenario(state.nodes, state.scenarios, at);
    if (!scenario) throw new Error('no resource can start a scenario');
    if (a.name) { scenario.name = String(a.name); scenario.id = uniqueScenarioId(scenario.name, state.scenarios); }
    if (a.event) scenario.trigger.event = String(a.event);
    if (a.draft) scenario.steps = suggestPath(scenario.trigger.at, state.nodes, state.edges);
    const s = useStore.getState();
    s.addScenario(scenario);
    s.inspectScenario(scenario.id);
    return { id: scenario.id, steps: scenario.steps.length };
  },
});

define({
  id: 'scenario.remove', title: 'Delete scenario', description: 'Remove a scenario from the project.', group: 'Scenarios', kind: 'project', hidden: true,
  params: { id: { type: 'string', description: 'Scenario id or name', required: true } },
  describe: (a, s) => { try { return `Delete scenario ${needScenario(s, a.id as string).name}`; } catch { return `Delete scenario ${a.id}`; } },
  run: (a, { state }) => useStore.getState().removeScenario(needScenario(state, a.id as string).id),
});

define({
  id: 'scenario.rename', title: 'Rename scenario', description: 'Give a scenario a new name.', group: 'Scenarios', kind: 'project', hidden: true,
  params: { id: { type: 'string', description: 'Scenario id or name', required: true }, name: { type: 'string', description: 'The new name', required: true } },
  describe: (a) => `Rename scenario ${a.id} to "${a.name}"`,
  run: (a, { state }) => useStore.getState().updateScenario(needScenario(state, a.id as string).id, (s) => ({ ...s, name: String(a.name).trim() })),
});

define({
  id: 'scenario.setTrigger', title: 'Set scenario trigger', description: 'Change where a scenario starts and what the event is.', group: 'Scenarios', kind: 'project', hidden: true,
  params: {
    id: { type: 'string', description: 'Scenario id or name', required: true },
    at: { type: 'string', description: 'Node id or label the request starts at' },
    event: { type: 'string', description: 'The event, e.g. "POST /orders"; empty clears it' },
  },
  describe: (a) => `Set the trigger of ${a.id}`,
  run: (a, { state }) => {
    const sc = needScenario(state, a.id as string);
    const at = a.at ? needStepNode(state, a.at as string).id : sc.trigger.at;
    useStore.getState().updateScenario(sc.id, (s) => {
      const event = a.event === undefined ? s.trigger.event : String(a.event) || undefined;
      return { ...s, trigger: { at, ...(event ? { event } : {}) } };
    });
  },
});

define({
  id: 'scenario.setSteps', title: 'Set scenario steps', description: 'Replace a scenario\'s steps. Each step is {at, note?, takes?, detached?, outcome?, retry?}; `at` is a node id or label.', group: 'Scenarios', kind: 'project', hidden: true,
  params: { id: { type: 'string', description: 'Scenario id or name', required: true }, steps: { type: 'object', description: 'An object with a `steps` array', required: true } },
  describe: (a) => `Set the steps of ${a.id}`,
  run: (a, { state }) => {
    const sc = needScenario(state, a.id as string);
    const raw = (a.steps as { steps?: unknown }).steps;
    if (!Array.isArray(raw)) throw new Error('steps must be { steps: [...] }');
    const steps = raw.map((st) => normaliseStep(state, st));
    useStore.getState().updateScenario(sc.id, (s) => ({ ...s, steps }));
    return { steps: steps.length };
  },
});

define({
  id: 'scenario.addStep', title: 'Add scenario step', description: 'Append a step to a scenario (or insert it at `index`).', group: 'Scenarios', kind: 'project', hidden: true,
  params: {
    id: { type: 'string', description: 'Scenario id or name', required: true },
    at: { type: 'string', description: 'Node id or label the request reaches', required: true },
    note: { type: 'string', description: 'What happens there' },
    takes: { type: 'string', description: 'How long it takes, e.g. "120ms" or "2s"' },
    index: { type: 'number', description: 'Insert before this 0-based step; default appends' },
    outcome: { type: 'string', description: 'What the last attempt does: ok, fail or timeout', enum: ['ok', 'fail', 'timeout'] },
    retry: { type: 'number', description: 'Retries before the outcome' },
    detached: { type: 'boolean', description: 'Fire and forget' },
  },
  describe: (a) => `Add step at ${a.at} to ${a.id}`,
  run: (a, { state }) => {
    const sc = needScenario(state, a.id as string);
    const step = normaliseStep(state, a);
    const index = (a.index as number | undefined) ?? sc.steps.length;
    useStore.getState().updateScenario(sc.id, (s) => ({ ...s, steps: [...s.steps.slice(0, index), step, ...s.steps.slice(index)] }));
    return { index };
  },
});

define({
  id: 'scenario.removeStep', title: 'Remove scenario step', description: 'Remove the step at a 0-based index.', group: 'Scenarios', kind: 'project', hidden: true,
  params: { id: { type: 'string', description: 'Scenario id or name', required: true }, index: { type: 'number', description: '0-based step', required: true } },
  describe: (a) => `Remove step ${a.index} from ${a.id}`,
  run: (a, { state }) => {
    const sc = needScenario(state, a.id as string);
    const i = a.index as number;
    if (i < 0 || i >= sc.steps.length) throw new Error(`no step ${i}; the scenario has ${sc.steps.length}`);
    useStore.getState().updateScenario(sc.id, (s) => ({ ...s, steps: s.steps.filter((_, j) => j !== i) }));
  },
});

define({
  id: 'scenario.inspect', title: 'Inspect scenario', description: 'Open a scenario in the inspector.', group: 'Scenarios', kind: 'view',
  params: { id: { type: 'string', description: 'Scenario id or name', required: true } },
  instances: instances('Inspect'),
  describe: (a) => `Inspect scenario ${a.id}`,
  run: (a, { state }) => useStore.getState().inspectScenario(needScenario(state, a.id as string).id),
});

define({
  id: 'scenario.play', title: 'Play scenario', description: 'Play a scenario through the canvas from the start.', group: 'Scenarios', kind: 'view',
  params: { id: { type: 'string', description: 'Scenario id or name', required: true } },
  keywords: ['scenario', 'simulate', 'request'],
  instances: instances('Play'),
  describe: (a) => `Play scenario ${a.id}`,
  run: (a, { state }) => {
    const sc = needScenario(state, a.id as string);
    if (!sc.steps.length) { useStore.getState().inspectScenario(sc.id); throw new Error(`${sc.name} has no steps yet`); }
    useStore.getState().playScenario(sc.id);
  },
});

define({
  id: 'scenario.setPlaying', title: (s) => (s.playhead?.playing ? 'Pause playback' : 'Resume playback'),
  description: 'Pause or resume the scenario on the transport bar. Omit `playing` to toggle.', group: 'Scenarios', kind: 'view',
  params: { playing: { type: 'boolean', description: 'true to play, false to pause' } },
  shortcut: { keys: [' '], label: 'Space' },
  available: (s) => (s.playhead ? null : 'No scenario is playing'),
  run: (a, { state }) => state.setPlaying((a.playing as boolean | undefined) ?? !state.playhead!.playing),
});

define({
  id: 'scenario.stop', title: 'Stop playback', description: 'Stop the scenario and close the transport bar.', group: 'Scenarios', kind: 'view',
  available: (s) => (s.playhead ? null : 'No scenario is playing'),
  run: (_a, { state }) => state.stopPlayback(),
});

define({
  id: 'scenario.seek', title: 'Seek', description: 'Jump the playhead to a step (0-based; -1 is the trigger).', group: 'Scenarios', kind: 'view', hidden: true,
  params: { index: { type: 'number', description: 'The step to jump to', required: true } },
  available: (s) => (s.playhead ? null : 'No scenario is playing'),
  run: (a, { state }) => state.seekPlayback(a.index as number),
});

define({
  id: 'scenario.stepBack', title: 'Previous step', description: 'Move the playhead one step back.', group: 'Scenarios', kind: 'view', hidden: true,
  shortcut: { keys: ['['], label: '[' },
  available: (s) => (s.playhead ? null : 'No scenario is playing'),
  run: (_a, { state }) => state.stepBack(),
});

define({
  id: 'scenario.stepForward', title: 'Next step', description: 'Move the playhead one step forward.', group: 'Scenarios', kind: 'view', hidden: true,
  shortcut: { keys: [']'], label: ']' },
  available: (s) => (s.playhead ? null : 'No scenario is playing'),
  run: (_a, { state }) => state.stepForward(),
});

define({
  id: 'scenario.speed', title: 'Playback speed', description: 'Set the playback speed: 0.5, 1, 2, 4 or 8.', group: 'Scenarios', kind: 'view', hidden: true,
  params: { speed: { type: 'number', description: 'The multiplier', required: true } },
  available: (s) => (s.playhead ? null : 'No scenario is playing'),
  run: (a, { state }) => {
    if (!SPEEDS.includes(a.speed as number)) throw new Error(`speed must be one of ${SPEEDS.join(', ')}`);
    state.setPlaybackSpeed(a.speed as number);
  },
});

define({
  id: 'scenario.record', title: (s) => (s.recording ? 'Stop recording' : 'Record steps'),
  description: 'Record: clicking resources on the canvas appends them as steps of the inspected scenario. Omit `on` to toggle.', group: 'Scenarios', kind: 'project', hidden: true,
  params: { on: { type: 'boolean', description: 'Start (true) or stop (false)' } },
  available: (s) => (s.inspectedScenario ? null : 'Inspect a scenario first'),
  run: (a, { state }) => state.setRecording((a.on as boolean | undefined) ?? !state.recording),
});

// ------------------------------------------------------------ questions

define({
  id: 'scenario.check', title: 'Check a scenario', description: 'Check every hop of a scenario against the wiring: the evidence for each step, and every problem.', group: 'Queries', kind: 'query', hidden: true,
  params: { id: { type: 'string', description: 'Scenario id or name', required: true } },
  run: (a, { state }) => {
    const sc = needScenario(state, a.id as string);
    const check = checkScenario(sc, state.nodes, state.edges, hopIndex(state.nodes, state.edges));
    return { ok: check.ok, problems: check.problems, steps: check.steps.map((st) => ({ at: st.at, evidence: st.evidence ? { from: st.evidence.from, via: st.evidence.edgeId, label: st.evidence.label, actions: st.evidence.actions ?? [] } : null, problems: st.problems, notes: st.notes })) };
  },
});

define({
  id: 'scenario.whatIf', title: 'What if', description: 'What a scenario loses if resources were removed: the steps that lose their evidence and the new problems. With no `id`, every scenario the removal would break.', group: 'Queries', kind: 'query', hidden: true,
  params: { removed: { type: 'string[]', description: 'Node ids or labels to take away', required: true }, id: { type: 'string', description: 'One scenario; omit for all' } },
  run: (a, { state }) => {
    const removed = new Set((a.removed as string[]).map((r) => { const n = findNode(state, r); if (!n) throw new Error(`no resource ${r} on the canvas`); return n.id; }));
    if (a.id) {
      const w = whatIf(needScenario(state, a.id as string), state.nodes, state.edges, removed);
      return { scenario: w.scenario.name, brokenSteps: w.brokenSteps, newProblems: w.newProblems };
    }
    return scenariosBrokenBy(state.scenarios, state.nodes, state.edges, removed).map((w) => ({ scenario: w.scenario.name, brokenSteps: w.brokenSteps, newProblems: w.newProblems }));
  },
});

/** A step from a command's input: the YAML rules, with `at` resolved to a node that can be a step. */
function normaliseStep(state: StoreState, raw: unknown): ScenarioStep {
  const step = stepFromRaw(raw);
  if (!step) throw new Error('each step needs `at`');
  return { ...step, at: needStepNode(state, step.at).id };
}
