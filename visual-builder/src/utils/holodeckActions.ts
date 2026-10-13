// What the Holodeck does to the store: preview an entry in memory, close
// the preview and put back what was open, save a copy as a project, and
// load a custom template. All of them go through the store's one project
// loader, which also fits the view once the nodes are measured; this
// module only decides what to load and when to refuse.

import { invoke } from '@tauri-apps/api/core';
import { DEFAULT_ENVIRONMENT_CONFIGS, DEFAULT_EXECUTIONS_PER_MONTH, EMPTY_PROJECT, useStore } from '../store/useStore';
import type { HolodeckEntry } from './holodeck';
import { generateYAMLFromCanvas } from './configSync';
import { isActive } from './deployEvents';
import { joinPath } from './host';
import { openProjectFile } from './projectIO';
import { applyTemplate, Template } from './templates';

/** Why the canvas cannot be replaced right now, or null when it can. Nothing is ever lost to a preview. */
export function replaceBlockedReason(): string | null {
  const s = useStore.getState();
  if (isActive(s.run)) return 'A deploy is running. Wait for it to finish.';
  if (s.hasUnsavedChanges && (s.nodes.length > 0 || s.configPath)) {
    return s.configPath
      ? 'The project has changes that are still being saved. Try again in a moment.'
      : 'This canvas has unsaved work. Save it as a template under Mine, or clear it, before loading something else.';
  }
  return null;
}

// React Flow writes measurements and selection into the node objects; the
// library's copies stay pristine for the next preview and for Save a copy.
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/**
 * Preview an entry: on the canvas, read-only, no file. Whatever was open is
 * stashed the first time and restored by closePreview. Returns the reason
 * when refused: something unsaved would be lost.
 */
export function previewEntry(entry: HolodeckEntry): string | null {
  const reason = replaceBlockedReason();
  if (reason) return reason;
  const s = useStore.getState();
  s.beginHolodeckPreview(entry.meta, {
    ...EMPTY_PROJECT,
    nodes: clone(entry.nodes), edges: clone(entry.edges), scenarios: clone(entry.scenarios),
    projectName: entry.meta.name, holodeck: entry.meta,
  });
  s.closeDialog();
  s.closeSettings();
  s.setRightPanelVisible(true);
  // The entry is read through its scenarios, which need the whole picture; a lens left on from before would hide most of it.
  s.setLens('all');
  return null;
}

/** Leave the preview: what was open comes back, or the canvas is empty again. */
export function closePreview(): void {
  const s = useStore.getState();
  if (!s.holodeckPreview) return;
  const stash = s.endHolodeckPreview();
  s.loadProject(stash ?? EMPTY_PROJECT);
}

/**
 * Write the entry as `<parentDir>/<name>/warpcore.yaml` and open it,
 * unlocked: from here it is the user's project. The copy replaces any
 * preview.
 */
export async function saveCopy(entry: HolodeckEntry, parentDir: string, name: string): Promise<string> {
  const yaml = generateYAMLFromCanvas(entry.nodes, entry.edges, DEFAULT_EXECUTIONS_PER_MONTH, DEFAULT_ENVIRONMENT_CONFIGS, {}, name, entry.scenarios, entry.meta);
  const path = joinPath(parentDir, name, 'warpcore.yaml');
  await invoke('write_config_file', { path, content: yaml });
  await openProjectFile(path);
  const s = useStore.getState();
  s.unlock();
  s.closeDialog();
  return path;
}

/** A custom template onto a fresh, unsaved canvas, with new ids. Returns the reason when refused. */
export function loadTemplate(template: Template): string | null {
  const reason = replaceBlockedReason();
  if (reason) return reason;
  const s = useStore.getState();
  s.loadProject({ ...EMPTY_PROJECT, ...applyTemplate(template) });
  s.closeDialog();
  return null;
}
