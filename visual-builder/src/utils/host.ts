// Host (Tauri) calls that are about this workstation rather than about AWS:
// where the app keeps its files, how big they are, and the bundled CLI.
//
// Everything here backs the application settings view. The shapes mirror the
// Rust structs in src-tauri/src/main.rs.

import { invoke } from '@tauri-apps/api/core';
import { formatBytes } from './accountExplorer';

export interface AppPaths {
  /** ~/.warpcore - where CLI runs land when no project is open. */
  home_warpcore: string;
  /** <project>/.warpcore - beside the open warpcore.yaml, or null. */
  project_warpcore: string | null;
  sidecar_path: string;
  /** False when the app fell back to a `warpcore` on PATH. */
  sidecar_bundled: boolean;
  app_version: string;
  /** Output of `warpcore --version`, or null when it could not be run. */
  cli_version: string | null;
  cli_error: string | null;
  platform: string;
  /** True for `tauri dev` and debug builds. */
  debug: boolean;
  git_sha: string;
  git_dirty: boolean;
  /** Unix seconds when the binary was compiled. */
  build_time: number;
  /** Unix seconds the sidecar was last written, i.e. when the CLI was built. */
  sidecar_modified: number | null;
}

/** When this copy of the frontend was loaded into the window. In dev, Vite
 * hot-reloads modules without a host recompile, so this is the stamp that
 * moves when UI code changes. */
export const FRONTEND_LOADED_AT = Math.floor(Date.now() / 1000);

/** "dev a1b2c3d4e*" for a debug build, "" for release. */
export function buildLabel(paths: AppPaths | null): string {
  if (!paths?.debug) return '';
  return `dev ${paths.git_sha}${paths.git_dirty ? '*' : ''}`;
}

export interface DirUsage {
  path: string;
  exists: boolean;
  bytes: number;
  files: number;
  /** Unix seconds of the most recently modified file, or null when empty. */
  newest: number | null;
}

export interface DirEntry {
  name: string;
  path: string;
  bytes: number;
  /** Unix seconds. */
  modified: number;
  is_dir: boolean;
}

export interface ScanCacheHit {
  /** Unix seconds when the scan finished. */
  saved_at: number;
  content: string;
}

export async function appPaths(configPath: string | null): Promise<AppPaths> {
  return invoke<AppPaths>('app_paths', { configPath });
}

export async function dirUsage(path: string): Promise<DirUsage> {
  return invoke<DirUsage>('dir_usage', { path });
}

export async function listDir(path: string): Promise<DirEntry[]> {
  return invoke<DirEntry[]>('list_dir', { path });
}

/** Reveal a .warpcore path in Finder / Explorer / the desktop's file manager. */
export async function openPath(path: string): Promise<void> {
  await invoke('open_path', { path });
}

/**
 * Delete the files under a .warpcore subdirectory. Returns how many were
 * removed. With olderThanDays, only files last modified before then go.
 */
export async function clearDir(path: string, olderThanDays?: number): Promise<number> {
  return invoke<number>('clear_dir', { path, olderThanDays: olderThanDays ?? null });
}

/** The last `lines` lines of a text file under .warpcore. */
export async function readTextTail(path: string, lines = 200): Promise<string> {
  return invoke<string>('read_text_tail', { path, lines });
}

/** Audit entries for one environment, newest first, as the CLI's JSON. */
export async function listAuditEntries(
  configPath: string | null,
  environment: string,
  limit = 30,
): Promise<AuditEntry[]> {
  const raw = await invoke<string>('list_audit_entries', { configPath, environment, limit });
  return JSON.parse(raw) as AuditEntry[];
}

/** Mirrors warpcore.audit.models.AuditEntry; only the fields the UI shows. */
export interface AuditEntry {
  id: string;
  timestamp: string;
  session_id: string;
  operation: string;
  status: string;
  resource_id: string;
  resource_type: string;
  physical_id: string | null;
  environment: string;
  project_name: string;
  region: string;
  duration_ms: number;
  error: string | null;
  actor: string;
  command: string;
  undone_at: string | null;
}

export async function readScanCache(key: string): Promise<ScanCacheHit | null> {
  return invoke<ScanCacheHit | null>('read_scan_cache', { key });
}

export async function writeScanCache(key: string, content: string): Promise<void> {
  await invoke('write_scan_cache', { key, content });
}

// ------------------------------------------------------------------ helpers

export { formatBytes };

/** "3 files · 76.5 KB · newest 2 h ago", or "nothing here yet". */
export function describeUsage(u: DirUsage | null | undefined): string {
  if (!u) return '';
  if (!u.exists || u.files === 0) return 'nothing here yet';
  return `${u.files} file${u.files === 1 ? '' : 's'} · ${formatBytes(u.bytes)}${u.newest ? ` · newest ${formatAgo(u.newest)}` : ''}`;
}

/** "3 min ago", "2 h ago", "5 d ago" from unix seconds. */
export function formatAgo(unixSeconds: number | null | undefined): string {
  if (unixSeconds == null) return '-';
  const seconds = Math.max(0, Math.floor(Date.now() / 1000 - unixSeconds));
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

/** Path joining that does not care which separator the host uses. */
export function joinPath(base: string, ...parts: string[]): string {
  const sep = base.includes('\\') && !base.includes('/') ? '\\' : '/';
  return [base.replace(/[\\/]+$/, ''), ...parts].join(sep);
}
