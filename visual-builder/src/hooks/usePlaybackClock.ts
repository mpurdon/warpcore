// The playback clock. The store holds the playhead as two facts (which
// step, travelling or dwelling); this waits the length of the phase and
// advances it. Mounted once in the workspace, so playback runs whatever
// view or bar happens to be on screen.

import { useEffect } from 'react';
import { useStore } from '../store/useStore';
import { phaseDurationMs } from '../utils/scenarios';

export function usePlaybackClock(): void {
  const playhead = useStore((s) => s.playhead);
  const scenarios = useStore((s) => s.scenarios);
  const advancePlayback = useStore((s) => s.advancePlayback);
  const scenario = playhead ? scenarios.find((s) => s.id === playhead.scenarioId) : undefined;
  const duration = scenario && playhead ? phaseDurationMs(scenario, playhead) : 0;
  useEffect(() => {
    if (!playhead || !playhead.playing || playhead.phase === 'end') return;
    const id = window.setTimeout(advancePlayback, duration);
    return () => window.clearTimeout(id);
  }, [playhead?.playing, playhead?.index, playhead?.phase, playhead?.scenarioId, duration, advancePlayback]); // eslint-disable-line react-hooks/exhaustive-deps
}
