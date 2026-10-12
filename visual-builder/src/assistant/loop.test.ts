// The loop over the registry, with the model faked: tools run as commands,
// a change waits on the card, and the transcript carries the receipts.

import { beforeEach, describe, expect, it } from 'vitest';
import { useStore, _resetHistoryClock } from '../store/useStore';
import { EMPTY_CHAT } from './types';
import type { Message, TurnResult } from './types';
import { _setTurn, drive, modelTools, sendMessage, systemPrompt } from './loop';
import { answerPending, hasPending } from './confirm';
import { handleBridgeRequest } from './bridge';

const fresh = () => {
  useStore.setState({
    nodes: [{ id: 'api', type: 'api-gateway', position: { x: 0, y: 0 }, data: { label: 'api' } }, { id: 'fn', type: 'lambda', position: { x: 0, y: 0 }, data: { label: 'orders', arn: 'arn:fn' } }],
    edges: [{ id: 'e1', source: 'api', target: 'fn', data: {} }], scenarios: [], past: [], future: [], receipts: [], configPath: '/tmp/p/warpcore.yaml', locked: false,
    holodeckPreview: false, chat: EMPTY_CHAT, assistantOpen: false, prefs: { ...useStore.getState().prefs, assistantProvider: 'anthropic', assistantModel: '' },
  });
  _resetHistoryClock();
};

/** A scripted model: each call pops the next turn; tool results are recorded. */
function script(turns: TurnResult[]) {
  const seen: Message[][] = [];
  _setTurn(async (_system, messages) => {
    seen.push(messages);
    const next = turns.shift();
    if (!next) throw new Error('the script ran out');
    return next;
  });
  return seen;
}

describe('the assistant loop', () => {
  beforeEach(fresh);

  it('hands the model the commands as tools, minus the chrome', () => {
    const names = modelTools().map((t) => t.name);
    expect(names).toContain('canvas_addNode');
    expect(names).toContain('query_path');
    expect(names).not.toContain('view_palette');
    expect(systemPrompt()).toContain('1 api-gateway, 1 lambda');
  });

  it('runs a query and an edit as commands and tells the model the results', async () => {
    const seen = script([
      { content: [{ type: 'text', text: 'Looking.' }, { type: 'tool_use', id: 't1', name: 'query_reach', input: { id: 'api' } }], stop_reason: 'tool_use', model: 'm', usage: { input: 10, output: 5 } },
      { content: [{ type: 'tool_use', id: 't2', name: 'canvas_addNode', input: { type: 'sqs', label: 'dlq' } }], stop_reason: 'tool_use', model: 'm', usage: { input: 10, output: 5 } },
      { content: [{ type: 'text', text: 'Added a queue; wire it when you are ready.' }], stop_reason: 'end_turn', model: 'm', usage: { input: 10, output: 5 } },
    ]);
    await sendMessage('what does the api reach, then add a dlq');
    const s = useStore.getState();
    expect(s.nodes.map((n) => n.data.label)).toEqual(['api', 'orders', 'dlq']);
    expect(s.chat.items.map((i) => [i.kind, i.text])).toEqual([
      ['user', 'what does the api reach, then add a dlq'], ['assistant', 'Looking.'], ['tool', 'Add sqs "dlq"'], ['assistant', 'Added a queue; wire it when you are ready.'],
    ]);
    // The second call carried the query's exact answer back.
    const result = seen[1][2].content[0];
    expect(result).toMatchObject({ type: 'tool_result', tool_use_id: 't1', content: [{ id: 'fn', name: 'orders', hops: 1 }] });
    expect(s.chat.usage).toEqual({ input: 30, output: 15, turns: 3 });
    expect(s.receipts.map((r) => [r.source, r.id])).toEqual([['assistant', 'query.reach'], ['assistant', 'canvas.addNode']]);
    expect(s.chat.busy).toBe(false);
  });

  it('waits on the card for a change to AWS, and reports a decline without retrying', async () => {
    script([
      { content: [{ type: 'tool_use', id: 't1', name: 'account_connect', input: { id: 'orders' } }, { type: 'tool_use', id: 't2', name: 'account_deploy', input: {} }], stop_reason: 'tool_use', model: 'm' },
      { content: [{ type: 'text', text: 'Understood.' }], stop_reason: 'end_turn', model: 'm' },
    ]);
    const done = sendMessage('connect to orders and deploy');
    await new Promise((r) => setTimeout(r, 0));
    expect(hasPending()).toBe(true);
    expect(useStore.getState().chat.pending).toMatchObject({ summary: 'Connect to orders', source: 'assistant', command: 'account.connect' });
    expect(useStore.getState().assistantOpen).toBe(true);
    answerPending(false);
    await done;
    const s = useStore.getState();
    expect(s.chat.pending).toBeNull();
    expect(s.chat.items.map((i) => i.text)).toContain('Declined: Connect to orders');
    const results = s.chat.messages[2].content;
    expect(results[0]).toMatchObject({ tool_use_id: 't1', content: 'The operator declined this action.' });
    expect(results[1]).toMatchObject({ tool_use_id: 't2', is_error: true, content: expect.stringContaining('One confirmed action at a time') });
  });

  it('refuses a project edit under the lock and says why', async () => {
    useStore.setState({ locked: true });
    script([
      { content: [{ type: 'tool_use', id: 't1', name: 'canvas_addNode', input: { type: 'sqs' } }], stop_reason: 'tool_use', model: 'm' },
      { content: [{ type: 'text', text: 'It is locked.' }], stop_reason: 'end_turn', model: 'm' },
    ]);
    await sendMessage('add a queue');
    const s = useStore.getState();
    expect(s.nodes).toHaveLength(2);
    expect(s.chat.messages[2].content[0]).toMatchObject({ is_error: true, content: expect.stringContaining('locked') });
  });

  it('says so when no model is configured', async () => {
    useStore.setState({ prefs: { ...useStore.getState().prefs, assistantProvider: '' } });
    await drive();
    expect(useStore.getState().chat.items[0]).toMatchObject({ kind: 'error', text: expect.stringContaining('No assistant model') });
  });
});

describe('the bridge', () => {
  beforeEach(fresh);
  it('answers a tools request and runs a command as mcp', async () => {
    const tools = await handleBridgeRequest({ id: 'r1', kind: 'tools', args: null }) as { tools: { name: string }[] };
    expect(tools.tools.some((t) => t.name === 'query_node')).toBe(true);
    const r = await handleBridgeRequest({ id: 'r2', kind: 'command', command: 'view.select', args: { id: 'orders' } }) as { ok: boolean };
    expect(r.ok).toBe(true);
    expect(useStore.getState().selectedNode).toBe('fn');
    expect(useStore.getState().receipts[0]).toMatchObject({ source: 'mcp', id: 'view.select' });
    expect(useStore.getState().chat.items[0].text).toBe('Select orders (from MCP)');
  });
  it('puts an mcp change on the same card', async () => {
    const p = handleBridgeRequest({ id: 'r3', kind: 'command', command: 'account.connect', args: { id: 'orders' } });
    await new Promise((r) => setTimeout(r, 0));
    expect(useStore.getState().chat.pending).toMatchObject({ source: 'mcp', summary: 'Connect to orders' });
    answerPending(false);
    expect(await p).toMatchObject({ ok: false, declined: true });
  });
});
