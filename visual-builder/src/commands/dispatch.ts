// The one door. Every caller, a button or a model, runs a command here:
// the args are checked, the lock and the command's own availability are
// asked, an aws-change command is confirmed, the command runs, and a
// receipt lands in the store whatever happened. The receipt is the audit
// line and, for an assistant, the transcript line, so neither has to be
// written by the command.

import { useStore } from '../store/useStore';
import { isArranged, layoutCanvas } from '../utils/autoLayout';
import { ArgError, blocked, confirmQuestion, get, summaryOf, validate } from './registry';
import type { StoreState } from '../store/useStore';
import type { CommandSpec } from './types';
import type { Args, CommandResult, Receipt, Source } from './types';

/** What a confirmation callback is told, so it can draw the card without re-deriving anything. */
export interface ConfirmInfo { summary: string; command: string; args: Args }

export interface RunOptions {
  source: Source;
  /** The caller already asked; skip the question. */
  confirmed?: boolean;
  /** How to ask. Without one, a command that needs confirming returns `needsConfirmation` instead of running. */
  confirm?: (question: string, info: ConfirmInfo) => Promise<boolean>;
}

const RECEIPTS_KEPT = 200;
let seq = 0;

/**
 * Keep the receipt. A run of the same command on the same thing straight
 * after the last one (a field typed into, a slider dragged) replaces it,
 * so the audit stays readable.
 */
function record(receipt: Omit<Receipt, 'seq'>): void {
  useStore.setState((s) => {
    const last = s.receipts[s.receipts.length - 1];
    const same = last && last.id === receipt.id && last.ok === receipt.ok && last.source === receipt.source
      && (receipt.args as { id?: unknown }).id !== undefined && (last.args as { id?: unknown }).id === (receipt.args as { id?: unknown }).id;
    const kept = same ? s.receipts.slice(0, -1) : s.receipts;
    return { receipts: [...kept, { ...receipt, seq: ++seq }].slice(-RECEIPTS_KEPT) };
  });
}

export async function run(id: string, rawArgs: Args = {}, opts: RunOptions = { source: 'ui' }): Promise<CommandResult> {
  const spec = get(id);
  const at = Date.now();
  if (!spec) {
    const error = `no command ${id}`;
    record({ id, args: rawArgs, source: opts.source, at, ok: false, summary: id, error });
    return { ok: false, summary: id, error };
  }
  let args: Args;
  try {
    args = validate(spec, rawArgs);
  } catch (e) {
    const error = e instanceof ArgError ? e.message : String(e);
    record({ id, args: rawArgs, source: opts.source, at, ok: false, summary: id, error });
    return { ok: false, summary: id, error };
  }
  const state = useStore.getState();
  const summary = summaryOf(spec, args, state);

  const reason = blocked(spec, state);
  if (reason) {
    record({ id, args, source: opts.source, at, ok: false, summary, error: reason });
    return { ok: false, summary, error: reason, blocked: true };
  }

  const question = confirmQuestion(spec, args, state);
  if (question && !opts.confirmed) {
    if (!opts.confirm) {
      return { ok: false, summary, error: 'needs confirmation', needsConfirmation: question };
    }
    if (!(await opts.confirm(question, { summary, command: id, args }))) {
      record({ id, args, source: opts.source, at, ok: false, summary, error: 'declined' });
      return { ok: false, summary, error: 'declined', declined: true };
    }
  }

  const before = useStore.getState();
  try {
    const result = await spec.run(args, { state: before, source: opts.source });
    redrawIfMoved(spec, before);
    record({ id, args, source: opts.source, at, ok: true, summary });
    return { ok: true, summary, result };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    record({ id, args, source: opts.source, at, ok: false, summary, error });
    return { ok: false, summary, error };
  }
}

/**
 * An arranged canvas places what it is given: after any command that
 * changed the nodes or the wiring, the tiles and bands are drawn again, so
 * no command has to remember to do it and none can forget. A canvas with
 * no tiles is a freehand sketch and is left where its author put things.
 */
function redrawIfMoved(spec: CommandSpec, before: StoreState): void {
  if (spec.keepsPlacement) return;
  const s = useStore.getState();
  if (s.nodes === before.nodes && s.edges === before.edges) return;
  if (!isArranged(s.nodes)) return;
  s.setNodes(layoutCanvas(s.nodes, s.edges, { projectName: s.projectName ?? undefined }));
  // assignHandles writes the handles in place; React Flow redraws an edge
  // only when the array it was handed changes.
  useStore.getState().setEdges((edges) => [...edges]);
}

/**
 * For UI handlers: run, confirm through the window when asked, and say so
 * when something actually failed. A command that was merely unavailable
 * is a tooltip's job and stays quiet; a declined confirmation is the
 * operator's own doing.
 */
export function runFromUi(id: string, args: Args = {}, source: Source = 'ui'): Promise<CommandResult> {
  return run(id, args, { source, confirm: (q) => Promise.resolve(window.confirm(q)) }).then((r) => {
    if (!r.ok && !r.blocked && !r.declined) window.alert(r.error);
    return r;
  });
}
