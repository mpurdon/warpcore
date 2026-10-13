// "Save a copy": a Holodeck entry becomes a project of the user's own. A
// name, a folder, one file written through the same path every project
// takes, then it opens unlocked.

import { useEffect, useState } from 'react';
import { AlertCircle, FolderOpen, X } from 'lucide-react';
import { useStore } from '../store/useStore';
import { joinPath } from '../utils/host';
import { HolodeckEntry } from '../utils/holodeck';
import { saveCopy } from '../utils/holodeckActions';
import { chooseDirectory, PROJECT_NAME_RE, PROJECT_NAME_RULE } from '../utils/projectIO';
import { slug } from '../utils/projectFromAccount';

export default function SaveCopyDialog({ entry, onClose }: { entry: HolodeckEntry; onClose: () => void }) {
  const prefs = useStore((s) => s.prefs);
  const [name, setName] = useState(slug(entry.meta.id, 64, true) || 'my-system');
  const [parentDir, setParentDir] = useState(prefs.projectsDir);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      if (!busy) onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [busy, onClose]);

  const problem = !PROJECT_NAME_RE.test(name) ? PROJECT_NAME_RULE : !parentDir ? 'Choose where to create the project.' : null;
  const path = parentDir ? joinPath(parentDir, name, 'warpcore.yaml') : '';

  const run = async () => {
    if (problem || busy) return;
    setBusy(true);
    setError(null);
    try {
      await saveCopy(entry, parentDir, name);
      onClose();
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[70] bg-black/40 flex items-center justify-center" onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="bg-surface text-gray-900 rounded-lg shadow-2xl w-[520px] overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-200 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold">Save a copy of {entry.meta.name}</h2>
            <p className="text-xs text-gray-500 mt-1">
              Writes a warpcore.yaml with the {entry.resourceCount} resources, the wiring and the {entry.scenarios.length} scenario{entry.scenarios.length === 1 ? '' : 's'}, then opens it unlocked. From there it is yours.
            </p>
          </div>
          {!busy && <button onClick={onClose} className="p-1 rounded hover:bg-gray-100 text-gray-400" title="Cancel (Esc)"><X size={16} /></button>}
        </div>
        <div className="px-5 py-4 space-y-4">
          {error && (
            <div className="p-3 bg-red-50 border border-red-200 rounded flex items-start gap-2 text-sm text-red-700">
              <AlertCircle size={16} className="mt-0.5 shrink-0" />
              <pre className="whitespace-pre-wrap font-mono text-xs">{error}</pre>
            </div>
          )}
          <label className="block">
            <span className="text-xs font-medium text-gray-700">Project name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void run(); }}
              autoFocus
              spellCheck={false}
              className="mt-1 w-full text-sm font-mono border border-gray-300 rounded px-2 py-1"
            />
          </label>
          <div>
            <span className="text-xs font-medium text-gray-700">Location</span>
            <div className="mt-1 flex items-center gap-2">
              <button onClick={async () => { const d = await chooseDirectory(parentDir, 'Create the project inside…'); if (d) setParentDir(d); }} className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded border border-gray-300 hover:bg-gray-50">
                <FolderOpen size={12} /> Choose…
              </button>
              <span className="text-xs font-mono text-gray-600 truncate">{path || 'not chosen'}</span>
            </div>
          </div>
          <p className="text-[11px] text-gray-500">
            Environments dev, staging and prod start from the built-in defaults; placeholder accounts until you set real ones on each environment.
          </p>
        </div>
        <div className="px-5 py-3 bg-gray-50 border-t border-gray-200 flex items-center justify-between">
          <span className="text-xs text-red-600">{problem || ''}</span>
          <span className="flex items-center gap-2">
            <button onClick={onClose} disabled={busy} className="text-sm px-3 py-1.5 rounded border border-gray-300 hover:bg-surface disabled:opacity-50">Cancel</button>
            <button onClick={run} disabled={busy || Boolean(problem)} className="text-sm px-3 py-1.5 rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50">
              {busy ? 'Writing…' : 'Create project'}
            </button>
          </span>
        </div>
      </div>
    </div>
  );
}
