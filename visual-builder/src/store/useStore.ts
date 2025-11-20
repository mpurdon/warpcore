import { create } from 'zustand';
import { Node, Edge, Connection } from 'reactflow';

export type NodeStatus = 'pending' | 'deploying' | 'success' | 'failed' | 'warning';

export interface ExecutionStep {
  id: string;
  name: string;
  status: NodeStatus;
  startTime: Date;
  endTime?: Date;
  duration?: number;
}

export interface LogEntry {
  timestamp: Date;
  level: 'DEBUG' | 'INFO' | 'WARNING' | 'ERROR';
  message: string;
  context?: any;
}

export interface APICall {
  service: string;
  operation: string;
  startTime: Date;
  duration: number;
  statusCode: number;
  request?: any;
  response?: any;
}

export interface ExecutionLog {
  resourceId: string;
  status: NodeStatus;
  startTime: Date;
  endTime?: Date;
  duration?: number;
  physicalId?: string;
  steps: ExecutionStep[];
  logs: LogEntry[];
  apiCalls: APICall[];
  configuration: any;
  error?: {
    type: string;
    message: string;
    suggestedFixes: string[];
  };
}

export interface DeploymentHistory {
  id: string;
  timestamp: Date;
  status: 'success' | 'failed';
  duration: number;
  changes: {
    created: string[];
    updated: string[];
    deleted: string[];
  };
}

interface StoreState {
  // Canvas state
  nodes: Node[];
  edges: Edge[];
  setNodes: (nodes: Node[]) => void;
  setEdges: (edges: Edge[]) => void;
  onNodesChange: (changes: any) => void;
  onEdgesChange: (changes: any) => void;
  onConnect: (connection: Connection) => void;
  
  // Execution state
  executionLogs: Map<string, ExecutionLog>;
  setExecutionLog: (resourceId: string, log: ExecutionLog) => void;
  
  // UI state
  selectedNode: string | null;
  setSelectedNode: (nodeId: string | null) => void;
  showExecutionPanel: boolean;
  setShowExecutionPanel: (show: boolean) => void;
  
  // Deployment state
  isDeploying: boolean;
  setIsDeploying: (deploying: boolean) => void;
  deploymentHistory: DeploymentHistory[];
  addDeploymentHistory: (history: DeploymentHistory) => void;
  
  // Config state
  configPath: string | null;
  setConfigPath: (path: string | null) => void;
  hasUnsavedChanges: boolean;
  setHasUnsavedChanges: (hasChanges: boolean) => void;
  
  // Environment state
  currentEnvironment: string;
  setCurrentEnvironment: (env: string) => void;
}

export const useStore = create<StoreState>((set) => ({
  // Canvas state
  nodes: [],
  edges: [],
  setNodes: (nodes) => set({ nodes, hasUnsavedChanges: true }),
  setEdges: (edges) => set({ edges, hasUnsavedChanges: true }),
  onNodesChange: (changes) => set((state) => ({
    nodes: applyNodeChanges(changes, state.nodes),
    hasUnsavedChanges: true,
  })),
  onEdgesChange: (changes) => set((state) => ({
    edges: applyEdgeChanges(changes, state.edges),
    hasUnsavedChanges: true,
  })),
  onConnect: (connection) => set((state) => ({
    edges: addEdge(connection, state.edges),
    hasUnsavedChanges: true,
  })),
  
  // Execution state
  executionLogs: new Map(),
  setExecutionLog: (resourceId, log) => set((state) => {
    const newLogs = new Map(state.executionLogs);
    newLogs.set(resourceId, log);
    return { executionLogs: newLogs };
  }),
  
  // UI state
  selectedNode: null,
  setSelectedNode: (nodeId) => set({ selectedNode: nodeId }),
  showExecutionPanel: false,
  setShowExecutionPanel: (show) => set({ showExecutionPanel: show }),
  
  // Deployment state
  isDeploying: false,
  setIsDeploying: (deploying) => set({ isDeploying: deploying }),
  deploymentHistory: [],
  addDeploymentHistory: (history) => set((state) => ({
    deploymentHistory: [history, ...state.deploymentHistory],
  })),
  
  // Config state
  configPath: null,
  setConfigPath: (path) => set({ configPath: path }),
  hasUnsavedChanges: false,
  setHasUnsavedChanges: (hasChanges) => set({ hasUnsavedChanges: hasChanges }),
  
  // Environment state
  currentEnvironment: 'dev',
  setCurrentEnvironment: (env) => set({ currentEnvironment: env }),
}));

// Helper functions for React Flow
function applyNodeChanges(changes: any[], nodes: Node[]): Node[] {
  // Simplified implementation - in real app, use React Flow's applyNodeChanges
  return nodes;
}

function applyEdgeChanges(changes: any[], edges: Edge[]): Edge[] {
  // Simplified implementation - in real app, use React Flow's applyEdgeChanges
  return edges;
}

function addEdge(connection: Connection, edges: Edge[]): Edge[] {
  const newEdge: Edge = {
    id: `${connection.source}-${connection.target}`,
    source: connection.source!,
    target: connection.target!,
    type: 'permission',
    data: { permissions: [] },
  };
  return [...edges, newEdge];
}
