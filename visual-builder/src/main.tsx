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
  import('./store/useStore').then((m) => { (window as unknown as { __warpcore?: unknown }).__warpcore = { useStore: m.useStore }; });
}
