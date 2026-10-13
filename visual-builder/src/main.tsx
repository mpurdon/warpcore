import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import ErrorBoundary from './components/ErrorBoundary';
import './index.css';
import { getPreferences } from './utils/preferences';
import { applyAppearance } from './utils/theme';

// Before the first paint, so a dark-mode user never sees a light frame.
applyAppearance(getPreferences().appearance);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);

// Dev aid: the store on window, so the canvas can be driven from a browser
// console or an automated check without the Tauri host.
if (import.meta.env.DEV) {
  Promise.all([
    import('./store/useStore'), import('./utils/canvasActions'), import('./utils/projectFromAccount'), import('./utils/demoAccount'),
    import('./utils/holodeckLibrary'), import('./utils/holodeckActions'), import('./commands'), import('./assistant/loop'), import('./assistant/confirm'),
  ]).then(([store, actions, account, demo, library, holodeck, commands, loop, confirm]) => {
    (window as unknown as { __warpcore?: unknown }).__warpcore = {
      useStore: store.useStore,
      canvas: actions.canvas,
      buildCanvas: account.buildCanvas,
      demo: demo.loadDemo,
      // The command layer: what an assistant or an outside agent would call.
      //   __warpcore.commands.list()            every command, with kind and params
      //   __warpcore.commands.run(id, args)     run one as source "dev"; aws-change commands need confirmed: true
      //   __warpcore.commands.tools()           the tool specs a model is handed
      commands: {
        list: () => commands.all().map((c) => ({ id: c.id, kind: c.kind, group: c.group, params: Object.keys(c.params ?? {}), blocked: commands.blocked(c, store.useStore.getState()) })),
        run: (id: string, args: Record<string, unknown> = {}, confirmed = false) => commands.run(id, args, { source: 'dev', confirmed }),
        tools: commands.toolSpecs,
      },
      // The assistant: send a message, answer the card, or swap the model turn for a fake.
      assistant: { send: loop.sendMessage, answer: confirm.answerPending, setTurn: loop._setTurn, tools: loop.modelTools, system: loop.systemPrompt },
      holodeck: {
        entries: library.HOLODECK_ENTRIES,
        preview: (id: string) => { const e = library.findEntry(id); return e ? holodeck.previewEntry(e) : `no entry ${id}`; },
        close: holodeck.closePreview,
      },
    };
  });
}
