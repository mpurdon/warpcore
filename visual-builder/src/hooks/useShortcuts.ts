// Every keyboard shortcut in the app. The keys come from the command
// registry (each command declares its own), so the sheet in
// ShortcutsHelp.tsx and the palette's hints read the same table. What is
// left here is the layering: Escape closes the top-most thing, playback
// keys only while a scenario is on the transport, lens digits only when no
// dialog is up.
//
// Rules: modifier shortcuts work everywhere, including inside inputs, the
// way desktop apps behave. Bare keys (lens digits, ?, Delete) only fire
// when nothing editable has focus.

import { useEffect } from 'react';
import { selectReadOnly, useStore } from '../store/useStore';
import { runFromUi, shortcuts } from '../commands';
import { LENSES } from '../utils/lenses';

function inEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;
}

export function useShortcuts({ deleteSelected }: { deleteSelected: () => void }) {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const s = useStore.getState();
      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();
      const editable = inEditable(e.target);
      const readOnly = selectReadOnly(s);

      // Cmd/Ctrl+R reloads the frontend in a dev build: the webview has no
      // menu for it, and a missed hot-reload otherwise looks like a bug.
      if (mod && key === 'r' && import.meta.env.DEV) {
        e.preventDefault();
        window.location.reload();
        return;
      }

      if (mod) {
        // Registry shortcuts: ⌘K, ⌘S, ⌘O, ⌘D, ⌘Z, ⇧⌘Z, ⌘0, ⌘=, ⌘-, ⌘,
        const hit = shortcuts().find((sc) => sc.mod && sc.key === key && sc.shift === e.shiftKey);
        if (hit) {
          if ((hit.command === 'project.undo' || hit.command === 'project.redo') && editable) return;
          e.preventDefault();
          void runFromUi(hit.command, {}, 'shortcut');
          return;
        }
        if (key === 'p') { e.preventDefault(); void runFromUi('view.palette', {}, 'shortcut'); return; }
        if (key === 'y' && !editable) { e.preventDefault(); void runFromUi('project.redo', {}, 'shortcut'); return; }
        if (key === '+') { e.preventDefault(); void runFromUi('view.zoomIn', {}, 'shortcut'); return; }
        return;
      }

      if (e.key === 'Escape') {
        // Layered: the palette, then a dialog, then settings, then selection.
        // Modals that own Escape stop propagation before this runs.
        if (s.paletteOpen) { s.setPaletteOpen(false); return; }
        if (s.dialog) { s.closeDialog(); return; }
        if (editable) { (e.target as HTMLElement).blur(); return; }
        if (s.settingsOpen) { s.closeSettings(); return; }
        if (s.editingNode) { s.setEditingNode(null); return; }
        if (s.selectedNode) { s.deselectAll(); return; }
        if (s.recording) { s.setRecording(false); return; }
        if (s.playhead) { s.stopPlayback(); return; }
        return;
      }

      if (editable || e.altKey) return;

      // Playback: space, [ and ] while a scenario is on the transport bar.
      if (s.playhead && !s.settingsOpen && !s.paletteOpen && !s.dialog) {
        if (e.key === ' ') { e.preventDefault(); void runFromUi('scenario.setPlaying', {}, 'shortcut'); return; }
        if (e.key === '[') { e.preventDefault(); void runFromUi('scenario.seek', { by: -1 }, 'shortcut'); return; }
        if (e.key === ']') { e.preventDefault(); void runFromUi('scenario.seek', { by: 1 }, 'shortcut'); return; }
      }

      if (e.key === '?') {
        e.preventDefault();
        void runFromUi('view.shortcuts', {}, 'shortcut');
        return;
      }

      const lens = LENSES.find((l) => l.key === e.key);
      if (lens && !s.settingsOpen && !s.paletteOpen && !s.dialog) {
        e.preventDefault();
        void runFromUi('view.lens', { lens: lens.id }, 'shortcut');
        return;
      }

      if ((e.key === 'Delete' || e.key === 'Backspace') && !s.settingsOpen && !readOnly && !s.paletteOpen && !s.dialog) {
        e.preventDefault();
        deleteSelected();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [deleteSelected]);
}
