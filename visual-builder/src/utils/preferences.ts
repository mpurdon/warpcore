// App-level developer preferences.
//
// These are local to this machine and are deliberately NOT part of
// EnvironmentConfig: environment settings get written into warpcore.yaml and
// shared with the team, whereas "am I debugging right now" is personal and
// must never end up in a committed config file.

const STORAGE_KEY = 'warpcore-preferences';

export interface Preferences {
  /** Runs the CLI with --dev: debug logging, AWS API tracing, session capture. */
  debugMode: boolean;
}

export const DEFAULT_PREFERENCES: Preferences = {
  debugMode: false,
};

export function getPreferences(): Preferences {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return { ...DEFAULT_PREFERENCES };
    // Spread over the defaults so a preference added in a later version does
    // not come back undefined for someone with an older stored blob.
    return { ...DEFAULT_PREFERENCES, ...(JSON.parse(stored) as Partial<Preferences>) };
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
