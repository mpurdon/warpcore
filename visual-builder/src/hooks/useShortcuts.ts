// Every keyboard shortcut in the app, in one place. The sheet in
// ShortcutsHelp.tsx documents these; keep the two in step.
//
// Rules: modifier shortcuts work everywhere, including inside inputs, the
// way desktop apps behave. Bare keys (lens digits, ?, Delete) only fire
// when nothing editable has focus.

import { useEffect } from 'react';
import { useStore } from '../store/useStore';
import { canvas } from '../utils/canvasActions';
import { openProjectDialog, saveProject } from '../utils/projectIO';
import { blockedReason, runDeployment } from '../utils/deployRunner';
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
      const readOnly = s.locked && Boolean(s.configPath);

      // Cmd/Ctrl+R reloads the frontend in a dev build: the webview has no
      // menu for it, and a missed hot-reload otherwise looks like a bug.
      if (mod && key === 'r' && import.meta.env.DEV) {
        e.preventDefault();
        window.location.reload();
        return;
      }

      if (mod) {
        switch (key) {
          case 'k':
          case 'p':
            e.preventDefault();
            s.setPaletteOpen(!s.paletteOpen);
            return;
          case ',':
            e.preventDefault();
            s.openSettings();
            return;
          case 's':
            e.preventDefault();
            if (s.configPath) void saveProject();
            return;
          case 'o':
            e.preventDefault();
            void openProjectDialog();
            return;
          case 'd':
            e.preventDefault();
            if (!blockedReason('deploy')) void runDeployment('deploy');
            return;
          case 'z':
            if (editable) return;
            e.preventDefault();
            if (e.shiftKey) s.redo(); else s.undo();
            return;
          case 'y':
            if (editable) return;
            e.preventDefault();
            s.redo();
            return;
          case '0':
            e.preventDefault();
            canvas.fitView();
            return;
          case '=':
          case '+':
            e.preventDefault();
            canvas.zoomIn();
            return;
          case '-':
            e.preventDefault();
            canvas.zoomOut();
            return;
          default:
            return;
        }
      }

      if (e.key === 'Escape') {
        // Layered: the palette, then a dialog, then settings, then selection.
        // Modals that own Escape stop propagation before this runs.
        if (s.paletteOpen) { s.setPaletteOpen(false); return; }
        if (s.dialog) { s.closeDialog(); return; }
        if (editable) { (e.target as HTMLElement).blur(); return; }
        if (s.settingsOpen) { s.closeSettings(); return; }
        if (s.editingNode) { s.setEditingNode(null); return; }
        if (s.selectedNode) {
          s.setSelectedNode(null);
          s.setNodes(s.nodes.map((n) => (n.selected ? { ...n, selected: false } : n)));
        }
        return;
      }

      if (editable || e.altKey) return;

      if (e.key === '?') {
        e.preventDefault();
        s.openDialog('shortcuts');
        return;
      }

      const lens = LENSES.find((l) => l.key === e.key);
      if (lens && !s.settingsOpen && !s.paletteOpen && !s.dialog) {
        e.preventDefault();
        s.setLens(lens.id);
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
