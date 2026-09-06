// The Activity drawer: what a deploy or destroy is doing, and what it did.
// Along the bottom of the canvas so the nodes changing colour and the
// reason they change are on screen together. Every number here came from
// the CLI's --progress stream or the host's exit framing; nothing is
// simulated, and an empty plan is reported as an empty plan.

import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronUp, X, CheckCircle2, XCircle, Circle, Loader2, MinusCircle } from 'lucide-react';
import { useStore } from '../store/useStore';
import { isActive, matchNodeForResource, RunResource, runElapsedSeconds } from '../utils/deployEvents';
import { canvas } from '../utils/canvasActions';
import { StatusDot, Tone } from './inspector/InspectorHeader';

/** Height of the drawer's header bar when collapsed, in px. Shared with the CSS offset. */
export const ACTIVITY_BAR_HEIGHT = 36;
export const ACTIVITY_BODY_HEIGHT = 240;

type Tab = 'resources' | 'output';

function fmtSeconds(s: number): string {
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s - m * 60)}s`;
}

function useNow(active: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [active]);
  return active ? now : Date.now();
}

const ICON: Record<RunResource['status'], { icon: typeof Circle; className: string; label: string }> = {
  planned: { icon: Circle, className: 'text-gray-300', label: 'waiting' },
  in_progress: { icon: Loader2, className: 'text-blue-500 animate-spin', label: 'in progress' },
  success: { icon: CheckCircle2, className: 'text-emerald-500', label: 'done' },
  failed: { icon: XCircle, className: 'text-red-500', label: 'failed' },
  skipped: { icon: MinusCircle, className: 'text-gray-400', label: 'skipped' },
};

const BAR: Record<RunResource['status'], string> = {
  planned: 'bg-gray-200',
  in_progress: 'bg-blue-400',
  success: 'bg-emerald-400',
  failed: 'bg-red-400',
  skipped: 'bg-gray-300',
};

export default function ActivityDrawer() {
  const { run, activityOpen, setActivityOpen, clearRun, nodes, selectNode } = useStore();
  const [tab, setTab] = useState<Tab>('resources');
  const active = isActive(run);
  const now = useNow(active);

  // Fresh runs open on the resources tab; a failure with no plan is only
  // explained in the output, so go there.
  useEffect(() => {
    if (run && run.phase === 'done' && !run.planned && run.output.length) setTab('output');
    if (run && run.phase === 'starting') setTab('resources');
  }, [run?.phase, run?.planned]); // eslint-disable-line react-hooks/exhaustive-deps

  const scale = useMemo(() => {
    if (!run) return { origin: 0, span: 1 };
    const origin = run.startedAt;
    const ends = run.resources.flatMap((r) => [r.endedAt ?? (r.startedAt ? now : 0)]);
    const end = Math.max(run.endedAt ?? now, ...ends, origin + 1000);
    return { origin, span: end - origin };
  }, [run, now]);

  if (!run) return null;

  const outcomeTone: Tone = active ? 'info' : run.outcome === 'success' ? 'ok' : run.outcome === 'partial' ? 'warn' : 'bad';
  const verb = run.kind === 'deploy' ? 'Deploy' : 'Destroy';
  const headline = active
    ? run.phase === 'starting' ? `${verb} to ${run.environment}: starting the CLI` : `${verb} to ${run.environment}: ${run.counts.total ? `${run.resources.filter((r) => r.status === 'success' || r.status === 'failed').length} of ${run.counts.total}` : 'planning'}`
    : run.outcome === 'success'
      ? `${verb} to ${run.environment} finished`
      : run.outcome === 'partial'
        ? `${verb} to ${run.environment} partly failed`
        : `${verb} to ${run.environment} failed`;
  const summary = `${run.counts.successful} ok · ${run.counts.failed} failed${run.counts.skipped ? ` · ${run.counts.skipped} skipped` : ''}`;

  return (
    <div className="absolute left-0 right-0 bottom-0 z-30 bg-white border-t border-gray-200 shadow-[0_-4px_12px_-6px_rgba(0,0,0,0.12)]">
      {/* Header bar: always visible while a run exists. */}
      <button
        onClick={() => setActivityOpen(!activityOpen)}
        className="w-full flex items-center gap-3 px-3 text-left hover:bg-gray-50"
        style={{ height: ACTIVITY_BAR_HEIGHT }}
        title={activityOpen ? 'Collapse' : 'Expand'}
      >
        <StatusDot tone={outcomeTone} label="" pulse={active} />
        <span className="text-sm font-medium text-gray-900 truncate">{headline}</span>
        <span className="text-xs text-gray-500 truncate">{run.planned ? summary : run.message ?? ''}</span>
        <span className="ml-auto text-xs text-gray-500 tabular-nums">{fmtSeconds(runElapsedSeconds(run, now))}</span>
        {activityOpen ? <ChevronDown size={14} className="text-gray-400" /> : <ChevronUp size={14} className="text-gray-400" />}
      </button>

      {activityOpen && (
        <div className="border-t border-gray-100 flex flex-col" style={{ height: ACTIVITY_BODY_HEIGHT }}>
          <div className="flex items-center gap-1 px-2 border-b border-gray-100 flex-shrink-0">
            {(['resources', 'output'] as Tab[]).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`px-3 py-1.5 text-xs font-medium border-b-2 -mb-px ${tab === t ? 'text-blue-700 border-blue-600' : 'text-gray-500 border-transparent hover:text-gray-800'}`}
              >
                {t === 'resources' ? `Resources · ${run.resources.length}` : `Output · ${run.output.length}`}
              </button>
            ))}
            <span className="flex-1" />
            {run.exitCode != null && <span className="text-[11px] text-gray-400 mr-2">exit {run.exitCode}</span>}
            {!active && (
              <button onClick={clearRun} className="p-1 rounded text-gray-400 hover:text-gray-700 hover:bg-gray-100" title="Clear this run">
                <X size={14} />
              </button>
            )}
          </div>

          {tab === 'resources' && (
            <div className="flex-1 overflow-y-auto min-h-0">
              {run.message && (
                <div className={`mx-3 mt-2 text-xs rounded border px-3 py-2 ${run.outcome === 'failed' ? 'bg-red-50 border-red-200 text-red-800' : 'bg-amber-50 border-amber-200 text-amber-900'}`}>
                  {run.message}
                </div>
              )}
              {run.planned && run.resources.length === 0 && (
                <div className="px-4 py-6 text-sm text-gray-600 max-w-2xl">
                  <p className="font-medium text-gray-800">The CLI planned no changes for {run.environment}.</p>
                  <p className="mt-1 text-xs text-gray-500">
                    Either every resource in the configuration is already recorded in the deployment state, or the configuration
                    declares nothing the orchestrator builds yet. The Output tab has the CLI's own words.
                  </p>
                </div>
              )}
              {!run.planned && active && (
                <div className="px-4 py-6 text-sm text-gray-500">Waiting for the CLI to plan…</div>
              )}
              {run.resources.length > 0 && (
                <table className="w-full text-xs">
                  <tbody>
                    {run.resources.map((r) => {
                      const meta = ICON[r.status];
                      const Icon = meta.icon;
                      const node = matchNodeForResource(r.id, nodes);
                      const start = r.startedAt ? (r.startedAt - scale.origin) / scale.span : null;
                      const end = r.endedAt ?? (r.startedAt ? now : null);
                      const width = start != null && end != null ? Math.max(0.004, (end - scale.origin) / scale.span - start) : 0;
                      return (
                        <tr key={r.id} className="border-b border-gray-50 hover:bg-gray-50">
                          <td className="pl-3 pr-2 py-1 w-6"><Icon size={13} className={meta.className} /></td>
                          <td className="py-1 pr-3 w-64">
                            <button
                              onClick={() => { if (node) { selectNode(node.id); canvas.fitToNodes([node.id]); } }}
                              disabled={!node}
                              className={`font-mono truncate max-w-[16rem] block text-left ${node ? 'text-blue-700 hover:underline' : 'text-gray-800'}`}
                              title={node ? 'Show on the canvas' : 'Not on the canvas'}
                            >
                              {r.id}
                            </button>
                            <span className="block text-[10px] text-gray-400 truncate">{[r.change, r.type?.replace(/^AWS::/, ''), r.reason].filter(Boolean).join(' · ')}</span>
                          </td>
                          <td className="py-1 pr-3">
                            <div className="relative h-3 bg-gray-100 rounded">
                              {start != null && (
                                <div className={`absolute top-0 bottom-0 rounded ${BAR[r.status]}`} style={{ left: `${start * 100}%`, width: `${width * 100}%` }} />
                              )}
                            </div>
                            {r.error && <div className="text-[11px] text-red-700 mt-0.5 truncate" title={r.error}>{r.error}</div>}
                          </td>
                          <td className="py-1 pr-3 w-16 text-right text-gray-500 tabular-nums">
                            {r.duration != null ? fmtSeconds(r.duration) : r.startedAt ? fmtSeconds(((r.endedAt ?? now) - r.startedAt) / 1000) : ''}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          )}

          {tab === 'output' && (
            <pre className="flex-1 overflow-auto min-h-0 m-0 px-3 py-2 text-[11px] leading-relaxed font-mono bg-gray-950 text-gray-200">
              {run.output.length === 0 ? <span className="text-gray-500">No output from the CLI yet.</span> : run.output.map((l, i) => (
                <div key={i} className={l.stream === 'err' ? 'text-amber-300' : ''}>{l.text}</div>
              ))}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
