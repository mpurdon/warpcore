import { create } from 'zustand';
import { Node, Edge, Connection } from 'reactflow';
import { getPreferences, setPreference, Preferences } from '../utils/preferences';
import { Layer } from '../utils/layers';

// Sections of the application settings view. Order here is display order.
export const SETTINGS_SECTIONS = [
  'general', 'regions', 'exploration', 'logs', 'audit', 'sessions', 'storage', 'projects', 'about',
] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];


// Node status types with meaningful states:
// - draft: New node, not yet configured
// - warning: Missing optional config or needs attention
// - configured: Properly configured, ready to deploy
// - deploying: Currently being deployed
// - deployed: Successfully deployed and running
// - failed: Deployment failed or has errors
// - present: found in the account by a scan; nothing has reported its health
export type NodeStatus = 'draft' | 'warning' | 'configured' | 'deploying' | 'deployed' | 'failed' | 'present';

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

/**
 * Built-in starting points for a new environment. A new environment always
 * inherits from one of these (or from an environment in the open project),
 * so it never starts with silently invented values.
 */
export const ENVIRONMENT_TEMPLATES: Record<string, EnvironmentConfig> = DEFAULT_ENVIRONMENT_CONFIGS;

/** A fresh environment config copied from a template, under a new display name. */
export function environmentFromTemplate(template: EnvironmentConfig, name: string): EnvironmentConfig {
  const copy = JSON.parse(JSON.stringify(template)) as EnvironmentConfig;
  copy.name = name;
  return copy;
}

/** One-line description of an environment's settings, for pickers. */
export function summariseEnvironment(config: EnvironmentConfig): string {
  const days = config.logging.defaultRetentionDays;
  const mem = config.defaults.lambdaMemory >= 1024
    ? `${config.defaults.lambdaMemory / 1024} GB`
    : `${config.defaults.lambdaMemory} MB`;
  return `${config.removalPolicies.default} on destroy · ${days}d logs · X-Ray ${config.logging.enableXRay ? 'on' : 'off'} · ${mem} / ${config.defaults.lambdaTimeout}s`;
}

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
  /**
   * Select a node from outside the canvas (a relationship in the inspector).
   * Updates React Flow's selected flags without marking the project dirty:
   * selection is not a change to the project.
   */
  selectNode: (nodeId: string) => void;
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
  /** Replace every environment at once, e.g. after opening a file. Not a project change. */
  setEnvironmentConfigs: (configs: Record<string, EnvironmentConfig>) => void;
  // Keys of each environment's YAML block the builder does not model
  // (account, region, vpc, tags). Carried through so saving never drops them.
  environmentExtras: Record<string, Record<string, unknown>>;
  setEnvironmentExtras: (extras: Record<string, Record<string, unknown>>) => void;

  // Cost estimation state
  executionsPerMonth: number;
  setExecutionsPerMonth: (executions: number) => void;

  // Drag state for palette items
  draggedItem: { type: string; label: string } | null;
  setDraggedItem: (item: { type: string; label: string } | null) => void;

  // Inspector (right panel). It shows the selected object: an environment
  // when one was opened for inspection, else the selected node, else the
  // project. Selecting a node clears the inspected environment so the two
  // never compete.
  rightPanelVisible: boolean;
  setRightPanelVisible: (visible: boolean) => void;
  inspectedEnvironment: string | null;
  inspectEnvironment: (env: string | null) => void;
  // The node whose configuration form is open. Lives here rather than in
  // App so the inspector can open it for the node it is showing.
  editingNode: string | null;
  setEditingNode: (nodeId: string | null) => void;

  // The project lock. On by default whenever a project is opened or the
  // environment changes; off only after the operator types the project's
  // name. While locked the canvas is view-only and Deploy/Destroy are off.
  locked: boolean;
  lock: () => void;
  unlock: () => void;

  // Application settings view. Replaces the workspace while open; the canvas
  // is hidden, not unmounted.
  settingsOpen: boolean;
  settingsSection: SettingsSection;
  openSettings: (section?: SettingsSection) => void;
  closeSettings: () => void;

  // Application preferences (machine-local, never written to warpcore.yaml).
  // debugMode and selectedRegions are mirrored at the top level because most
  // of the app reads them; everything else lives under prefs.
  prefs: Preferences;
  setPref: <K extends keyof Preferences>(key: K, value: Preferences[K]) => void;
  debugMode: boolean;
  setDebugMode: (enabled: boolean) => void;

  // Regions of interest. Every region-aware surface reads this rather than
  // presenting all ~30 AWS regions.
  selectedRegions: string[];
  setSelectedRegions: (regions: string[]) => void;

  // Edge layers shown on the canvas (DESIGN_GUIDANCE.md §9.6). A personal
  // view setting, so it lives in preferences.
  layers: Record<Layer, boolean>;
  setLayer: (layer: Layer, on: boolean) => void;
}

/** The lock only bites once a project is open; an unsaved canvas is free. */
export const selectReadOnly = (s: { locked: boolean; configPath: string | null }): boolean => s.locked && Boolean(s.configPath);
export const useReadOnly = (): boolean => useStore(selectReadOnly);

/** Display name of the current deploy scope. */
export const selectCurrentEnvName = (s: { currentEnvironment: string; environmentConfigs: Record<string, EnvironmentConfig> }): string =>
  s.environmentConfigs[s.currentEnvironment]?.name ?? s.currentEnvironment;
export const useCurrentEnvName = (): string => useStore(selectCurrentEnvName);

// Read once at startup; the mirrors below all derive from it.
const initialPrefs = getPreferences();

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
  setSelectedNode: (nodeId) => set((state) => ({
    selectedNode: nodeId,
    inspectedEnvironment: nodeId ? null : state.inspectedEnvironment,
  })),
  selectNode: (nodeId) => set((state) => ({
    nodes: state.nodes.map((n) => (n.selected === (n.id === nodeId) ? n : { ...n, selected: n.id === nodeId })),
    selectedNode: nodeId,
    inspectedEnvironment: null,
    rightPanelVisible: true,
  })),
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
  // Changing the deploy scope re-locks: whatever was unlocked was unlocked
  // for the previous environment.
  setCurrentEnvironment: (env) => set((state) => ({
    currentEnvironment: env,
    locked: state.locked || env !== state.currentEnvironment,
  })),
  environmentConfigs: { ...DEFAULT_ENVIRONMENT_CONFIGS },
  setEnvironmentConfig: (env, config) => set((state) => ({
    environmentConfigs: { ...state.environmentConfigs, [env]: config },
    hasUnsavedChanges: true,
  })),
  setEnvironmentConfigs: (configs) => set({ environmentConfigs: configs }),
  environmentExtras: {},
  setEnvironmentExtras: (extras) => set({ environmentExtras: extras }),

  // Cost estimation state
  executionsPerMonth: 100000,
  setExecutionsPerMonth: (executions) => set({ executionsPerMonth: executions, hasUnsavedChanges: true }),

  // Drag state for palette items
  draggedItem: null,
  setDraggedItem: (item) => set({ draggedItem: item }),

  // Inspector state
  rightPanelVisible: true,
  setRightPanelVisible: (visible) => set({ rightPanelVisible: visible }),
  inspectedEnvironment: null,
  inspectEnvironment: (env) => set((state) => ({
    inspectedEnvironment: env,
    // Opening an environment is a selection too: make sure it can be seen.
    rightPanelVisible: env ? true : state.rightPanelVisible,
    settingsOpen: env ? false : state.settingsOpen,
  })),
  editingNode: null,
  setEditingNode: (nodeId) => set({ editingNode: nodeId }),

  // Project lock
  locked: true,
  lock: () => set({ locked: true }),
  unlock: () => set({ locked: false }),

  // Settings view
  settingsOpen: false,
  settingsSection: 'general',
  openSettings: (section) => set((state) => ({
    settingsOpen: true,
    settingsSection: section ?? state.settingsSection,
  })),
  closeSettings: () => set({ settingsOpen: false }),

  // Preferences. Restored from localStorage so they survive a restart, and
  // deliberately never set hasUnsavedChanges - none of this is project config.
  prefs: initialPrefs,
  setPref: (key, value) => {
    const prefs = setPreference(key, value);
    set({ prefs, debugMode: prefs.debugMode, selectedRegions: prefs.regions });
  },
  debugMode: initialPrefs.debugMode,
  setDebugMode: (enabled) => {
    const prefs = setPreference('debugMode', enabled);
    set({ debugMode: enabled, prefs });
  },

  selectedRegions: initialPrefs.regions,
  setSelectedRegions: (regions) => {
    const unique = [...new Set(regions)].sort();
    const prefs = setPreference('regions', unique);
    set({ selectedRegions: unique, prefs });
  },

  layers: initialPrefs.layers,
  setLayer: (layer, on) => set((state) => {
    const layers = { ...state.layers, [layer]: on };
    const prefs = setPreference('layers', layers);
    return { layers, prefs };
  }),
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
