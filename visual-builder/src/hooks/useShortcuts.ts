// Every keyboard shortcut in the app comes from the command registry: each
// command declares its keys, whether they fire inside a text field and
// whether they fire over a dialog, and the sheet in ShortcutsHelp.tsx reads
// the same table. What is left here is Escape, which closes the top-most
// thing and so depends on what is open, and the dev-build reload.

import { useEffect } from 'react';
import { useStore } from '../store/useStore';
import { runFromUi, shortcuts } from '../commands';

function inEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;
}

export function useShortcuts() {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const s = useStore.getState();
      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key.toLowerCase();
      const editable = inEditable(e.target);
      const overDialog = Boolean(s.paletteOpen || s.dialog || s.settingsOpen);

      // Cmd/Ctrl+R reloads the frontend in a dev build: the webview has no
      // menu for it, and a missed hot-reload otherwise looks like a bug.
      if (mod && key === 'r' && import.meta.env.DEV) {
        e.preventDefault();
        window.location.reload();
        return;
      }

      if (e.key === 'Escape') {
        // Layered: the palette, then a dialog, then a field, then settings,
        // then the form, then the selection, then recording, then playback.
        // Modals that own Escape stop propagation before this runs.
        if (s.paletteOpen) { s.setPaletteOpen(false); return; }
        if (s.dialog) { void runFromUi('view.closeDialog', {}, 'shortcut'); return; }
        if (editable) { (e.target as HTMLElement).blur(); return; }
        if (s.settingsOpen) { s.closeSettings(); return; }
        if (s.editingNode) { s.setEditingNode(null); return; }
        if (s.selectedNode) { void runFromUi('view.deselect', {}, 'shortcut'); return; }
        if (s.recording) { void runFromUi('scenario.record', { on: false }, 'shortcut'); return; }
        if (s.playhead) { void runFromUi('scenario.stop', {}, 'shortcut'); return; }
        return;
      }

      if (e.altKey) return;
      const hit = shortcuts().find((sc) => sc.mod === mod && sc.shift === e.shiftKey && sc.keys.includes(e.key === ' ' ? ' ' : key));
      if (!hit) return;
      if (editable && !hit.inEditable) return;
      if (overDialog && !hit.overDialogs) return;
      e.preventDefault();
      void runFromUi(hit.command, hit.args, 'shortcut');
    };

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);
}
