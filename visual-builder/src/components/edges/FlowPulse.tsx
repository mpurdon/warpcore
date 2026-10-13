// The request crossing an edge, drawn as a comet: a bright bead with a tail
// that fades behind it, on a hop lit from end to end. The whole thing is
// driven by frames rather than SMIL. A SMIL animation inserted into a
// document that has been open a while starts its clock at document load,
// so the old dot had arrived before it was ever drawn; frames also freeze
// on pause and follow a speed change without starting over.
//
// The tail is three dashes of the same path, each `pathLength` 1, so a dash
// of length L with offset (L - t) ends exactly at the bead at progress t.

import { useLayoutEffect, useRef } from 'react';
import { rc } from '../../utils/theme';

export const PULSE_COLOR = 'var(--c-blue-600)';
/** The comet is light on the wire: its edge is usually this same blue. */
const PALE = 'var(--c-blue-200)';
const CORE = 'var(--c-white)';

/** Tail layers, widest and faintest first; length is a fraction of the hop. */
const TAIL = [
  { len: 0.42, width: 10, opacity: 0.2, color: PULSE_COLOR },
  { len: 0.24, width: 5, opacity: 0.75, color: PALE },
  { len: 0.11, width: 2.5, opacity: 0.95, color: CORE },
];

interface Props {
  /** The edge's path, in the edge's own coordinates. */
  path: string;
  /** Travel from the path's end to its start. */
  reverse: boolean;
  /** How long the crossing takes at the current speed. */
  durationMs: number;
  /** Whether the clock is running; paused, the comet holds where it is. */
  playing: boolean;
}

export default function FlowPulse({ path, reverse, durationMs, playing }: Props) {
  const measure = useRef<SVGPathElement>(null);
  const bead = useRef<SVGGElement>(null);
  const tails = useRef<(SVGPathElement | null)[]>([]);
  // Progress along the hop, 0..1. Kept across re-renders so a speed change
  // or a dragged node mid-hop continues from where the comet is.
  const progress = useRef(0);
  const settings = useRef({ durationMs, playing, reverse });
  settings.current = { durationMs, playing, reverse };

  useLayoutEffect(() => {
    const m = measure.current;
    const length = m ? m.getTotalLength() : 0;
    const paint = () => {
      const t = progress.current;
      const rev = settings.current.reverse;
      if (m && bead.current && length > 0) {
        const p = m.getPointAtLength(length * (rev ? 1 - t : t));
        bead.current.setAttribute('transform', `translate(${p.x} ${p.y})`);
      }
      tails.current.forEach((el, i) => el?.setAttribute('stroke-dashoffset', String(rev ? t - 1 : TAIL[i].len - t)));
    };
    paint();
    if (!playing || progress.current >= 1) return;
    let frame = 0;
    let last = performance.now();
    const tick = (now: number) => {
      progress.current = Math.min(1, progress.current + (now - last) / Math.max(1, settings.current.durationMs));
      last = now;
      paint();
      if (progress.current < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [path, reverse, playing]);

  return (
    <g className="scn-pulse" style={{ pointerEvents: 'none' }}>
      <path ref={measure} d={path} fill="none" stroke="none" />
      {/* The hop, lit while the request is on it. */}
      <path className="scn-wire" d={path} fill="none" stroke={rc(PULSE_COLOR)} strokeWidth={14} strokeLinecap="round" />
      {/* The tail: three dashes that end at the bead, fading outwards. */}
      {TAIL.map((layer, i) => (
        <path
          key={i}
          ref={(el) => { tails.current[i] = el; }}
          d={path}
          pathLength={1}
          fill="none"
          stroke={rc(layer.color)}
          strokeWidth={layer.width}
          strokeOpacity={layer.opacity}
          strokeLinecap="round"
          strokeDasharray={`${layer.len} 1`}
        />
      ))}
      {/* The bead: a soft aura around a bright core. */}
      <g ref={bead} className="scn-bead">
        <circle r={14} fill={rc(PULSE_COLOR)} fillOpacity={0.18} />
        <circle r={8} fill={rc(PALE)} fillOpacity={0.6} />
        <circle r={4.5} fill={rc(CORE)} stroke={rc(PULSE_COLOR)} strokeWidth={2} />
      </g>
    </g>
  );
}
