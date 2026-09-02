import { Component, ErrorInfo, ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
  info: string;
}

/**
 * Catches render errors so a bad payload shows a message instead of a blank
 * window.
 *
 * React unmounts the entire tree on an uncaught render error. Without this the
 * app goes white with nothing in the UI to say why - which is exactly what a
 * malformed scan result produced.
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, info: '' };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Surfaced in the webview console for `tauri dev` and Inspect Element.
    console.error('Unhandled render error:', error, info.componentStack);
    this.setState({ info: info.componentStack || '' });
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="fixed inset-0 bg-white text-gray-900 overflow-auto p-6">
        <div className="flex items-center gap-2 mb-3">
          <AlertTriangle size={20} className="text-red-600" />
          <h1 className="text-lg font-semibold">Something broke while rendering</h1>
        </div>
        <p className="text-sm text-gray-600 mb-4">
          The view failed rather than the data. Reload the window to carry on.
        </p>
        <pre className="text-xs bg-red-50 border border-red-200 rounded p-3 whitespace-pre-wrap mb-3">
          {this.state.error.message}
        </pre>
        {this.state.info && (
          <details>
            <summary className="text-xs text-gray-500 cursor-pointer">Component stack</summary>
            <pre className="text-[11px] bg-gray-50 border border-gray-200 rounded p-3 mt-1 whitespace-pre-wrap">
              {this.state.info}
            </pre>
          </details>
        )}
        <button
          onClick={() => window.location.reload()}
          className="mt-4 px-3 py-1.5 bg-blue-600 text-white text-sm rounded hover:bg-blue-700"
        >
          Reload
        </button>
      </div>
    );
  }
}
