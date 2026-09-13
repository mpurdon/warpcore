// The Live section of a discovered resource: what AWS says about it right
// now. Read on request, not on selection, because every read is a handful
// of API calls; cached per window once read. Health now sits beside the
// health the import recorded, so drift shows without a re-import.

import { useState } from 'react';
import { Activity, RefreshCw, Settings } from 'lucide-react';
import { Node } from 'reactflow';
import { useStore } from '../../store/useStore';
import { projectProfile } from '../../utils/accountExplorer';
import { LiveDetailTabs, useResourceDetail, WINDOWS } from '../live/LiveDetail';
import { Fact, Section, StatusDot } from './InspectorHeader';

export default function LiveSection({ node }: { node: Node }) {
  const { environmentExtras, currentEnvironment, nodes, selectNode, openSettings } = useStore();
  const profile = projectProfile(environmentExtras, currentEnvironment);
  const arn = node.data?.arn as string | undefined;
  const [wanted, setWanted] = useState(false);
  const [hours, setHours] = useState(24);
  const state = useResourceDetail(profile, arn ?? null, hours, wanted);

  if (!arn) return null;

  // A related resource that is on the canvas is one click away; one that is
  // not stays a name.
  const navigate = (target: string) => {
    const hit = nodes.find((n) => n.data?.arn === target);
    if (hit) selectNode(hit.id);
  };

  const importedHealth = node.data?.meta?.health as { level: string; reason: string } | undefined;
  const live = state.detail?.health;
  const tone = (level?: string) => (level === 'ok' ? 'ok' : level === 'warn' ? 'warn' : 'muted');

  return (
    <Section
      title="Live"
      hint={
        profile ? (
          <span className="flex items-center gap-1.5">
            <span className="font-mono text-gray-400">{profile}</span>
            {wanted && (
              <button onClick={state.reload} className="p-0.5 rounded hover:bg-gray-100 text-gray-500" title="Read again">
                <RefreshCw size={11} className={state.loading ? 'animate-spin' : ''} />
              </button>
            )}
          </span>
        ) : undefined
      }
    >
      {!profile ? (
        <div className="text-xs text-gray-500">
          No AWS profile is recorded for this environment.{' '}
          <button className="inline-flex items-center gap-1 text-blue-700 hover:underline" onClick={() => openSettings('exploration')}>
            <Settings size={11} /> Choose a default profile
          </button>
          {' '}or re-import the account.
        </div>
      ) : !wanted ? (
        <div className="flex items-center gap-2">
          <button
            onClick={() => setWanted(true)}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-gray-900 text-white text-xs hover:bg-gray-800"
          >
            <Activity size={12} /> Read from AWS
          </button>
          <span className="text-[11px] text-gray-500">state, metrics, network and logs over the last {WINDOWS.find((w) => w.hours === hours)?.label}</span>
        </div>
      ) : (
        <>
          {live && (
            <div className="mb-2">
              <Fact
                label="Now"
                value={<span className="flex items-center gap-1.5"><StatusDot tone={tone(live.level)} label={live.level} /> {live.reason}</span>}
              />
              {importedHealth && importedHealth.level !== live.level && (
                <Fact
                  label="At import"
                  value={<span className="flex items-center gap-1.5 text-gray-500"><StatusDot tone={tone(importedHealth.level)} label={importedHealth.level} /> {importedHealth.reason}</span>}
                />
              )}
            </div>
          )}
          <LiveDetailTabs state={state} hours={hours} onHours={setHours} onNavigate={navigate} compact />
        </>
      )}
    </Section>
  );
}
