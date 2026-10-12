// The one way anything other than the operator gets a yes: a card in the
// assistant panel, answered by a click. The in-app assistant and an
// outside agent over the bridge both wait here; whoever is first holds
// the card until it is answered, and the next waits its turn.

import type { ConfirmInfo } from '../commands/dispatch';
import { useStore } from '../store/useStore';
import type { PendingAction } from './types';

let resolver: ((approve: boolean) => void) | null = null;
let queue: Promise<unknown> = Promise.resolve();

/** The dispatcher's confirm hook for a caller that asks through the card. */
export function confirmOnCard(source: PendingAction['source']) {
  return (question: string, info: ConfirmInfo) => askOperator({ question, ...info, source });
}

/** Ask the operator. Resolves when they click; false if the card is dismissed. */
export function askOperator(action: PendingAction): Promise<boolean> {
  const ask = () => new Promise<boolean>((resolve) => {
    resolver = (approve) => {
      resolver = null;
      useStore.getState().setChatPending(null);
      resolve(approve);
    };
    useStore.getState().setChatPending(action);
    // An assistant waiting on a card should be seen: open the panel.
    useStore.getState().setAssistantOpen(true);
  });
  const turn = queue.then(ask);
  queue = turn;
  return turn;
}

/** The operator's answer to the card on show. */
export function answerPending(approve: boolean): void {
  resolver?.(approve);
}

/** Whether a card is waiting, for tests. */
export function hasPending(): boolean {
  return resolver !== null;
}
