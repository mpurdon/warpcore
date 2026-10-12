// The review: what is wrong, wasteful or fragile in the open project, from
// what its resources are doing. Rules produce the list; a configured model
// ranks it and says why each finding matters here. Every row is a place to
// go: click it and the canvas selects the resource.

import { useState } from 'react';
import { AlertTriangle, Coins, RefreshCw, ShieldAlert, Sparkles, Terminal, Wrench, X } from 'lucide-react';
import { useStore } from '../store/useStore';
import { projectProfile } from '../utils/accountExplorer';
import { Finding, FindingKind, KIND_LABEL, SEVERITY_RANK, Severity } from '../utils/findings';
import { runReview } from '../utils/review';
import { WINDOWS } from './live/LiveDetail';
import { refreshDrift } from '../utils/live';

const KIND_ICON: Record<FindingKind, JSX.Element> = {
  cost: <Coins size={13} />, security: <ShieldAlert size={13} />, reliability: <AlertTriangle size={13} />, operability: <Wrench size={13} />,
};
const SEVERITY_CLASS: Record<Severity, string> = {
  high: 'bg-red-100 text-red-800 border-red-200', medium: 'bg-amber-100 text-amber-800 border-amber-200', low: 'bg-gray-100 text-gray-700 border-gray-200',
};

export default function FindingsDrawer({ onClose }: { onClose: () => void }) {
  const { review, reviewBusy, nodes, selectNode, prefs, configPath, environmentExtras, currentEnvironment, openSettings, drift, driftBusy } = useStore();
  const driftItems = (drift?.items ?? []).filter((d) => d.kind === 'modified' || d.kind === 'missing');
  const goArn = (arn: string) => {
    const hit = nodes.find((n) => n.data?.arn === arn);
    if (hit) { selectNode(hit.id); onClose(); }
  };
  const [hours, setHours] = useState(review?.window_hours ?? 24);
  const [filter, setFilter] = useState<FindingKind | 'all'>('all');
  const profile = projectProfile(environmentExtras, currentEnvironment);

  const go = (f: Finding) => {
    const hit = nodes.find((n) => f.arns.includes(n.data?.arn));
    if (hit) { selectNode(hit.id); onClose(); }
  };

  const shown = (review?.findings ?? []).filter((f) => filter === 'all' || f.kind === filter);
  const counts = (['high', 'medium', 'low'] as Severity[]).map((sev) => [sev, (review?.findings ?? []).filter((f) => f.severity === sev).length] as const);
  const kinds = (['cost', 'security', 'reliability', 'operability'] as FindingKind[]).map((k) => [k, (review?.findings ?? []).filter((f) => f.kind === k).length] as const);

  return (
    <div className="fixed inset-0 bg-black bg-opacity-40 flex items-center justify-center z-50" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="bg-white text-gray-900 rounded-lg shadow-xl w-[720px] max-w-[95vw] h-[85vh] flex flex-col overflow-hidden" role="dialog" aria-label="Review">
        <div className="px-4 py-3 border-b border-gray-200 flex items-center gap-3">
          <div className="min-w-0">
            <h2 className="text-base font-semibold">Review</h2>
            <p className="text-xs text-gray-500">
              What the resources are doing, and what that says.
              {review?.at && <> Read {new Date(review.at).toLocaleTimeString()} over {review.window_hours}h{review.model ? <>, ranked by <span className="font-mono">{review.model}</span></> : ''}.</>}
            </p>
          </div>
          <div className="flex-1" />
          <div className="flex items-center gap-0.5 text-xs text-gray-500">
            {WINDOWS.map((w) => (
              <button key={w.hours} onClick={() => setHours(w.hours)} className={`px-1.5 py-0.5 rounded ${hours === w.hours ? 'bg-gray-200 text-gray-900' : 'hover:bg-gray-100'}`}>{w.label}</button>
            ))}
          </div>
          <button
            onClick={() => { void runReview(hours); }}
            disabled={reviewBusy || !profile || !configPath}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-gray-900 text-white text-xs hover:bg-gray-800 disabled:opacity-40"
            title={!configPath ? 'Save the project first' : !profile ? 'No AWS profile is recorded for this environment' : 'Read the metrics again and re-run the rules'}
          >
            <RefreshCw size={12} className={reviewBusy ? 'animate-spin' : ''} /> {review ? 'Review again' : 'Review'}
          </button>
          <button onClick={onClose} className="p-1.5 hover:bg-gray-100 rounded-full" title="Close"><X size={18} className="text-gray-500" /></button>
        </div>

        <div className="flex-1 overflow-y-auto">
          <div className="px-4 pt-3" data-testid="drift-section">
            <div className="flex items-center gap-2 text-xs">
              <span className="font-medium text-gray-800">Drift</span>
              <span className="text-gray-500">
                {driftBusy ? 'comparing the state with the account…'
                  : drift?.error ? <span className="text-amber-700" title={drift.error}>could not compare: {drift.error.split('\n')[0].slice(0, 120)}</span>
                  : drift ? `${drift.counts.modified} changed, ${drift.counts.missing} gone, ${drift.counts.ok} as recorded, ${drift.counts.unchecked} unchecked · ${new Date(drift.checked_at).toLocaleTimeString()}`
                  : 'the deployment state has not been checked against the account'}
              </span>
              <span className="flex-1" />
              <button
                onClick={() => { void refreshDrift(); }}
                disabled={driftBusy || !profile || !configPath}
                className="px-2 py-0.5 rounded border border-gray-200 hover:bg-gray-50 disabled:opacity-40"
                title={prefs.driftCheckMinutes ? `Also checked every ${prefs.driftCheckMinutes} minutes` : 'Compare now; a schedule can be set in Settings'}
              >
                {drift ? 'Check again' : 'Check'}
              </button>
            </div>
            {driftItems.length > 0 && (
              <ul className="mt-2 space-y-1">
                {driftItems.map((d) => (
                  <li key={d.id}>
                    <button onClick={() => goArn(d.physical_id)} className="w-full text-left text-xs rounded border border-violet-200 bg-violet-50/60 px-2 py-1.5 hover:bg-violet-50">
                      <span className={`font-medium ${d.kind === 'missing' ? 'text-red-700' : 'text-violet-800'}`}>{d.kind === 'missing' ? 'gone' : 'changed'}</span>
                      <span className="ml-1.5 font-mono text-gray-800">{d.id}</span>
                      <span className="ml-1 text-gray-400">{d.type.replace('AWS::', '')}{d.managed ? '' : ' · adopted'}</span>
                      {d.kind === 'missing' && d.note && <span className="ml-1 text-gray-500">{d.note}</span>}
                      {d.differences.map((x) => (
                        <div key={x.key} className="ml-2 text-[11px] text-gray-600">
                          <span className="font-mono">{x.key}</span>: recorded <span className="font-mono">{JSON.stringify(x.recorded)}</span>, account has <span className="font-mono">{JSON.stringify(x.live)}</span>
                        </div>
                      ))}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          {!review && !reviewBusy && (
            <div className="p-8 text-sm text-gray-600 space-y-2">
              <p>A review reads each metered resource's CloudWatch metrics over the window, then applies the rules: idle hosts, quiet NAT gateways, ports open to the world, stopped instances still billing, missing Session Manager, failing functions, databases nobody connects to.</p>
              <p>
                {prefs.assistantProvider
                  ? <>The <span className="font-mono">{prefs.assistantProvider}</span> model will rank the findings for this account and say why each matters here.</>
                  : <>No model is configured, so the rules' order stands. <button className="text-blue-700 hover:underline" onClick={() => openSettings('exploration')}>Choose one in Settings</button> to have the findings ranked and explained for this account.</>}
              </p>
              {!profile && <p className="text-amber-700">No AWS profile is recorded for this environment; re-import the account or choose a default profile in Settings.</p>}
            </div>
          )}
          {reviewBusy && (
            <div className="p-8 text-sm text-gray-500 flex items-center gap-2"><RefreshCw size={14} className="animate-spin" /> Reading metrics and running the rules{prefs.assistantProvider ? ', then asking the model' : ''}…</div>
          )}
          {review && !reviewBusy && (
            <div className="p-4">
              {review.summary && (
                <div className="mb-4 p-3 rounded-md bg-blue-50 border border-blue-100 text-sm text-blue-900 flex gap-2">
                  <Sparkles size={15} className="shrink-0 mt-0.5" /> <span>{review.summary}</span>
                </div>
              )}
              {Object.entries(review.errors).map(([k, v]) => (
                <div key={k} className="mb-3 p-2 rounded bg-amber-50 border border-amber-200 text-xs text-amber-900"><span className="font-mono">{k}</span>: {v}</div>
              ))}
              <div className="flex items-center gap-2 mb-3 text-xs">
                {counts.map(([sev, n]) => n > 0 && <span key={sev} className={`px-1.5 py-0.5 rounded border ${SEVERITY_CLASS[sev]}`}>{n} {sev}</span>)}
                <span className="flex-1" />
                <button onClick={() => setFilter('all')} className={`px-1.5 py-0.5 rounded ${filter === 'all' ? 'bg-gray-200' : 'hover:bg-gray-100'}`}>All</button>
                {kinds.map(([k, n]) => n > 0 && (
                  <button key={k} onClick={() => setFilter(k)} className={`px-1.5 py-0.5 rounded inline-flex items-center gap-1 ${filter === k ? 'bg-gray-200' : 'hover:bg-gray-100'}`}>{KIND_ICON[k]} {KIND_LABEL[k]} {n}</button>
                ))}
              </div>
              {shown.length === 0 && <p className="text-sm text-gray-500">{review.notes.join(' ') || 'Nothing to show.'}</p>}
              <ul className="space-y-2">
                {[...shown].sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99) || SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]).map((f) => {
                  const onCanvas = nodes.some((n) => f.arns.includes(n.data?.arn));
                  return (
                    <li key={f.id}>
                      <button
                        onClick={() => go(f)}
                        disabled={!onCanvas}
                        className="w-full text-left rounded-lg border border-gray-200 p-3 hover:border-blue-300 hover:bg-blue-50/30 disabled:cursor-default disabled:hover:border-gray-200 disabled:hover:bg-white"
                      >
                        <div className="flex items-start gap-2">
                          <span className={`shrink-0 mt-0.5 px-1.5 py-0.5 rounded border text-[10px] uppercase tracking-wide ${SEVERITY_CLASS[f.severity]}`}>{f.severity}</span>
                          <div className="min-w-0 flex-1">
                            <div className="text-sm font-medium text-gray-900 flex items-center gap-1.5">
                              <span className="text-gray-400">{KIND_ICON[f.kind]}</span>{f.title}
                            </div>
                            <p className="text-xs text-gray-600 mt-0.5">{f.detail}</p>
                            {f.why && <p className="text-xs text-blue-900 mt-1 flex gap-1"><Sparkles size={11} className="shrink-0 mt-0.5" /> {f.why}</p>}
                            {f.reasoning?.length > 0 && (
                              <ol className="mt-1 ml-5 list-decimal text-[11px] text-blue-900/80 space-y-0.5" title="The chain the model reasoned from; each step cites the evidence">
                                {f.reasoning.map((step, i) => <li key={i}>{step}</li>)}
                              </ol>
                            )}
                            {f.suggestion && <p className="text-xs text-gray-500 mt-1 flex gap-1"><Terminal size={11} className="shrink-0 mt-0.5" /> {f.suggestion}</p>}
                          </div>
                        </div>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
