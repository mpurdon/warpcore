import { useMemo, useState } from 'react';
import { Search, Check } from 'lucide-react';
import { GROUP_ORDER, groupRegions, regionInfo } from '../utils/regions';

interface Props {
  /** Every region the account can use. */
  available: string[];
  /** Currently checked region codes. */
  selected: string[];
  onChange: (regions: string[]) => void;
  /** Shown when `available` could not be fetched. */
  note?: string;
}

/**
 * Grouped, checkable region list.
 *
 * ~30 regions is too many to scan visually as a flat list, so they are grouped
 * geographically (US, Europe, Asia Pacific …) with a per-group toggle.
 */
export default function RegionPicker({ available, selected, onChange, note }: Props) {
  const [query, setQuery] = useState('');
  const chosen = useMemo(() => new Set(selected), [selected]);

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matching = available.filter((code) => {
      if (!q) return true;
      const info = regionInfo(code);
      return `${info.code} ${info.place} ${info.group}`.toLowerCase().includes(q);
    });
    return groupRegions(matching);
  }, [available, query]);

  const toggle = (code: string) => {
    const next = new Set(chosen);
    if (next.has(code)) next.delete(code);
    else next.add(code);
    onChange([...next]);
  };

  const toggleGroup = (codes: string[], allOn: boolean) => {
    const next = new Set(chosen);
    for (const code of codes) {
      if (allOn) next.delete(code);
      else next.add(code);
    }
    onChange([...next]);
  };

  return (
    <div className="text-gray-900">
      <div className="flex items-center gap-2 mb-3">
        <div className="relative flex-1">
          <Search size={14} className="absolute left-2 top-2 text-gray-400" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter regions"
            className="w-full text-sm border border-gray-300 rounded pl-7 pr-2 py-1"
          />
        </div>
        <span className="text-xs text-gray-500 whitespace-nowrap">
          {selected.length} selected
        </span>
        {selected.length > 0 && (
          <button
            onClick={() => onChange([])}
            className="text-xs text-gray-500 hover:text-gray-800 underline"
          >
            Clear
          </button>
        )}
      </div>

      {note && <p className="text-xs text-amber-700 mb-2">{note}</p>}

      <div className="max-h-72 overflow-y-auto pr-1">
        {groups.length === 0 && (
          <p className="text-sm text-gray-400 py-4 text-center">No regions match.</p>
        )}
        {groups.map(([group, regions]) => {
          const codes = regions.map((r) => r.code);
          const allOn = codes.every((c) => chosen.has(c));
          const someOn = !allOn && codes.some((c) => chosen.has(c));
          return (
            <div key={group} className="mb-3">
              <button
                onClick={() => toggleGroup(codes, allOn)}
                className="w-full flex items-center gap-2 text-left mb-1 group"
              >
                <span
                  className={`w-4 h-4 rounded border flex items-center justify-center ${
                    allOn ? 'bg-blue-600 border-blue-600'
                      : someOn ? 'bg-blue-100 border-blue-400' : 'border-gray-300'
                  }`}
                >
                  {allOn && <Check size={11} className="text-white" />}
                  {someOn && <span className="w-1.5 h-0.5 bg-blue-600 rounded" />}
                </span>
                <span className="text-xs font-semibold uppercase tracking-wide text-gray-500 group-hover:text-gray-800">
                  {group}
                </span>
                <span className="text-xs text-gray-400">{codes.length}</span>
              </button>
              <div className="grid grid-cols-2 gap-x-4 ml-6">
                {regions.map((r) => (
                  <label
                    key={r.code}
                    className="flex items-center gap-2 py-0.5 cursor-pointer text-sm hover:bg-gray-50 rounded px-1"
                  >
                    <input
                      type="checkbox"
                      checked={chosen.has(r.code)}
                      onChange={() => toggle(r.code)}
                    />
                    <span className="font-mono text-xs">{r.code}</span>
                    {r.place !== r.code && (
                      <span className="text-xs text-gray-400 truncate">{r.place}</span>
                    )}
                  </label>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Groups present in a set of codes, for a compact summary line. */
export function summariseRegions(selected: string[]): string {
  if (selected.length === 0) return 'none selected';
  const groups = new Set(selected.map((c) => regionInfo(c).group));
  const ordered = GROUP_ORDER.filter((g) => groups.has(g));
  return `${selected.length} region${selected.length === 1 ? '' : 's'} across ${ordered.join(', ')}`;
}
