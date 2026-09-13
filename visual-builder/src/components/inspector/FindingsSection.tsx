// The findings that name this resource, from the last review. Each one
// shows its evidence, so the answer to "why" is on the card.

import { Sparkles } from 'lucide-react';
import { Node } from 'reactflow';
import { useStore } from '../../store/useStore';
import { KIND_LABEL, SEVERITY_RANK } from '../../utils/findings';
import { Section } from './InspectorHeader';

const TONE: Record<string, string> = { high: 'text-red-700', medium: 'text-amber-700', low: 'text-gray-600' };

export default function FindingsSection({ node }: { node: Node }) {
  const { reviewByArn, review, openDialog } = useStore();
  const arn = node.data?.arn as string | undefined;
  if (!arn || !review) return null;
  const findings = [...(reviewByArn.get(arn) ?? [])].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
  return (
    <Section
      title="Findings"
      hint={<button className="text-blue-700 hover:underline" onClick={() => openDialog('findings')}>{findings.length ? `${findings.length} · all` : 'review'}</button>}
    >
      {findings.length === 0 ? (
        <p className="text-xs text-gray-500">Nothing stood out for this resource in the last review.</p>
      ) : (
        <ul className="space-y-2">
          {findings.map((f) => (
            <li key={f.id} className="text-xs">
              <div className={`font-medium ${TONE[f.severity]}`}>
                <span className="uppercase tracking-wide text-[10px] mr-1">{f.severity}</span>{f.title}
                <span className="text-gray-400 font-normal"> · {KIND_LABEL[f.kind]}</span>
              </div>
              <p className="text-gray-600 mt-0.5">{f.detail}</p>
              {f.why && <p className="text-blue-900 mt-0.5 flex gap-1"><Sparkles size={11} className="shrink-0 mt-0.5" /> {f.why}</p>}
              {f.suggestion && <p className="text-gray-500 mt-0.5">{f.suggestion}</p>}
              {Object.keys(f.evidence).length > 0 && (
                <details className="mt-0.5">
                  <summary className="text-[11px] text-gray-400 cursor-pointer">evidence</summary>
                  <pre className="text-[10px] bg-gray-50 rounded p-1.5 mt-0.5 overflow-x-auto">{JSON.stringify(f.evidence, null, 1)}</pre>
                </details>
              )}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
