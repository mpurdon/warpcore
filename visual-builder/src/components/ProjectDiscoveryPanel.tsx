import { useState, useEffect } from 'react';
import { X, FolderSearch, Wrench, Bot, Zap, ChevronDown, ChevronRight, FileCode, Plus, RefreshCw, AlertCircle } from 'lucide-react';
import {
  ProjectDiscovery,
  DiscoveredTool,
  DiscoveredHandler,
  DiscoveredAgent,
  ToolParameter,
  scanProjectForStrands,
  getRelativePath,
} from '../utils/projectDiscovery';
import { useStore } from '../store/useStore';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  projectPath: string;
}

type TabType = 'tools' | 'agents' | 'handlers';

export default function ProjectDiscoveryPanel({ isOpen, onClose, projectPath }: Props) {
  const [discovery, setDiscovery] = useState<ProjectDiscovery | null>(null);
  const [isScanning, setIsScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<TabType>('handlers');
  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set());

  const { nodes, setNodes } = useStore();

  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    if (isOpen) {
      window.addEventListener('keydown', handleEscape);
    }
    return () => window.removeEventListener('keydown', handleEscape);
  }, [isOpen, onClose]);

  // Auto-scan when panel opens
  useEffect(() => {
    if (isOpen && projectPath && !discovery && !isScanning) {
      scanProject();
    }
  }, [isOpen, projectPath]);

  const scanProject = async () => {
    setIsScanning(true);
    setError(null);
    try {
      const result = await scanProjectForStrands(projectPath);
      setDiscovery(result);
      // Auto-expand all files
      const allFiles = new Set<string>();
      result.tools.forEach(t => allFiles.add(t.file_path));
      result.agents.forEach(a => allFiles.add(a.file_path));
      result.handlers.forEach(h => allFiles.add(h.file_path));
      setExpandedFiles(allFiles);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setDiscovery(null);
    } finally {
      setIsScanning(false);
    }
  };

  const toggleFile = (filePath: string) => {
    const newExpanded = new Set(expandedFiles);
    if (newExpanded.has(filePath)) {
      newExpanded.delete(filePath);
    } else {
      newExpanded.add(filePath);
    }
    setExpandedFiles(newExpanded);
  };

  const addHandlerToCanvas = (handler: DiscoveredHandler) => {
    const newNode = {
      id: `agent-${Date.now()}`,
      type: 'agent',
      position: { x: 300, y: 200 + nodes.length * 100 },
      data: {
        label: handler.name,
        config: {
          name: handler.name,
          handlerPath: `${getRelativePath(handler.file_path, projectPath)}:${handler.name}`,
          sourceFile: handler.file_path,
          sourceLine: handler.line_number,
        },
      },
    };
    setNodes([...nodes, newNode]);
  };

  const addToolToCanvas = (tool: DiscoveredTool) => {
    // Tools are typically attached to agents, so we create a note about it
    const newNode = {
      id: `tool-note-${Date.now()}`,
      type: 'agent',
      position: { x: 300, y: 200 + nodes.length * 100 },
      data: {
        label: `Tool: ${tool.name}`,
        config: {
          name: tool.name,
          description: tool.description,
          toolType: tool.tool_type,
          sourceFile: tool.file_path,
          sourceLine: tool.line_number,
          parameters: tool.parameters,
        },
      },
    };
    setNodes([...nodes, newNode]);
  };

  const groupByFile = <T extends { file_path: string }>(items: T[]): Map<string, T[]> => {
    const grouped = new Map<string, T[]>();
    for (const item of items) {
      const existing = grouped.get(item.file_path) || [];
      existing.push(item);
      grouped.set(item.file_path, existing);
    }
    return grouped;
  };

  if (!isOpen) return null;

  const toolsByFile = discovery ? groupByFile(discovery.tools) : new Map();
  const agentsByFile = discovery ? groupByFile(discovery.agents) : new Map();
  const handlersByFile = discovery ? groupByFile(discovery.handlers) : new Map();

  const renderTools = () => {
    if (!discovery || discovery.tools.length === 0) {
      return (
        <div className="text-gray-500 text-center py-8">
          <p>No tools found</p>
          <p className="text-xs mt-2">Looking for @tool decorators, TOOL_SPEC, or strands_tools imports</p>
        </div>
      );
    }

    return (
      <div className="space-y-2">
        {Array.from(toolsByFile.entries()).map(([filePath, tools]) => (
          <div key={filePath} className="border border-gray-700 rounded-lg overflow-hidden">
            <button
              onClick={() => toggleFile(filePath)}
              className="w-full flex items-center gap-2 p-3 bg-gray-800 hover:bg-gray-700 text-left"
            >
              {expandedFiles.has(filePath) ? (
                <ChevronDown size={16} className="text-gray-400" />
              ) : (
                <ChevronRight size={16} className="text-gray-400" />
              )}
              <FileCode size={16} className="text-blue-400" />
              <span className="text-sm text-gray-300 truncate flex-1">
                {getRelativePath(filePath, projectPath)}
              </span>
              <span className="text-xs text-gray-500 bg-gray-700 px-2 py-0.5 rounded">
                {tools.length} tool{tools.length !== 1 ? 's' : ''}
              </span>
            </button>

            {expandedFiles.has(filePath) && (
              <div className="divide-y divide-gray-700">
                {tools.map((tool: DiscoveredTool, idx: number) => (
                  <div key={idx} className="p-3 bg-gray-800">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <Wrench size={14} className="text-purple-400 flex-shrink-0" />
                          <span className="font-medium text-white">{tool.name}</span>
                          <span className="text-xs text-gray-500">:{tool.line_number}</span>
                          <span className={`text-xs px-1.5 py-0.5 rounded ${
                            tool.tool_type === 'builtin'
                              ? 'bg-blue-900/50 text-blue-300'
                              : 'bg-purple-900/50 text-purple-300'
                          }`}>
                            {tool.tool_type === 'builtin' ? 'strands_tools' : tool.tool_type}
                          </span>
                        </div>
                        {tool.description && (
                          <p className="text-sm text-gray-400 mt-1 line-clamp-2">
                            {tool.description}
                          </p>
                        )}
                        {tool.tool_type !== 'builtin' && tool.parameters.length > 0 && (
                          <div className="mt-2 flex flex-wrap gap-1">
                            {tool.parameters.map((param: ToolParameter, pIdx: number) => (
                              <span
                                key={pIdx}
                                className={`text-xs px-1.5 py-0.5 rounded ${
                                  param.required
                                    ? 'bg-orange-900/50 text-orange-300'
                                    : 'bg-gray-700 text-gray-400'
                                }`}
                                title={param.description || `${param.name}: ${param.param_type}`}
                              >
                                {param.name}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                      <button
                        onClick={() => addToolToCanvas(tool)}
                        className="p-1.5 rounded bg-purple-600 hover:bg-purple-500 text-white flex-shrink-0"
                        title="Add to canvas"
                      >
                        <Plus size={14} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    );
  };

  const renderAgents = () => {
    if (!discovery || discovery.agents.length === 0) {
      return (
        <div className="text-gray-500 text-center py-8">
          <p>No agents found</p>
          <p className="text-xs mt-2">Looking for Agent() calls or create_*_agent functions</p>
        </div>
      );
    }

    return (
      <div className="space-y-2">
        {Array.from(agentsByFile.entries()).map(([filePath, agents]) => (
          <div key={filePath} className="border border-gray-700 rounded-lg overflow-hidden">
            <button
              onClick={() => toggleFile(filePath)}
              className="w-full flex items-center gap-2 p-3 bg-gray-800 hover:bg-gray-700 text-left"
            >
              {expandedFiles.has(filePath) ? (
                <ChevronDown size={16} className="text-gray-400" />
              ) : (
                <ChevronRight size={16} className="text-gray-400" />
              )}
              <FileCode size={16} className="text-blue-400" />
              <span className="text-sm text-gray-300 truncate flex-1">
                {getRelativePath(filePath, projectPath)}
              </span>
              <span className="text-xs text-gray-500 bg-gray-700 px-2 py-0.5 rounded">
                {agents.length} agent{agents.length !== 1 ? 's' : ''}
              </span>
            </button>

            {expandedFiles.has(filePath) && (
              <div className="divide-y divide-gray-700">
                {agents.map((agent: DiscoveredAgent, idx: number) => (
                  <div key={idx} className="p-3 bg-gray-800">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <Bot size={14} className="text-green-400 flex-shrink-0" />
                          <span className="font-medium text-white">{agent.name}</span>
                          <span className="text-xs text-gray-500">:{agent.line_number}</span>
                        </div>
                        {agent.system_prompt && (
                          <p className="text-sm text-gray-400 mt-1 ml-5 line-clamp-2">
                            {agent.system_prompt}
                          </p>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    );
  };

  const renderHandlers = () => {
    if (!discovery || discovery.handlers.length === 0) {
      return (
        <div className="text-gray-500 text-center py-8">
          <p>No handlers found</p>
          <p className="text-xs mt-2">Looking for handler(), lambda_handler(), or main() functions</p>
        </div>
      );
    }

    return (
      <div className="space-y-2">
        {Array.from(handlersByFile.entries()).map(([filePath, handlers]) => (
          <div key={filePath} className="border border-gray-700 rounded-lg overflow-hidden">
            <button
              onClick={() => toggleFile(filePath)}
              className="w-full flex items-center gap-2 p-3 bg-gray-800 hover:bg-gray-700 text-left"
            >
              {expandedFiles.has(filePath) ? (
                <ChevronDown size={16} className="text-gray-400" />
              ) : (
                <ChevronRight size={16} className="text-gray-400" />
              )}
              <FileCode size={16} className="text-blue-400" />
              <span className="text-sm text-gray-300 truncate flex-1">
                {getRelativePath(filePath, projectPath)}
              </span>
              <span className="text-xs text-gray-500 bg-gray-700 px-2 py-0.5 rounded">
                {handlers.length} handler{handlers.length !== 1 ? 's' : ''}
              </span>
            </button>

            {expandedFiles.has(filePath) && (
              <div className="divide-y divide-gray-700">
                {handlers.map((handler: DiscoveredHandler, idx: number) => (
                  <div key={idx} className="p-3 bg-gray-800">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <Zap size={14} className="text-yellow-400" />
                        <span className="font-medium text-white">{handler.name}</span>
                        <span className="text-xs text-gray-500">:{handler.line_number}</span>
                        <span className={`text-xs px-1.5 py-0.5 rounded ${
                          handler.handler_type === 'lambda'
                            ? 'bg-yellow-900/50 text-yellow-300'
                            : handler.handler_type === 'graph'
                            ? 'bg-purple-900/50 text-purple-300'
                            : 'bg-green-900/50 text-green-300'
                        }`}>
                          {handler.handler_type === 'lambda' ? 'Lambda' :
                           handler.handler_type === 'graph' ? 'Graph' : 'Entry Point'}
                        </span>
                      </div>
                      <button
                        onClick={() => addHandlerToCanvas(handler)}
                        className="p-1.5 rounded bg-blue-600 hover:bg-blue-500 text-white flex-shrink-0"
                        title="Add as Lambda agent"
                      >
                        <Plus size={14} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    );
  };

  return (
    <div className="theme-light fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-gray-900 rounded-lg shadow-xl w-[700px] max-h-[80vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-gray-700">
          <div className="flex items-center gap-2">
            <FolderSearch className="text-blue-400" size={20} />
            <h2 className="text-lg font-semibold text-white">Project Discovery</h2>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-gray-700 text-gray-400 hover:text-white"
          >
            <X size={20} />
          </button>
        </div>

        {/* Project Path */}
        <div className="px-4 py-3 border-b border-gray-700 bg-gray-800/50">
          <div className="flex items-center justify-between">
            <div className="flex-1 min-w-0">
              <p className="text-xs text-gray-500 mb-1">Scanning project directory</p>
              <p className="text-sm text-gray-300 truncate">{projectPath}</p>
            </div>
            <button
              onClick={() => scanProject()}
              disabled={isScanning}
              className="ml-3 p-2 bg-gray-700 hover:bg-gray-600 text-white rounded disabled:opacity-50"
              title="Rescan project"
            >
              <RefreshCw size={16} className={isScanning ? 'animate-spin' : ''} />
            </button>
          </div>
        </div>

        {/* Error Message */}
        {error && (
          <div className="mx-4 mt-4 p-3 bg-red-900/30 border border-red-700 rounded flex items-center gap-2">
            <AlertCircle size={16} className="text-red-400" />
            <span className="text-sm text-red-300">{error}</span>
          </div>
        )}

        {/* Tabs */}
        {discovery && (
          <div className="flex border-b border-gray-700">
            <button
              onClick={() => setActiveTab('handlers')}
              className={`flex-1 px-4 py-3 text-sm font-medium flex items-center justify-center gap-2 ${
                activeTab === 'handlers'
                  ? 'text-blue-400 border-b-2 border-blue-400 bg-gray-800/50'
                  : 'text-gray-400 hover:text-white hover:bg-gray-800/30'
              }`}
            >
              <Zap size={16} />
              Handlers ({discovery.handlers.length})
            </button>
            <button
              onClick={() => setActiveTab('tools')}
              className={`flex-1 px-4 py-3 text-sm font-medium flex items-center justify-center gap-2 ${
                activeTab === 'tools'
                  ? 'text-blue-400 border-b-2 border-blue-400 bg-gray-800/50'
                  : 'text-gray-400 hover:text-white hover:bg-gray-800/30'
              }`}
            >
              <Wrench size={16} />
              Tools ({discovery.tools.length})
            </button>
            <button
              onClick={() => setActiveTab('agents')}
              className={`flex-1 px-4 py-3 text-sm font-medium flex items-center justify-center gap-2 ${
                activeTab === 'agents'
                  ? 'text-blue-400 border-b-2 border-blue-400 bg-gray-800/50'
                  : 'text-gray-400 hover:text-white hover:bg-gray-800/30'
              }`}
            >
              <Bot size={16} />
              Agents ({discovery.agents.length})
            </button>
          </div>
        )}

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4">
          {isScanning ? (
            <div className="flex items-center justify-center py-12">
              <RefreshCw className="animate-spin text-blue-400" size={24} />
              <span className="ml-2 text-gray-400">Scanning project...</span>
            </div>
          ) : !discovery ? (
            <div className="text-center py-12 text-gray-500">
              <FolderSearch size={48} className="mx-auto mb-4 opacity-50" />
              <p>No Strands SDK components found in this project</p>
            </div>
          ) : (
            <>
              {activeTab === 'tools' && renderTools()}
              {activeTab === 'agents' && renderAgents()}
              {activeTab === 'handlers' && renderHandlers()}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-gray-700 text-xs text-gray-500">
          Click the + button to add discovered components to your canvas
        </div>
      </div>
    </div>
  );
}
