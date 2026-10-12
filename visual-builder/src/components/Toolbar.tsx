// Three groups, left to right: scope (project, environment), the search /
// command box, and actions (tasks, lock, deploy, destroy, panels). The
// project name and the environment selector are selection surfaces:
// clicking them puts that object in the inspector. See DESIGN_GUIDANCE.md
// §5.3 and UX_PLAN.md §3.6: one light chrome, colour only for state and for
// the two actions that change AWS.

import { Play, Trash2, LibraryBig, FolderSearch, PanelRight, Radar, Search, Activity as ActivityIcon, Box, ClipboardCheck } from 'lucide-react';
import { useCurrentEnvName, useStore } from '../store/useStore';
import { useEffect, useRef } from 'react';
import { listen } from '@tauri-apps/api/event';
import HolodeckDrawer from './HolodeckDrawer';
import FindingsDrawer from './FindingsDrawer';
import FileMenu from './FileMenu';
import EnvironmentSelector from './EnvironmentSelector';
import ProjectDiscoveryPanel from './ProjectDiscoveryPanel';
import AccountExplorerPanel from './AccountExplorerPanel';
import ShortcutsHelp from './ShortcutsHelp';
import { isOwnSaveEcho, openProjectDialog, openProjectFile, saveProject } from '../utils/projectIO';
import { blockedReason } from '../utils/deployRunner';
import { runFromUi } from '../commands';
import { isActive } from '../utils/deployEvents';
import { dirname } from '../utils/paths';
import { useAppPaths } from '../utils/useAppPaths';
import { LockControl } from './ProjectLock';
import DevBuildBadge from './DevBuildBadge';

// Debounce delay for auto-save (ms)
const AUTO_SAVE_DELAY = 1000;

const quiet = 'px-2.5 py-1.5 rounded-md text-sm text-gray-700 hover:bg-gray-100 border border-transparent flex items-center gap-1.5';
const iconButton = (on: boolean) => `p-2 rounded-md transition-colors ${on ? 'bg-gray-100 text-gray-900' : 'text-gray-500 hover:bg-gray-100 hover:text-gray-900'} disabled:opacity-40`;

export default function Toolbar() {
  const {
    nodes,
    edges,
    configPath,
    projectName,
    hasUnsavedChanges,
    saving,
    currentEnvironment,
    environmentConfigs,
    environmentExtras,
    executionsPerMonth,
    rightPanelVisible,
    debugMode,
    inspectEnvironment,
    settingsOpen,
    closeSettings,
    locked,
    run,
    activityOpen,
    systemView,
    dialog,
    closeDialog,
    setPaletteOpen,
    review,
  } = useStore();
  const reviewCount = review?.findings.filter((f) => f.severity !== 'low').length ?? 0;

  const { paths: appInfo } = useAppPaths();
  const envName = useCurrentEnvName();
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const running = isActive(run);

  // Listen for file changes (only from external editors)
  useEffect(() => {
    const unlisten = listen('config-file-changed', async (event) => {
      const changedPath = event.payload as string;
      if (changedPath !== configPath) return;
      if (isOwnSaveEcho()) return;
      const shouldReload = confirm('Configuration file changed externally. Reload?');
      if (shouldReload) {
        try {
          await openProjectFile(changedPath);
        } catch (error) {
          console.error('Failed to reload file:', error);
        }
      }
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [configPath]);

  // Auto-save when changes are made (debounced)
  useEffect(() => {
    if (!configPath || !hasUnsavedChanges) return;
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    saveTimeoutRef.current = setTimeout(() => { void saveProject(); }, AUTO_SAVE_DELAY);
    return () => {
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    };
  }, [configPath, hasUnsavedChanges, nodes, edges, executionsPerMonth, environmentConfigs, environmentExtras]);

  // Every button runs a command (commands/): the dispatcher asks before a
  // destroy, writes the receipt, and is what an assistant would call.
  const handleDestroy = () => { void runFromUi('account.destroy'); };
  const inspectProject = () => { void runFromUi('view.inspectProject'); };

  const deployReason = blockedReason('deploy') ?? `Deploy to ${envName}${debugMode ? ' (developer mode)' : ''} · ⌘D`;
  const destroyReason = blockedReason('destroy') ?? `Destroy everything in ${envName}`;
  const runTone = !run ? '' : running ? 'bg-blue-500 animate-pulse' : run.outcome === 'success' ? 'bg-emerald-500' : run.outcome === 'partial' ? 'bg-amber-500' : 'bg-red-500';

  return (
    <div className="h-12 bg-white text-gray-900 flex items-center px-3 border-b border-gray-200 gap-2">
      {/* Scope */}
      <div className="flex items-center gap-2 shrink-0">
        <span className="text-[15px] font-semibold tracking-tight pl-1">Warpcore</span>
        <DevBuildBadge paths={appInfo} />
        <span className="w-px h-5 bg-gray-200 mx-1" />
        <button
          onClick={inspectProject}
          className="text-sm text-gray-800 hover:bg-gray-100 rounded-md px-2 py-1 truncate max-w-[220px]"
          title={configPath ? `Inspect the project · ${configPath}` : 'Inspect the project'}
        >
          {projectName || (configPath ? 'Project' : 'No project open')}
        </button>
        {saving && <span className="text-xs text-blue-600" title="Writing warpcore.yaml">● Saving</span>}
        {hasUnsavedChanges && !saving && (
          <span className="text-xs text-amber-600" title={configPath ? 'Changes are auto-saved a moment after you stop editing' : 'Not saved anywhere yet'}>● Unsaved</span>
        )}
        <EnvironmentSelector
          onOpenEnvironment={(env) => {
            closeSettings();
            inspectEnvironment(env);
          }}
        />
      </div>

      {/* Search / command box */}
      <button
        onClick={() => setPaletteOpen(true)}
        className="hidden lg:flex items-center gap-2 flex-1 min-w-[140px] max-w-[320px] mx-2 px-3 py-1.5 rounded-md border border-gray-200 bg-gray-50 hover:bg-white hover:border-gray-300 text-sm text-gray-500 text-left"
        title="Find a resource or run a command (⌘K)"
      >
        <Search size={14} className="shrink-0" />
        <span className="flex-1 truncate">Search resources and commands</span>
        <kbd className="text-[10px] font-mono text-gray-400 border border-gray-200 rounded px-1 bg-white">⌘K</kbd>
      </button>

      <div className="flex items-center gap-1 shrink-0 ml-auto">
        {/* Tasks */}
        <FileMenu onOpenFile={() => { void openProjectDialog(); }} onOpenRecent={(p) => { void openProjectFile(p); }} />

        {configPath && (
          <button onClick={() => { void runFromUi('view.dialog', { dialog: 'discovery' }); }} className={quiet} title="Scan this project's code for Strands SDK components">
            <FolderSearch size={15} />
            <span className="hidden 2xl:inline">Discover</span>
          </button>
        )}

        <button onClick={() => { void runFromUi('view.dialog', { dialog: 'explorer' }); }} className={quiet} title="Reverse-engineer an AWS account: every resource, drill in to config, network, metrics and logs">
          <Radar size={15} />
          <span className="hidden 2xl:inline">Explore</span>
        </button>

        {configPath && (
          <button onClick={() => { void runFromUi('view.dialog', { dialog: 'findings' }); }} className={quiet} title="Review: what the resources are doing, and what is wrong, wasteful or fragile">
            <ClipboardCheck size={15} />
            <span className="hidden 2xl:inline">Review</span>
            {reviewCount > 0 && <span className="ml-0.5 px-1.5 rounded-full bg-red-100 text-red-800 text-[10px] font-semibold">{reviewCount}</span>}
          </button>
        )}

        <button onClick={() => { void runFromUi('view.dialog', { dialog: 'holodeck' }); }} className={quiet} title="The Holodeck: systems to walk through with scenarios, and copy to work from">
          <LibraryBig size={15} />
          <span className="hidden 2xl:inline">Holodeck</span>
        </button>

        <span className="w-px h-5 bg-gray-200 mx-1" />

        {/* Actions */}
        <LockControl />

        <button
          onClick={() => { void runFromUi('account.deploy'); }}
          disabled={Boolean(blockedReason('deploy'))}
          title={deployReason}
          className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-md flex items-center gap-1.5 text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <Play size={15} />
          {running && run?.kind === 'deploy' ? 'Deploying…' : 'Deploy'}
        </button>

        <button
          onClick={handleDestroy}
          disabled={Boolean(blockedReason('destroy'))}
          title={destroyReason}
          className="px-3 py-1.5 rounded-md flex items-center gap-1.5 text-sm font-medium text-red-700 border border-red-200 hover:bg-red-50 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <Trash2 size={15} />
          {running && run?.kind === 'destroy' ? 'Destroying…' : 'Destroy'}
        </button>

        <span className="w-px h-5 bg-gray-200 mx-1" />

        <button
          onClick={() => { void runFromUi('view.activity'); }}
          disabled={settingsOpen || !run}
          className={`relative ${iconButton(activityOpen && Boolean(run))}`}
          title={!run ? 'Activity: nothing has run yet' : activityOpen ? 'Hide the activity drawer' : 'Show the activity drawer'}
        >
          <ActivityIcon size={17} />
          {run && <span className={`absolute top-1.5 right-1.5 w-1.5 h-1.5 rounded-full ${runTone}`} />}
        </button>

        <button
          onClick={() => { void runFromUi('view.systemView'); }}
          disabled={settingsOpen}
          className={iconButton(systemView)}
          title={systemView ? 'Back to the canvas' : 'System view: the canvas as terraces, read only. Scenarios play here too.'}
        >
          <Box size={17} />
        </button>

        <button
          onClick={() => { void runFromUi('view.inspector'); }}
          disabled={settingsOpen}
          className={iconButton(rightPanelVisible)}
          title={settingsOpen ? 'Close Settings to use the inspector' : rightPanelVisible ? 'Hide inspector' : 'Show inspector'}
        >
          <PanelRight size={17} />
        </button>
      </div>

      {dialog === 'holodeck' && <HolodeckDrawer onClose={closeDialog} />}
      {dialog === 'findings' && <FindingsDrawer onClose={closeDialog} />}
      {dialog === 'shortcuts' && <ShortcutsHelp onClose={closeDialog} />}

      <AccountExplorerPanel isOpen={dialog === 'explorer'} onClose={closeDialog} />

      {configPath && (
        <ProjectDiscoveryPanel
          isOpen={dialog === 'discovery'}
          onClose={closeDialog}
          projectPath={dirname(configPath)}
        />
      )}

      {/* The lock is a property of the deploy scope; keep the two in sight. */}
      <span className="sr-only">{locked ? 'locked' : 'unlocked'} · {currentEnvironment}</span>
    </div>
  );
}
