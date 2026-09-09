// Opening and saving the project file. Shared by the toolbar's Open / Recent
// / auto-save, by "Create project from account", by ⌘S and ⌘O, and by the
// command palette, so there is exactly one loading path and one saving path.

import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { useStore } from '../store/useStore';

/** Lowercase letters, digits and hyphens, starting with a letter: what the CLI accepts as a project name. */
export const PROJECT_NAME_RE = /^[a-z][a-z0-9-]*$/;
export const PROJECT_NAME_RULE = 'Lowercase letters, digits and hyphens, starting with a letter.';

/** The OS folder picker; null when dismissed. */
export async function chooseDirectory(defaultPath: string, title: string): Promise<string | null> {
  const picked = await open({ directory: true, defaultPath: defaultPath || undefined, title });
  return picked && typeof picked === 'string' ? picked : null;
}
import { generateYAMLFromCanvas, parseYAMLToCanvas } from './configSync';
import { addRecentProject, extractProjectName } from './recentProjects';

export async function openProjectFile(filePath: string): Promise<void> {
  const content = await invoke<string>('read_config_file', { path: filePath });
  const parsed = parseYAMLToCanvas(content);
  const name = extractProjectName(content);
  const s = useStore.getState();
  // Every opened project starts locked; see ProjectLock.tsx.
  s.loadProject({
    nodes: parsed.nodes, edges: parsed.edges, scenarios: parsed.scenarios,
    environmentConfigs: parsed.environmentConfigs, environmentExtras: parsed.environmentExtras, executionsPerMonth: parsed.executionsPerMonth,
    configPath: filePath, projectName: name, currentEnvironment: s.currentEnvironment, locked: true, holodeck: parsed.holodeck,
  });
  addRecentProject(name, filePath);
  await invoke('watch_config_file', { path: filePath });
}

/** Show the OS file picker and open what the operator chooses. */
export async function openProjectDialog(): Promise<void> {
  const { prefs } = useStore.getState();
  const selected = await open({
    filters: [{ name: 'YAML', extensions: ['yaml', 'yml'] }],
    defaultPath: prefs.projectsDir || undefined,
  });
  if (selected && typeof selected === 'string') {
    await openProjectFile(selected);
  }
}

// When we last wrote the file, so the file watcher's echo of our own save
// is not mistaken for an external edit.
let lastSaveTime = 0;
const IGNORE_WATCHER_MS = 2000;

/** True when a change event is most likely the echo of our own save. */
export function isOwnSaveEcho(now = Date.now()): boolean {
  return now - lastSaveTime < IGNORE_WATCHER_MS;
}

/**
 * Write the canvas to warpcore.yaml. Returns false when there is no file to
 * write to (an unsaved canvas): the caller decides whether to ask for one.
 */
export async function saveProject(): Promise<boolean> {
  const s = useStore.getState();
  if (!s.configPath) return false;
  s.setSaving(true);
  try {
    // Keep the project's name across saves: deriving it from the first agent
    // renamed every project after its first function.
    const yamlContent = generateYAMLFromCanvas(
      s.nodes, s.edges, s.executionsPerMonth, s.environmentConfigs, s.environmentExtras, s.projectName || undefined, s.scenarios, s.holodeck,
    );
    await invoke('write_config_file', { path: s.configPath, content: yamlContent });
    lastSaveTime = Date.now();
    useStore.getState().setHasUnsavedChanges(false);
    addRecentProject(extractProjectName(yamlContent), s.configPath);
    return true;
  } catch (error) {
    console.error('Failed to save file:', error);
    return false;
  } finally {
    useStore.getState().setSaving(false);
  }
}
