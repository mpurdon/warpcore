// Opening and saving the project file. Shared by the toolbar's Open / Recent
// / auto-save, by "Create project from account", by ⌘S and ⌘O, and by the
// command palette, so there is exactly one loading path and one saving path.

import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { useStore } from '../store/useStore';
import { generateYAMLFromCanvas, parseYAMLToCanvas } from './configSync';
import { addRecentProject, extractProjectName } from './recentProjects';

export async function openProjectFile(filePath: string): Promise<void> {
  const content = await invoke<string>('read_config_file', { path: filePath });
  const parsed = parseYAMLToCanvas(content);
  const s = useStore.getState();
  s.setNodes(parsed.nodes);
  s.setEdges(parsed.edges);
  s.setEnvironmentConfigs(parsed.environmentConfigs);
  s.setEnvironmentExtras(parsed.environmentExtras);
  s.setConfigPath(filePath);
  s.setHasUnsavedChanges(false);
  s.setExecutionsPerMonth(parsed.executionsPerMonth);
  // A project's current environment must be one it has.
  if (!parsed.environmentConfigs[s.currentEnvironment]) {
    const first = Object.keys(parsed.environmentConfigs)[0];
    if (first) s.setCurrentEnvironment(first);
  }
  s.setSelectedNode(null);
  s.inspectEnvironment(null);
  s.setEditingNode(null);
  // Loading is not an edit: nothing to undo, nothing dirty.
  s.resetHistory();
  s.setHasUnsavedChanges(false);
  // Every opened project starts locked; see ProjectLock.tsx.
  s.lock();

  const name = extractProjectName(content);
  s.setProjectName(name);
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
      s.nodes, s.edges, s.executionsPerMonth, s.environmentConfigs, s.environmentExtras, s.projectName || undefined,
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
