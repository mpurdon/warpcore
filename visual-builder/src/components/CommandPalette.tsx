// ⌘K. One box that finds any resource on the canvas and runs any action in
// the app. Selecting a resource selects it, opens the inspector and pans
// the canvas to it; everything else is what the toolbar, menus and
// settings already do, reachable without hunting for it.

import { useEffect, useMemo, useRef, useState } from 'react';
import { Search, CornerDownLeft } from 'lucide-react';
import { useStore, NodeStatus, SETTINGS_SECTIONS } from '../store/useStore';
import { displayNameFor } from '../utils/nodeName';
import { DISCOVERED_TYPES, discoveredTypeLabel } from '../utils/discoveredTypes';
import { groupItems, PaletteItem, rankItems } from '../utils/palette';
import { LENSES } from '../utils/lenses';
import { LAYERS } from '../utils/layers';
import { canvas } from '../utils/canvasActions';
import { openProjectDialog, saveProject } from '../utils/projectIO';
import { blockedReason, runDeployment } from '../utils/deployRunner';
import { StatusDot, Tone } from './inspector/InspectorHeader';

const TONE: Record<NodeStatus, Tone> = {
  draft: 'muted', warning: 'warn', configured: 'info', deploying: 'info', deployed: 'ok', failed: 'bad', present: 'muted',
};

const SECTION_LABELS: Record<(typeof SETTINGS_SECTIONS)[number], string> = {
  general: 'General', regions: 'Regions', exploration: 'Exploration', logs: 'Logs', audit: 'Audit trail',
  sessions: 'Dev sessions', storage: 'Storage', projects: 'Projects', about: 'About',
};

function typeLabel(type: string | undefined, config: Record<string, unknown> | undefined): string {
  if (!type) return 'resource';
  return discoveredTypeLabel(type, config) || DISCOVERED_TYPES[type]?.label || type;
}

export default function CommandPalette() {
  const s = useStore();
  const { paletteOpen, setPaletteOpen } = s;
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (paletteOpen) {
      setQuery('');
      setCursor(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [paletteOpen]);

  const close = () => setPaletteOpen(false);
  const after = (fn: () => void) => () => { close(); fn(); };

  const items = useMemo<PaletteItem[]>(() => {
    if (!paletteOpen) return [];
    const list: PaletteItem[] = [];
    const deployBlock = blockedReason('deploy');
    const destroyBlock = blockedReason('destroy');
    const envName = s.environmentConfigs[s.currentEnvironment]?.name ?? s.currentEnvironment;

    // Actions
    list.push({ id: 'deploy', kind: 'command', group: 'Actions', title: `Deploy to ${envName}`, subtitle: deployBlock ?? 'Runs warpcore deploy and shows the run in Activity', shortcut: '⌘D', keywords: ['run', 'apply'], run: after(() => { if (!deployBlock) void runDeployment('deploy'); }) });
    list.push({ id: 'destroy', kind: 'command', group: 'Actions', title: `Destroy ${envName}`, subtitle: destroyBlock ?? 'Asks first, then runs warpcore destroy', keywords: ['delete', 'teardown', 'remove'], run: after(() => { if (destroyBlock) return; if (confirm(`Destroy every resource in the ${envName} environment?`)) void runDeployment('destroy'); }) });
    list.push({ id: 'save', kind: 'command', group: 'Actions', title: 'Save project', subtitle: s.configPath ? s.configPath : 'No file yet: open or create a project first', shortcut: '⌘S', run: after(() => { void saveProject(); }) });
    list.push({ id: 'open', kind: 'command', group: 'Actions', title: 'Open project…', subtitle: 'Choose a warpcore.yaml', shortcut: '⌘O', run: after(() => { void openProjectDialog(); }) });
    list.push({ id: 'templates', kind: 'command', group: 'Actions', title: 'Templates…', subtitle: 'Start from a template or save this canvas as one', run: after(() => s.openDialog('templates')) });
    list.push({ id: 'explore', kind: 'command', group: 'Actions', title: 'Explore an AWS account…', subtitle: 'Scan an account and turn it into a project', keywords: ['scan', 'discover', 'import', 'reverse'], run: after(() => s.openDialog('explorer')) });
    if (s.configPath) list.push({ id: 'discover', kind: 'command', group: 'Actions', title: 'Discover Strands components…', subtitle: 'Scan this project\'s code', keywords: ['scan'], run: after(() => s.openDialog('discovery')) });
    if (s.configPath && !s.locked) list.push({ id: 'lock', kind: 'command', group: 'Actions', title: 'Lock the project', subtitle: 'Back to view-only', run: after(() => s.lock()) });
    list.push({ id: 'undo', kind: 'command', group: 'Actions', title: 'Undo', subtitle: s.past.length ? `${s.past.length} step${s.past.length === 1 ? '' : 's'} back` : 'Nothing to undo', shortcut: '⌘Z', run: after(() => s.undo()) });
    list.push({ id: 'redo', kind: 'command', group: 'Actions', title: 'Redo', subtitle: s.future.length ? `${s.future.length} step${s.future.length === 1 ? '' : 's'} forward` : 'Nothing to redo', shortcut: '⇧⌘Z', run: after(() => s.redo()) });

    // View
    list.push({ id: 'fit', kind: 'command', group: 'View', title: 'Fit view', subtitle: 'Show the whole canvas', shortcut: '⌘0', run: after(() => canvas.fitView()) });
    for (const lens of LENSES) {
      list.push({ id: `lens-${lens.id}`, kind: 'lens', group: 'View', title: `Lens: ${lens.label}`, subtitle: lens.description, shortcut: lens.key, keywords: ['view', 'filter', 'layer'], tone: s.lens === lens.id ? 'info' : undefined, run: after(() => s.setLens(lens.id)) });
    }
    for (const layer of LAYERS) {
      const on = s.layers[layer.id];
      list.push({ id: `layer-${layer.id}`, kind: 'layer', group: 'View', title: `${on ? 'Hide' : 'Show'} ${layer.label.toLowerCase()} edges`, subtitle: layer.description, keywords: ['layer', 'edges'], run: after(() => s.setLayer(layer.id, !on)) });
    }
    list.push({ id: 'inspector', kind: 'command', group: 'View', title: `${s.rightPanelVisible ? 'Hide' : 'Show'} inspector`, run: after(() => s.setRightPanelVisible(!s.rightPanelVisible)) });
    list.push({ id: 'activity', kind: 'command', group: 'View', title: `${s.activityOpen ? 'Hide' : 'Show'} activity`, subtitle: s.run ? `Last run: ${s.run.kind} to ${s.run.environment}` : 'Nothing has run yet', run: after(() => s.setActivityOpen(!s.activityOpen)) });
    list.push({ id: 'help', kind: 'command', group: 'View', title: 'Keyboard shortcuts', shortcut: '?', run: after(() => s.openDialog('shortcuts')) });

    // Resources
    for (const n of s.nodes) {
      if (n.hidden) continue;
      const status = (n.data?.status as NodeStatus | undefined) ?? 'draft';
      list.push({
        id: `node-${n.id}`,
        kind: 'resource',
        group: 'Resources',
        title: displayNameFor(n),
        subtitle: `${typeLabel(n.type, n.data?.config)} · ${n.id}`,
        keywords: [n.type || '', String(n.data?.arn || ''), String(n.data?.region || '')].filter(Boolean),
        tone: TONE[status],
        run: after(() => {
          s.selectNode(n.id);
          canvas.fitToNodes([n.id]);
        }),
      });
    }

    // Environments
    for (const [key, cfg] of Object.entries(s.environmentConfigs)) {
      list.push({ id: `env-switch-${key}`, kind: 'environment', group: 'Environments', title: `Switch to ${cfg.name}`, subtitle: key === s.currentEnvironment ? 'Current deploy scope' : `Make ${key} the deploy scope (re-locks the project)`, keywords: [key, 'environment'], run: after(() => s.setCurrentEnvironment(key)) });
      list.push({ id: `env-inspect-${key}`, kind: 'environment', group: 'Environments', title: `Inspect ${cfg.name}`, subtitle: 'Removal policies, logging, Lambda defaults', keywords: [key, 'environment', 'settings'], run: after(() => s.inspectEnvironment(key)) });
    }

    // Settings
    for (const section of SETTINGS_SECTIONS) {
      list.push({ id: `settings-${section}`, kind: 'setting', group: 'Settings', title: `Settings: ${SECTION_LABELS[section]}`, shortcut: section === 'general' ? '⌘,' : undefined, keywords: ['preferences', 'settings'], run: after(() => s.openSettings(section)) });
    }
    return list;
    // The palette rebuilds when it opens; the store fields it reads are
    // captured then, which is what a snapshot-style list wants.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paletteOpen, s.nodes, s.environmentConfigs, s.currentEnvironment, s.configPath, s.locked, s.lens, s.layers, s.rightPanelVisible, s.activityOpen, s.run, s.past.length, s.future.length]);

  const ranked = useMemo(() => rankItems(query, items, query.trim() ? 40 : 200), [query, items]);
  const groups = useMemo(() => groupItems(ranked), [ranked]);
  const flat = ranked;

  useEffect(() => { setCursor(0); }, [query]);
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${cursor}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  if (!paletteOpen) return null;

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setCursor((c) => Math.min(flat.length - 1, c + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setCursor((c) => Math.max(0, c - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); flat[cursor]?.run(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
  };

  let index = -1;
  return (
    <div className="fixed inset-0 z-[80] bg-gray-900/30 backdrop-blur-[1px] flex items-start justify-center pt-[12vh]" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="w-[640px] max-w-[92vw] bg-white rounded-xl shadow-2xl border border-gray-200 overflow-hidden palette-enter" role="dialog" aria-label="Command palette">
        <div className="flex items-center gap-2 px-3 border-b border-gray-200">
          <Search size={16} className="text-gray-400 shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Find a resource, switch a lens, run a command…"
            className="flex-1 py-3 text-sm outline-none placeholder:text-gray-400 bg-transparent"
            spellCheck={false}
            autoComplete="off"
          />
          <kbd className="text-[10px] font-mono text-gray-400 border border-gray-200 rounded px-1">esc</kbd>
        </div>
        <div ref={listRef} className="max-h-[52vh] overflow-y-auto py-1">
          {flat.length === 0 && (
            <div className="px-4 py-8 text-sm text-gray-500 text-center">Nothing matches "{query}".</div>
          )}
          {groups.map((g) => (
            <div key={g.group}>
              <div className="px-4 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wide text-gray-400">{g.group}</div>
              {g.items.map((item) => {
                index += 1;
                const i = index;
                const active = i === cursor;
                return (
                  <button
                    key={item.id}
                    data-index={i}
                    onMouseEnter={() => setCursor(i)}
                    onClick={() => item.run()}
                    className={`w-full flex items-center gap-3 px-4 py-1.5 text-left ${active ? 'bg-blue-50' : ''}`}
                  >
                    {item.tone ? <StatusDot tone={item.tone} label="" /> : <span className="w-2" />}
                    <span className="flex-1 min-w-0">
                      <span className={`block text-sm truncate ${active ? 'text-blue-900' : 'text-gray-900'}`}>{item.title}</span>
                      {item.subtitle && <span className="block text-[11px] text-gray-500 truncate">{item.subtitle}</span>}
                    </span>
                    {item.shortcut && <kbd className="text-[10px] font-mono text-gray-400 border border-gray-200 rounded px-1 shrink-0">{item.shortcut}</kbd>}
                    {active && <CornerDownLeft size={12} className="text-blue-400 shrink-0" />}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
