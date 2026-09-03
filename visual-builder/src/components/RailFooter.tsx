// Pinned to the bottom of the left rail: ambient status and the one global
// entry point, Settings. Everything else in the app is reached by selecting
// an object; this is the exception, because application settings are not a
// property of anything in the system.

import { Settings } from 'lucide-react';
import { useStore } from '../store/useStore';
import { useAppPaths } from '../utils/useAppPaths';
import DevBuildBadge from './DevBuildBadge';
import { StatusDot } from './inspector/InspectorHeader';

export default function RailFooter() {
  const { settingsOpen, openSettings, closeSettings, debugMode } = useStore();
  const { paths, loading } = useAppPaths();

  const cli = loading
    ? <StatusDot tone="muted" label="checking CLI" pulse />
    : paths?.cli_version
      ? <StatusDot tone="ok" label="CLI ready" />
      : <StatusDot tone="bad" label="CLI unavailable" />;

  return (
    <div className="border-t border-gray-200 bg-gray-50 flex-shrink-0">
      <button
        onClick={() => openSettings('about')}
        className="w-full flex items-center justify-between px-4 py-1.5 text-left hover:bg-gray-100"
        title={paths?.cli_version || paths?.cli_error || 'Checking the bundled CLI'}
      >
        {cli}
        <DevBuildBadge paths={paths} />
        {debugMode && (
          <span
            className="text-[10px] uppercase tracking-wide font-semibold text-amber-700 bg-amber-100 border border-amber-200 rounded px-1"
            title="Developer mode is on: the CLI runs with --dev"
          >
            dev
          </span>
        )}
      </button>
      <button
        onClick={() => (settingsOpen ? closeSettings() : openSettings())}
        className={`w-full flex items-center gap-2 px-4 py-2.5 text-sm font-medium transition-colors border-l-2 ${
          settingsOpen
            ? 'bg-white text-blue-700 border-blue-600'
            : 'text-gray-700 hover:bg-gray-100 border-transparent'
        }`}
        title="Application settings (⌘,)"
      >
        <Settings size={16} className={settingsOpen ? 'text-blue-600' : 'text-gray-500'} />
        Settings
      </button>
    </div>
  );
}
