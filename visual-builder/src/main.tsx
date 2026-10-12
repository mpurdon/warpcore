import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import ErrorBoundary from './components/ErrorBoundary';
import './index.css';

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
    import('./utils/holodeckLibrary'), import('./utils/holodeckActions'), import('./commands'),
  ]).then(([store, actions, account, demo, library, holodeck, commands]) => {
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
      holodeck: {
        entries: library.HOLODECK_ENTRIES,
        preview: (id: string) => { const e = library.findEntry(id); return e ? holodeck.previewEntry(e) : `no entry ${id}`; },
        close: holodeck.closePreview,
      },
    };
  });
}
