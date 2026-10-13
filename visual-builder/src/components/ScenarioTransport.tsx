// The transport bar: play, pause, step, jump, speed and follow, for the
// scenario that is playing. Pure UI over the store's playhead; the clock
// is usePlaybackClock, mounted once in the workspace. Everything
// continuous on the canvas - the pulse along an edge, the fill of the
// current segment - is CSS driven by the playhead's two facts.

import { useEffect } from 'react';
import { ChevronsLeft, ChevronsRight, Crosshair, Pause, Play, Route, X } from 'lucide-react';
import { useStore } from '../store/useStore';
import { canvas } from '../utils/canvasActions';
import { useScenarioView } from '../hooks/useCanvasView';
import { formatTakes, modelledTimeMs, outcomeLabel, phaseDurationMs, stepFails } from '../utils/scenarios';

// 1× is deliberately slow enough to follow a hop by eye; the rest is for skimming.
const SPEEDS = [1, 2, 4, 8];

export const TRANSPORT_HEIGHT = 44;

export default function ScenarioTransport({ bottomOffset }: { bottomOffset: number }) {
  const setPlaying = useStore((s) => s.setPlaying);
  const stopPlayback = useStore((s) => s.stopPlayback);
  const seekPlayback = useStore((s) => s.seekPlayback);
  const stepBack = useStore((s) => s.stepBack);
  const stepForward = useStore((s) => s.stepForward);
  const setPlaybackSpeed = useStore((s) => s.setPlaybackSpeed);
  const inspectScenario = useStore((s) => s.inspectScenario);
  const inspectedScenario = useStore((s) => s.inspectedScenario);
  const follow = useStore((s) => s.followPlayhead);
  const setFollow = useStore((s) => s.setFollowPlayhead);
  const systemView = useStore((s) => s.systemView);
  const sv = useScenarioView();
  const head = sv?.head ?? null;

  // Follow on the canvas: keep the hop in view. The system view pans itself.
  useEffect(() => {
    if (!follow || systemView || !sv?.focus) return;
    canvas.fitToNodes([sv.focus.at, sv.focus.from].filter((x): x is string => Boolean(x)));
  }, [follow, systemView, sv?.focus]);

  if (!sv || !head) return null;
  const { scenario, check } = sv;
  const n = scenario.steps.length;
  const label = sv.name;
  const atEnd = head.phase === 'end';
  const current = head.index;
  const retrying = !atEnd && current >= 0 && head.attempt > 0 ? ` · retry ${head.attempt} of ${scenario.steps[current].retry}` : '';
  const where = atEnd ? 'finished' : current < 0 ? `at ${label(scenario.trigger.at)}` : `${head.phase === 'travel' ? 'to' : 'at'} ${label(scenario.steps[current].at)}${retrying}`;
  const modelled = modelledTimeMs(scenario, head);
  const problems = check.steps[current]?.problems ?? [];
  const duration = phaseDurationMs(scenario, head);

  return (
    <div
      className="absolute left-1/2 -translate-x-1/2 z-30 flex items-center gap-2 bg-chrome text-chrome-fg rounded-xl shadow-xl px-2 text-xs select-none"
      style={{ bottom: bottomOffset + 14, height: TRANSPORT_HEIGHT, maxWidth: 'calc(100% - 48px)' }}
      role="toolbar"
      aria-label="Scenario playback"
    >
      <button
        onClick={() => inspectScenario(scenario.id)}
        className={`flex items-center gap-1.5 px-2 py-1 rounded-md max-w-[200px] hover:bg-surface/10 ${inspectedScenario === scenario.id ? 'text-white' : 'text-chrome-fg/80'}`}
        title="Open in the inspector"
      >
        <Route size={13} className="shrink-0 text-blue-400" />
        <span className="truncate font-medium">{scenario.name}</span>
      </button>

      <span className="w-px h-5 bg-surface/15" />

      <button onClick={stepBack} className="p-1.5 rounded-md hover:bg-surface/10" title="Previous step ([)"><ChevronsLeft size={15} /></button>
      <button
        onClick={() => setPlaying(!head.playing)}
        className="p-1.5 rounded-md bg-blue-600 hover:bg-blue-500"
        title={head.playing ? 'Pause (space)' : atEnd ? 'Play again (space)' : 'Play (space)'}
      >
        {head.playing ? <Pause size={15} /> : <Play size={15} />}
      </button>
      <button onClick={stepForward} disabled={atEnd} className="p-1.5 rounded-md hover:bg-surface/10 disabled:opacity-30" title="Next step (])"><ChevronsRight size={15} /></button>

      {/* One segment per step; click to jump. The current segment fills over the phase. */}
      <div className="flex items-center gap-0.5 mx-1" style={{ width: Math.min(360, Math.max(120, n * 36)) }}>
        {scenario.steps.map((step, i) => {
          const done = atEnd || i < current || (i === current && head.phase === 'dwell');
          const active = !atEnd && i === current;
          const flagged = (check.steps[i]?.problems.length ?? 0) > 0;
          const fill = flagged ? 'bg-amber-400' : stepFails(step) ? 'bg-red-500' : 'bg-blue-400';
          return (
            <button
              key={i}
              onClick={() => seekPlayback(i)}
              className="relative flex-1 h-2.5 rounded-sm overflow-hidden bg-surface/15 hover:bg-surface/25"
              title={`${i + 1}. ${label(step.at)}${step.note ? ` · ${step.note}` : ''}${step.retry ? ` · ${step.retry} retries` : ''}${stepFails(step) ? ` · ${outcomeLabel(step)}` : ''}${flagged ? ' · flagged' : ''}`}
            >
              <span className={`absolute inset-y-0 left-0 ${fill}`} style={{ width: done ? '100%' : 0 }} />
              {active && head.phase === 'travel' && (
                <span
                  key={`${i}-${head.attempt}-${head.speed}-${head.playing}`}
                  className={`absolute inset-y-0 left-0 ${fill} scn-fill`}
                  style={{ animationDuration: `${duration}ms`, animationPlayState: head.playing ? 'running' : 'paused' }}
                />
              )}
            </button>
          );
        })}
      </div>

      <div className="flex flex-col leading-tight min-w-[150px]">
        <span className="tabular-nums text-chrome-fg truncate">
          {atEnd ? `${n} of ${n}` : current < 0 ? 'trigger' : `step ${current + 1} of ${n}`} <span className="text-chrome-muted">· {where}</span>
        </span>
        <span className="text-[10px] text-chrome-muted tabular-nums truncate">
          t = {formatTakes(modelled)}{problems.length ? <span className="text-amber-400"> · {problems[0]}</span> : null}
        </span>
      </div>

      <button
        onClick={() => setPlaybackSpeed(SPEEDS[(SPEEDS.indexOf(head.speed) + 1) % SPEEDS.length])}
        className="px-2 py-1 rounded-md hover:bg-surface/10 tabular-nums text-chrome-fg w-11 text-center"
        title="Playback speed"
      >
        {head.speed}×
      </button>
      <button
        onClick={() => setFollow(!follow)}
        className={`p-1.5 rounded-md hover:bg-surface/10 ${follow ? 'text-blue-400' : 'text-chrome-muted'}`}
        title={follow ? 'Following the request' : 'Follow the request: keep each hop in view'}
      >
        <Crosshair size={14} />
      </button>
      <button onClick={stopPlayback} className="p-1.5 rounded-md hover:bg-surface/10 text-chrome-muted" title="Stop and close (Esc)"><X size={14} /></button>
    </div>
  );
}
