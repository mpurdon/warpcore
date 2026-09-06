// Runs `warpcore deploy` or `warpcore destroy` through the host and keeps
// the store in step with what the CLI reports. This is the only place the
// app starts a run; the toolbar, the palette and ⌘D all come here.
//
// Nothing is simulated. If the CLI says the plan is empty, the run shows an
// empty plan; if it dies, the run says so with its exit code.

import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { NodeStatus, useStore } from '../store/useStore';
import { isActive, matchNodeForResource, nodeStatusFor, RunEvent, RunKind } from './deployEvents';

/** Why a run cannot start right now, or null when it can. */
export function blockedReason(kind: RunKind): string | null {
  const s = useStore.getState();
  const verb = kind === 'deploy' ? 'deploy' : 'destroy';
  if (!s.configPath) return 'Open or save a project first';
  if (s.locked) return `The project is locked. Unlock it to ${verb}.`;
  if (isActive(s.run)) return `A ${s.run!.kind} is in progress`;
  return null;
}

/**
 * Start a run and resolve when the CLI has exited. Safe to call without
 * awaiting; the store carries everything the UI needs.
 */
export async function runDeployment(kind: RunKind): Promise<void> {
  const store = useStore.getState();
  if (blockedReason(kind)) return;
  const { configPath, currentEnvironment, debugMode } = store;

  store.startRun(kind, currentEnvironment);

  // Statuses the nodes should show, applied as the run progresses. Final
  // states are written to the project; "deploying" is not.
  const applyStatuses = (event: RunEvent) => {
    const s = useStore.getState();
    const run = s.run;
    if (!run) return;
    if (event.event === 'plan') {
      const statuses: Record<string, NodeStatus> = {};
      for (const r of run.resources) {
        const node = matchNodeForResource(r.id, s.nodes);
        const status = nodeStatusFor(kind, 'planned');
        if (node && status) statuses[node.id] = status;
      }
      s.setNodeStatuses(statuses, false);
    } else if (event.event === 'resource') {
      const r = run.resources.find((x) => x.id === String(event.id));
      const node = r ? matchNodeForResource(r.id, s.nodes) : undefined;
      const status = r ? nodeStatusFor(kind, r.status) : null;
      if (node && status) s.setNodeStatuses({ [node.id]: status }, r!.status !== 'in_progress');
    } else if (event.event === 'complete') {
      // Anything left mid-flight when the CLI finished did not happen.
      const statuses: Record<string, NodeStatus> = {};
      for (const r of run.resources) {
        const node = matchNodeForResource(r.id, s.nodes);
        if (!node) continue;
        if (r.status === 'skipped' && node.data?.status === 'deploying') statuses[node.id] = 'configured';
        if (r.status === 'failed') statuses[node.id] = 'failed';
      }
      s.setNodeStatuses(statuses, true);
    }
  };

  const unlisteners: UnlistenFn[] = [];
  try {
    unlisteners.push(await listen<RunEvent>('deployment-update', (e) => {
      const s = useStore.getState();
      s.applyRunEvent(e.payload);
      applyStatuses(e.payload);
    }));
    unlisteners.push(await listen<string>('cli-output', (e) => useStore.getState().appendRunOutput(e.payload, 'out')));
    unlisteners.push(await listen<string>('cli-error', (e) => useStore.getState().appendRunOutput(e.payload, 'err')));

    await invoke(kind === 'deploy' ? 'execute_deployment' : 'execute_destroy', {
      configPath,
      environment: currentEnvironment,
      debug: debugMode,
    });
  } catch (error) {
    // The host already emitted `exit` for a non-zero status. If the run is
    // somehow still active (the host could not even start, or this is not
    // running inside Tauri at all), close it here so it never spins forever.
    const s = useStore.getState();
    if (isActive(s.run)) {
      s.applyRunEvent({ event: 'error', message: String(error) });
      s.applyRunEvent({ event: 'exit', code: null, success: false });
    }
  } finally {
    for (const un of unlisteners) un();
    const s = useStore.getState();
    if (s.run && !isActive(s.run)) {
      s.setIsDeploying(false);
      s.addDeploymentHistory({
        id: `${kind}-${s.run.startedAt}`,
        timestamp: new Date(s.run.startedAt),
        status: s.run.outcome === 'success' ? 'deployed' : 'failed',
        duration: s.run.duration ?? ((s.run.endedAt ?? Date.now()) - s.run.startedAt) / 1000,
        changes: {
          created: s.run.resources.filter((r) => r.status === 'success' && r.change === 'create').map((r) => r.id),
          updated: s.run.resources.filter((r) => r.status === 'success' && r.change === 'update').map((r) => r.id),
          deleted: s.run.resources.filter((r) => r.status === 'success' && r.change === 'delete').map((r) => r.id),
        },
      });
    }
  }
}
