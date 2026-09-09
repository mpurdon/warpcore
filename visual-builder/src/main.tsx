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
    import('./utils/holodeckLibrary'), import('./utils/holodeckActions'),
  ]).then(([store, actions, account, demo, library, holodeck]) => {
    (window as unknown as { __warpcore?: unknown }).__warpcore = {
      useStore: store.useStore,
      canvas: actions.canvas,
      buildCanvas: account.buildCanvas,
      demo: demo.loadDemo,
      holodeck: {
        entries: library.HOLODECK_ENTRIES,
        preview: (id: string) => { const e = library.findEntry(id); return e ? holodeck.previewEntry(e) : `no entry ${id}`; },
        close: holodeck.closePreview,
      },
    };
  });
}
