import { Play, Trash2, FileText, FolderSearch, PanelRight } from 'lucide-react';
import { useStore } from '../store/useStore';
import { invoke } from '@tauri-apps/api/tauri';
import { open } from '@tauri-apps/api/dialog';
import { generateYAMLFromCanvas } from '../utils/configSync';
import { useEffect, useState, useRef, useCallback } from 'react';
import { listen } from '@tauri-apps/api/event';
import TemplateModal from './TemplateModal';
import FileMenu from './FileMenu';
import EnvironmentConfigPanel from './EnvironmentConfigPanel';
import EnvironmentSelector from './EnvironmentSelector';
import ProjectDiscoveryPanel from './ProjectDiscoveryPanel';
import { addRecentProject, extractProjectName } from '../utils/recentProjects';

// Debounce delay for auto-save (ms)
const AUTO_SAVE_DELAY = 1000;

export default function Toolbar() {
  const {
    nodes,
    edges,
    setNodes,
    setEdges,
    configPath,
    setConfigPath,
    projectName,
    setProjectName,
    hasUnsavedChanges,
    setHasUnsavedChanges,
    currentEnvironment,
    isDeploying,
    setIsDeploying,
    executionsPerMonth,
    setExecutionsPerMonth,
    rightPanelVisible,
    setRightPanelVisible,
  } = useStore();

  const [showTemplateModal, setShowTemplateModal] = useState(false);
  const [showEnvConfig, setShowEnvConfig] = useState(false);
  const [editingEnv, setEditingEnv] = useState<string | null>(null);
  const [showDiscoveryPanel, setShowDiscoveryPanel] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  // Track last save time to ignore file watcher events triggered by our saves
  const lastSaveTimeRef = useRef<number>(0);
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // How long to ignore file watcher events after a save (ms)
  const IGNORE_WATCHER_DURATION = 2000;

  const openConfigFile = async (filePath: string) => {
    try {
      const content = await invoke<string>('read_config_file', { path: filePath });
      const { parseYAMLToCanvas } = await import('../utils/configSync');
      const { nodes: parsedNodes, edges: parsedEdges, executionsPerMonth: executions } = parseYAMLToCanvas(content);
      setNodes(parsedNodes);
      setEdges(parsedEdges);
      setConfigPath(filePath);
      setHasUnsavedChanges(false);
      setExecutionsPerMonth(executions);

      // Extract and set project name
      const name = extractProjectName(content);
      setProjectName(name);

      // Add to recent projects
      addRecentProject(name, filePath);
      
      // Start watching file for changes
      await invoke('watch_config_file', { path: filePath });
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
    });
    
    if (selected && typeof selected === 'string') {
      await openConfigFile(selected);
    }
  };

  const handleOpenRecent = async (filePath: string) => {
    await openConfigFile(filePath);
  };

  // Core save function
  const performSave = useCallback(async (path: string, nodesData: typeof nodes, edgesData: typeof edges, executions: number) => {
    try {
      setIsSaving(true);

      const yamlContent = generateYAMLFromCanvas(nodesData, edgesData, executions);
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
      performSave(configPath, nodes, edges, executionsPerMonth);
    }, AUTO_SAVE_DELAY);

    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
    };
  }, [configPath, hasUnsavedChanges, nodes, edges, executionsPerMonth, performSave]);

  const handleDeploy = async () => {
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
        command: 'strands',
        args: ['deploy', '--env', currentEnvironment, '--config', configPath],
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
    if (!configPath) {
      alert('Please save the configuration first');
      return;
    }
    
    if (!confirm('Are you sure you want to destroy all resources?')) {
      return;
    }
    
    try {
      await invoke('execute_cli_command', {
        command: 'strands',
        args: ['destroy', '--env', currentEnvironment, '--config', configPath],
      });
    } catch (error) {
      console.error('Destroy failed:', error);
    }
  };

  return (
    <div className="h-14 bg-gray-900 text-white flex items-center justify-between px-4 border-b border-gray-700">
      <div className="flex items-center gap-3">
        <h1 className="text-lg font-semibold">Warpcore Visual Builder</h1>
        {projectName && (
          <div className="flex items-center gap-2">
            <span className="text-gray-500">|</span>
            <span className="text-sm text-blue-400">{projectName}</span>
          </div>
        )}
        {isSaving && (
          <span className="text-xs text-blue-400">● Saving...</span>
        )}
        {hasUnsavedChanges && !isSaving && (
          <span className="text-xs text-yellow-400">● Unsaved</span>
        )}
      </div>
      
      <div className="flex items-center gap-2">
        <EnvironmentSelector
          onOpenEnvironment={(env) => {
            setEditingEnv(env);
            setShowEnvConfig(true);
          }}
        />

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
          onClick={() => setShowTemplateModal(true)}
          className="px-3 py-1.5 bg-gray-800 hover:bg-gray-700 rounded flex items-center gap-2 text-sm"
        >
          <FileText size={16} />
          Templates
        </button>

        <button
          onClick={handleDeploy}
          disabled={isDeploying || !configPath}
          className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 rounded flex items-center gap-2 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Play size={16} />
          {isDeploying ? 'Deploying...' : 'Deploy'}
        </button>
        
        <button
          onClick={handleDestroy}
          disabled={isDeploying || !configPath}
          className="px-3 py-1.5 bg-red-600 hover:bg-red-700 rounded flex items-center gap-2 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Trash2 size={16} />
          Destroy
        </button>

        <div className="w-px h-6 bg-gray-700 mx-1" />

        <button
          onClick={() => setRightPanelVisible(!rightPanelVisible)}
          className={`p-2 rounded transition-colors ${
            rightPanelVisible
              ? 'bg-gray-700 text-white'
              : 'bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-white'
          }`}
          title={rightPanelVisible ? 'Hide Roles Panel' : 'Show Roles Panel'}
        >
          <PanelRight size={18} />
        </button>

      </div>

      {showTemplateModal && (
        <TemplateModal onClose={() => setShowTemplateModal(false)} />
      )}

      {showEnvConfig && editingEnv && (
        <EnvironmentConfigPanel
          environment={editingEnv}
          onClose={() => {
            setShowEnvConfig(false);
            setEditingEnv(null);
          }}
        />
      )}

      {configPath && (
        <ProjectDiscoveryPanel
          isOpen={showDiscoveryPanel}
          onClose={() => setShowDiscoveryPanel(false)}
          projectPath={configPath.substring(0, configPath.lastIndexOf('/'))}
        />
      )}
    </div>
  );
}
