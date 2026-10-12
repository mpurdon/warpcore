// View commands: this operator's screen. Nothing here touches the project
// file or the account, so nothing here asks, locks or undoes.

import type { Node } from 'reactflow';
import { SETTINGS_SECTIONS, useStore, type Dialog, type SettingsSection } from '../store/useStore';
import { canvas } from '../utils/canvasActions';
import { LAYERS, type Layer } from '../utils/layers';
import { LENSES, type Lens } from '../utils/lenses';
import { displayNameFor } from '../utils/nodeName';
import { DISCOVERED_TYPES, discoveredTypeLabel } from '../utils/discoveredTypes';
import { SECTION_LABEL } from '../utils/settingsSections';
import { define } from './registry';

const DIALOGS: readonly Dialog[] = ['holodeck', 'explorer', 'discovery', 'shortcuts', 'findings'];
const DIALOG_TITLE: Record<Dialog, string> = {
  holodeck: 'Holodeck…', explorer: 'Explore an AWS account…', discovery: 'Discover Strands components…', shortcuts: 'Keyboard shortcuts', findings: 'Review…',
};
const DIALOG_DESCRIPTION: Record<Dialog, string> = {
  holodeck: 'Systems to walk through with scenarios, and copy to work from',
  explorer: 'Scan an account and turn it into a project',
  discovery: "Scan this project's code for Strands SDK components",
  shortcuts: 'Every keyboard shortcut in the app',
  findings: 'What the resources are doing, and what is wrong, wasteful or fragile',
};
const TONE = {
  draft: 'muted', warning: 'warn', configured: 'info', deploying: 'info', deployed: 'ok', failed: 'bad', present: 'muted',
} as const;

define({
  id: 'view.fit', title: 'Fit view', description: 'Show the whole canvas.', group: 'View', kind: 'view',
  shortcut: { key: '0', mod: true, label: '⌘0' },
  run: () => canvas.fitView(),
});

define({
  id: 'view.zoomIn', title: 'Zoom in', description: 'Zoom the canvas in one step.', group: 'View', kind: 'view', hidden: true,
  shortcut: { key: '=', mod: true, label: '⌘=' },
  run: () => canvas.zoomIn(),
});

define({
  id: 'view.zoomOut', title: 'Zoom out', description: 'Zoom the canvas out one step.', group: 'View', kind: 'view', hidden: true,
  shortcut: { key: '-', mod: true, label: '⌘-' },
  run: () => canvas.zoomOut(),
});

define({
  id: 'view.lens', title: 'Lens', description: 'View the canvas through a lens: all, security, network, dataflow, cost or live.', group: 'View', kind: 'view',
  params: { lens: { type: 'string', description: 'The lens', required: true, enum: LENSES.map((l) => l.id) } },
  keywords: ['view', 'filter', 'layer'],
  instances: (s) => LENSES.map((l) => ({
    key: l.id, args: { lens: l.id }, title: `Lens: ${l.label}`, subtitle: l.description, tone: s.lens === l.id ? 'info' : undefined,
  })),
  describe: (a) => `Lens: ${LENSES.find((l) => l.id === a.lens)?.label ?? a.lens}`,
  run: (a) => useStore.getState().setLens(a.lens as Lens),
});

define({
  id: 'view.layer', title: 'Edge layer', description: 'Show or hide one kind of edge: triggers, access, network, encryption or plumbing.', group: 'View', kind: 'view',
  params: {
    layer: { type: 'string', description: 'The edge layer', required: true, enum: LAYERS.map((l) => l.id) },
    on: { type: 'boolean', description: 'Show (true) or hide (false); omitted toggles' },
  },
  keywords: ['layer', 'edges'],
  instances: (s) => LAYERS.map((l) => ({
    key: l.id, args: { layer: l.id, on: !s.layers[l.id] }, title: `${s.layers[l.id] ? 'Hide' : 'Show'} ${l.label.toLowerCase()} edges`, subtitle: l.description,
  })),
  describe: (a, s) => `${(a.on ?? !s.layers[a.layer as Layer]) ? 'Show' : 'Hide'} ${a.layer} edges`,
  run: (a, { state }) => state.setLayer(a.layer as Layer, (a.on as boolean | undefined) ?? !state.layers[a.layer as Layer]),
});

define({
  id: 'view.systemView', title: (s) => (s.systemView ? 'Back to the canvas' : 'System view'),
  description: 'The canvas as terraces in 3D, read only; scenarios play there too. Omit `on` to toggle.', group: 'View', kind: 'view',
  params: { on: { type: 'boolean', description: 'Show the system view (true) or the canvas (false)' } },
  keywords: ['3d', 'three', 'terraces', 'presentation'],
  describe: (a, s) => (((a.on as boolean | undefined) ?? !s.systemView) ? 'System view' : 'Back to the canvas'),
  run: (a, { state }) => state.setSystemView((a.on as boolean | undefined) ?? !state.systemView),
});

define({
  id: 'view.inspector', title: (s) => `${s.rightPanelVisible ? 'Hide' : 'Show'} inspector`,
  description: 'Show or hide the right-hand inspector. Omit `visible` to toggle.', group: 'View', kind: 'view',
  params: { visible: { type: 'boolean', description: 'Show (true) or hide (false)' } },
  describe: (a, s) => `${((a.visible as boolean | undefined) ?? !s.rightPanelVisible) ? 'Show' : 'Hide'} inspector`,
  run: (a, { state }) => state.setRightPanelVisible((a.visible as boolean | undefined) ?? !state.rightPanelVisible),
});

define({
  id: 'view.activity', title: (s) => `${s.activityOpen ? 'Hide' : 'Show'} activity`,
  description: 'Show or hide the Activity drawer: the last deploy or destroy, its plan and output. Omit `open` to toggle.', group: 'View', kind: 'view',
  params: { open: { type: 'boolean', description: 'Open (true) or close (false)' } },
  describe: (a, s) => `${((a.open as boolean | undefined) ?? !s.activityOpen) ? 'Show' : 'Hide'} activity`,
  run: (a, { state }) => state.setActivityOpen((a.open as boolean | undefined) ?? !state.activityOpen),
});

define({
  id: 'view.palette', title: 'Command palette', description: 'Open the command palette.', group: 'View', kind: 'view', hidden: true, notForModel: true,
  shortcut: { key: 'k', mod: true, label: '⌘K' },
  run: (_a, { state }) => state.setPaletteOpen(!state.paletteOpen),
});

define({
  id: 'view.settings', title: 'Settings', description: 'Open application settings at a section.', group: 'Settings', kind: 'view',
  params: { section: { type: 'string', description: 'The settings section', enum: SETTINGS_SECTIONS } },
  shortcut: { key: ',', mod: true, label: '⌘,' },
  keywords: ['preferences', 'settings'],
  instances: () => SETTINGS_SECTIONS.map((section) => ({ key: section, args: { section }, title: `Settings: ${SECTION_LABEL[section]}` })),
  describe: (a) => `Settings: ${SECTION_LABEL[(a.section as SettingsSection) ?? 'general']}`,
  run: (a, { state }) => state.openSettings(a.section as SettingsSection | undefined),
});

define({
  id: 'view.dialog', title: 'Open', description: 'Open one of the app\'s dialogs: the Holodeck, the account explorer, project discovery, the shortcuts sheet or the Review.', group: 'Actions', kind: 'view',
  params: { dialog: { type: 'string', description: 'Which dialog', required: true, enum: DIALOGS } },
  keywords: ['template', 'example', 'library', 'scan', 'discover', 'import', 'reverse', 'review'],
  instances: (s) => DIALOGS.filter((d) => d !== 'discovery' || s.configPath).map((d) => ({
    key: d, args: { dialog: d }, title: DIALOG_TITLE[d], subtitle: DIALOG_DESCRIPTION[d], keywords: [d],
  })),
  describe: (a) => `Open ${a.dialog}`,
  run: (a, { state }) => state.openDialog(a.dialog as Dialog),
});

define({
  id: 'view.assistant', title: (s) => `${s.assistantOpen ? 'Hide' : 'Show'} assistant`,
  description: 'Show or hide the assistant panel. Omit `open` to toggle.', group: 'View', kind: 'view',
  params: { open: { type: 'boolean', description: 'Open (true) or close (false)' } },
  shortcut: { key: 'j', mod: true, label: '⌘J' },
  keywords: ['chat', 'ai', 'model', 'help'],
  describe: (a, s) => `${((a.open as boolean | undefined) ?? !s.assistantOpen) ? 'Show' : 'Hide'} assistant`,
  run: (a, { state }) => state.setAssistantOpen((a.open as boolean | undefined) ?? !state.assistantOpen),
});

define({
  id: 'view.closeDialog', title: 'Close dialog', description: 'Close whatever dialog is open.', group: 'View', kind: 'view', hidden: true, notForModel: true,
  run: (_a, { state }) => state.closeDialog(),
});

define({
  id: 'view.shortcuts', title: 'Keyboard shortcuts', description: 'The shortcuts sheet.', group: 'View', kind: 'view', notForModel: true,
  shortcut: { key: '?', label: '?' },
  run: (_a, { state }) => state.openDialog('shortcuts'),
});

define({
  id: 'view.select', title: 'Select a resource', description: 'Select a resource on the canvas, open it in the inspector, and pan to it. `id` is a node id; a label works when it is unique.', group: 'View', kind: 'view',
  params: { id: { type: 'string', description: 'The node id or its label', required: true } },
  instances: (s) => s.nodes.filter((n) => !n.hidden).map((n) => ({
    key: n.id, args: { id: n.id }, title: displayNameFor(n),
    subtitle: `${discoveredTypeLabel(n.type || '', n.data?.config) || DISCOVERED_TYPES[n.type || '']?.label || n.type || 'resource'} · ${n.id}`,
    keywords: [n.type || '', String(n.data?.arn || ''), String(n.data?.region || '')].filter(Boolean),
    tone: TONE[(n.data?.status as keyof typeof TONE | undefined) ?? 'draft'],
  })),
  describe: (a, s) => `Select ${nameOf(s, a.id as string)}`,
  run: (a, { state }) => {
    const node = findNode(state, a.id as string);
    if (!node) throw new Error(`no resource ${a.id} on the canvas`);
    state.selectNode(node.id);
    canvas.fitToNodes([node.id]);
    return { id: node.id };
  },
});

define({
  id: 'view.deselect', title: 'Clear the selection', description: 'Deselect everything; the inspector shows the project.', group: 'View', kind: 'view', hidden: true,
  run: (_a, { state }) => state.deselectAll(),
});

define({
  id: 'view.inspectProject', title: 'Inspect the project', description: 'Put the project itself in the inspector.', group: 'View', kind: 'view',
  run: (_a, { state }) => { state.closeSettings(); state.setSelectedNode(null); state.inspectEnvironment(null); state.setRightPanelVisible(true); },
});

define({
  id: 'view.configure', title: 'Configure a resource', description: 'Open the configuration form for a resource.', group: 'View', kind: 'view', hidden: true,
  params: { id: { type: 'string', description: 'The node id', required: true } },
  run: (a, { state }) => {
    const node = findNode(state, a.id as string);
    if (!node) throw new Error(`no resource ${a.id} on the canvas`);
    state.selectNode(node.id);
    state.setEditingNode(node.id);
  },
});

/** A resource's display name for a ref that may or may not resolve: for receipts and cards. */
export function nameOf(state: { nodes: Node[] }, ref: string): string {
  const node = findNode(state, ref);
  return node ? displayNameFor(node) : ref;
}

/** A node by id, else by unique label. */
export function findNode(state: { nodes: Node[] }, ref: string): Node | undefined {
  const byId = state.nodes.find((n) => n.id === ref);
  if (byId) return byId;
  const byLabel = state.nodes.filter((n) => displayNameFor(n) === ref || n.data?.label === ref);
  return byLabel.length === 1 ? byLabel[0] : undefined;
}
