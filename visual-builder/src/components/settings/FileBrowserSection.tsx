// Shared body for the Logs and Dev sessions sections: for each .warpcore root
// (home, and the open project's), the directory's usage, its files newest
// first, a viewer for one file, and clear actions.
//
// Logs and dev sessions are both "files the CLI wrote that the operator may
// want to read and is free to delete", so they get the same treatment.

import { useEffect, useState } from 'react';
import { Trash2, X } from 'lucide-react';
import {
  DirEntry, clearDir, formatAgo, formatBytes, joinPath, listDir, readTextTail,
} from '../../utils/host';
import { useAppPaths, warpcoreRoots } from '../../utils/useAppPaths';
import { EmptyNote, MetricRow, PathRow, SmallButton, SubHeader, useDirUsage } from './primitives';

interface Props {
  /** Subdirectory under each .warpcore root, e.g. "logs". */
  subdir: string;
  /** Noun for the things in the directory, e.g. "log files". */
  noun: string;
  /** Lines shown when a file is opened. */
  tailLines?: number;
  /** Extra hint under the file list. */
  hint?: string;
}

function Root({ label, root, subdir, noun, tailLines, hint }: Props & { label: string; root: string }) {
  const path = joinPath(root, subdir);
  const { usage, reload } = useDirUsage(path);
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [open, setOpen] = useState<{ entry: DirEntry; text: string } | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    listDir(path)
      .then((list) => { if (!cancelled) setEntries(list); })
      .catch(() => { if (!cancelled) setEntries([]); });
    return () => { cancelled = true; };
  }, [path, tick]);

  const refresh = () => { reload(); setTick((t) => t + 1); };

  const view = async (entry: DirEntry) => {
    if (entry.is_dir) return;
    try {
      const text = await readTextTail(entry.path, tailLines ?? 200);
      setOpen({ entry, text });
    } catch (e) {
      alert(String(e));
    }
  };

  const clear = async (olderThanDays?: number) => {
    const what = olderThanDays ? `${noun} older than ${olderThanDays} days` : `all ${noun}`;
    if (!confirm(`Delete ${what} under ${path}?`)) return;
    try {
      const removed = await clearDir(path, olderThanDays);
      setOpen(null);
      refresh();
      if (removed === 0) alert(`Nothing to delete: no ${what}.`);
    } catch (e) {
      alert(String(e));
    }
  };

  const hasFiles = Boolean(usage?.exists && usage.files > 0);

  return (
    <div className="mb-8">
      <SubHeader title={label} hint={hint} />
      <PathRow
        label={subdir}
        path={path}
        usage={usage}
        onReload={refresh}
        actions={
          <>
            <SmallButton onClick={() => clear(7)} disabled={!hasFiles} title={`Delete ${noun} older than 7 days`}>
              Clear older than 7 d
            </SmallButton>
            <SmallButton onClick={() => clear()} disabled={!hasFiles} danger title={`Delete all ${noun}`}>
              <span className="inline-flex items-center gap-1"><Trash2 size={12} /> Clear all</span>
            </SmallButton>
          </>
        }
      />
      {entries.length === 0 ? (
        <EmptyNote>No {noun} here yet.</EmptyNote>
      ) : (
        <div className="mt-1">
          {entries.slice(0, 30).map((entry) => (
            <MetricRow
              key={entry.path}
              label={entry.name}
              hint={entry.is_dir ? 'directory' : formatAgo(entry.modified)}
              value={formatBytes(entry.bytes)}
              onClick={entry.is_dir ? undefined : () => view(entry)}
            />
          ))}
          {entries.length > 30 && (
            <p className="text-xs text-gray-400 py-2">{entries.length - 30} more not shown. Reveal the folder to see them all.</p>
          )}
        </div>
      )}

      {open && (
        <div className="mt-3 border border-gray-200 rounded-lg overflow-hidden">
          <div className="flex items-center justify-between px-3 py-2 bg-gray-50 border-b border-gray-200">
            <span className="text-xs font-mono text-gray-700 truncate">{open.entry.name} · last {tailLines ?? 200} lines</span>
            <button onClick={() => setOpen(null)} className="p-1 rounded text-gray-400 hover:text-gray-700 hover:bg-gray-100" title="Close">
              <X size={14} />
            </button>
          </div>
          <pre className="text-[11px] font-mono leading-snug p-3 max-h-80 overflow-auto whitespace-pre-wrap break-all text-gray-800">
            {open.text || '(empty)'}
          </pre>
        </div>
      )}
    </div>
  );
}

export default function FileBrowserSection(props: Props) {
  const { paths, error } = useAppPaths();
  if (error) return <EmptyNote>Could not resolve where files live: {error}</EmptyNote>;
  if (!paths) return <EmptyNote>Loading…</EmptyNote>;
  return (
    <div>
      {warpcoreRoots(paths).map((r) => <Root key={r.root} label={r.label} root={r.root} {...props} />)}
    </div>
  );
}
