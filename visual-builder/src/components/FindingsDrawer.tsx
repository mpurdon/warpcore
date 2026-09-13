// The review: what is wrong, wasteful or fragile in the open project, from
// what its resources are doing. Rules produce the list; a configured model
// ranks it and says why each finding matters here. Every row is a place to
// go: click it and the canvas selects the resource.

import { useState } from 'react';
import { AlertTriangle, Coins, RefreshCw, ShieldAlert, Sparkles, Terminal, Wrench, X } from 'lucide-react';
import { useStore } from '../store/useStore';
import { projectProfile } from '../utils/accountExplorer';
import { fetchFindings, Finding, FindingKind, KIND_LABEL, SEVERITY_RANK, Severity } from '../utils/findings';
import { WINDOWS } from './live/LiveDetail';

const KIND_ICON: Record<FindingKind, JSX.Element> = {
  cost: <Coins size={13} />, security: <ShieldAlert size={13} />, reliability: <AlertTriangle size={13} />, operability: <Wrench size={13} />,
};
const SEVERITY_CLASS: Record<Severity, string> = {
  high: 'bg-red-100 text-red-800 border-red-200', medium: 'bg-amber-100 text-amber-800 border-amber-200', low: 'bg-gray-100 text-gray-700 border-gray-200',
};

/** Read (or re-read) the review for the open project. Shared with the palette. */
export async function runReview(hours = 24): Promise<void> {
  const s = useStore.getState();
  const profile = projectProfile(s.environmentExtras, s.currentEnvironment);
  if (!profile || !s.configPath) return;
  s.setReviewBusy(true);
  try {
    const llm = s.prefs.assistantProvider ? { provider: s.prefs.assistantProvider, model: s.prefs.assistantModel } : undefined;
    s.setReview(await fetchFindings(profile, s.configPath, hours, llm));
  } catch (e) {
    s.setReview({ window_hours: hours, findings: [], summary: null, model: null, notes: [], errors: { review: String(e) }, at: new Date().toISOString() });
  } finally {
    useStore.getState().setReviewBusy(false);
  }
}

export default function FindingsDrawer({ onClose }: { onClose: () => void }) {
  const { review, reviewBusy, nodes, selectNode, prefs, configPath, environmentExtras, currentEnvironment, openSettings } = useStore();
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
