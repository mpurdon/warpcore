// The agent loop, in the app, over the command registry. The model is
// asked what to do next (one turn through the CLI, any provider); every
// tool it calls is a command run through the dispatcher, with the same
// lock, the same confirmation card and the same receipt as a click. The
// model is told what the receipts already say so it does not repeat it.
//
// One aws-change command at a time: a second one in the same turn is
// answered with "ask again after the pending one resolves", so the
// operator never faces two cards.

import { invoke } from '@tauri-apps/api/core';
import { confirmQuestion, get, run, toolSpecs, type CommandResult, type CommandSpec } from '../commands';
import { countByType } from '../commands/query';
import { selectCurrentEnvName, useStore } from '../store/useStore';
import { assistantConfig } from '../utils/assistant';
import { confirmOnCard } from './confirm';
import type { Block, ChatItemKind, Message, TurnResult } from './types';

export const MAX_TURNS = 12;

/** The commands a model is offered: every one not marked as the operator's own chrome. */
export function modelTools() {
  return toolSpecs({ forModel: true });
}

export function systemPrompt(): string {
  const s = useStore.getState();
  const envName = selectCurrentEnvName(s);
  const counts = countByType(s.nodes);
  return [
    "You are the assistant inside warpcore's Visual Builder, a desktop app that explores and deploys AWS infrastructure drawn as a canvas of resources and the connections between them.",
    'Everything you can do, you do through the tools, which are the app\'s own commands: the same ones the operator\'s buttons run. Tool names are group_action.',
    'Read before you act: query_project, query_nodes, query_node, query_edges, query_path and query_reach answer exactly from the canvas; never guess at the graph when a query would tell you.',
    'Resource arguments take a node id or a label that is unique on the canvas. Scenario arguments take a scenario id or name.',
    'Commands of kind aws-change (deploy, destroy, take over, connect, opening anything outside the app) pause for the operator to confirm a card in the app; call one at a time and wait for its result. A declined card is their decision: do not retry it or argue.',
    'A project command is refused while the project is locked; say so and offer project_unlock rather than working around it.',
    'Every command you run prints its own receipt line in the transcript, so do not recap what you did; write only what the receipts cannot say: what you found, what you recommend, what you need from the operator.',
    'Be brief and concrete. Refer to resources by their names on the canvas.',
    '',
    `Project: ${s.projectName ?? 'unsaved'}${s.configPath ? ` at ${s.configPath}` : ''}. Environment: ${envName} (${s.currentEnvironment}). ${s.locked ? 'The project is locked.' : 'The project is unlocked.'}`,
    `Canvas: ${Object.entries(counts).map(([t, n]) => `${n} ${t}`).join(', ') || 'empty'}; ${s.edges.length} connections; ${s.scenarios.length} scenarios${s.selectedNode ? `; selected: ${s.selectedNode}` : ''}.`,
  ].join('\n');
}

const NO_MODEL = 'No assistant model is configured. Choose a provider in Settings › Exploration › Assistant.';

/** One model turn, through the host's long-lived worker. Replaceable for tests. */
export let turn: (system: string, messages: Message[]) => Promise<TurnResult> = async (system, messages) => {
  const p = assistantConfig();
  if (!p) throw new Error(NO_MODEL);
  const raw = await invoke<string>('assistant_turn', {
    provider: p.provider, model: p.model || null,
    input: JSON.stringify({ system, messages, tools: modelTools(), max_tokens: 4096 }),
  });
  const parsed = JSON.parse(raw) as TurnResult;
  if (parsed.error) throw new Error(parsed.error);
  return parsed;
};

export function _setTurn(fn: typeof turn): void {
  turn = fn;
}

function push(kind: ChatItemKind, text: string, extra: Record<string, unknown> = {}): void {
  useStore.getState().pushChatItem({ kind, text, at: Date.now(), ...extra });
}

/**
 * A command's outcome as a transcript line, for any caller that is not the
 * operator. Queries are silent (their answer is for the model); everything
 * else prints its receipt, a decline, or the failure.
 */
export function noteResult(spec: CommandSpec | undefined, r: CommandResult, suffix = ''): void {
  if (r.ok) {
    if (spec?.kind !== 'query') push('tool', `${r.summary}${suffix}`, { command: spec?.id, ok: true });
  } else if (r.declined) {
    push('action', `Declined: ${r.summary}${suffix}`, { command: spec?.id, ok: false });
  } else {
    push('tool', `${r.summary}${suffix}: ${r.error}`, { command: spec?.id, ok: false });
  }
}

/** The operator's message: appended, then the loop runs until the model stops or a card is waiting. */
export async function sendMessage(text: string): Promise<void> {
  const s = useStore.getState();
  if (!text.trim() || s.chat.busy || s.chat.pending) return;
  s.pushChatItem({ kind: 'user', text, at: Date.now() });
  s.setChatMessages([...s.chat.messages, { role: 'user', content: [{ type: 'text', text }] }]);
  await drive();
}

export async function drive(): Promise<void> {
  const store = useStore.getState();
  if (!assistantConfig()) { push('error', NO_MODEL); return; }
  store.setChatBusy(true);
  try {
    for (let i = 0; i < MAX_TURNS; i++) {
      const messages = useStore.getState().chat.messages;
      const result = await turn(systemPrompt(), messages);
      useStore.getState().addChatUsage(result.usage ?? { input: 0, output: 0 }, result.model);
      useStore.getState().setChatMessages([...messages, { role: 'assistant', content: result.content }]);
      const uses = result.content.filter((b): b is Extract<Block, { type: 'tool_use' }> => b.type === 'tool_use');
      for (const b of result.content) if (b.type === 'text' && b.text.trim()) push('assistant', b.text);
      if (uses.length === 0) {
        if (result.stop_reason === 'max_tokens') {
          useStore.getState().setChatMessages([...useStore.getState().chat.messages, { role: 'user', content: [{ type: 'text', text: 'Your reply was cut off by the output limit. Continue.' }] }]);
          continue;
        }
        return;
      }
      const results = await runTools(uses);
      useStore.getState().setChatMessages([...useStore.getState().chat.messages, { role: 'user', content: results }]);
    }
    push('error', `Stopped after ${MAX_TURNS} tool turns; ask again to continue.`);
  } catch (e) {
    push('error', e instanceof Error ? e.message : String(e));
  } finally {
    useStore.getState().setChatBusy(false);
  }
}

/** Run the model's tool calls: reads and edits at once, one confirmed change at a time. */
async function runTools(uses: Extract<Block, { type: 'tool_use' }>[]): Promise<Block[]> {
  const out: Block[] = [];
  let confirmedOne = false;
  for (const use of uses) {
    const spec = get(use.name.replace('_', '.'));
    if (!spec) { out.push({ type: 'tool_result', tool_use_id: use.id, content: `no such tool ${use.name}`, is_error: true }); continue; }
    const needsCard = confirmQuestion(spec, use.input, useStore.getState()) !== null;
    if (needsCard && confirmedOne) {
      out.push({ type: 'tool_result', tool_use_id: use.id, content: 'One confirmed action at a time; ask again after the pending one resolves.', is_error: true });
      continue;
    }
    if (needsCard) confirmedOne = true;
    const r = await run(spec.id, use.input, { source: 'assistant', confirm: confirmOnCard('assistant') });
    noteResult(spec, r);
    if (r.ok) out.push({ type: 'tool_result', tool_use_id: use.id, content: r.result === undefined ? { ok: true } : r.result });
    else out.push({ type: 'tool_result', tool_use_id: use.id, content: r.declined ? 'The operator declined this action.' : r.error, is_error: !r.declined });
  }
  return out;
}
