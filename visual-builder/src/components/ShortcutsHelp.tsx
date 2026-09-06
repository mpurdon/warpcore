// The shortcut sheet. Everything listed here is implemented in
// hooks/useShortcuts.ts; keep the two in step.

import { X } from 'lucide-react';
import { useEffect } from 'react';
import { LENSES } from '../utils/lenses';

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
export const MOD = IS_MAC ? '⌘' : 'Ctrl';

export const SHORTCUT_GROUPS: { title: string; items: { keys: string[]; what: string }[] }[] = [
  {
    title: 'Find and move',
    items: [
      { keys: [`${MOD} K`], what: 'Command palette: find a resource or run anything' },
      { keys: [`${MOD} 0`], what: 'Fit the whole canvas in view' },
      { keys: [`${MOD} =`, `${MOD} -`], what: 'Zoom in and out' },
      { keys: ['Esc'], what: 'Close what is open, else clear the selection' },
      { keys: ['?'], what: 'This sheet' },
    ],
  },
  {
    title: 'Lenses',
    items: LENSES.map((l) => ({ keys: [l.key], what: `${l.label}: ${l.description}` })),
  },
  {
    title: 'Edit',
    items: [
      { keys: [`${MOD} Z`], what: 'Undo' },
      { keys: [`⇧ ${MOD} Z`], what: 'Redo' },
      { keys: ['⌫', 'Del'], what: 'Delete the selected resources or connection' },
      { keys: ['⇧ drag'], what: 'Select several resources' },
      { keys: ['Double-click'], what: 'Configure a resource, or edit a connection\'s role' },
    ],
  },
  {
    title: 'Project',
    items: [
      { keys: [`${MOD} O`], what: 'Open a project' },
      { keys: [`${MOD} S`], what: 'Save now (changes also auto-save)' },
      { keys: [`${MOD} D`], what: 'Deploy the current environment (when unlocked)' },
      { keys: [`${MOD} ,`], what: 'Application settings' },
    ],
  },
];

export default function ShortcutsHelp({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-[75] bg-gray-900/30 flex items-center justify-center p-6" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="bg-white rounded-xl shadow-2xl border border-gray-200 w-[720px] max-w-full max-h-[85vh] overflow-y-auto">
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-200">
          <h2 className="text-base font-semibold text-gray-900">Keyboard shortcuts</h2>
          <button onClick={onClose} className="p-1 rounded text-gray-400 hover:text-gray-700 hover:bg-gray-100" title="Close (Esc)"><X size={16} /></button>
        </div>
        <div className="grid grid-cols-2 gap-x-8 gap-y-5 p-5">
          {SHORTCUT_GROUPS.map((g) => (
            <section key={g.title}>
              <h3 className="text-[10px] font-semibold uppercase tracking-wide text-gray-400 mb-2">{g.title}</h3>
              <ul className="space-y-1.5">
                {g.items.map((it) => (
                  <li key={it.what} className="flex items-start justify-between gap-3 text-xs">
                    <span className="text-gray-700">{it.what}</span>
                    <span className="flex gap-1 shrink-0">
                      {it.keys.map((k) => <kbd key={k} className="font-mono text-[10px] text-gray-600 bg-gray-50 border border-gray-200 rounded px-1.5 py-0.5">{k}</kbd>)}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
