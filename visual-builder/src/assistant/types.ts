// The assistant's conversation, as the panel shows it and as the model
// sees it. Two records of the same exchange: `ChatItem`s are what the
// operator reads (a line per message, per tool run, per action), and
// `Message`s are the provider-neutral transcript handed back to the model
// each turn (warpcore/assistant/converse.py defines the block shapes).

export type ChatItemKind = 'user' | 'assistant' | 'tool' | 'action' | 'error' | 'note';

export interface ChatItem {
  kind: ChatItemKind;
  text: string;
  at: number;
  /** For tool and action lines: the command id, so the line can name it. */
  command?: string;
  ok?: boolean;
}

export type Block =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: unknown; is_error?: boolean };

export interface Message {
  role: 'user' | 'assistant';
  content: Block[];
}

export interface TurnResult {
  content: Block[];
  stop_reason: 'end_turn' | 'tool_use' | 'max_tokens' | 'other';
  model: string;
  usage?: { input: number; output: number };
  error?: string;
}

/** A confirmation the operator has to answer before a command runs: the card in the panel. */
export interface PendingAction {
  question: string;
  summary: string;
  command: string;
  args: Record<string, unknown>;
  /** Who asked: the in-app assistant or an outside agent over the bridge. */
  source: 'assistant' | 'mcp';
}

export interface ChatState {
  items: ChatItem[];
  messages: Message[];
  busy: boolean;
  pending: PendingAction | null;
  usage: { input: number; output: number; turns: number };
  model: string | null;
}

export const EMPTY_CHAT: ChatState = { items: [], messages: [], busy: false, pending: null, usage: { input: 0, output: 0, turns: 0 }, model: null };
