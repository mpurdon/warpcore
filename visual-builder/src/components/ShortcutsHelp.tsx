// The shortcut sheet, read from the command registry: a command's own
// shortcut declaration is the one place a key is written down.

import { X } from 'lucide-react';
import { useEffect } from 'react';
import { LENSES } from '../utils/lenses';
import { shortcuts } from '../commands';
import { GROUPS } from '../commands/types';

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
export const MOD = IS_MAC ? '⌘' : 'Ctrl';

/** Bindings in the registry read ⌘; the sheet says what this platform calls it. */
const platform = (label: string) => label.replace('⌘', `${MOD} `).replace(/\s+/g, ' ').trim();

/** The mouse and Escape, which the registry does not cover. */
const MANUAL: { title: string; items: { keys: string[]; what: string }[] }[] = [
  {
    title: 'Mouse and Esc',
    items: [
      { keys: ['Esc'], what: 'Close what is open, else clear the selection, else stop recording or playback' },
      { keys: ['⇧ drag'], what: 'Select several resources' },
      { keys: ['Double-click'], what: 'Configure a resource, or edit a connection\'s role' },
    ],
  },
];

/** Every binding, grouped the way the palette groups commands. Read from the registry, so nothing here goes stale. */
export function shortcutGroups(): { title: string; items: { keys: string[]; what: string }[] }[] {
  const byGroup = new Map<string, { keys: string[]; what: string }[]>();
  for (const sc of shortcuts()) {
    const what = sc.command === 'view.lens' ? `Lens: ${LENSES.find((l) => l.id === sc.args.lens)?.label ?? ''}` : sc.what.replace(/\s*Omit `\w+` to toggle\.$/, '');
    const list = byGroup.get(sc.group) ?? [];
    const existing = list.find((it) => it.what === what);
    if (existing) existing.keys.push(platform(sc.label));
    else list.push({ keys: [platform(sc.label)], what });
    byGroup.set(sc.group, list);
  }
  return [...GROUPS.filter((g) => byGroup.has(g)).map((g) => ({ title: g, items: byGroup.get(g)! })), ...MANUAL];
}

export default function ShortcutsHelp({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-[75] bg-black/40 flex items-center justify-center p-6" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="bg-surface rounded-xl shadow-2xl border border-gray-200 w-[720px] max-w-full max-h-[85vh] overflow-y-auto">
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-200">
          <h2 className="text-base font-semibold text-gray-900">Keyboard shortcuts</h2>
          <button onClick={onClose} className="p-1 rounded text-gray-400 hover:text-gray-700 hover:bg-gray-100" title="Close (Esc)"><X size={16} /></button>
        </div>
        <div className="grid grid-cols-2 gap-x-8 gap-y-5 p-5">
          {shortcutGroups().map((g) => (
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
