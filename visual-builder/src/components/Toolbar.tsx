// Three groups, left to right: scope (project, environment), tasks (scan,
// explore, templates) and actions (deploy, destroy, inspector). The project
// name and the environment selector are selection surfaces: clicking them
// puts that object in the inspector. See DESIGN_GUIDANCE.md §5.3.

import { Play, Trash2, FileText, FolderSearch, PanelRight, Radar } from 'lucide-react';
import { useCurrentEnvName, useStore } from '../store/useStore';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { generateYAMLFromCanvas } from '../utils/configSync';
import { useEffect, useState, useRef, useCallback } from 'react';
import { listen } from '@tauri-apps/api/event';
import TemplateModal from './TemplateModal';
import FileMenu from './FileMenu';
import EnvironmentSelector from './EnvironmentSelector';
import ProjectDiscoveryPanel from './ProjectDiscoveryPanel';
import AccountExplorerPanel from './AccountExplorerPanel';
import { addRecentProject, extractProjectName } from '../utils/recentProjects';
import { openProjectFile } from '../utils/projectIO';
import { dirname } from '../utils/paths';
import { useAppPaths } from '../utils/useAppPaths';
import { LockControl } from './ProjectLock';
import DevBuildBadge from './DevBuildBadge';

// Debounce delay for auto-save (ms)
const AUTO_SAVE_DELAY = 1000;

export default function Toolbar() {
  const {
    nodes,
    edges,
    setNodes,
    configPath,
    projectName,
    hasUnsavedChanges,
    setHasUnsavedChanges,
    currentEnvironment,
    environmentConfigs,
    environmentExtras,
    isDeploying,
    setIsDeploying,
    executionsPerMonth,
    rightPanelVisible,
    setRightPanelVisible,
    debugMode,
    prefs,
    inspectEnvironment,
    setSelectedNode,
    settingsOpen,
    closeSettings,
    locked,
  } = useStore();

  const [showTemplateModal, setShowTemplateModal] = useState(false);
  const [showDiscoveryPanel, setShowDiscoveryPanel] = useState(false);
  const [showAccountExplorer, setShowAccountExplorer] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const { paths: appInfo } = useAppPaths();
  const envName = useCurrentEnvName();

  // Track last save time to ignore file watcher events triggered by our saves
  const lastSaveTimeRef = useRef<number>(0);
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // How long to ignore file watcher events after a save (ms)
  const IGNORE_WATCHER_DURATION = 2000;

  // Global CLI flags. --dev and --log-level are options on the top-level
  // click group, so they go before the subcommand.
  const cliFlags = debugMode ? ['--dev'] : ['--log-level', prefs.logLevel];

  const openConfigFile = async (filePath: string) => {
    try {
      await openProjectFile(filePath);
    } catch (error) {
      console.error('Failed to open file:', error);
    }
  };

  // Listen for file changes (only from external editors)
  useEffect(() => {
    const unlisten = listen('config-file-changed', async (event) => {
      const changedPath = event.payload as string;

      // Ignore if path doesn't match
      if (changedPath !== configPath) {
        return;
      }

      // Ignore if this event is likely from our own save (within the ignore window)
      const timeSinceLastSave = Date.now() - lastSaveTimeRef.current;
      if (timeSinceLastSave < IGNORE_WATCHER_DURATION) {
        console.log('Ignoring file change event (likely from our own save)');
        return;
      }

      const shouldReload = confirm('Configuration file changed externally. Reload?');
      if (shouldReload) {
        await openConfigFile(changedPath);
      }
    });

    return () => {
      unlisten.then(fn => fn());
    };
  }, [configPath]);

  const handleOpen = async () => {
    const selected = await open({
      filters: [{ name: 'YAML', extensions: ['yaml', 'yml'] }],
      defaultPath: prefs.projectsDir || undefined,
    });

    if (selected && typeof selected === 'string') {
      await openConfigFile(selected);
    }
  };

  const handleOpenRecent = async (filePath: string) => {
    await openConfigFile(filePath);
  };

  // Core save function
  const performSave = useCallback(async (
    path: string,
    nodesData: typeof nodes,
    edgesData: typeof edges,
    executions: number,
    environments: typeof environmentConfigs,
    extras: typeof environmentExtras,
  ) => {
    try {
      setIsSaving(true);

      // Keep the project's name across saves: deriving it from the first agent
      // renamed every project after its first function.
      const yamlContent = generateYAMLFromCanvas(
        nodesData, edgesData, executions, environments, extras, useStore.getState().projectName || undefined,
      );
      await invoke('write_config_file', { path, content: yamlContent });

      // Record the save time so we can ignore file watcher events
      lastSaveTimeRef.current = Date.now();

      setHasUnsavedChanges(false);

      // Add to recent projects
      const name = extractProjectName(yamlContent);
      addRecentProject(name, path);

      setIsSaving(false);
    } catch (error) {
      console.error('Failed to save file:', error);
      setIsSaving(false);
    }
  }, [setHasUnsavedChanges]);

  // Auto-save when changes are made (debounced)
  useEffect(() => {
    if (!configPath || !hasUnsavedChanges) {
      return;
    }

    // Clear any existing timeout
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }

    // Set new timeout for auto-save
    saveTimeoutRef.current = setTimeout(() => {
      performSave(configPath, nodes, edges, executionsPerMonth, environmentConfigs, environmentExtras);
    }, AUTO_SAVE_DELAY);

    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
    };
  }, [configPath, hasUnsavedChanges, nodes, edges, executionsPerMonth, environmentConfigs, environmentExtras, performSave]);

  const handleDeploy = async () => {
    if (locked) return;
    if (!configPath) {
      alert('Please save the configuration first');
      return;
    }

    setIsDeploying(true);

    // Start mock deployment updates for demo
    const { createMockDeploymentUpdates } = await import('../utils/deploymentWebSocket');
    const resourceIds = nodes.map(n => n.id);

    const cleanup = createMockDeploymentUpdates(resourceIds, (update) => {
      if (update.type === 'resource_status') {
        // Update node status
        const updatedNodes = nodes.map(n =>
          n.id === update.resourceId
            ? { ...n, data: { ...n.data, status: update.data.status } }
            : n
        );
        setNodes(updatedNodes);
      }
    });

    try {
      await invoke('execute_cli_command', {
        command: 'warpcore',
        args: [...cliFlags, 'deploy', '--env', currentEnvironment, '--config', configPath],
      });
    } catch (error) {
      console.error('Deployment failed:', error);
    } finally {
      setTimeout(() => {
        setIsDeploying(false);
        cleanup();
      }, resourceIds.length * 3500);
    }
  };

  const handleDestroy = async () => {
    if (locked) return;
    if (!configPath) {
      alert('Please save the configuration first');
      return;
    }

    if (!confirm(`Destroy every resource in the ${envName} environment?`)) {
      return;
    }

    try {
      await invoke('execute_cli_command', {
        command: 'warpcore',
        args: [...cliFlags, 'destroy', '--env', currentEnvironment, '--config', configPath],
      });
    } catch (error) {
      console.error('Destroy failed:', error);
    }
  };

  // Put the project in the inspector: nothing narrower selected.
  const inspectProject = () => {
    closeSettings();
    setSelectedNode(null);
    inspectEnvironment(null);
    setRightPanelVisible(true);
  };

  // Why an action is unavailable, so a disabled button still explains itself.
  const blocked = (verb: string) => (
    !configPath ? 'Open or save a project first'
      : locked ? `The project is locked. Unlock it to ${verb}.`
        : isDeploying ? 'A deployment is in progress'
          : null
  );
  const deployReason = blocked('deploy') ?? `Deploy to ${envName}${debugMode ? ' (developer mode)' : ''}`;
  const destroyReason = blocked('destroy') ?? `Destroy everything in ${envName}`;

  return (
    <div className="h-14 bg-gray-900 text-white flex items-center justify-between px-4 border-b border-gray-700">
      {/* Scope */}
      <div className="flex items-center gap-3">
        <h1 className="text-lg font-semibold">Warpcore</h1>
        <DevBuildBadge paths={appInfo} dark />
        <span className="text-gray-600">|</span>
        <button
          onClick={inspectProject}
          className="text-sm text-blue-400 hover:text-blue-300 hover:underline"
          title="Inspect the project"
        >
          {projectName || (configPath ? 'Project' : 'No project open')}
        </button>
        {isSaving && (
          <span className="text-xs text-blue-400">● Saving...</span>
        )}
        {hasUnsavedChanges && !isSaving && (
          <span className="text-xs text-yellow-400" title="Changes are auto-saved a moment after you stop editing">● Unsaved</span>
        )}
        <EnvironmentSelector
          onOpenEnvironment={(env) => {
            closeSettings();
            inspectEnvironment(env);
          }}
        />
      </div>

      <div className="flex items-center gap-2">
        {/* Tasks */}
        <FileMenu onOpenFile={handleOpen} onOpenRecent={handleOpenRecent} />

        {configPath && (
          <button
            onClick={() => setShowDiscoveryPanel(true)}
            className="px-3 py-1.5 bg-purple-600 hover:bg-purple-700 rounded flex items-center gap-2 text-sm"
            title="Scan project for Strands SDK components"
          >
            <FolderSearch size={16} />
            Discover
          </button>
        )}

        <button
          onClick={() => setShowAccountExplorer(true)}
          className="px-3 py-1.5 bg-teal-600 hover:bg-teal-700 rounded flex items-center gap-2 text-sm"
          title="Reverse-engineer an AWS account: every resource, drill in to config, network, metrics and logs"
        >
          <Radar size={16} />
          Explore Account
        </button>

        <button
          onClick={() => setShowTemplateModal(true)}
          className="px-3 py-1.5 bg-gray-800 hover:bg-gray-700 rounded flex items-center gap-2 text-sm"
        >
          <FileText size={16} />
          Templates
        </button>

        <div className="w-px h-6 bg-gray-700 mx-1" />

        {/* Actions */}
        <LockControl />

        <button
          onClick={handleDeploy}
          disabled={isDeploying || !configPath || locked}
          title={deployReason}
          className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 rounded flex items-center gap-2 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Play size={16} />
          {isDeploying ? 'Deploying...' : 'Deploy'}
        </button>

        <button
          onClick={handleDestroy}
          disabled={isDeploying || !configPath || locked}
          title={destroyReason}
          className="px-3 py-1.5 bg-red-600 hover:bg-red-700 rounded flex items-center gap-2 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Trash2 size={16} />
          Destroy
        </button>

        <div className="w-px h-6 bg-gray-700 mx-1" />

        <button
          onClick={() => setRightPanelVisible(!rightPanelVisible)}
          disabled={settingsOpen}
          className={`p-2 rounded transition-colors disabled:opacity-40 ${
            rightPanelVisible
              ? 'bg-gray-700 text-white'
              : 'bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-white'
          }`}
          title={settingsOpen ? 'Close Settings to use the inspector' : rightPanelVisible ? 'Hide inspector' : 'Show inspector'}
        >
          <PanelRight size={18} />
        </button>
      </div>

      {showTemplateModal && (
        <TemplateModal onClose={() => setShowTemplateModal(false)} />
      )}

      <AccountExplorerPanel
        isOpen={showAccountExplorer}
        onClose={() => setShowAccountExplorer(false)}
      />

      {configPath && (
        <ProjectDiscoveryPanel
          isOpen={showDiscoveryPanel}
          onClose={() => setShowDiscoveryPanel(false)}
          projectPath={dirname(configPath)}
        />
      )}
    </div>
  );
}
