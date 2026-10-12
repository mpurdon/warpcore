// The assistant, docked beside the inspector: a transcript, the card for
// anything that needs a yes, and a box to type in. Every tool it runs is a
// command, so each lands as its own line here and in the Activity drawer's
// receipts; the model is told not to repeat them.

import { useEffect, useRef, useState } from 'react';
import { Bot, Check, Eraser, Send, Sparkles, X } from 'lucide-react';
import { useStore } from '../store/useStore';
import { answerPending } from '../assistant/confirm';
import { sendMessage } from '../assistant/loop';
import type { ChatItem } from '../assistant/types';

export const ASSISTANT_WIDTH = 360;

const LINE: Record<ChatItem['kind'], string> = {
  user: 'bg-gray-900 text-white rounded-lg px-3 py-2 self-end max-w-[90%] whitespace-pre-wrap',
  assistant: 'text-gray-800 whitespace-pre-wrap max-w-[95%]',
  tool: 'text-xs text-gray-500 font-mono',
  action: 'text-xs text-amber-800',
  error: 'text-xs text-red-700',
  note: 'text-xs text-gray-400',
};

export default function AssistantPanel() {
  const chat = useStore((s) => s.chat);
  const provider = useStore((s) => s.prefs.assistantProvider);
  const model = useStore((s) => s.prefs.assistantModel);
  const openSettings = useStore((s) => s.openSettings);
  const setAssistantOpen = useStore((s) => s.setAssistantOpen);
  const clearChat = useStore((s) => s.clearChat);
  const [draft, setDraft] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { listRef.current?.scrollTo({ top: listRef.current.scrollHeight }); }, [chat.items.length, chat.busy, chat.pending]);
  useEffect(() => { if (!chat.pending && !chat.busy) inputRef.current?.focus(); }, [chat.pending, chat.busy]);

  const canSend = Boolean(draft.trim()) && !chat.busy && !chat.pending;
  const submit = () => {
    if (!canSend) return;
    const text = draft;
    setDraft('');
    void sendMessage(text);
  };

  return (
    <div className="h-full flex flex-col bg-white border-l border-gray-200" style={{ width: ASSISTANT_WIDTH }} data-testid="assistant-panel">
      <div className="h-10 flex items-center gap-2 px-3 border-b border-gray-100">
        <Bot size={15} className="text-gray-500" />
        <span className="text-sm font-medium text-gray-900">Assistant</span>
        <span className="text-[11px] text-gray-400 truncate">
          {provider ? `${provider}${chat.model ? ` · ${chat.model}` : model ? ` · ${model}` : ''}` : 'no model configured'}
          {chat.usage.turns > 0 && ` · ${chat.usage.turns} turn${chat.usage.turns === 1 ? '' : 's'} · ${chat.usage.input + chat.usage.output} tokens`}
        </span>
        <span className="flex-1" />
        <button onClick={clearChat} disabled={chat.busy || Boolean(chat.pending)} className="p-1 rounded text-gray-400 hover:bg-gray-100 disabled:opacity-40" title="Clear the conversation"><Eraser size={14} /></button>
        <button onClick={() => setAssistantOpen(false)} className="p-1 rounded text-gray-400 hover:bg-gray-100" title="Close"><X size={14} /></button>
      </div>

      <div ref={listRef} className="flex-1 overflow-y-auto px-3 py-3 flex flex-col gap-2 text-sm">
        {chat.items.length === 0 && (
          <div className="text-xs text-gray-500 space-y-2">
            <p>Ask about the canvas, or ask for a change. The assistant works through the app's own commands: it reads the graph exactly, edits the project under the same lock as you, and anything that touches AWS or the deployment state waits for your yes on a card here.</p>
            <p>Try: <em>which resources can the API reach?</em> · <em>add a dead-letter queue to the indexer</em> · <em>draft a scenario for a webhook and play it</em> · <em>what would break if the index queue went away?</em></p>
            {!provider && (
              <p className="text-amber-700">No model is configured. <button className="underline" onClick={() => openSettings('exploration')}>Choose one in Settings</button>. Credentials come from the environment the CLI runs in; the app stores none.</p>
            )}
          </div>
        )}
        {chat.items.map((item, i) => (
          <div key={`${item.at}-${i}`} className={LINE[item.kind]} data-kind={item.kind}>
            {item.kind === 'tool' && <span className={item.ok === false ? 'text-red-600' : 'text-emerald-600'}>{item.ok === false ? '✕ ' : '✓ '}</span>}
            {item.kind === 'action' && '✕ '}
            {item.text}
          </div>
        ))}
        {chat.busy && !chat.pending && <div className="text-xs text-gray-400 flex items-center gap-1"><Sparkles size={12} className="animate-pulse" /> thinking…</div>}
        {chat.pending && (
          <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm" data-testid="pending-card">
            <div className="text-[10px] uppercase tracking-wide text-amber-700 mb-1">{chat.pending.source === 'mcp' ? 'An agent over MCP asks' : 'The assistant asks'}</div>
            <div className="font-medium text-gray-900">{chat.pending.summary}</div>
            <div className="text-xs text-gray-700 mt-1 whitespace-pre-wrap">{chat.pending.question}</div>
            {Object.keys(chat.pending.args).length > 0 && (
              <pre className="text-[10px] bg-white/70 rounded p-1.5 mt-2 overflow-x-auto">{JSON.stringify(chat.pending.args, null, 1)}</pre>
            )}
            <div className="flex gap-2 mt-2">
              <button onClick={() => answerPending(true)} className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-gray-900 text-white text-xs hover:bg-gray-800"><Check size={12} /> Run it</button>
              <button onClick={() => answerPending(false)} className="px-2.5 py-1 rounded border border-gray-300 text-xs hover:bg-white">Decline</button>
            </div>
          </div>
        )}
      </div>

      <div className="border-t border-gray-100 p-2">
        <div className="flex items-end gap-1.5">
          <textarea
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } }}
            rows={2}
            disabled={Boolean(chat.pending)}
            placeholder={chat.pending ? 'Answer the card above first…' : chat.busy ? 'Working…' : 'Ask, or ask for a change…'}
            className="flex-1 text-sm border border-gray-200 rounded-md px-2 py-1.5 resize-none focus:outline-none focus:border-blue-400 disabled:bg-gray-50"
          />
          <button onClick={submit} disabled={!canSend} className="p-2 rounded-md bg-gray-900 text-white disabled:opacity-40" title="Send (Enter)"><Send size={14} /></button>
        </div>
      </div>
    </div>
  );
}
