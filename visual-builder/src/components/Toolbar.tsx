import { Save, Play, Trash2, FolderOpen, Settings, FileText } from 'lucide-react';
import { useStore } from '../store/useStore';
import { invoke } from '@tauri-apps/api/tauri';
import { open, save } from '@tauri-apps/api/dialog';
import { generateYAMLFromCanvas } from '../utils/configSync';
import { useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import TemplateModal from './TemplateModal';

export default function Toolbar() {
  const {
    nodes,
    edges,
    setNodes,
    setEdges,
    configPath,
    setConfigPath,
    hasUnsavedChanges,
    setHasUnsavedChanges,
    currentEnvironment,
    setCurrentEnvironment,
    isDeploying,
    setIsDeploying,
  } = useStore();

  const [showTemplateModal, setShowTemplateModal] = useState(false);

  // Listen for file changes
  useEffect(() => {
    const unlisten = listen('config-file-changed', async (event) => {
      const changedPath = event.payload as string;
      if (changedPath === configPath) {
        const shouldReload = confirm('Configuration file changed externally. Reload?');
        if (shouldReload) {
          try {
            const content = await invoke<string>('read_config_file', { path: changedPath });
            const { parseYAMLToCanvas } = await import('../utils/configSync');
            const { nodes: parsedNodes, edges: parsedEdges } = parseYAMLToCanvas(content);
            setNodes(parsedNodes);
            setEdges(parsedEdges);
            setHasUnsavedChanges(false);
          } catch (error) {
            console.error('Failed to reload file:', error);
          }
        }
      }
    });

    return () => {
      unlisten.then(fn => fn());
    };
  }, [configPath, setNodes, setEdges, setHasUnsavedChanges]);

  const handleOpen = async () => {
    const selected = await open({
      filters: [{ name: 'YAML', extensions: ['yaml', 'yml'] }],
    });
    
    if (selected && typeof selected === 'string') {
      try {
        const content = await invoke<string>('read_config_file', { path: selected });
        const { parseYAMLToCanvas } = await import('../utils/configSync');
        const { nodes: parsedNodes, edges: parsedEdges } = parseYAMLToCanvas(content);
        setNodes(parsedNodes);
        setEdges(parsedEdges);
        setConfigPath(selected);
        setHasUnsavedChanges(false);
        
        // Start watching file for changes
        await invoke('watch_config_file', { path: selected });
      } catch (error) {
        console.error('Failed to open file:', error);
      }
    }
  };

  const handleSave = async () => {
    let path = configPath;
    
    if (!path) {
      const selected = await save({
        filters: [{ name: 'YAML', extensions: ['yaml'] }],
        defaultPath: 'strands.yaml',
      });
      
      if (selected) {
        path = selected;
        setConfigPath(selected);
      } else {
        return;
      }
    }
    
    try {
      const yamlContent = generateYAMLFromCanvas(nodes, edges);
      await invoke('write_config_file', { path, content: yamlContent });
      setHasUnsavedChanges(false);
    } catch (error) {
      console.error('Failed to save file:', error);
    }
  };

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
      <div className="flex items-center gap-2">
        <h1 className="text-lg font-semibold">Strands Visual Builder</h1>
        {hasUnsavedChanges && (
          <span className="text-xs text-yellow-400">● Unsaved changes</span>
        )}
      </div>
      
      <div className="flex items-center gap-2">
        <select
          value={currentEnvironment}
          onChange={(e) => setCurrentEnvironment(e.target.value)}
          className="px-3 py-1.5 bg-gray-800 border border-gray-700 rounded text-sm"
        >
          <option value="dev">Development</option>
          <option value="staging">Staging</option>
          <option value="prod">Production</option>
        </select>
        
        <button
          onClick={() => setShowTemplateModal(true)}
          className="px-3 py-1.5 bg-gray-800 hover:bg-gray-700 rounded flex items-center gap-2 text-sm"
        >
          <FileText size={16} />
          Templates
        </button>
        
        <button
          onClick={handleOpen}
          className="px-3 py-1.5 bg-gray-800 hover:bg-gray-700 rounded flex items-center gap-2 text-sm"
        >
          <FolderOpen size={16} />
          Open
        </button>
        
        <button
          onClick={handleSave}
          disabled={!hasUnsavedChanges}
          className="px-3 py-1.5 bg-gray-800 hover:bg-gray-700 rounded flex items-center gap-2 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Save size={16} />
          Save
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
        
        <button className="px-3 py-1.5 bg-gray-800 hover:bg-gray-700 rounded flex items-center gap-2 text-sm">
          <Settings size={16} />
        </button>
      </div>
      
      {showTemplateModal && (
        <TemplateModal onClose={() => setShowTemplateModal(false)} />
      )}
    </div>
  );
}
