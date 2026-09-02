import { RegionProgress, phaseLabel, regionFraction } from '../utils/accountExplorer';
import { regionInfo } from '../utils/regions';

interface Props {
  regions: Map<string, RegionProgress>;
  elapsed: number;
  parallelism?: number;
}

// Phase dot colours. `skipped` is deliberately distinct from `done`: Resource
// Explorer being absent is worth seeing, not worth alarming about.
const PHASE_STYLE: Record<string, string> = {
  pending: 'bg-gray-200',
  running: 'bg-blue-500 animate-pulse',
  done: 'bg-emerald-500',
  skipped: 'bg-gray-300',
  failed: 'bg-red-500',
};

/**
 * Live view of a running scan: one row per region with a progress bar, and
 * beneath each active region a map of the services being enumerated.
 */
export default function ScanProgressView({ regions, elapsed, parallelism }: Props) {
  const rows = [...regions.values()];
  const done = rows.filter((r) => r.status === 'done' || r.status === 'failed');
  const scanning = rows.filter((r) => r.status === 'scanning');
  const found = rows.reduce((n, r) => n + r.count, 0);
  const overall = rows.length
    ? rows.reduce((n, r) => n + regionFraction(r), 0) / rows.length
    : 0;

  // Busiest first so the active regions stay at the top rather than jumping
  // around as they finish.
  const order = { scanning: 0, pending: 1, done: 2, failed: 3 } as const;
  rows.sort(
    (a, b) => order[a.status] - order[b.status] || a.region.localeCompare(b.region),
  );

  return (
    <div className="p-4">
      {/* Overall */}
      <div className="mb-5">
        <div className="flex items-baseline justify-between mb-1">
          <span className="text-sm font-medium">
            {done.length} of {rows.length} regions · {found.toLocaleString()} resources
          </span>
          <span className="text-xs text-gray-500 tabular-nums">
            {elapsed}s
            {parallelism ? ` · ${scanning.length}/${parallelism} in flight` : ''}
          </span>
        </div>
        <div className="h-2 bg-gray-200 rounded overflow-hidden">
          <div
            className="h-full bg-blue-600 transition-all duration-300"
            style={{ width: `${Math.round(overall * 100)}%` }}
          />
        </div>
      </div>

      {/* Per region */}
      <div className="space-y-2">
        {rows.map((r) => {
          const info = regionInfo(r.region);
          const pct = Math.round(regionFraction(r) * 100);
          const barColour =
            r.status === 'failed' ? 'bg-red-500'
              : r.status === 'done' ? 'bg-emerald-500'
                : 'bg-blue-500';
          return (
            <div
              key={r.region}
              className={`rounded border px-3 py-2 ${
                r.status === 'scanning' ? 'border-blue-200 bg-blue-50/40' : 'border-gray-200'
              }`}
            >
              <div className="flex items-center gap-2 mb-1">
                <span className="font-mono text-sm">{r.region}</span>
                <span className="text-xs text-gray-400">{info.place !== r.region ? info.place : ''}</span>
                <div className="flex-1" />
                {r.status === 'done' && (
                  <span className="text-xs text-gray-600">
                    {r.count.toLocaleString()} resources
                    {r.errors > 0 && <span className="text-amber-600"> · {r.errors} errors</span>}
                  </span>
                )}
                {r.status === 'failed' && (
                  <span className="text-xs text-red-600 truncate max-w-[50%]" title={r.error}>
                    {r.error || 'failed'}
                  </span>
                )}
                {r.status === 'scanning' && (
                  <span className="text-xs text-blue-600 tabular-nums">{pct}%</span>
                )}
                {r.status === 'pending' && <span className="text-xs text-gray-400">queued</span>}
              </div>

              <div className="h-1.5 bg-gray-200 rounded overflow-hidden">
                <div
                  className={`h-full ${barColour} transition-all duration-300`}
                  style={{ width: `${pct}%` }}
                />
              </div>

              {/* Service map: only for the region actually being worked on,
                  otherwise the view is a wall of dots. */}
              {r.status === 'scanning' && r.plan.length > 0 && (
                <div className="flex flex-wrap gap-1 mt-2">
                  {r.plan.map((phase) => {
                    const state = r.phases[phase] || 'pending';
                    const count = r.found[phase];
                    return (
                      <span
                        key={phase}
                        title={`${phaseLabel(phase)}: ${state}${count != null ? ` (${count})` : ''}`}
                        className={`inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border ${
                          state === 'running'
                            ? 'border-blue-300 bg-white text-blue-700'
                            : state === 'pending'
                              ? 'border-gray-200 text-gray-400'
                              : 'border-gray-200 bg-white text-gray-600'
                        }`}
                      >
                        <span className={`w-1.5 h-1.5 rounded-full ${PHASE_STYLE[state]}`} />
                        {phaseLabel(phase)}
                        {count != null && count > 0 && (
                          <span className="text-gray-400">{count}</span>
                        )}
                      </span>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
