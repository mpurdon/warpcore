// Project commands: the file, the lock, history, environments.

import { ENVIRONMENT_TEMPLATES, environmentFromTemplate, useStore } from '../store/useStore';
import { openProjectDialog, openProjectFile, saveProject } from '../utils/projectIO';
import { closePreview } from '../utils/holodeckActions';
import { define } from './registry';

define({
  id: 'project.open', title: 'Open project…', description: 'Open a warpcore.yaml. With `path`, open that file; without, show the file chooser.', group: 'Actions', kind: 'view', notForModel: true,
  params: { path: { type: 'string', description: 'Absolute path to a warpcore.yaml' } },
  shortcut: { key: 'o', mod: true, label: '⌘O' },
  describe: (a) => (a.path ? `Open ${a.path}` : 'Open a project'),
  run: async (a) => { if (a.path) await openProjectFile(a.path as string); else await openProjectDialog(); },
});

define({
  id: 'project.save', title: 'Save project', description: 'Write the project to its warpcore.yaml now (changes also auto-save).', group: 'Actions', kind: 'file',
  shortcut: { key: 's', mod: true, label: '⌘S' },
  available: (s) => (s.configPath ? null : 'No file yet: open or create a project first'),
  describe: (_a, s) => `Save ${s.configPath ?? 'the project'}`,
  run: async () => ({ saved: await saveProject() }),
});

define({
  id: 'project.lock', title: 'Lock the project', description: 'Back to view-only: the canvas cannot be edited and Deploy and Destroy are off.', group: 'Actions', kind: 'file',
  available: (s) => (!s.configPath ? 'Nothing is open' : s.locked ? 'Already locked' : null),
  run: (_a, { state }) => state.lock(),
});

define({
  id: 'project.unlock', title: 'Unlock the project', description: 'Allow edits and deploys. Changes auto-save to the file.', group: 'Actions', kind: 'file',
  available: (s) => (!s.configPath ? 'Nothing is open' : s.holodeckPreview ? 'A Holodeck preview cannot be unlocked; save a copy first' : !s.locked ? 'Already unlocked' : null),
  run: (_a, { state }) => state.unlock(),
});

define({
  id: 'project.undo', title: 'Undo', description: 'Undo the last canvas change.', group: 'Actions', kind: 'project',
  shortcut: { key: 'z', mod: true, label: '⌘Z' },
  available: (s) => (s.past.length ? null : 'Nothing to undo'),
  describe: (_a, s) => `Undo (${s.past.length} step${s.past.length === 1 ? '' : 's'} back)`,
  run: (_a, { state }) => state.undo(),
});

define({
  id: 'project.redo', title: 'Redo', description: 'Redo the last undone canvas change.', group: 'Actions', kind: 'project',
  shortcut: { key: 'z', mod: true, shift: true, label: '⇧⌘Z' },
  available: (s) => (s.future.length ? null : 'Nothing to redo'),
  run: (_a, { state }) => state.redo(),
});

define({
  id: 'project.closePreview', title: 'Close the Holodeck preview', description: 'Leave the preview and go back to what was open before.', group: 'Actions', kind: 'view',
  keywords: ['preview', 'holodeck'],
  available: (s) => (s.holodeckPreview ? null : 'No preview is open'),
  run: () => closePreview(),
});

define({
  id: 'project.switchEnvironment', title: 'Switch environment', description: 'Make an environment the deploy scope. Re-locks the project.', group: 'Environments', kind: 'view',
  params: { environment: { type: 'string', description: 'The environment key, e.g. dev', required: true } },
  instances: (s) => Object.entries(s.environmentConfigs).map(([key, cfg]) => ({
    key, args: { environment: key }, title: `Switch to ${cfg.name}`, keywords: [key, 'environment'],
    subtitle: key === s.currentEnvironment ? 'Current deploy scope' : `Make ${key} the deploy scope (re-locks the project)`,
  })),
  describe: (a) => `Switch to ${a.environment}`,
  run: (a, { state }) => {
    const key = a.environment as string;
    if (!state.environmentConfigs[key]) throw new Error(`no environment ${key}; have ${Object.keys(state.environmentConfigs).join(', ')}`);
    state.setCurrentEnvironment(key);
  },
});

define({
  id: 'project.inspectEnvironment', title: 'Inspect environment', description: 'Open an environment in the inspector: removal policies, logging, Lambda defaults.', group: 'Environments', kind: 'view',
  params: { environment: { type: 'string', description: 'The environment key', required: true } },
  instances: (s) => Object.entries(s.environmentConfigs).map(([key, cfg]) => ({
    key, args: { environment: key }, title: `Inspect ${cfg.name}`, subtitle: 'Removal policies, logging, Lambda defaults', keywords: [key, 'environment', 'settings'],
  })),
  describe: (a) => `Inspect ${a.environment}`,
  run: (a, { state }) => {
    const key = a.environment as string;
    if (!state.environmentConfigs[key]) throw new Error(`no environment ${key}`);
    state.inspectEnvironment(key);
  },
});

define({
  id: 'project.addEnvironment', title: 'Add environment', description: 'Add an environment from a template (dev, staging, prod) or as a copy of an existing one.', group: 'Environments', kind: 'project', hidden: true,
  params: {
    name: { type: 'string', description: 'Display name; the key is derived from it', required: true },
    from: { type: 'string', description: 'A template name or an existing environment key; default dev' },
  },
  describe: (a) => `Add environment ${a.name}`,
  run: (a, { state }) => {
    const name = String(a.name).trim();
    const key = name.toLowerCase().replace(/\s+/g, '-');
    if (state.environmentConfigs[key]) throw new Error(`environment ${key} already exists`);
    const base = state.environmentConfigs[String(a.from ?? '')] ?? ENVIRONMENT_TEMPLATES[String(a.from ?? 'dev')] ?? ENVIRONMENT_TEMPLATES.dev;
    state.setEnvironmentConfig(key, environmentFromTemplate(base, name));
    useStore.getState().setHasUnsavedChanges(true);
    return { key };
  },
});
