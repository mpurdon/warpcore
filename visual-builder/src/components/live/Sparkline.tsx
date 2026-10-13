// A metric's shape over the window: one line, no axes, the latest value
// beside it. Enough to tell "idle" from "busy" from "spiked at 03:00"
// without leaving the card.

import { rc } from '../../utils/theme';

interface Props {
  points: { t: string; v: number }[];
  width?: number;
  height?: number;
  color?: string;
  /** Fill under the line. */
  area?: boolean;
}

export default function Sparkline({ points, width = 120, height = 28, color = 'var(--c-blue-600)', area = true }: Props) {
  if (points.length < 2) return <svg width={width} height={height} aria-hidden />;
  const values = points.map((p) => p.v);
  const min = Math.min(...values, 0);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pad = 2;
  const x = (i: number) => pad + (i / (points.length - 1)) * (width - pad * 2);
  const y = (v: number) => height - pad - ((v - min) / span) * (height - pad * 2);
  const line = points.map((p, i) => `${x(i).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
  const last = points[points.length - 1];
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="shrink-0" aria-hidden>
      {area && (
        <polygon points={`${x(0).toFixed(1)},${height - pad} ${line} ${x(points.length - 1).toFixed(1)},${height - pad}`} fill={rc(color)} fillOpacity={0.12} />
      )}
      <polyline points={line} fill="none" stroke={rc(color)} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={x(points.length - 1)} cy={y(last.v)} r={2} fill={rc(color)} />
    </svg>
  );
}
