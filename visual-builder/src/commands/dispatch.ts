// The one door. Every caller, a button or a model, runs a command here:
// the args are checked, the lock and the command's own availability are
// asked, an aws-change command is confirmed, the command runs, and a
// receipt lands in the store whatever happened. The receipt is the audit
// line and, for an assistant, the transcript line, so neither has to be
// written by the command.

import { useStore } from '../store/useStore';
import { ArgError, blocked, get, validate } from './registry';
import type { Args, CommandResult, Receipt, Source } from './types';

export interface RunOptions {
  source: Source;
  /** The caller already asked; skip the question. */
  confirmed?: boolean;
  /** How to ask. Without one, a command that needs confirming returns `needsConfirmation` instead of running. */
  confirm?: (question: string) => Promise<boolean>;
}

const RECEIPTS_KEPT = 200;

function record(receipt: Receipt): void {
  useStore.setState((s) => ({ receipts: [...s.receipts, receipt].slice(-RECEIPTS_KEPT) }));
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
  const summary = spec.describe ? spec.describe(args, state) : typeof spec.title === 'function' ? spec.title(state) : spec.title;

  const reason = blocked(spec, state);
  if (reason) {
    record({ id, args, source: opts.source, at, ok: false, summary, error: reason });
    return { ok: false, summary, error: reason, blocked: true };
  }

  const question = spec.confirm ? spec.confirm(args, state) : spec.kind === 'aws-change' ? `${summary}?` : null;
  if (question && !opts.confirmed) {
    if (!opts.confirm) {
      return { ok: false, summary, error: 'needs confirmation', needsConfirmation: question };
    }
    if (!(await opts.confirm(question))) {
      record({ id, args, source: opts.source, at, ok: false, summary, error: 'declined' });
      return { ok: false, summary, error: 'declined', declined: true };
    }
  }

  try {
    const result = await spec.run(args, { state: useStore.getState(), source: opts.source });
    record({ id, args, source: opts.source, at, ok: true, summary });
    return { ok: true, summary, result };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    record({ id, args, source: opts.source, at, ok: false, summary, error });
    return { ok: false, summary, error };
  }
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
