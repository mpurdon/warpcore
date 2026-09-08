// The transport bar: play, pause, step, jump, speed, for the scenario that
// is playing. It owns the clock. The store holds the playhead as two facts
// (which step, travelling or dwelling); this component waits the length of
// the phase and advances it. Everything continuous on the canvas - the
// pulse along an edge, the fill of the current segment - is CSS driven by
// those facts, so the store changes a few times per scenario, not sixty
// times a second.

import { useEffect, useMemo, useState } from 'react';
import { ChevronsLeft, ChevronsRight, Crosshair, Pause, Play, Route, X } from 'lucide-react';
import { useStore } from '../store/useStore';
import { canvas } from '../utils/canvasActions';
import { displayNameFor } from '../utils/nodeName';
import { checkScenario, formatTakes, modelledTimeMs, phaseDurationMs } from '../utils/scenarios';

const SPEEDS = [0.5, 1, 2, 4];

export const TRANSPORT_HEIGHT = 44;

export default function ScenarioTransport({ bottomOffset }: { bottomOffset: number }) {
  const { playhead, scenarios, nodes, edges, setPlaying, stopPlayback, advancePlayback, seekPlayback, setPlaybackSpeed, inspectScenario, inspectedScenario } = useStore();
  const scenario = playhead ? scenarios.find((s) => s.id === playhead.scenarioId) : undefined;
  const [follow, setFollow] = useState(false);
  const check = useMemo(() => (scenario ? checkScenario(scenario, nodes, edges) : null), [scenario, nodes, edges]);

  // The clock: wait out the current phase, then advance.
  const duration = scenario && playhead ? phaseDurationMs(scenario, playhead) : 0;
  useEffect(() => {
    if (!playhead || !playhead.playing || playhead.phase === 'end') return;
    const id = window.setTimeout(advancePlayback, duration);
    return () => window.clearTimeout(id);
  }, [playhead?.playing, playhead?.index, playhead?.phase, playhead?.speed, playhead?.scenarioId, duration, advancePlayback]); // eslint-disable-line react-hooks/exhaustive-deps

  // Follow: keep the hop in view.
  useEffect(() => {
    if (!follow || !scenario || !playhead || playhead.phase === 'end') return;
    const step = scenario.steps[playhead.index];
    const from = check?.steps[playhead.index]?.evidence?.from;
    const ids = [step?.at ?? scenario.trigger.at, from].filter((x): x is string => Boolean(x));
    canvas.fitToNodes(ids);
  }, [follow, playhead?.index, playhead?.phase, playhead?.scenarioId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!playhead || !scenario) return null;

  const n = scenario.steps.length;
  const byId = new Map(nodes.map((x) => [x.id, x]));
  const name = (id: string) => (byId.has(id) ? displayNameFor(byId.get(id)!) : id);
  const atEnd = playhead.phase === 'end';
  const current = playhead.index;
  const where = atEnd ? 'finished' : current < 0 ? `at ${name(scenario.trigger.at)}` : `${playhead.phase === 'travel' ? 'to' : 'at'} ${name(scenario.steps[current].at)}`;
  const modelled = modelledTimeMs(scenario, playhead);
  const problems = check?.steps[current]?.problems ?? [];

  return (
    <div
      className="absolute left-1/2 -translate-x-1/2 z-30 flex items-center gap-2 bg-gray-900 text-white rounded-xl shadow-xl px-2 text-xs select-none"
      style={{ bottom: bottomOffset + 14, height: TRANSPORT_HEIGHT, maxWidth: 'calc(100% - 48px)' }}
      role="toolbar"
      aria-label="Scenario playback"
    >
      <button
        onClick={() => inspectScenario(scenario.id)}
        className={`flex items-center gap-1.5 px-2 py-1 rounded-md max-w-[200px] hover:bg-white/10 ${inspectedScenario === scenario.id ? 'text-white' : 'text-gray-300'}`}
        title="Open in the inspector"
      >
        <Route size={13} className="shrink-0 text-blue-300" />
        <span className="truncate font-medium">{scenario.name}</span>
      </button>

      <span className="w-px h-5 bg-white/15" />

      <button onClick={() => seekPlayback(atEnd ? n - 1 : current - 1)} className="p-1.5 rounded-md hover:bg-white/10" title="Previous step ([)"><ChevronsLeft size={15} /></button>
      <button
        onClick={() => setPlaying(!playhead.playing)}
        className="p-1.5 rounded-md bg-blue-600 hover:bg-blue-500"
        title={playhead.playing ? 'Pause (space)' : atEnd ? 'Play again (space)' : 'Play (space)'}
      >
        {playhead.playing ? <Pause size={15} /> : <Play size={15} />}
      </button>
      <button onClick={() => { if (!atEnd) seekPlayback(current + 1); }} disabled={atEnd} className="p-1.5 rounded-md hover:bg-white/10 disabled:opacity-30" title="Next step (])"><ChevronsRight size={15} /></button>

      {/* One segment per step; click to jump. The current segment fills over the phase. */}
      <div className="flex items-center gap-0.5 mx-1" style={{ width: Math.min(360, Math.max(120, n * 36)) }}>
        {scenario.steps.map((step, i) => {
          const done = atEnd || i < current || (i === current && playhead.phase === 'dwell');
          const active = !atEnd && i === current;
          const flagged = (check?.steps[i]?.problems.length ?? 0) > 0;
          return (
            <button
              key={i}
              onClick={() => seekPlayback(i)}
              className="relative flex-1 h-2.5 rounded-sm overflow-hidden bg-white/15 hover:bg-white/25"
              title={`${i + 1}. ${name(step.at)}${step.note ? ` · ${step.note}` : ''}${flagged ? ' · flagged' : ''}`}
            >
              <span className={`absolute inset-y-0 left-0 ${flagged ? 'bg-amber-400' : 'bg-blue-400'}`} style={{ width: done ? '100%' : 0 }} />
              {active && playhead.phase === 'travel' && (
                <span
                  key={`${i}-${playhead.speed}-${playhead.playing}`}
                  className={`absolute inset-y-0 left-0 ${flagged ? 'bg-amber-400' : 'bg-blue-400'} scn-fill`}
                  style={{ animationDuration: `${duration}ms`, animationPlayState: playhead.playing ? 'running' : 'paused' }}
                />
              )}
            </button>
          );
        })}
      </div>

      <div className="flex flex-col leading-tight min-w-[150px]">
        <span className="tabular-nums text-gray-100 truncate">
          {atEnd ? `${n} of ${n}` : current < 0 ? 'trigger' : `step ${current + 1} of ${n}`} <span className="text-gray-400">· {where}</span>
        </span>
        <span className="text-[10px] text-gray-400 tabular-nums truncate">
          t = {formatTakes(modelled)}{problems.length ? <span className="text-amber-300"> · {problems[0]}</span> : null}
        </span>
      </div>

      <button
        onClick={() => setPlaybackSpeed(SPEEDS[(SPEEDS.indexOf(playhead.speed) + 1) % SPEEDS.length])}
        className="px-2 py-1 rounded-md hover:bg-white/10 tabular-nums text-gray-200 w-11 text-center"
        title="Playback speed"
      >
        {playhead.speed}×
      </button>
      <button
        onClick={() => setFollow((f) => !f)}
        className={`p-1.5 rounded-md hover:bg-white/10 ${follow ? 'text-blue-300' : 'text-gray-400'}`}
        title={follow ? 'Following the playhead' : 'Follow the playhead: keep each hop in view'}
      >
        <Crosshair size={14} />
      </button>
      <button onClick={stopPlayback} className="p-1.5 rounded-md hover:bg-white/10 text-gray-400" title="Stop and close (Esc)"><X size={14} /></button>
    </div>
  );
}
