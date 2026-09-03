// Map layers for the canvas. Sits over the canvas; counts show how many
// edges each layer holds so an empty layer is obviously empty.

import { useMemo, useState } from 'react';
import { ChevronDown, ChevronUp, Layers as LayersIcon } from 'lucide-react';
import { useStore } from '../store/useStore';
import { LAYERS, Layer } from '../utils/layers';

export default function LayersControl() {
  const { edges, layers, setLayer } = useStore();
  const [open, setOpen] = useState(false);

  const counts = useMemo(() => {
    const c = Object.fromEntries(LAYERS.map((l) => [l.id, 0])) as Record<Layer, number>;
    for (const e of edges) {
      const layer = (e.data?.meta?.layer as Layer | undefined) ?? 'access';
      c[layer] = (c[layer] || 0) + 1;
    }
    return c;
  }, [edges]);

  const total = Object.values(counts).reduce((s, n) => s + n, 0);
  if (total === 0) return null;
  const shown = LAYERS.filter((l) => layers[l.id]).reduce((s, l) => s + counts[l.id], 0);

  return (
    <div className="absolute top-3 right-3 z-20 bg-white/95 backdrop-blur border border-gray-200 rounded-lg shadow text-xs">
      <button onClick={() => setOpen((o) => !o)} className="flex items-center gap-2 px-3 py-2 w-full text-left hover:bg-gray-50 rounded-lg">
        <LayersIcon size={14} className="text-gray-500" />
        <span className="font-medium text-gray-800">Layers</span>
        <span className="text-gray-500">{shown} of {total} edges</span>
        {open ? <ChevronUp size={12} className="text-gray-400" /> : <ChevronDown size={12} className="text-gray-400" />}
      </button>
      {open && (
        <div className="border-t border-gray-100 px-2 py-1 w-64">
          {LAYERS.map((l) => (
            <label key={l.id} className="flex items-start gap-2 px-1 py-1.5 cursor-pointer hover:bg-gray-50 rounded" title={l.description}>
              <input type="checkbox" checked={layers[l.id]} onChange={(e) => setLayer(l.id, e.target.checked)} className="mt-0.5" />
              <span className="flex-1">
                <span className="text-gray-800">{l.label}</span>
                <span className="block text-[10px] text-gray-500 leading-tight">{l.description}</span>
              </span>
              <span className="text-gray-500 tabular-nums">{counts[l.id]}</span>
            </label>
          ))}
          <p className="text-[10px] text-gray-400 px-1 pt-1 pb-0.5">Selecting a node shows all of its edges, dimmed for layers that are off.</p>
        </div>
      )}
    </div>
  );
}
