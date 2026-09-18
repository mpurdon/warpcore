// Who owns a discovered resource, and the way to make it warpcore's. The
// take-over rewrites the deployment state through the CLI and marks the
// node; the section then shows what the previous manager must be told.

import { useState } from 'react';
import { HandMetal, RefreshCw } from 'lucide-react';
import { Node } from 'reactflow';
import { useReadOnly, useStore } from '../../store/useStore';
import { MANAGER_LABEL, Provenance, takeOver, TakeoverResult } from '../../utils/takeover';
import { Fact, Section } from './InspectorHeader';

export default function ManagedBySection({ node }: { node: Node }) {
  const { configPath, currentEnvironment, setNodes, nodes } = useStore();
  const readOnly = useReadOnly();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<TakeoverResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const arn = node.data?.arn as string | undefined;
  if (!arn) return null;
  const managed = Boolean(node.data?.meta?.managed);
  const provenance = node.data?.meta?.provenance as Provenance | undefined;
  const manager = managed ? 'warpcore' : provenance?.manager ?? 'console';

  const run = async () => {
    if (!configPath) { setError('Save the project first: the take-over is recorded in its deployment state.'); return; }
    setBusy(true);
    setError(null);
    try {
      const out = await takeOver(configPath, currentEnvironment, [arn]);
      setResult(out);
      if (out.taken > 0) {
        setNodes(nodes.map((n) => (n.id === node.id ? { ...n, data: { ...n.data, meta: { ...(n.data.meta || {}), managed: true } } } : n)));
      } else {
        setError(out.items.map((i) => `${i.resource_id}: ${i.detail}`).join('\n') || 'Nothing was taken over.');
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const where = provenance?.stack ?? provenance?.address ?? (provenance?.app ? `${provenance.app}/${provenance.stage ?? ''}` : undefined);

  return (
    <Section title="Managed by" hint={managed ? 'taken over' : undefined}>
      <Fact label="Manager" value={MANAGER_LABEL[manager] ?? manager} />
      {where && <Fact label={provenance?.address ? 'Address' : provenance?.app ? 'App' : 'Stack'} value={where} mono />}
      {provenance?.logical_id && <Fact label="Logical id" value={provenance.logical_id} mono />}
      {provenance?.evidence && <p className="text-[11px] text-gray-500 mt-1">{provenance.evidence}</p>}
      {managed ? (
        <p className="text-[11px] text-gray-600 mt-1">
          warpcore owns this resource: the config here is what a deploy enforces, and removing it from the canvas removes it from AWS.
          {provenance?.manager && provenance.manager !== 'warpcore' && ` It was deployed by ${MANAGER_LABEL[provenance.manager] ?? provenance.manager}; make sure that tool no longer manages it.`}
        </p>
      ) : (
        <div className="mt-1">
          <p className="text-[11px] text-gray-600">Observed, not managed: a deploy never creates, changes or removes it.</p>
          <button
            onClick={run}
            disabled={readOnly || busy}
            className="mt-1.5 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-gray-900 text-white text-xs hover:bg-gray-800 disabled:opacity-40 disabled:cursor-not-allowed"
            title={readOnly ? 'Unlock the project to take resources over' : 'Make this resource warpcore\'s'}
          >
            {busy ? <RefreshCw size={12} className="animate-spin" /> : <HandMetal size={12} />} Take over
          </button>
        </div>
      )}
      {result && result.release.length > 0 && (
        <div className="mt-2 text-[11px] text-amber-900 bg-amber-50 border border-amber-200 rounded p-2 space-y-1">
          <div className="font-medium">Tell the previous manager</div>
          {result.release.map((s) => <pre key={s} className="whitespace-pre-wrap font-mono text-[10px]">{s}</pre>)}
        </div>
      )}
      {error && <pre className="mt-1 text-[11px] text-red-700 whitespace-pre-wrap">{error}</pre>}
    </Section>
  );
}
