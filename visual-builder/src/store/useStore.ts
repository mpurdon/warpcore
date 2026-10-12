import { create } from 'zustand';
import { Node, Edge } from 'reactflow';
import { getPreferences, setPreference, Preferences } from '../utils/preferences';
import { Layer } from '../utils/layers';
import { Finding, findingsByArn, Review } from '../utils/findings';
import type { CanvasHealth, DriftReport, ImportDiff } from '../utils/live';
import type { Receipt } from '../commands/types';
import { EMPTY_CHAT, type ChatItem, type ChatState, type Message, type PendingAction } from '../assistant/types';
import { Lens, LENS_LAYERS } from '../utils/lenses';
import type { RunEvent, RunKind, RunState } from '../utils/deployEvents';
import { appendOutput, applyRunEvent, isActive, newRun } from '../utils/deployEvents';
import type { Playhead, Scenario } from '../utils/scenarios';
import { advance as advancePlayhead, canBeStep, createScenario, seekTo } from '../utils/scenarios';
import type { HolodeckMeta } from '../utils/holodeck';

// Sections of the application settings view. Order here is display order.
export const SETTINGS_SECTIONS = [
  'general', 'regions', 'exploration', 'logs', 'audit', 'sessions', 'storage', 'projects', 'about',
] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

/** Task dialogs. One at a time; they are modal because they run a job. */
export type Dialog = 'holodeck' | 'explorer' | 'discovery' | 'shortcuts' | 'findings';

/**
 * A project as the store holds it: what `loadProject` puts on the canvas
 * and `snapshotProject` takes off it. Opening a file, the demo, a Holodeck
 * preview and a template all go through the one loader, so none of them
 * can forget a field.
 */
export interface ProjectState {
  nodes: Node[];
  edges: Edge[];
  scenarios: Scenario[];
  configPath: string | null;
  projectName: string | null;
  environmentConfigs: Record<string, EnvironmentConfig>;
  environmentExtras: Record<string, Record<string, unknown>>;
  executionsPerMonth: number;
  currentEnvironment: string;
  locked: boolean;
  holodeck: HolodeckMeta | null;
}



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

export const DEFAULT_EXECUTIONS_PER_MONTH = 100000;

/** Nothing open: an empty, unlocked-by-absence canvas with the default environments. */
export const EMPTY_PROJECT: ProjectState = {
  nodes: [], edges: [], scenarios: [], configPath: null, projectName: null,
  environmentConfigs: DEFAULT_ENVIRONMENT_CONFIGS, environmentExtras: {}, executionsPerMonth: DEFAULT_EXECUTIONS_PER_MONTH,
  currentEnvironment: 'dev', locked: true, holodeck: null,
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

// ------------------------------------------------------------------ history
//
// Undo and redo over the canvas. A snapshot is taken before a change lands.
// Two rules keep the stack meaningful: a change that only touches selection
// is not a change, and changes arriving in quick succession (a drag emits
// one every frame) fold into the snapshot taken before the first of them.

interface Snapshot {
  nodes: Node[];
  edges: Edge[];
}

const HISTORY_LIMIT = 100;
const COALESCE_MS = 400;
let lastRecordedAt = 0;

// Measured width and height are React Flow's own bookkeeping, written when
// a node mounts; a resize the operator makes lands in `style`. So a
// measurement is neither dirty nor a step, and a freshly loaded canvas
// stays clean.
function sameNodeIgnoringSelection(a: Node, b: Node): boolean {
  return a === b || (
    a.id === b.id
    && a.type === b.type
    && a.data === b.data
    && a.parentNode === b.parentNode
    && a.hidden === b.hidden
    && a.style === b.style
    && a.position.x === b.position.x
    && a.position.y === b.position.y
  );
}

export function selectionOnlyChange(before: Node[], after: Node[]): boolean {
  if (before === after) return true;
  if (before.length !== after.length) return false;
  for (let i = 0; i < before.length; i++) {
    if (!sameNodeIgnoringSelection(before[i], after[i])) return false;
  }
  return true;
}

/**
 * The history fields to merge into the next state, given what is about to
 * change. Empty when the change is not worth a step.
 */
function recordHistory(
  state: { nodes: Node[]; edges: Edge[]; past: Snapshot[] },
  nextNodes: Node[],
  nextEdges: Edge[],
  now = Date.now(),
): { past: Snapshot[]; future: Snapshot[] } | Record<string, never> {
  const edgesSame = state.edges === nextEdges;
  if (edgesSame && selectionOnlyChange(state.nodes, nextNodes)) return {};
  if (now - lastRecordedAt < COALESCE_MS && state.past.length > 0) {
    lastRecordedAt = now;
    return {};
  }
  lastRecordedAt = now;
  const past = [...state.past, { nodes: state.nodes, edges: state.edges }];
  if (past.length > HISTORY_LIMIT) past.splice(0, past.length - HISTORY_LIMIT);
  return { past, future: [] };
}

/** For tests: forget the coalescing clock. */
export function _resetHistoryClock(): void {
  lastRecordedAt = 0;
}

// -------------------------------------------------------------------- store

export interface StoreState {
  // Canvas state
  nodes: Node[];
  edges: Edge[];
  setNodes: (nodes: Node[] | ((prev: Node[]) => Node[])) => void;
  setEdges: (edges: Edge[] | ((prev: Edge[]) => Edge[])) => void;
  /**
   * Set node statuses from a deployment run. Not a history step, and only
   * marks the project dirty when asked: a transient "deploying" is not worth
   * writing to warpcore.yaml, a final "deployed" is.
   */
  setNodeStatuses: (statuses: Record<string, NodeStatus>, dirty?: boolean) => void;

  // Undo / redo
  past: Snapshot[];
  future: Snapshot[];
  undo: () => void;
  redo: () => void;
  resetHistory: () => void;

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
  /** Clear the selection on the canvas and in the store. */
  deselectAll: () => void;
  showExecutionPanel: boolean;
  setShowExecutionPanel: (show: boolean) => void;

  // Deployment state. `run` is the current or most recent deploy/destroy;
  // `isDeploying` is kept as the simple flag most of the UI asks for.
  isDeploying: boolean;
  setIsDeploying: (deploying: boolean) => void;
  run: RunState | null;
  startRun: (kind: RunKind, environment: string) => void;
  applyRunEvent: (event: RunEvent) => void;
  appendRunOutput: (text: string, stream: 'out' | 'err') => void;
  clearRun: () => void;
  activityOpen: boolean;
  setActivityOpen: (open: boolean) => void;
  deploymentHistory: DeploymentHistory[];
  addDeploymentHistory: (history: DeploymentHistory) => void;

  // Config state
  configPath: string | null;
  setConfigPath: (path: string | null) => void;
  projectName: string | null;
  setProjectName: (name: string | null) => void;
  hasUnsavedChanges: boolean;
  setHasUnsavedChanges: (hasChanges: boolean) => void;
  /** True while warpcore.yaml is being written. */
  saving: boolean;
  setSaving: (saving: boolean) => void;

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

  // Scenarios (utils/scenarios.ts): part of the project, saved to
  // warpcore.yaml, so editing them is a project change and respects the
  // lock. Playing one is not. `inspectedScenario` puts a scenario in the
  // inspector the way inspectedEnvironment does; selecting a node clears it
  // unless the scenario is recording, when node clicks are its input.
  scenarios: Scenario[];
  /** Replace every scenario, e.g. after opening a file. Dirty only when asked. */
  setScenarios: (scenarios: Scenario[], dirty?: boolean) => void;
  addScenario: (scenario: Scenario) => void;
  /** A fresh scenario triggered at the node, or at the most entry-like one, opened in the inspector. */
  newScenario: (triggerAt?: string) => void;
  updateScenario: (id: string, update: (scenario: Scenario) => Scenario) => void;
  removeScenario: (id: string) => void;
  inspectedScenario: string | null;
  inspectScenario: (id: string | null) => void;
  recording: boolean;
  setRecording: (on: boolean) => void;
  /** Append a step to the scenario being recorded; ignored for nodes that cannot be one. */
  recordStep: (nodeId: string) => void;
  // Playback: one playhead in the store drives the canvas and the system
  // view, so both show the same instant. See Playhead in scenarios.ts.
  playhead: Playhead | null;
  playScenario: (id: string) => void;
  stopPlayback: () => void;
  setPlaying: (playing: boolean) => void;
  /** The next phase: travel → dwell → next step's travel … → end. */
  advancePlayback: () => void;
  /** Jump to the start of a step; -1 is the trigger. */
  seekPlayback: (index: number) => void;
  stepBack: () => void;
  stepForward: () => void;
  setPlaybackSpeed: (speed: number) => void;
  /** Keep the request in view as it plays, on the canvas and in the system view. */
  followPlayhead: boolean;
  setFollowPlayhead: (on: boolean) => void;

  // The project lock. On by default whenever a project is opened or the
  // environment changes; off only after the operator types the project's
  // name. While locked the canvas is view-only and Deploy/Destroy are off.
  locked: boolean;
  lock: () => void;
  unlock: () => void;

  // The Holodeck (utils/holodeck.ts). `holodeck` is the entry the canvas
  // came from, if any: its notes show in the project inspector. A preview
  // is the entry loaded in memory, read-only, with no file; whatever was
  // open before is stashed and comes back when the preview closes.
  holodeck: HolodeckMeta | null;
  holodeckPreview: boolean;
  previewStash: ProjectState | null;
  /** Record where the canvas came from. Not a preview: any stash is dropped. */
  setHolodeck: (meta: HolodeckMeta | null) => void;
  /** Put the entry on the canvas as a preview, stashing the current project the first time. */
  beginHolodeckPreview: (meta: HolodeckMeta, project: ProjectState) => void;
  /** Leave the preview; the caller loads what comes back, or EMPTY_PROJECT. */
  endHolodeckPreview: () => ProjectState | null;

  // The one way a project gets onto the canvas. Atomic: nothing to undo,
  // nothing dirty, no selection, no playhead, no preview.
  loadProject: (project: ProjectState) => void;
  snapshotProject: () => ProjectState;
  /** Set by loadProject; the canvas fits the view once the new nodes are measured, then clears it. */
  fitPending: boolean;
  clearFitPending: () => void;

  // Application settings view. Replaces the workspace while open; the canvas
  // is hidden, not unmounted.
  settingsOpen: boolean;
  settingsSection: SettingsSection;
  openSettings: (section?: SettingsSection) => void;
  closeSettings: () => void;

  // The system view (SystemView.tsx): the canvas as terraces, read-only.
  // Replaces the canvas in the workspace while on; everything else stays.
  systemView: boolean;
  setSystemView: (on: boolean) => void;

  // Task dialogs, the command palette and the shortcut sheet. Held here so
  // the toolbar, the palette, the welcome screen and the keyboard can all
  // open the same thing.
  dialog: Dialog | null;
  openDialog: (dialog: Dialog) => void;

  // The last review of the open project (utils/findings.ts): the drawer
  // lists it, cards and the inspector wear it. Session-only; a new project
  // clears it.
  review: Review | null;
  reviewByArn: Map<string, Finding[]>;
  reviewBusy: boolean;
  setReview: (review: Review | null) => void;
  setReviewBusy: (busy: boolean) => void;
  // The live lens (utils/live.ts): health per ARN as the account last
  // reported it, the deployment state checked against the account, and
  // what changed since the previous import. Session-only, like the review.
  liveHealth: CanvasHealth | null;
  liveBusy: boolean;
  setLiveHealth: (health: CanvasHealth | null) => void;
  setLiveBusy: (busy: boolean) => void;
  drift: DriftReport | null;
  driftBusy: boolean;
  setDrift: (drift: DriftReport | null) => void;
  setDriftBusy: (busy: boolean) => void;
  importDiff: ImportDiff | null;
  setImportDiff: (diff: ImportDiff | null) => void;
  // What the command layer ran this session (commands/dispatch.ts): one
  // receipt per run, whoever asked. The Activity drawer's audit, the
  // assistant's transcript lines.
  receipts: Receipt[];
  clearReceipts: () => void;
  // The assistant (assistant/): its transcript, the model's messages, and
  // the card waiting for the operator. Session-only.
  chat: ChatState;
  assistantOpen: boolean;
  setAssistantOpen: (open: boolean) => void;
  pushChatItem: (item: ChatItem) => void;
  setChatMessages: (messages: Message[]) => void;
  setChatBusy: (busy: boolean) => void;
  setChatPending: (pending: PendingAction | null) => void;
  addChatUsage: (usage: { input: number; output: number }, model: string | null) => void;
  clearChat: () => void;
  closeDialog: () => void;
  paletteOpen: boolean;
  setPaletteOpen: (open: boolean) => void;

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

  // The lens the canvas is viewed through, and the edge layers it shows
  // (DESIGN_GUIDANCE.md §9.6, lenses.ts). Personal view settings, so they
  // live in preferences. Choosing a lens resets the layers to its preset;
  // toggling a layer afterwards is an adjustment on top of it.
  lens: Lens;
  setLens: (lens: Lens) => void;
  layers: Record<Layer, boolean>;
  setLayer: (layer: Layer, on: boolean) => void;
}

/** The lock only bites once a project is open; an unsaved canvas is free. A Holodeck preview is always read-only. */
export const selectReadOnly = (s: { locked: boolean; configPath: string | null; holodeckPreview: boolean }): boolean =>
  (s.locked && Boolean(s.configPath)) || s.holodeckPreview;
export const useReadOnly = (): boolean => useStore(selectReadOnly);

/** Display name of the current deploy scope. */
export const selectCurrentEnvName = (s: { currentEnvironment: string; environmentConfigs: Record<string, EnvironmentConfig> }): string =>
  s.environmentConfigs[s.currentEnvironment]?.name ?? s.currentEnvironment;
export const useCurrentEnvName = (): string => useStore(selectCurrentEnvName);

// Read once at startup; the mirrors below all derive from it.
const initialPrefs = getPreferences();

/** The project fields of the state, for the stash. */
function snapshotOf(s: ProjectState): ProjectState {
  return {
    nodes: s.nodes, edges: s.edges, scenarios: s.scenarios, configPath: s.configPath, projectName: s.projectName,
    environmentConfigs: s.environmentConfigs, environmentExtras: s.environmentExtras, executionsPerMonth: s.executionsPerMonth,
    currentEnvironment: s.currentEnvironment, locked: s.locked, holodeck: s.holodeck,
  };
}

/** The state change that puts a project on the canvas, with everything transient cleared. */
function projectPatch(p: ProjectState): Partial<StoreState> {
  lastRecordedAt = 0;
  return {
    ...snapshotOf(p),
    // A project's current environment must be one it has.
    currentEnvironment: p.environmentConfigs[p.currentEnvironment] ? p.currentEnvironment : Object.keys(p.environmentConfigs)[0] ?? p.currentEnvironment,
    playhead: null, recording: false, inspectedScenario: null, inspectedEnvironment: null, selectedNode: null, editingNode: null,
    past: [], future: [], hasUnsavedChanges: false, fitPending: p.nodes.length > 0,
  };
}

/**
 * A playback action: given the scenario playing and the playhead, the next
 * playhead. Nothing happens without a playhead; a playhead whose scenario
 * is gone is dropped.
 */
function withPlayback(next: (scenario: Scenario, head: Playhead) => Playhead) {
  return (state: StoreState): Partial<StoreState> => {
    if (!state.playhead) return {};
    const scenario = state.scenarios.find((s) => s.id === state.playhead!.scenarioId);
    if (!scenario) return { playhead: null };
    return { playhead: next(scenario, state.playhead) };
  };
}

export const useStore = create<StoreState>((set, get) => ({
  // Canvas state
  nodes: [],
  edges: [],
  setNodes: (nodesOrFn) => set((state) => {
    const nodes = typeof nodesOrFn === 'function' ? nodesOrFn(state.nodes) : nodesOrFn;
    const selectionOnly = selectionOnlyChange(state.nodes, nodes);
    return {
      nodes,
      hasUnsavedChanges: state.hasUnsavedChanges || !selectionOnly,
      ...recordHistory(state, nodes, state.edges),
    };
  }),
  setEdges: (edgesOrFn) => set((state) => {
    const edges = typeof edgesOrFn === 'function' ? edgesOrFn(state.edges) : edgesOrFn;
    if (edges === state.edges) return {};
    return {
      edges,
      hasUnsavedChanges: true,
      ...recordHistory(state, state.nodes, edges),
    };
  }),
  setNodeStatuses: (statuses, dirty = false) => set((state) => {
    let changed = false;
    const nodes = state.nodes.map((n) => {
      const status = statuses[n.id];
      if (!status || n.data?.status === status) return n;
      changed = true;
      return { ...n, data: { ...n.data, status } };
    });
    if (!changed) return {};
    return { nodes, hasUnsavedChanges: state.hasUnsavedChanges || dirty };
  }),

  // Undo / redo
  past: [],
  future: [],
  undo: () => set((state) => {
    const previous = state.past[state.past.length - 1];
    if (!previous) return {};
    return {
      nodes: previous.nodes,
      edges: previous.edges,
      past: state.past.slice(0, -1),
      future: [{ nodes: state.nodes, edges: state.edges }, ...state.future].slice(0, HISTORY_LIMIT),
      hasUnsavedChanges: true,
      editingNode: null,
    };
  }),
  redo: () => set((state) => {
    const next = state.future[0];
    if (!next) return {};
    return {
      nodes: next.nodes,
      edges: next.edges,
      past: [...state.past, { nodes: state.nodes, edges: state.edges }].slice(-HISTORY_LIMIT),
      future: state.future.slice(1),
      hasUnsavedChanges: true,
      editingNode: null,
    };
  }),
  resetHistory: () => {
    lastRecordedAt = 0;
    set({ past: [], future: [] });
  },

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
    inspectedScenario: nodeId && !state.recording ? null : state.inspectedScenario,
  })),
  selectNode: (nodeId) => set((state) => ({
    nodes: state.nodes.map((n) => (n.selected === (n.id === nodeId) ? n : { ...n, selected: n.id === nodeId })),
    selectedNode: nodeId,
    inspectedEnvironment: null,
    inspectedScenario: state.recording ? state.inspectedScenario : null,
    rightPanelVisible: true,
    settingsOpen: false,
  })),
  deselectAll: () => set((state) => ({
    nodes: state.nodes.some((n) => n.selected) ? state.nodes.map((n) => (n.selected ? { ...n, selected: false } : n)) : state.nodes,
    selectedNode: null,
  })),
  showExecutionPanel: false,
  setShowExecutionPanel: (show) => set({ showExecutionPanel: show }),

  // Deployment state
  isDeploying: false,
  setIsDeploying: (deploying) => set({ isDeploying: deploying }),
  run: null,
  startRun: (kind, environment) => set({
    run: newRun(kind, environment),
    isDeploying: true,
    activityOpen: true,
  }),
  applyRunEvent: (event) => set((state) => {
    if (!state.run) return {};
    const run = applyRunEvent(state.run, event);
    return { run, isDeploying: isActive(run) };
  }),
  appendRunOutput: (text, stream) => set((state) => (state.run ? { run: appendOutput(state.run, text, stream) } : {})),
  clearRun: () => set((state) => (isActive(state.run) ? {} : { run: null })),
  activityOpen: initialPrefs.activityOpen,
  setActivityOpen: (open) => {
    const prefs = setPreference('activityOpen', open);
    set({ activityOpen: open, prefs });
  },
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
  saving: false,
  setSaving: (saving) => set({ saving }),

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
    inspectedScenario: env ? null : state.inspectedScenario,
    // Opening an environment is a selection too: make sure it can be seen.
    rightPanelVisible: env ? true : state.rightPanelVisible,
    settingsOpen: env ? false : state.settingsOpen,
  })),
  editingNode: null,
  setEditingNode: (nodeId) => set({ editingNode: nodeId }),

  // Scenarios
  scenarios: [],
  setScenarios: (scenarios, dirty = false) => set((state) => ({
    scenarios,
    hasUnsavedChanges: state.hasUnsavedChanges || dirty,
    inspectedScenario: state.inspectedScenario && scenarios.some((s) => s.id === state.inspectedScenario) ? state.inspectedScenario : null,
    playhead: state.playhead && scenarios.some((s) => s.id === state.playhead!.scenarioId) ? state.playhead : null,
    recording: false,
  })),
  addScenario: (scenario) => set((state) => ({
    scenarios: [...state.scenarios, scenario],
    hasUnsavedChanges: true,
    inspectedScenario: scenario.id,
    inspectedEnvironment: null,
    rightPanelVisible: true,
    settingsOpen: false,
  })),
  newScenario: (triggerAt) => {
    const state = get();
    const scenario = createScenario(state.nodes, state.scenarios, triggerAt);
    if (scenario) state.addScenario(scenario);
  },
  updateScenario: (id, update) => set((state) => {
    let next: Scenario | undefined;
    const scenarios = state.scenarios.map((s) => {
      if (s.id !== id) return s;
      next = update(s);
      return next;
    });
    if (!next || next === state.scenarios.find((s) => s.id === id)) return {};
    // A playhead past the end of a shortened scenario is clamped.
    const playhead = state.playhead && state.playhead.scenarioId === id
      ? seekTo(next, state.playhead, Math.min(state.playhead.index, next.steps.length - 1))
      : state.playhead;
    return { scenarios, hasUnsavedChanges: true, playhead };
  }),
  removeScenario: (id) => set((state) => ({
    scenarios: state.scenarios.filter((s) => s.id !== id),
    hasUnsavedChanges: true,
    inspectedScenario: state.inspectedScenario === id ? null : state.inspectedScenario,
    playhead: state.playhead?.scenarioId === id ? null : state.playhead,
    recording: state.inspectedScenario === id ? false : state.recording,
  })),
  inspectedScenario: null,
  inspectScenario: (id) => set((state) => ({
    inspectedScenario: id,
    inspectedEnvironment: id ? null : state.inspectedEnvironment,
    recording: id ? state.recording : false,
    rightPanelVisible: id ? true : state.rightPanelVisible,
    settingsOpen: id ? false : state.settingsOpen,
  })),
  recording: false,
  setRecording: (on) => set((state) => (on && !state.inspectedScenario ? {} : { recording: on, playhead: on ? null : state.playhead })),
  recordStep: (nodeId) => set((state) => {
    const id = state.inspectedScenario;
    if (!state.recording || !id) return {};
    const scenario = state.scenarios.find((s) => s.id === id);
    const node = state.nodes.find((n) => n.id === nodeId);
    if (!scenario || !node || !canBeStep(node)) return {};
    const last = scenario.steps[scenario.steps.length - 1]?.at ?? scenario.trigger.at;
    if (last === nodeId) return {};
    const next = { ...scenario, steps: [...scenario.steps, { at: nodeId }] };
    return { scenarios: state.scenarios.map((s) => (s.id === id ? next : s)), hasUnsavedChanges: true };
  }),
  playhead: null,
  playScenario: (id) => set((state) => {
    const scenario = state.scenarios.find((s) => s.id === id);
    if (!scenario) return {};
    const speed = state.playhead?.speed ?? 1;
    const playhead: Playhead = scenario.steps.length
      ? { scenarioId: id, index: 0, phase: 'travel', attempt: 0, playing: true, speed }
      : { scenarioId: id, index: -1, phase: 'dwell', attempt: 0, playing: false, speed };
    return { playhead, recording: false, inspectedScenario: state.inspectedScenario ?? id };
  }),
  stopPlayback: () => set({ playhead: null }),
  setPlaying: (playing) => set(withPlayback((scenario, head) => {
    // Play at the end starts over.
    if (playing && head.phase === 'end') {
      return { ...head, index: 0, phase: scenario.steps.length ? 'travel' : 'dwell', attempt: 0, playing: scenario.steps.length > 0 };
    }
    return { ...head, playing };
  })),
  advancePlayback: () => set(withPlayback((scenario, head) => advancePlayhead(scenario, head))),
  seekPlayback: (index) => set(withPlayback((scenario, head) => seekTo(scenario, head, index))),
  stepBack: () => set(withPlayback((scenario, head) => seekTo(scenario, head, head.phase === 'end' ? scenario.steps.length - 1 : head.index - 1))),
  stepForward: () => set(withPlayback((scenario, head) => (head.phase === 'end' ? head : seekTo(scenario, head, head.index + 1)))),
  setPlaybackSpeed: (speed) => set(withPlayback((_scenario, head) => ({ ...head, speed }))),
  followPlayhead: false,
  setFollowPlayhead: (on) => set({ followPlayhead: on }),

  // Project lock
  locked: true,
  lock: () => set({ locked: true }),
  unlock: () => set({ locked: false }),

  // Holodeck
  holodeck: null,
  holodeckPreview: false,
  previewStash: null,
  setHolodeck: (meta) => set({ holodeck: meta, holodeckPreview: false, previewStash: null }),
  beginHolodeckPreview: (meta, project) => set((state) => ({
    ...projectPatch(project),
    previewStash: state.holodeckPreview ? state.previewStash : snapshotOf(state),
    holodeck: meta,
    holodeckPreview: true,
  })),
  endHolodeckPreview: () => {
    const stash = get().previewStash;
    set({ holodeck: null, holodeckPreview: false, previewStash: null });
    return stash;
  },
  loadProject: (project) => set({ ...projectPatch(project), holodeckPreview: false, previewStash: null, review: null, reviewByArn: new Map(), liveHealth: null, drift: null }),
  snapshotProject: () => snapshotOf(get()),
  fitPending: false,
  clearFitPending: () => set({ fitPending: false }),

  // Settings view
  settingsOpen: false,
  settingsSection: 'general',
  openSettings: (section) => set((state) => ({
    settingsOpen: true,
    settingsSection: section ?? state.settingsSection,
    paletteOpen: false,
  })),
  closeSettings: () => set({ settingsOpen: false }),

  // System view
  systemView: false,
  setSystemView: (on) => set((state) => ({ systemView: on, paletteOpen: false, settingsOpen: on ? false : state.settingsOpen })),

  // Dialogs and the palette
  dialog: null,
  openDialog: (dialog) => set({ dialog, paletteOpen: false }),
  review: null,
  reviewByArn: new Map(),
  reviewBusy: false,
  setReview: (review) => set({ review, reviewByArn: findingsByArn(review) }),
  setReviewBusy: (reviewBusy) => set({ reviewBusy }),
  liveHealth: null,
  liveBusy: false,
  setLiveHealth: (liveHealth) => set({ liveHealth }),
  setLiveBusy: (liveBusy) => set({ liveBusy }),
  drift: null,
  driftBusy: false,
  setDrift: (drift) => set({ drift }),
  setDriftBusy: (driftBusy) => set({ driftBusy }),
  importDiff: null,
  setImportDiff: (importDiff) => set({ importDiff }),
  receipts: [],
  clearReceipts: () => set({ receipts: [] }),
  chat: EMPTY_CHAT,
  assistantOpen: false,
  setAssistantOpen: (assistantOpen) => set({ assistantOpen }),
  pushChatItem: (item) => set((s) => ({ chat: { ...s.chat, items: [...s.chat.items, item] } })),
  setChatMessages: (messages) => set((s) => ({ chat: { ...s.chat, messages } })),
  setChatBusy: (busy) => set((s) => ({ chat: { ...s.chat, busy } })),
  setChatPending: (pending) => set((s) => ({ chat: { ...s.chat, pending } })),
  addChatUsage: (usage, model) => set((s) => ({ chat: { ...s.chat, model: model ?? s.chat.model, usage: { input: s.chat.usage.input + usage.input, output: s.chat.usage.output + usage.output, turns: s.chat.usage.turns + 1 } } })),
  clearChat: () => set((s) => ({ chat: { ...EMPTY_CHAT, pending: s.chat.pending } })),
  closeDialog: () => set({ dialog: null }),
  paletteOpen: false,
  setPaletteOpen: (open) => set({ paletteOpen: open }),

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

  lens: initialPrefs.lens,
  setLens: (lens) => {
    const layers = { ...LENS_LAYERS[lens] };
    setPreference('lens', lens);
    const prefs = setPreference('layers', layers);
    set({ lens, layers, prefs });
  },
  layers: initialPrefs.layers,
  setLayer: (layer, on) => set((state) => {
    const layers = { ...state.layers, [layer]: on };
    const prefs = setPreference('layers', layers);
    return { layers, prefs };
  }),
}));
