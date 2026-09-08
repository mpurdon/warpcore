// One scenario in a list: play it, open it, and a word on the right.

import { Play } from 'lucide-react';
import { useStore } from '../../store/useStore';
import type { Scenario } from '../../utils/scenarios';

export default function ScenarioRow({ scenario, trailing }: { scenario: Scenario; trailing?: React.ReactNode }) {
  const playScenario = useStore((s) => s.playScenario);
  const inspectScenario = useStore((s) => s.inspectScenario);
  return (
    <div className="flex items-center gap-2 py-1">
      <button
        onClick={() => playScenario(scenario.id)}
        disabled={scenario.steps.length === 0}
        className="p-1 rounded text-blue-700 hover:bg-blue-50 disabled:text-gray-300 shrink-0"
        title={scenario.steps.length ? 'Play' : 'No steps yet'}
      >
        <Play size={12} />
      </button>
      <button onClick={() => inspectScenario(scenario.id)} className="flex-1 min-w-0 text-left text-xs text-blue-700 hover:underline truncate" title="Inspect">
        {scenario.name}
      </button>
      {trailing && <span className="text-[10px] text-gray-400 shrink-0 inline-flex items-center gap-1">{trailing}</span>}
    </div>
  );
}
