// Where this workstation keeps Warpcore's files, and whether the bundled CLI
// runs. Shared by the left-rail status line and the settings view.

import { useCallback, useEffect, useState } from 'react';
import { useStore } from '../store/useStore';
import { AppPaths, appPaths } from './host';

export interface AppPathsState {
  paths: AppPaths | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
}

// app_paths runs `warpcore --version`, and a PyInstaller binary takes a few
// seconds to start. Share one in-flight lookup per project across every
// mount so the settings sections open instantly once the rail footer has
// done it; reload() bypasses the cache.
const cache = new Map<string, Promise<AppPaths>>();

function lookup(configPath: string | null, fresh: boolean): Promise<AppPaths> {
  const key = configPath ?? '';
  if (fresh || !cache.has(key)) {
    const p = appPaths(configPath);
    cache.set(key, p);
    // A failure must not be cached, or the section could never recover.
    p.catch(() => cache.delete(key));
  }
  return cache.get(key)!;
}

export function useAppPaths(): AppPathsState {
  const configPath = useStore((s) => s.configPath);
  const [paths, setPaths] = useState<AppPaths | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    lookup(configPath, tick > 0)
      .then((p) => {
        if (cancelled) return;
        setPaths(p);
        setError(null);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [configPath, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { paths, error, loading, reload };
}

/**
 * The .warpcore roots a settings section should show: the open project's,
 * then home. Home is labelled by what lands there.
 */
export function warpcoreRoots(paths: AppPaths): { label: string; root: string; isProject: boolean }[] {
  const roots: { label: string; root: string; isProject: boolean }[] = [];
  if (paths.project_warpcore) roots.push({ label: 'This project', root: paths.project_warpcore, isProject: true });
  roots.push({ label: paths.project_warpcore ? 'Home (runs with no project open)' : 'Home', root: paths.home_warpcore, isProject: false });
  return roots;
}
