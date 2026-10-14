// The command layer: one declaration per thing the app can do, and every
// surface derived from it. The toolbar, the palette, the shortcuts, the
// inspector, the assistant and an outside agent over MCP all run the same
// commands through the same dispatcher, so parity is a property of the
// design rather than a hope.
//
// Each command declares, once: what it is called, what it needs, what it
// touches (its kind), why it cannot run right now, and the one line that
// describes a given run. Tool schemas for a model, palette items, the
// shortcut table and the receipts in the Activity drawer are all read off
// that declaration. There is no second list anywhere.
//
// Kinds, split by consequence rather than by convenience (the rule CORA's
// assistant settled on, kept here):
//   view        this operator's screen: selection, lens, panels, playback.
//               Free, immediate, undone by doing the opposite.
//   project     the project: canvas, scenarios, environments. Respects the
//               lock and the Holodeck preview; canvas edits land in the undo
//               history because they go through the store's setters.
//   file        the project's own files beside it: save, the lock itself,
//               finding mutes. Immediate, not undoable, not under the lock.
//   aws-read    reads the account (health, review, drift, detail). Slow and
//               costs API calls, but changes nothing; immediate.
//   aws-change  changes the account or the deployment state (deploy,
//               destroy, take over) or opens something outside the app.
//               Always confirmed, whoever asks.
//   query       answers a question from what the app already holds, exactly.
//               The reason an assistant never has to guess at the graph.

import type { StoreState } from '../store/useStore';

export type CommandKind = 'view' | 'project' | 'file' | 'aws-read' | 'aws-change' | 'query';

/** Where a run came from; receipts carry it, audit reads it. */
export type Source = 'ui' | 'palette' | 'shortcut' | 'assistant' | 'mcp' | 'dev' | 'test';

/** Palette groups, in the order the palette shows them. */
export const GROUPS = ['Actions', 'View', 'Scenarios', 'Canvas', 'Environments', 'Account', 'Settings', 'Queries'] as const;
export type Group = (typeof GROUPS)[number];

export type ParamType = 'string' | 'number' | 'boolean' | 'string[]' | 'object';

export interface Param {
  type: ParamType;
  description: string;
  required?: boolean;
  /** Closed set of values; validated and handed to a model as an enum. */
  enum?: readonly string[];
}

export type Args = Record<string, unknown>;

export interface Shortcut {
  /** KeyboardEvent.key values, lower-cased for letters; the first is the one shown. */
  keys: string[];
  mod?: boolean;
  shift?: boolean;
  /** Shown in the palette and the help sheet, e.g. "⌘D". */
  label: string;
  /**
   * Fires with the caret in a text field. Modifier shortcuts do by default,
   * the way desktop apps behave; bare keys never do; undo and redo opt out.
   */
  inEditable?: boolean;
  /** Fires with a dialog, the palette or settings on top. Default false. */
  overDialogs?: boolean;
  args?: Args;
}

/** One palette row for a command that lists several (a lens, a scenario, a node). */
export interface Instance {
  args: Args;
  title: string;
  subtitle?: string;
  keywords?: string[];
  tone?: 'ok' | 'warn' | 'bad' | 'info' | 'muted';
  /** Stable suffix for the palette item id. */
  key: string;
}

export interface RunContext {
  state: StoreState;
  source: Source;
}

export interface CommandSpec {
  /** Dotted, stable, lower-case: "canvas.addNode". Agents see this name. */
  id: string;
  /** Palette title. May read the state so it can say "Hide inspector" vs "Show inspector". */
  title: string | ((state: StoreState) => string);
  /** What it does and when to use it, for the palette's subtitle and for a model. */
  description: string;
  group: Group;
  kind: CommandKind;
  params?: Record<string, Param>;
  /** One or several key bindings; the first is the one the palette shows. */
  shortcut?: Shortcut | Shortcut[];
  keywords?: string[];
  /** Why it cannot run right now, or null. Project commands are also blocked by the lock. */
  available?: (state: StoreState) => string | null;
  /**
   * The question to ask before running, or null to run without asking.
   * Defaults to a generic question for aws-change commands and to none
   * otherwise. The dispatcher asks, whoever the caller is.
   */
  confirm?: (args: Args, state: StoreState) => string | null;
  /** The one-line receipt for these args: "Added a lambda called orders". */
  describe?: (args: Args, state: StoreState) => string;
  /** Not listed in the palette: queries, and commands only meaningful with arguments a person would not type. */
  hidden?: boolean;
  /** Not offered to a model: the operator's own chrome (the palette, file pickers, the selection). */
  notForModel?: boolean;
  /**
   * The canvas is not re-arranged after this one. For a drag, where the
   * operator is placing something themselves, and for the layout command,
   * which has just done it.
   */
  keepsPlacement?: boolean;
  /** Palette rows, one per instance, when the command is about a particular thing. */
  instances?: (state: StoreState) => Instance[];
  run: (args: Args, ctx: RunContext) => unknown | Promise<unknown>;
}

export interface Receipt {
  /** Monotonic within the session; the stable key for a list. */
  seq: number;
  id: string;
  args: Args;
  source: Source;
  at: number;
  ok: boolean;
  summary: string;
  error?: string;
}

export type CommandResult =
  | { ok: true; summary: string; result: unknown }
  | {
      ok: false;
      summary: string;
      error: string;
      /** The command could not run now (the lock, nothing selected, a run in progress); `error` says why. */
      blocked?: boolean;
      /** The operator said no. */
      declined?: boolean;
      /** No way to ask was given; this is the question. */
      needsConfirmation?: string;
    };
