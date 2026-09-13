// Draft a scenario with the configured model. The draft is added like any
// other scenario and checked hop by hop by the scenario checker, so a step
// the wiring cannot ground shows up as a problem, not as a fact.

import { useState } from 'react';
import { Sparkles } from 'lucide-react';
import { useReadOnly, useStore } from '../../store/useStore';
import { assistantConfig, draftScenario } from '../../utils/assistant';
import { checkScenario } from '../../utils/scenarios';

/**
 * Without `scenarioId`, the draft becomes a new scenario. With one, the
 * draft fills that scenario's steps from its own trigger.
 */
export default function DraftScenarioButton({ scenarioId }: { scenarioId?: string }) {
  const { nodes, edges, scenarios, addScenario, updateScenario, openSettings } = useStore();
  const target = scenarioId ? scenarios.find((sc) => sc.id === scenarioId) : undefined;
  const readOnly = useReadOnly();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [ask, setAsk] = useState('');
  const assistant = assistantConfig();

  const draft = async () => {
    if (!assistant) return;
    setBusy(true);
    setNote(null);
    try {
      const draft = await draftScenario(nodes, edges, scenarios, assistant, ask, target?.trigger);
      const scenario = target ? { ...target, steps: draft.steps } : draft;
      const check = checkScenario(scenario, nodes, edges);
      if (target) updateScenario(target.id, () => scenario);
      else addScenario(scenario);
      const ungrounded = check.steps.filter((st) => !st.evidence).length;
      setNote(ungrounded ? `Drafted ${scenario.steps.length} steps; ${ungrounded} hop${ungrounded === 1 ? '' : 's'} the wiring cannot ground, marked in the checker.` : `Drafted ${scenario.steps.length} steps, every hop grounded.`);
      setAsking(false);
    } catch (e) {
      setNote(String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!assistant) {
    return (
      <button
        onClick={() => openSettings('exploration')}
        className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded border border-dashed border-gray-300 text-gray-500 hover:bg-gray-50"
        title="Choose a model provider in Settings to draft scenarios from the wiring"
      >
        <Sparkles size={12} /> Draft with a model…
      </button>
    );
  }

  return (
    <span className="inline-flex flex-col gap-1">
      <span className="inline-flex items-center gap-1">
        <button
          onClick={() => (asking ? void draft() : setAsking(true))}
          disabled={readOnly || busy || nodes.length === 0}
          className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded border border-blue-200 text-blue-800 bg-blue-50 hover:bg-blue-100 disabled:opacity-40 disabled:cursor-not-allowed"
          title={readOnly ? 'Unlock the project to add scenarios' : 'Ask the model to draft a scenario from the wiring; every hop is then checked'}
        >
          <Sparkles size={12} /> {busy ? 'Drafting…' : asking ? 'Draft' : 'Draft with assistant'}
        </button>
        {asking && !busy && (
          <input
            autoFocus
            value={ask}
            onChange={(e) => setAsk(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void draft(); if (e.key === 'Escape') setAsking(false); }}
            placeholder="what happens? (optional)"
            className="text-xs px-2 py-1 border border-gray-300 rounded w-44"
          />
        )}
      </span>
      {note && <span className="text-[11px] text-gray-500">{note}</span>}
    </span>
  );
}
