// ⌘K. One box that finds any resource on the canvas and runs any action in
// the app. Selecting a resource selects it, opens the inspector and pans
// the canvas to it; everything else is what the toolbar, menus and
// settings already do, reachable without hunting for it.

import { useEffect, useMemo, useRef, useState } from 'react';
import { Search, CornerDownLeft } from 'lucide-react';
import { useStore } from '../store/useStore';
import { groupItems, PaletteItem, rankItems } from '../utils/palette';
import { paletteRows, runFromUi } from '../commands';
import { StatusDot } from './inspector/InspectorHeader';

export default function CommandPalette() {
  const s = useStore();
  const { paletteOpen, setPaletteOpen } = s;
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (paletteOpen) {
      setQuery('');
      setCursor(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [paletteOpen]);

  const close = () => setPaletteOpen(false);
  const after = (fn: () => void) => () => { close(); fn(); };

  // Every row comes from the command registry (commands/): the same
  // declarations the toolbar, the shortcuts and an assistant run. A row
  // the registry says is blocked still runs, so the reason is the answer.
  const items = useMemo<PaletteItem[]>(() => {
    if (!paletteOpen) return [];
    return paletteRows(s).map((row) => ({
      id: row.id,
      kind: 'command',
      group: row.group,
      title: row.title,
      subtitle: row.subtitle,
      keywords: row.keywords,
      shortcut: row.shortcut,
      tone: row.tone,
      run: after(() => { void runFromUi(row.command, row.args, 'palette'); }),
    }));
    // The palette rebuilds when it opens; the store fields it reads are
    // captured then, which is what a snapshot-style list wants.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paletteOpen, s.nodes, s.environmentConfigs, s.currentEnvironment, s.configPath, s.locked, s.lens, s.layers, s.rightPanelVisible, s.activityOpen, s.run, s.past.length, s.future.length, s.scenarios, s.playhead, s.selectedNode, s.systemView, s.holodeckPreview]);

  const ranked = useMemo(() => rankItems(query, items, query.trim() ? 40 : 200), [query, items]);
  const groups = useMemo(() => groupItems(ranked), [ranked]);
  const flat = ranked;

  useEffect(() => { setCursor(0); }, [query]);
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${cursor}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  if (!paletteOpen) return null;

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setCursor((c) => Math.min(flat.length - 1, c + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setCursor((c) => Math.max(0, c - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); flat[cursor]?.run(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
  };

  let index = -1;
  return (
    <div className="fixed inset-0 z-[80] bg-gray-900/30 backdrop-blur-[1px] flex items-start justify-center pt-[12vh]" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="w-[640px] max-w-[92vw] bg-white rounded-xl shadow-2xl border border-gray-200 overflow-hidden palette-enter" role="dialog" aria-label="Command palette">
        <div className="flex items-center gap-2 px-3 border-b border-gray-200">
          <Search size={16} className="text-gray-400 shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Find a resource, switch a lens, run a command…"
            className="flex-1 py-3 text-sm outline-none placeholder:text-gray-400 bg-transparent"
            spellCheck={false}
            autoComplete="off"
          />
          <kbd className="text-[10px] font-mono text-gray-400 border border-gray-200 rounded px-1">esc</kbd>
        </div>
        <div ref={listRef} className="max-h-[52vh] overflow-y-auto py-1">
          {flat.length === 0 && (
            <div className="px-4 py-8 text-sm text-gray-500 text-center">Nothing matches "{query}".</div>
          )}
          {groups.map((g) => (
            <div key={g.group}>
              <div className="px-4 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wide text-gray-400">{g.group}</div>
              {g.items.map((item) => {
                index += 1;
                const i = index;
                const active = i === cursor;
                return (
                  <button
                    key={item.id}
                    data-index={i}
                    onMouseEnter={() => setCursor(i)}
                    onClick={() => item.run()}
                    className={`w-full flex items-center gap-3 px-4 py-1.5 text-left ${active ? 'bg-blue-50' : ''}`}
                  >
                    {item.tone ? <StatusDot tone={item.tone} label="" /> : <span className="w-2" />}
                    <span className="flex-1 min-w-0">
                      <span className={`block text-sm truncate ${active ? 'text-blue-900' : 'text-gray-900'}`}>{item.title}</span>
                      {item.subtitle && <span className="block text-[11px] text-gray-500 truncate">{item.subtitle}</span>}
                    </span>
                    {item.shortcut && <kbd className="text-[10px] font-mono text-gray-400 border border-gray-200 rounded px-1 shrink-0">{item.shortcut}</kbd>}
                    {active && <CornerDownLeft size={12} className="text-blue-400 shrink-0" />}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
