// The Live tab of a discovered resource: what AWS says about it right now.
// Opening the tab is the request, so it reads on open and caches per
// window; the header row re-reads or changes the window. Health now sits
// beside the health the import recorded, so drift shows without a re-import.

import { useState } from 'react';
import { RefreshCw, Settings } from 'lucide-react';
import { Node } from 'reactflow';
import { useStore } from '../../store/useStore';
import { projectProfile } from '../../utils/accountExplorer';
import { LiveDetailTabs, useResourceDetail } from '../live/LiveDetail';
import { StatusDot } from './InspectorHeader';

export default function LiveTab({ node }: { node: Node }) {
  const { environmentExtras, currentEnvironment, nodes, selectNode, openSettings } = useStore();
  const profile = projectProfile(environmentExtras, currentEnvironment);
  const arn = node.data?.arn as string | undefined;
  const [hours, setHours] = useState(24);
  const state = useResourceDetail(profile, arn ?? null, hours, Boolean(profile && arn));

  if (!arn) return null;

  // A related resource that is on the canvas is one click away.
  const navigate = (target: string) => {
    const hit = nodes.find((n) => n.data?.arn === target);
    if (hit) selectNode(hit.id);
  };

  const importedHealth = node.data?.meta?.health as { level: string; reason: string } | undefined;
  const live = state.detail?.health;
  const tone = (level?: string) => (level === 'ok' ? 'ok' : level === 'warn' ? 'warn' : 'muted');

  if (!profile) {
    return (
      <div className="p-4 text-xs text-gray-600">
        No AWS profile is recorded for this environment.{' '}
        <button className="inline-flex items-center gap-1 text-blue-700 hover:underline" onClick={() => openSettings('exploration')}>
          <Settings size={11} /> Choose a default profile
        </button>
        {' '}or re-import the account.
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto min-h-0 px-4 pb-4">
      <div className="flex items-center justify-between py-2 text-xs">
        <div className="min-w-0">
          {live ? (
            <div className="flex items-center gap-1.5">
              <StatusDot tone={tone(live.level)} label={live.level} />
              <span className="text-gray-800 truncate">{live.reason}</span>
              {importedHealth && importedHealth.level !== live.level && (
                <span className="text-gray-400 truncate">· at import: {importedHealth.reason}</span>
              )}
            </div>
          ) : (
            <span className="text-gray-400">{state.loading ? 'Reading…' : 'Not read yet'}</span>
          )}
        </div>
        <div className="flex items-center gap-1.5 shrink-0 text-gray-500">
          <span className="font-mono text-gray-400">{profile}</span>
          <button onClick={state.reload} className="p-0.5 rounded hover:bg-gray-100" title="Read again">
            <RefreshCw size={12} className={state.loading ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>
      <LiveDetailTabs state={state} hours={hours} onHours={setHours} onNavigate={navigate} compact />
    </div>
  );
}
