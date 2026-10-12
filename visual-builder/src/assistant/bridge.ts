// The webview's end of the bridge (src-tauri/src/main.rs, `Bridge`): a
// request arrives as a Tauri event, the command runs through the same
// dispatcher as everything else with the source marked `mcp`, and the
// answer goes back through `bridge_respond`. A command that needs the
// operator's yes shows the same card the in-app assistant uses.

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { get, run } from '../commands';
import { confirmOnCard } from './confirm';
import { modelTools, noteResult } from './loop';

interface BridgeRequest {
  id: string;
  kind: 'tools' | 'command';
  command?: string;
  args: Record<string, unknown> | null;
}

async function respond(id: string, payload: unknown): Promise<void> {
  await invoke('bridge_respond', { requestId: id, payload: JSON.stringify(payload) });
}

export async function handleBridgeRequest(req: BridgeRequest): Promise<unknown> {
  if (req.kind === 'tools') return { tools: modelTools() };
  if (req.kind === 'command' && req.command) {
    const r = await run(req.command, req.args ?? {}, { source: 'mcp', confirm: confirmOnCard('mcp') });
    noteResult(get(req.command), r, ' (from MCP)');
    return r;
  }
  return { ok: false, error: `bad bridge request ${req.kind}` };
}

/** Start answering bridge requests. Resolves to the unlistener; null outside Tauri. */
export async function startBridge(): Promise<UnlistenFn | null> {
  if (!('__TAURI_INTERNALS__' in window)) return null;
  return listen<BridgeRequest>('bridge-request', (e) => {
    void handleBridgeRequest(e.payload)
      .catch((err) => ({ ok: false, error: err instanceof Error ? err.message : String(err) }))
      .then((payload) => respond(e.payload.id, payload));
  });
}
