// The command layer: every surface derives from one registry, the
// dispatcher gates and records, and the commands move the real store.

import { beforeEach, describe, expect, it } from 'vitest';
import { useStore, _resetHistoryClock } from '../store/useStore';
import { all, blocked, commandForTool, get, paletteRows, run, shortcuts, toolSpecs } from './index';

const fresh = () => {
  useStore.setState({
    nodes: [], edges: [], scenarios: [], past: [], future: [], receipts: [], configPath: '/tmp/p/warpcore.yaml', locked: false,
    holodeckPreview: false, selectedNode: null, editingNode: null, inspectedScenario: null, playhead: null, recording: false, run: null,
  });
  _resetHistoryClock();
};

const dev = { source: 'test' as const };

describe('registry', () => {
  it('declares every command once, with a description and a kind', () => {
    const ids = all().map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of all()) {
      expect(c.description.length, c.id).toBeGreaterThan(10);
      expect(['view', 'project', 'file', 'aws-read', 'aws-change', 'query']).toContain(c.kind);
    }
    expect(ids).toEqual(expect.arrayContaining(['canvas.addNode', 'canvas.connect', 'account.deploy', 'scenario.new', 'query.path', 'view.lens']));
  });
  it('turns params into tool schemas, and tool names back into commands', () => {
    const tool = toolSpecs().find((t) => t.name === 'canvas_addNode')!;
    expect(tool.input_schema.required).toEqual(['type']);
    expect(tool.input_schema.properties.config).toEqual({ type: 'object', description: expect.any(String) });
    expect(tool.description).toContain('can be undone');
    expect(tool.command).toBe('canvas.addNode');
    expect(toolSpecs({ forModel: true }).some((t) => t.name === 'view_palette')).toBe(false);
    expect(toolSpecs().find((t) => t.name === 'account_deploy')!.description).toContain('confirmation');
    expect(commandForTool('view_lens')?.id).toBe('view.lens');
    const lens = toolSpecs().find((t) => t.name === 'view_lens')!;
    expect((lens.input_schema.properties.lens as { enum: string[] }).enum).toContain('live');
  });
  it('gives every shortcut to one command', () => {
    const keys = shortcuts().flatMap((s) => s.keys.map((k) => `${s.mod ? 'mod+' : ''}${s.shift ? 'shift+' : ''}${k}`));
    expect(new Set(keys).size).toBe(keys.length);
    expect(shortcuts().find((s) => s.command === 'project.undo')?.inEditable).toBe(false);
    expect(shortcuts().filter((s) => s.command === 'view.lens').map((s) => s.args.lens)).toContain('live');
    expect(shortcuts().find((s) => s.command === 'account.deploy')?.label).toBe('⌘D');
  });
  it('lists palette rows from the registry, one per instance, with the block reason as the subtitle', () => {
    fresh();
    useStore.setState({ nodes: [{ id: 'fn', type: 'lambda', position: { x: 0, y: 0 }, data: { label: 'orders' } }] });
    const rows = paletteRows(useStore.getState());
    expect(rows.find((r) => r.id === 'view.select:fn')?.title).toBe('orders');
    expect(rows.filter((r) => r.command === 'view.lens')).toHaveLength(6);
    expect(rows.some((r) => r.command === 'query.path')).toBe(false);
    const undo = rows.find((r) => r.id === 'project.undo')!;
    expect(undo.blockedReason).toBe('Nothing to undo');
    expect(undo.subtitle).toBe('Nothing to undo');
  });
});

describe('dispatch', () => {
  beforeEach(fresh);
  it('validates arguments before anything runs', async () => {
    const r = await run('canvas.addNode', {}, dev);
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain('type is required');
    const bad = await run('view.lens', { lens: 'x-ray' }, dev);
    expect((bad as { error: string }).error).toContain('one of');
    expect(useStore.getState().receipts.map((x) => x.ok)).toEqual([false, false]);
    const seqs = useStore.getState().receipts.map((x) => x.seq);
    expect(seqs[1]).toBeGreaterThan(seqs[0]);
  });
  it('blocks every project command under the lock, in one place', async () => {
    useStore.setState({ locked: true });
    const r = await run('canvas.addNode', { type: 'sqs' }, dev);
    expect(r).toMatchObject({ ok: false, blocked: true, error: expect.stringContaining('locked') });
    expect(useStore.getState().nodes).toHaveLength(0);
    expect(blocked(get('project.unlock')!, useStore.getState())).toBeNull();
    expect((await run('project.unlock', {}, dev)).ok).toBe(true);
    expect((await run('canvas.addNode', { type: 'sqs' }, dev)).ok).toBe(true);
  });
  it('asks before an aws-change command, whoever the caller is', async () => {
    const asked: string[] = [];
    useStore.setState({ nodes: [{ id: 'i', type: 'ec2-instance', position: { x: 0, y: 0 }, data: { label: 'bastion', arn: 'arn:x' } }] });
    const r = await run('account.connect', { id: 'bastion' }, dev);
    expect(r).toMatchObject({ ok: false, needsConfirmation: 'Open a terminal session to bastion?' });
    const declined = await run('account.connect', { id: 'bastion' }, { ...dev, confirm: async (q) => { asked.push(q); return false; } });
    expect(declined).toMatchObject({ ok: false, declined: true });
    expect(asked).toEqual(['Open a terminal session to bastion?']);
    expect(useStore.getState().receipts[useStore.getState().receipts.length - 1]).toMatchObject({ id: 'account.connect', ok: false, error: 'declined', source: 'test' });
  });
  it('records a receipt for every run, with the command\'s own summary, folding a repeated edit of one thing', async () => {
    await run('canvas.addNode', { type: 'dynamodb', label: 'orders', id: 'tbl' }, dev);
    await run('view.lens', { lens: 'security' }, { source: 'palette' });
    await run('canvas.setConfig', { id: 'tbl', config: { name: 'o' } }, dev);
    await run('canvas.setConfig', { id: 'tbl', config: { name: 'or' } }, dev);
    await run('canvas.setConfig', { id: 'tbl', config: { name: 'ord' } }, dev);
    expect(useStore.getState().receipts.map((r) => [r.source, r.ok, r.summary])).toEqual([
      ['test', true, 'Add dynamodb "orders"'], ['palette', true, 'Lens: Security'], ['test', true, 'Configure orders: name'],
    ]);
  });
});

describe('canvas commands', () => {
  beforeEach(fresh);
  it('adds, configures, connects, and removes, through the undo history', async () => {
    const a = await run('canvas.addNode', { type: 'lambda', label: 'orders' }, dev);
    const b = await run('canvas.addNode', { type: 'log-group', label: 'logs' }, dev);
    expect(a.ok && b.ok).toBe(true);
    const fn = (a as { result: { id: string } }).result.id;
    const lg = (b as { result: { id: string } }).result.id;
    expect(fn).toMatch(/^lambda-/);
    expect((await run('canvas.setConfig', { id: 'orders', config: { memory: 512 } }, dev)).ok).toBe(true);
    expect(useStore.getState().nodes.find((n) => n.id === fn)?.data.config).toEqual({ memory: 512 });
    useStore.setState({ projectName: 'shop' });
    const c = await run('canvas.connect', { source: 'orders', target: 'logs' }, dev);
    expect(c.ok).toBe(true);
    const edge = useStore.getState().edges[0];
    expect(edge).toMatchObject({ source: fn, target: lg, type: 'permission' });
    expect(useStore.getState().nodes.find((n) => n.id === lg)?.data.config.logGroupPath).toBe('/shop/lambdas/orders');
    expect((await run('canvas.connect', { source: 'orders', target: 'logs' }, dev))).toMatchObject({ ok: false, error: expect.stringContaining('already connected') });
    expect((await run('canvas.removeNodes', { ids: ['orders'] }, dev)).ok).toBe(true);
    expect(useStore.getState().nodes.map((n) => n.id)).toEqual([lg]);
    expect(useStore.getState().edges).toEqual([]);
    expect(useStore.getState().past.length).toBeGreaterThan(0);
    expect((await run('canvas.addNode', { type: 'warp-drive' }, dev))).toMatchObject({ ok: false, error: expect.stringContaining('unknown resource type') });
  });
});

describe('scenario and query commands', () => {
  beforeEach(fresh);
  it('builds a scenario by commands and answers questions about the graph', async () => {
    await run('canvas.addNode', { type: 'api-gateway', label: 'api', id: 'api' }, dev);
    await run('canvas.addNode', { type: 'lambda', label: 'fn', id: 'fn' }, dev);
    await run('canvas.addNode', { type: 'sqs', label: 'q', id: 'q' }, dev);
    await run('canvas.connect', { source: 'api', target: 'fn' }, dev);
    await run('canvas.connect', { source: 'fn', target: 'q' }, dev);
    const made = await run('scenario.new', { triggerAt: 'api', name: 'Order', event: 'POST /orders' }, dev);
    expect(made.ok).toBe(true);
    expect((await run('scenario.addStep', { id: 'Order', at: 'fn', takes: '120ms' }, dev)).ok).toBe(true);
    expect((await run('scenario.addStep', { id: 'Order', at: 'q' }, dev)).ok).toBe(true);
    const sc = useStore.getState().scenarios[0];
    expect(sc.steps).toEqual([{ at: 'fn', takes: 120 }, { at: 'q' }]);
    expect((await run('scenario.addStep', { id: 'Order', at: 'q', outcome: 'fail', retry: 2 }, dev)).ok).toBe(true);
    expect(useStore.getState().scenarios[0].steps[2]).toEqual({ at: 'q', outcome: 'fail', retry: 2 });
    const check = await run('scenario.check', { id: 'Order' }, dev);
    expect((check as { result: { steps: unknown[] } }).result.steps).toHaveLength(3);
    const path = await run('query.path', { from: 'api', to: 'q' }, dev);
    expect((path as { result: { found: boolean; hops: { source: string; target: string }[] } }).result).toMatchObject({ found: true, hops: [{ source: 'api', target: 'fn' }, { source: 'fn', target: 'q' }] });
    const none = await run('query.path', { from: 'q', to: 'api' }, dev);
    expect((none as { result: { found: boolean } }).result.found).toBe(false);
    const reach = await run('query.reach', { id: 'api' }, dev);
    expect((reach as { result: { id: string; hops: number }[] }).result.map((r) => [r.id, r.hops])).toEqual([['fn', 1], ['q', 2]]);
    const w = await run('scenario.whatIf', { removed: ['fn'] }, dev);
    expect((w as { result: { scenario: string; brokenSteps: number[] }[] }).result).toMatchObject([{ scenario: 'Order', brokenSteps: [0, 1, 2] }]);
    expect((await run('scenario.play', { id: 'Order' }, dev)).ok).toBe(true);
    expect(useStore.getState().playhead?.scenarioId).toBe(sc.id);
    expect((await run('scenario.setPlaying', { playing: false }, dev)).ok).toBe(true);
    expect(useStore.getState().playhead?.playing).toBe(false);
    expect((await run('scenario.removeStep', { id: 'Order', index: 5 }, dev))).toMatchObject({ ok: false, error: expect.stringContaining('no step 5') });
  });
});
