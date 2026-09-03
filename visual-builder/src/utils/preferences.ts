// App-level preferences: properties of this workstation and this operator.
//
// These are local to this machine and are deliberately NOT part of
// EnvironmentConfig: environment settings get written into warpcore.yaml and
// shared with the team, whereas "am I debugging right now" or "how long do I
// trust a scan" is personal and must never end up in a committed config file.
//
// Changing anything here changes how the tool behaves, never what gets
// deployed. See DESIGN_GUIDANCE.md §4.2.

import { DEFAULT_LAYERS, Layer } from './layers';

const STORAGE_KEY = 'warpcore-preferences';

export type LogLevel = 'debug' | 'info' | 'warning' | 'error';

export interface Preferences {
  /** Runs the CLI with --dev: debug logging, AWS API tracing, session capture. */
  debugMode: boolean;
  /**
   * AWS regions this user cares about, as region codes.
   *
   * Empty means "not configured yet", which callers treat as the profile's own
   * region rather than as "no regions" - an empty list must never silently
   * mean an empty scan.
   */
  regions: string[];
  /**
   * AWS profile the Account Explorer and region lookups start from. Empty
   * means "whichever profile was used last", which is the historical
   * behaviour.
   */
  defaultProfile: string;
  /**
   * How long a completed account scan is reused before the Explorer scans
   * again. 0 disables the cache: every open is a fresh scan.
   */
  scanCacheMinutes: number;
  /** Regions scanned concurrently; the CLI's --parallelism. */
  scanParallelism: number;
  /** --log-level passed to every CLI invocation when debug mode is off. */
  logLevel: LogLevel;
  /** Directory the Open dialog starts in. Empty means the OS default. */
  projectsDir: string;
  /** Which edge layers the canvas shows. */
  layers: Record<Layer, boolean>;
}

export const DEFAULT_PREFERENCES: Preferences = {
  debugMode: false,
  regions: [],
  defaultProfile: '',
  scanCacheMinutes: 60,
  scanParallelism: 6,
  logLevel: 'info',
  projectsDir: '',
  layers: { ...DEFAULT_LAYERS },
};

export function getPreferences(): Preferences {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return { ...DEFAULT_PREFERENCES };
    // Spread over the defaults so a preference added in a later version does
    // not come back undefined for someone with an older stored blob.
    const parsed = JSON.parse(stored) as Partial<Preferences>;
    return { ...DEFAULT_PREFERENCES, ...parsed, layers: { ...DEFAULT_LAYERS, ...(parsed.layers || {}) } };
  } catch {
    return { ...DEFAULT_PREFERENCES };
  }
}

export function setPreference<K extends keyof Preferences>(
  key: K,
  value: Preferences[K],
): Preferences {
  const updated = { ...getPreferences(), [key]: value };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
  } catch {
    // Storage can be unavailable (private browsing, quota). The preference
    // still applies for this session; it just will not survive a restart.
  }
  return updated;
}

/** Forget every preference. The next read returns the defaults. */
export function resetPreferences(): Preferences {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to do; see setPreference.
  }
  return { ...DEFAULT_PREFERENCES };
}
