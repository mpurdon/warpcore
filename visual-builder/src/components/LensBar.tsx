// The lens bar sits over the canvas: a segmented control for the lens (what
// the picture is about) and, beside it, the edge layers (the expert
// control the lens presets). Counts say how much each choice foregrounds so
// an empty lens is obviously empty. See lenses.ts and layers.ts.

import { useMemo, useState, useEffect, useRef } from 'react';
import { ChevronDown, Layers as LayersIcon } from 'lucide-react';
import { useReadOnly, useStore } from '../store/useStore';
import { LOCK_BANNER_HEIGHT } from './ProjectLock';
import { LAYERS, Layer } from '../utils/layers';
import { LENSES, countFocus } from '../utils/lenses';
import { countLevels, isStale, refreshLive } from '../utils/live';
import { RefreshCw } from 'lucide-react';

export default function LensBar() {
  const { nodes, edges, layers, setLayer, lens, setLens, selectedNode, liveHealth, liveBusy, reviewByArn, configPath } = useStore();
  // Sits below the lock band when there is one.
  const readOnly = useReadOnly();
  const [layersOpen, setLayersOpen] = useState(false);
  const popRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!layersOpen) return;
    const onDown = (e: MouseEvent) => {
      if (popRef.current && !popRef.current.contains(e.target as Node)) setLayersOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [layersOpen]);

  const edgeCounts = useMemo(() => {
    const c = Object.fromEntries(LAYERS.map((l) => [l.id, 0])) as Record<Layer, number>;
    for (const e of edges) {
      const layer = (e.data?.meta?.layer as Layer | undefined) ?? 'access';
      c[layer] = (c[layer] || 0) + 1;
    }
    return c;
  }, [edges]);
  const totalEdges = Object.values(edgeCounts).reduce((s, n) => s + n, 0);
  const shownEdges = LAYERS.filter((l) => layers[l.id]).reduce((s, l) => s + edgeCounts[l.id], 0);

  const visible = nodes.filter((n) => !n.hidden).length;
  const focusCounts = useMemo(
    () => Object.fromEntries(LENSES.map((l) => [l.id, countFocus(nodes, edges, l.id, selectedNode)])) as Record<string, number>,
    [nodes, edges, selectedNode],
  );

  const liveArns = useMemo(() => nodes.filter((n) => !n.hidden && n.data?.arn).map((n) => n.data.arn as string), [nodes]);
  const liveCounts = useMemo(() => countLevels(liveHealth, reviewByArn, liveArns), [liveHealth, reviewByArn, liveArns]);
  const liveError = (liveHealth as { error?: string } | null)?.error;
  const liveStale = isStale(liveHealth);

  if (visible === 0) return null;

  return (
    <div className="absolute left-3 z-20 flex items-center gap-2 text-xs" style={{ top: 12 + (readOnly ? LOCK_BANNER_HEIGHT : 0) }}>
      <div className="flex items-center bg-surface/95 backdrop-blur border border-gray-200 rounded-lg shadow-sm p-0.5" role="tablist" aria-label="Lens">
        {LENSES.map((l) => {
          const on = lens === l.id;
          const count = focusCounts[l.id];
          return (
            <button
              key={l.id}
              role="tab"
              aria-selected={on}
              onClick={() => setLens(l.id)}
              className={`px-2.5 py-1 rounded-md flex items-center gap-1.5 transition-colors ${on ? 'bg-strong text-on-strong' : 'text-gray-700 hover:bg-gray-100'}`}
              title={`${l.description} · press ${l.key}`}
            >
              <span className="font-medium">{l.label}</span>
              {l.id !== 'all' && l.id !== 'cost' && (
                <span className={`tabular-nums ${on ? 'text-gray-300' : 'text-gray-400'}`}>{count}</span>
              )}
            </button>
          );
        })}
      </div>

      {lens === 'live' && (
        <div className="flex items-center gap-2 px-2.5 py-1.5 bg-surface/95 backdrop-blur border border-gray-200 rounded-lg shadow-sm text-gray-700" data-testid="live-status">
          {liveHealth && !liveError && (
            <span className="flex items-center gap-1.5 tabular-nums">
              {liveCounts.bad > 0 && <span className="text-red-700">{liveCounts.bad} bad</span>}
              {liveCounts.warn > 0 && <span className="text-amber-700">{liveCounts.warn} warn</span>}
              <span className="text-green-700">{liveCounts.ok} ok</span>
              {liveCounts.unknown > 0 && <span className="text-gray-400">{liveCounts.unknown} unchecked</span>}
            </span>
          )}
          {liveError && <span className="text-red-700 truncate max-w-[16rem]" title={liveError}>could not read the account</span>}
          {!liveHealth && !liveBusy && <span className="text-gray-500">{configPath ? 'not read yet' : 'save the project to read the account'}</span>}
          <span className={`text-gray-400 ${liveStale && liveHealth ? 'italic' : ''}`}>
            {liveBusy ? 'reading…' : liveHealth && !liveError ? `read ${new Date(liveHealth.checked_at).toLocaleTimeString()}${liveStale ? ', stale' : ''}` : ''}
          </span>
          <button
            onClick={() => { void refreshLive(); }}
            disabled={liveBusy || !configPath}
            className="p-0.5 rounded hover:bg-gray-100 disabled:opacity-40"
            title="Read the account again"
          >
            <RefreshCw size={12} className={liveBusy ? 'animate-spin' : ''} />
          </button>
        </div>
      )}

      <div className="relative" ref={popRef}>
        <button
          onClick={() => setLayersOpen((o) => !o)}
          className="flex items-center gap-1.5 px-2.5 py-1.5 bg-surface/95 backdrop-blur border border-gray-200 rounded-lg shadow-sm text-gray-700 hover:bg-gray-50"
          title="Which kinds of edges are drawn"
        >
          <LayersIcon size={13} className="text-gray-500" />
          <span>Edges</span>
          <span className="text-gray-400 tabular-nums">{shownEdges}/{totalEdges}</span>
          <ChevronDown size={12} className={`text-gray-400 transition-transform ${layersOpen ? 'rotate-180' : ''}`} />
        </button>
        {layersOpen && (
          <div className="absolute top-full left-0 mt-1 w-72 bg-surface border border-gray-200 rounded-lg shadow-lg p-2">
            {LAYERS.map((l) => (
              <label key={l.id} className="flex items-start gap-2 px-1 py-1.5 cursor-pointer hover:bg-gray-50 rounded" title={l.description}>
                <input type="checkbox" checked={layers[l.id]} onChange={(e) => setLayer(l.id, e.target.checked)} className="mt-0.5" />
                <span className="flex-1">
                  <span className="text-gray-800">{l.label}</span>
                  <span className="block text-[10px] text-gray-500 leading-tight">{l.description}</span>
                </span>
                <span className="text-gray-500 tabular-nums">{edgeCounts[l.id]}</span>
              </label>
            ))}
            <p className="text-[10px] text-gray-400 px-1 pt-1.5">Choosing a lens resets these. Selecting a node shows all of its edges, dimmed for layers that are off.</p>
          </div>
        )}
      </div>
    </div>
  );
}
