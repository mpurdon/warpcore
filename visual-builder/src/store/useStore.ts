import { create } from 'zustand';
import { Node, Edge, Connection } from 'reactflow';

// Node status types with meaningful states:
// - draft: New node, not yet configured
// - warning: Missing optional config or needs attention
// - configured: Properly configured, ready to deploy
// - deploying: Currently being deployed
// - deployed: Successfully deployed and running
// - failed: Deployment failed or has errors
export type NodeStatus = 'draft' | 'warning' | 'configured' | 'deploying' | 'deployed' | 'failed';

export type RemovalPolicy = 'destroy' | 'retain' | 'snapshot';

export interface EnvironmentConfig {
  name: string;
  // Removal policies by resource type
  removalPolicies: {
    default: RemovalPolicy;
    s3?: RemovalPolicy;
    dynamodb?: RemovalPolicy;
    logGroup?: RemovalPolicy;
    sqs?: RemovalPolicy;
  };
  // Log configuration
  logging: {
    defaultRetentionDays: number;
    enableXRay: boolean;
  };
  // Resource defaults
  defaults: {
    lambdaMemory: number;
    lambdaTimeout: number;
    s3Versioning: boolean;
    dynamoDbBackup: boolean;
  };
}

// Default environment configurations
export const DEFAULT_ENVIRONMENT_CONFIGS: Record<string, EnvironmentConfig> = {
  dev: {
    name: 'Development',
    removalPolicies: {
      default: 'destroy',
    },
    logging: {
      defaultRetentionDays: 1,
      enableXRay: false,
    },
    defaults: {
      lambdaMemory: 256,
      lambdaTimeout: 30,
      s3Versioning: false,
      dynamoDbBackup: false,
    },
  },
  staging: {
    name: 'Staging',
    removalPolicies: {
      default: 'destroy',
      dynamodb: 'snapshot',
    },
    logging: {
      defaultRetentionDays: 14,
      enableXRay: true,
    },
    defaults: {
      lambdaMemory: 512,
      lambdaTimeout: 60,
      s3Versioning: true,
      dynamoDbBackup: false,
    },
  },
  prod: {
    name: 'Production',
    removalPolicies: {
      default: 'retain',
    },
    logging: {
      defaultRetentionDays: 90,
      enableXRay: true,
    },
    defaults: {
      lambdaMemory: 1024,
      lambdaTimeout: 60,
      s3Versioning: true,
      dynamoDbBackup: true,
    },
  },
};

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
  status: 'deployed' | 'failed';
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
  setNodes: (nodes: Node[] | ((prev: Node[]) => Node[])) => void;
  setEdges: (edges: Edge[] | ((prev: Edge[]) => Edge[])) => void;
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
  projectName: string | null;
  setProjectName: (name: string | null) => void;
  hasUnsavedChanges: boolean;
  setHasUnsavedChanges: (hasChanges: boolean) => void;
  
  // Environment state
  currentEnvironment: string;
  setCurrentEnvironment: (env: string) => void;
  environmentConfigs: Record<string, EnvironmentConfig>;
  setEnvironmentConfig: (env: string, config: EnvironmentConfig) => void;

  // Cost estimation state
  executionsPerMonth: number;
  setExecutionsPerMonth: (executions: number) => void;

  // Drag state for palette items
  draggedItem: { type: string; label: string } | null;
  setDraggedItem: (item: { type: string; label: string } | null) => void;

  // Right panel state
  rightPanelVisible: boolean;
  setRightPanelVisible: (visible: boolean) => void;
  rightPanelTab: 'roles' | 'environment';
  setRightPanelTab: (tab: 'roles' | 'environment') => void;
}

export const useStore = create<StoreState>((set) => ({
  // Canvas state
  nodes: [],
  edges: [],
  setNodes: (nodesOrFn) => set((state) => ({
    nodes: typeof nodesOrFn === 'function' ? nodesOrFn(state.nodes) : nodesOrFn,
    hasUnsavedChanges: true,
  })),
  setEdges: (edgesOrFn) => set((state) => ({
    edges: typeof edgesOrFn === 'function' ? edgesOrFn(state.edges) : edgesOrFn,
    hasUnsavedChanges: true,
  })),
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
  projectName: null,
  setProjectName: (name) => set({ projectName: name }),
  hasUnsavedChanges: false,
  setHasUnsavedChanges: (hasChanges) => set({ hasUnsavedChanges: hasChanges }),
  
  // Environment state
  currentEnvironment: 'dev',
  setCurrentEnvironment: (env) => set({ currentEnvironment: env }),
  environmentConfigs: { ...DEFAULT_ENVIRONMENT_CONFIGS },
  setEnvironmentConfig: (env, config) => set((state) => ({
    environmentConfigs: { ...state.environmentConfigs, [env]: config },
    hasUnsavedChanges: true,
  })),

  // Cost estimation state
  executionsPerMonth: 100000,
  setExecutionsPerMonth: (executions) => set({ executionsPerMonth: executions, hasUnsavedChanges: true }),

  // Drag state for palette items
  draggedItem: null,
  setDraggedItem: (item) => set({ draggedItem: item }),

  // Right panel state
  rightPanelVisible: true,
  setRightPanelVisible: (visible) => set({ rightPanelVisible: visible }),
  rightPanelTab: 'roles',
  setRightPanelTab: (tab) => set({ rightPanelTab: tab }),
}));

// Helper functions for React Flow
function applyNodeChanges(_changes: any[], nodes: Node[]): Node[] {
  // Simplified implementation - in real app, use React Flow's applyNodeChanges
  return nodes;
}

function applyEdgeChanges(_changes: any[], edges: Edge[]): Edge[] {
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
