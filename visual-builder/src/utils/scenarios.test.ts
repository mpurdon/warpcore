import { describe, expect, it } from 'vitest';
import type { Edge, Node } from 'reactflow';
import {
  advance, checkScenario, formatTakes, hopsFrom, logLinesUpTo, modelledTimeMs, parseTakes, phaseDurationMs,
  playbackMarks, Scenario, scenariosFromYaml, scenariosToYaml, seekTo, suggestPath, syntheticLogLines, uniqueScenarioId,
  Playhead, DWELL_MIN_MS, TRAVEL_MS,
} from './scenarios';

const node = (id: string, type: string, extra: Record<string, unknown> = {}): Node => ({ id, type, position: { x: 0, y: 0 }, data: { label: id, ...extra } });
const discovered = (id: string, source: string, target: string, kind: string, detail: string): Edge => ({
  id, source, target, type: 'permission', data: { meta: { layer: 'triggers', discovered: { kind, detail } } },
});
const access = (id: string, source: string, target: string, level: string, actions: string[]): Edge => ({
  id, source, target, type: 'permission', data: { meta: { layer: 'access', discovered: { kind: 'access', detail: level }, access: { level, via: 'exec-role', actions } } },
});

// The webhook story: API → authorizer → key; API → function → table, topic; function → logs.
function webhook(): { nodes: Node[]; edges: Edge[] } {
  const nodes = [
    node('api', 'api-gateway'), node('authorizer', 'lambda'), node('key', 'kms-key'), node('fn', 'lambda'),
    node('sessions', 'dynamodb'), node('events', 'sns'), node('logs-fn', 'log-group'), node('logs-auth', 'log-group'), node('role', 'iam-role', {}),
  ];
  const edges = [
    discovered('e1', 'api', 'fn', 'invokes', 'POST /webhook'),
    discovered('e0', 'api', 'authorizer', 'invokes', 'authorizer'),
    access('e2', 'authorizer', 'key', 'read', ['kms:Decrypt']),
    access('e3', 'fn', 'sessions', 'read/write', ['dynamodb:PutItem', 'dynamodb:GetItem']),
    access('e4', 'fn', 'events', 'write', ['sns:Publish']),
    discovered('e5', 'fn', 'logs-fn', 'logs', 'function log group'),
    discovered('e6', 'fn', 'role', 'role', 'execution role'),
    discovered('e7', 'authorizer', 'logs-auth', 'logs', 'function log group'),
  ];
  return { nodes, edges };
}

const scenario = (): Scenario => ({
  id: 'webhook-received',
  name: 'Webhook received',
  trigger: { at: 'api', event: 'POST /webhook' },
  steps: [
    { at: 'authorizer', takes: 40 },
    { at: 'key' },
    { at: 'fn', takes: 180 },
    { at: 'sessions', note: 'writes the session row' },
    { at: 'events', detached: true },
  ],
});

describe('takes', () => {
  it('parses units and formats back', () => {
    expect(parseTakes('40ms')).toBe(40);
    expect(parseTakes('1.5s')).toBe(1500);
    expect(parseTakes(25)).toBe(25);
    expect(parseTakes('soon')).toBeUndefined();
    expect(formatTakes(40)).toBe('40ms');
    expect(formatTakes(1500)).toBe('1.5s');
    expect(formatTakes(2000)).toBe('2s');
  });
});

describe('yaml round trip', () => {
  it('keeps what was written and gives every scenario a unique id', () => {
    const yaml = scenariosToYaml([scenario(), { ...scenario(), id: 'x' }]);
    expect(yaml[0]).toEqual({
      name: 'Webhook received',
      trigger: { at: 'api', event: 'POST /webhook' },
      steps: [
        { at: 'authorizer', takes: '40ms' }, { at: 'key' }, { at: 'fn', takes: '180ms' },
        { at: 'sessions', note: 'writes the session row' }, { at: 'events', detached: true },
      ],
    });
    const back = scenariosFromYaml(yaml);
    expect(back.map((s) => s.id)).toEqual(['webhook-received', 'webhook-received-2']);
    expect(back[0].steps).toEqual(scenario().steps);
  });

  it('skips junk and tolerates missing steps', () => {
    expect(scenariosFromYaml([{ name: 'no trigger' }, null, { name: 'ok', trigger: { at: 'api' } }])).toEqual([
      { id: 'ok', name: 'ok', trigger: { at: 'api' }, steps: [] },
    ]);
    expect(scenariosFromYaml(undefined)).toEqual([]);
  });

  it('numbers duplicate names', () => {
    expect(uniqueScenarioId('Webhook received', [scenario()])).toBe('webhook-received-2');
  });
});

describe('hops and suggested paths', () => {
  it('offers triggers, access and references but never roles or log groups', () => {
    const { nodes, edges } = webhook();
    expect(hopsFrom('fn', nodes, edges).map((h) => h.to)).toEqual(['events', 'sessions']);
    expect(hopsFrom('api', nodes, edges).map((h) => h.to)).toEqual(['authorizer', 'fn']);
    expect(hopsFrom('sessions', nodes, edges)).toEqual([]);
  });

  it('drafts the webhook story in request order', () => {
    const { nodes, edges } = webhook();
    expect(suggestPath('api', nodes, edges).map((s) => s.at)).toEqual(['authorizer', 'key', 'fn', 'events', 'sessions']);
  });

  it('never loops and respects the cap', () => {
    const nodes = [node('a', 'lambda'), node('b', 'lambda'), node('c', 'lambda')];
    const edges = [access('ab', 'a', 'b', 'write', []), access('bc', 'b', 'c', 'write', []), access('ca', 'c', 'a', 'write', [])];
    expect(suggestPath('a', nodes, edges).map((s) => s.at)).toEqual(['b', 'c']);
    expect(suggestPath('a', nodes, edges, 1).map((s) => s.at)).toEqual(['b']);
  });
});

describe('checkScenario', () => {
  it('finds the evidence for each hop from the nearest earlier step', () => {
    const { nodes, edges } = webhook();
    const check = checkScenario(scenario(), nodes, edges);
    expect(check.ok).toBe(true);
    expect(check.steps[0].evidence).toMatchObject({ from: 'api', label: 'authorizer', reverse: false });
    expect(check.steps[1].evidence).toMatchObject({ from: 'authorizer', actions: ['kms:Decrypt'] });
    // The function is reached from the API, two steps back, not from the key.
    expect(check.steps[2].evidence).toMatchObject({ from: 'api', label: 'POST /webhook' });
    expect(check.steps[2].logGroups).toEqual(['logs-fn']);
    expect(check.steps[2].logEdges).toEqual(['e5']);
    expect(check.steps[4].evidence).toMatchObject({ from: 'fn', label: 'write via exec-role' });
  });

  it('flags a hop with nothing behind it and a compute step with no logs', () => {
    const { nodes, edges } = webhook();
    const s = scenario();
    s.steps = [{ at: 'authorizer' }, { at: 'sessions' }, { at: 'missing' }];
    const check = checkScenario(s, nodes, edges.filter((e) => e.id !== 'e5' && e.id !== 'e7'));
    expect(check.ok).toBe(false);
    expect(check.steps[0].problems).toEqual(['authorizer has no log group wired']);
    expect(check.steps[1].problems).toEqual(['No permission or trigger found from authorizer to sessions']);
    expect(check.steps[2].problems).toEqual(['missing is not on the canvas']);
  });
});

describe('playhead', () => {
  const start = (): Playhead => ({ scenarioId: 'webhook-received', index: 0, phase: 'travel', attempt: 0, playing: true, speed: 1 });

  it('alternates travel and dwell and stops at the end', () => {
    const s = scenario();
    let h = start();
    const seen: string[] = [];
    for (let i = 0; i < 20 && h.phase !== 'end'; i++) {
      seen.push(`${h.index}:${h.phase}`);
      h = advance(s, h);
    }
    expect(seen).toEqual(['0:travel', '0:dwell', '1:travel', '1:dwell', '2:travel', '2:dwell', '3:travel', '3:dwell', '4:travel', '4:dwell']);
    expect(h.playing).toBe(false);
    expect(advance(s, h)).toBe(h);
  });

  it('times the phases from the speed and clamps short steps so they can be seen', () => {
    const s = scenario();
    expect(phaseDurationMs(s, { index: 0, phase: 'travel', speed: 2 })).toBe(TRAVEL_MS / 2);
    expect(phaseDurationMs(s, { index: 0, phase: 'dwell', speed: 1 })).toBe(DWELL_MIN_MS);
    expect(phaseDurationMs(s, { index: 2, phase: 'end', speed: 1 })).toBe(0);
  });

  it('seeks to a step and reports modelled time from the takes', () => {
    const s = scenario();
    expect(seekTo(s, start(), 99)).toMatchObject({ index: 4, phase: 'dwell' });
    expect(seekTo(s, start(), -5)).toMatchObject({ index: -1, phase: 'dwell' });
    expect(modelledTimeMs(s, { index: 2, phase: 'dwell' })).toBe(40 + 100 + 180);
    expect(modelledTimeMs(s, { index: 2, phase: 'travel' })).toBe(140);
    // The detached step does not count towards the request's time.
    expect(modelledTimeMs(s, { index: 4, phase: 'end' })).toBe(40 + 100 + 180 + 100);
  });

  it('marks nodes and the pulse edge, and lights the log group while a function runs', () => {
    const { nodes, edges } = webhook();
    const s = scenario();
    const check = checkScenario(s, nodes, edges);
    const travelling = playbackMarks(s, { ...start(), index: 2, phase: 'travel' }, check);
    expect(travelling.pulse).toEqual({ edgeId: 'e1', reverse: false, attempt: 0 });
    expect(travelling.state.get('api')).toBe('visited');
    expect(travelling.state.get('fn')).toBe('travelling');
    expect(travelling.state.get('sessions')).toBe('pending');
    expect(travelling.numbers.get('fn')).toEqual([3]);
    expect(travelling.numbers.get('api')).toEqual([0]);

    const dwelling = playbackMarks(s, { ...start(), index: 2, phase: 'dwell' }, check);
    expect(dwelling.state.get('fn')).toBe('active');
    expect(dwelling.logging.has('logs-fn')).toBe(true);
    expect(dwelling.logEdges.has('e5')).toBe(true);
    expect(dwelling.pulse).toBeNull();

    const idle = playbackMarks(s, null, check);
    expect(idle.state.size).toBe(0);
    expect(idle.numbers.get('events')).toEqual([5]);
  });
});

describe('synthetic logs', () => {
  it('is deterministic and shaped like a Lambda log', () => {
    const { nodes, edges } = webhook();
    const s = scenario();
    const a = syntheticLogLines(s, 2, nodes, edges);
    const b = syntheticLogLines(s, 2, nodes, edges);
    expect(a).toEqual(b);
    expect(a[0].level).toBe('START');
    expect(a[a.length - 1].level).toBe('REPORT');
    // It mentions the resources the function goes on to touch, and nothing after the next compute step.
    expect(a.some((l) => l.text.includes('sessions'))).toBe(true);
    expect(a.some((l) => l.text.includes('events'))).toBe(true);
    expect(a[0].t).toBe(140);
  });

  it('only mentions what the function calls itself, not what its topic fans out to', () => {
    const { nodes, edges } = webhook();
    const s = scenario();
    nodes.push(node('queue', 'sqs'));
    edges.push(discovered('e8', 'events', 'queue', 'event-target', 'sqs subscription'));
    s.steps.push({ at: 'queue' });
    const lines = syntheticLogLines(s, 2, nodes, edges);
    expect(lines.some((l) => l.text.includes('queue'))).toBe(false);
  });

  it('accumulates one block per compute step reached so far', () => {
    const { nodes, edges } = webhook();
    const s = scenario();
    expect(logLinesUpTo(s, { scenarioId: s.id, index: 0, phase: 'travel', attempt: 0, playing: false, speed: 1 }, nodes, edges)).toEqual([]);
    expect(logLinesUpTo(s, { scenarioId: s.id, index: 3, phase: 'dwell', attempt: 0, playing: false, speed: 1 }, nodes, edges).map((b) => b.at)).toEqual(['authorizer', 'fn']);
  });
});

// ---------------------------------------------------------- unhappy paths

describe('failure paths', () => {
  // A queue feeding a function that gives up, and the queue's dead-letter queue.
  function orders(): { nodes: Node[]; edges: Edge[] } {
    const nodes = [node('queue', 'sqs'), node('fn', 'lambda'), node('dlq', 'sqs'), node('table', 'dynamodb'), node('logs', 'log-group')];
    const edges = [
      discovered('e1', 'queue', 'fn', 'event-source', 'event source mapping'),
      access('e2', 'fn', 'table', 'write', ['dynamodb:PutItem']),
      discovered('e3', 'fn', 'logs', 'logs', 'function log group'),
      { id: 'e4', source: 'queue', target: 'dlq', type: 'permission', data: { isDLQ: true, meta: { layer: 'triggers', discovered: { kind: 'dlq', detail: 'dead-letter queue' } } } } as Edge,
    ];
    return { nodes, edges };
  }
  const giveUp = (): Scenario => ({
    id: 'gives-up', name: 'Gives up', trigger: { at: 'queue' },
    steps: [{ at: 'fn', takes: 100, outcome: 'timeout', retry: 2 }, { at: 'dlq' }],
  });
  const recovers = (): Scenario => ({
    id: 'recovers', name: 'Recovers', trigger: { at: 'queue' },
    steps: [{ at: 'fn', takes: 100, retry: 1 }, { at: 'table' }],
  });
  const lost = (): Scenario => ({
    id: 'lost', name: 'Lost', trigger: { at: 'queue' },
    steps: [{ at: 'fn', outcome: 'fail' }],
  });

  it('round-trips outcome and retry through YAML', () => {
    const yaml = scenariosToYaml([giveUp()]);
    expect(yaml[0].steps![0]).toEqual({ at: 'fn', takes: '100ms', outcome: 'timeout', retry: 2 });
    expect(yaml[0].steps![1]).toEqual({ at: 'dlq' });
    const back = scenariosFromYaml(yaml);
    expect(back[0].steps[0].outcome).toBe('timeout');
    expect(back[0].steps[0].retry).toBe(2);
    expect(back[0].steps[1].outcome).toBeUndefined();
  });

  it('replays the hop once per retry before moving on', () => {
    const s = giveUp();
    let head: Playhead = { scenarioId: s.id, index: 0, phase: 'travel', attempt: 0, playing: true, speed: 1 };
    const phases: string[] = [];
    for (let i = 0; i < 8; i++) { head = advance(s, head); phases.push(`${head.index}:${head.phase}:${head.attempt}`); }
    expect(phases).toEqual(['0:dwell:0', '0:travel:1', '0:dwell:1', '0:travel:2', '0:dwell:2', '1:travel:0', '1:dwell:0', '1:end:0']);
    // Seeking resets the attempt.
    expect(seekTo(s, head, 0).attempt).toBe(0);
  });

  it('marks a failing attempt, then the failed step, and a recovered step as visited', () => {
    const { nodes, edges } = orders();
    const s = giveUp();
    const check = checkScenario(s, nodes, edges);
    expect(check.problems).toEqual([]);
    expect(check.notes).toEqual([]);
    const during = playbackMarks(s, { scenarioId: s.id, index: 0, phase: 'dwell', attempt: 0, playing: true, speed: 1 }, check);
    expect(during.state.get('fn')).toBe('failing');
    const after = playbackMarks(s, { scenarioId: s.id, index: 1, phase: 'dwell', attempt: 0, playing: true, speed: 1 }, check);
    expect(after.state.get('fn')).toBe('failed');
    expect(after.state.get('dlq')).toBe('active');
    // The dead-letter hop is the evidence for the last step.
    expect(check.steps[1].evidence?.edgeId).toBe('e4');

    const r = recovers();
    const rc = checkScenario(r, nodes, edges);
    const mid = playbackMarks(r, { scenarioId: r.id, index: 0, phase: 'dwell', attempt: 0, playing: true, speed: 1 }, rc);
    expect(mid.state.get('fn')).toBe('failing');
    const last = playbackMarks(r, { scenarioId: r.id, index: 0, phase: 'dwell', attempt: 1, playing: true, speed: 1 }, rc);
    expect(last.state.get('fn')).toBe('active');
    const done = playbackMarks(r, { scenarioId: r.id, index: 1, phase: 'dwell', attempt: 0, playing: true, speed: 1 }, rc);
    expect(done.state.get('fn')).toBe('visited');
  });

  it('notes a failure nothing catches, without calling it a problem', () => {
    const { nodes, edges } = orders();
    const check = checkScenario(lost(), nodes, edges);
    expect(check.ok).toBe(true);
    expect(check.notes).toHaveLength(1);
    expect(check.notes[0]).toMatch(/nothing retries it and no dead-letter queue/);
  });

  it('counts every attempt in the modelled time', () => {
    const s = giveUp();
    expect(modelledTimeMs(s, { index: 0, phase: 'dwell', attempt: 0 })).toBe(100);
    expect(modelledTimeMs(s, { index: 0, phase: 'dwell', attempt: 2 })).toBe(300);
    expect(modelledTimeMs(s, { index: 1, phase: 'dwell', attempt: 0 })).toBe(400);
  });

  it('logs an ERROR per failed attempt and only the attempts made so far', () => {
    const { nodes, edges } = orders();
    const s = giveUp();
    const all = syntheticLogLines(s, 0, nodes, edges);
    expect(all.filter((l) => l.level === 'START')).toHaveLength(3);
    expect(all.filter((l) => l.level === 'ERROR')).toHaveLength(3);
    expect(all.find((l) => l.level === 'ERROR')?.text).toMatch(/timed out/);
    const soFar = logLinesUpTo(s, { scenarioId: s.id, index: 0, phase: 'dwell', attempt: 1, playing: true, speed: 1 }, nodes, edges);
    expect(soFar[0].lines.filter((l) => l.level === 'START')).toHaveLength(2);
    // A recovered step fails once, then gets through.
    const r = recovers();
    const rl = syntheticLogLines(r, 0, nodes, edges);
    expect(rl.filter((l) => l.level === 'ERROR')).toHaveLength(1);
  });
});
