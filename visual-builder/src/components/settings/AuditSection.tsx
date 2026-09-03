import { useEffect, useState } from 'react';
import { AlertCircle, ClipboardList, RefreshCw } from 'lucide-react';
import { useStore } from '../../store/useStore';
import {
  AuditEntry, DirEntry, formatAgo, formatBytes, joinPath, listAuditEntries, listDir,
} from '../../utils/host';
import { useAppPaths, warpcoreRoots } from '../../utils/useAppPaths';
import { EmptyNote, MetricRow, PathRow, SectionHeader, SubHeader, useDirUsage } from './primitives';

const STATUS_COLOR: Record<string, string> = {
  success: 'text-emerald-600',
  failed: 'text-red-600',
  partial: 'text-amber-600',
};

function Trail({ label, root, configPath }: { label: string; root: string; configPath: string | null }) {
  const path = joinPath(root, 'audit');
  const { usage, reload } = useDirUsage(path);
  const [files, setFiles] = useState<DirEntry[]>([]);
  const [env, setEnv] = useState<string | null>(null);
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    listDir(path)
      .then((list) => { if (!cancelled) setFiles(list.filter((f) => f.name.endsWith('.jsonl'))); })
      .catch(() => { if (!cancelled) setFiles([]); });
    return () => { cancelled = true; };
  }, [path]);

  const load = async (name: string) => {
    setEnv(name);
    setLoading(true);
    setError(null);
    try {
      setEntries(await listAuditEntries(configPath, name, 50));
    } catch (e) {
      setEntries(null);
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="mb-8">
      <SubHeader title={label} />
      <PathRow label="audit" path={path} usage={usage} onReload={reload} />
      {files.length === 0 ? (
        <EmptyNote>No audit trail here yet. One appears after the first deploy or destroy.</EmptyNote>
      ) : (
        <div className="mt-1">
          {files.map((f) => {
            const name = f.name.replace(/\.jsonl$/, '');
            return (
              <MetricRow
                key={f.path}
                label={name}
                hint={`last write ${formatAgo(f.modified)}`}
                value={formatBytes(f.bytes)}
                onClick={() => load(name)}
              />
            );
          })}
        </div>
      )}

      {env && (
        <div className="mt-3 border border-gray-200 rounded-lg overflow-hidden">
          <div className="flex items-center justify-between px-3 py-2 bg-gray-50 border-b border-gray-200">
            <span className="text-xs text-gray-700">
              <strong>{env}</strong> · latest 50 entries, newest first
            </span>
            <button onClick={() => load(env)} className="p-1 rounded text-gray-400 hover:text-gray-700 hover:bg-gray-100" title="Refresh">
              <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
            </button>
          </div>
          {error && (
            <div className="m-3 p-2 bg-red-50 border border-red-200 rounded flex items-start gap-2 text-xs text-red-700">
              <AlertCircle size={14} className="mt-0.5 shrink-0" />
              <pre className="whitespace-pre-wrap font-mono">{error}</pre>
            </div>
          )}
          {entries && entries.length === 0 && <EmptyNote>No entries.</EmptyNote>}
          {entries && entries.length > 0 && (
            <div className="max-h-96 overflow-auto">
              <table className="w-full text-xs">
                <thead className="bg-white sticky top-0">
                  <tr className="text-left text-gray-500 border-b border-gray-200">
                    <th className="px-3 py-1.5 font-medium">When</th>
                    <th className="px-3 py-1.5 font-medium">Operation</th>
                    <th className="px-3 py-1.5 font-medium">Resource</th>
                    <th className="px-3 py-1.5 font-medium">Status</th>
                    <th className="px-3 py-1.5 font-medium">Actor</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((e) => (
                    <tr key={e.id} className="border-b border-gray-100 align-top" title={e.command}>
                      <td className="px-3 py-1.5 whitespace-nowrap text-gray-600">{new Date(e.timestamp).toLocaleString()}</td>
                      <td className="px-3 py-1.5 whitespace-nowrap">{e.operation}{e.undone_at ? ' (undone)' : ''}</td>
                      <td className="px-3 py-1.5 font-mono text-gray-800">
                        {e.resource_id}
                        {e.resource_type && <span className="text-gray-400"> · {e.resource_type}</span>}
                      </td>
                      <td className={`px-3 py-1.5 whitespace-nowrap ${STATUS_COLOR[e.status] || 'text-gray-700'}`}>
                        {e.status}
                        {e.error && <div className="text-red-600 font-mono max-w-xs truncate" title={e.error}>{e.error}</div>}
                      </td>
                      <td className="px-3 py-1.5 text-gray-600 max-w-[12rem] truncate" title={e.actor}>{e.actor || '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function AuditSection() {
  const { paths, error } = useAppPaths();
  const configPath = useStore((s) => s.configPath);

  return (
    <div>
      <SectionHeader
        icon={ClipboardList}
        title="Audit trail"
        description="Every create, update and delete the CLI performed in AWS, per environment, with the identity that did it. The trail is a record of real changes, so the app never deletes it; use the file manager if you must."
        scope={null}
      />
      {error && <EmptyNote>Could not resolve where files live: {error}</EmptyNote>}
      {!paths && !error && <EmptyNote>Finding where files live…</EmptyNote>}
      {paths && warpcoreRoots(paths).map((r) => (
        <Trail key={r.root} label={r.label} root={r.root} configPath={r.isProject ? configPath : null} />
      ))}
    </div>
  );
}
