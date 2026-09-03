// Opening a project file into the store. Shared by the toolbar's Open /
// Recent and by "Create project from account", which writes a file and then
// opens it the same way so there is exactly one loading path.

import { invoke } from '@tauri-apps/api/core';
import { useStore } from '../store/useStore';
import { parseYAMLToCanvas } from './configSync';
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
  // Every opened project starts locked; see ProjectLock.tsx.
  s.lock();

  const name = extractProjectName(content);
  s.setProjectName(name);
  addRecentProject(name, filePath);

  await invoke('watch_config_file', { path: filePath });
}
