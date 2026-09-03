import { useEffect, useState } from 'react';
import { HardDrive, Trash2 } from 'lucide-react';
import { useStore } from '../../store/useStore';
import { DirUsage, clearDir, describeUsage, dirUsage, formatBytes, joinPath, openPath } from '../../utils/host';
import { getRecentProjects, clearRecentProjects } from '../../utils/recentProjects';
import { useAppPaths, warpcoreRoots } from '../../utils/useAppPaths';
import { EmptyNote, MetricRow, SectionHeader, SmallButton, SubHeader } from './primitives';

// What each subdirectory is, and whether the app may empty it.
const AREAS: { subdir: string; label: string; clearable: boolean; why: string }[] = [
  { subdir: 'logs', label: 'Application logs', clearable: true, why: 'Diagnostics only.' },
  { subdir: 'audit', label: 'Audit trail', clearable: false, why: 'A record of real AWS changes; never deleted by the app.' },
  { subdir: 'dev', label: 'Dev sessions', clearable: true, why: 'Developer-mode captures.' },
  { subdir: 'cache', label: 'Scan cache', clearable: true, why: 'Rebuilt by the next scan.' },
  { subdir: 'state', label: 'Deployment state', clearable: false, why: 'Which AWS resources belong to which environment. Losing it orphans them.' },
];

function Root({ label, root }: { label: string; root: string }) {
  const [usages, setUsages] = useState<Record<string, DirUsage>>({});
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    Promise.all(
      AREAS.map((a) => dirUsage(joinPath(root, a.subdir)).then((u) => [a.subdir, u] as const).catch(() => null)),
    ).then((pairs) => {
      if (cancelled) return;
      const next: Record<string, DirUsage> = {};
      for (const pair of pairs) if (pair) next[pair[0]] = pair[1];
      setUsages(next);
    });
    return () => { cancelled = true; };
  }, [root, tick]);

  const total = Object.values(usages).reduce((s, u) => s + u.bytes, 0);

  const clear = async (subdir: string, label: string) => {
    if (!confirm(`Delete everything under ${label}? (${joinPath(root, subdir)})`)) return;
    try {
      await clearDir(joinPath(root, subdir));
      setTick((t) => t + 1);
    } catch (e) {
      alert(String(e));
    }
  };

  return (
    <div className="mb-8">
      <SubHeader title={label} hint={<span className="font-mono">{root}</span>} />
      {AREAS.map((a) => {
        const u = usages[a.subdir];
        const empty = !u || !u.exists || u.files === 0;
        return (
          <MetricRow
            key={a.subdir}
            label={a.label}
            hint={`${describeUsage(u) || '…'} · ${a.why}`}
            value={u ? formatBytes(u.bytes) : '…'}
            onClick={u?.exists ? () => openPath(joinPath(root, a.subdir)).catch((e) => alert(String(e))) : undefined}
            actions={
              a.clearable ? (
                <SmallButton onClick={() => clear(a.subdir, a.label)} disabled={empty} danger title={`Delete everything under ${a.subdir}`}>
                  <span className="inline-flex items-center gap-1"><Trash2 size={12} /> Clear</span>
                </SmallButton>
              ) : (
                <span className="text-[10px] uppercase tracking-wide text-gray-400 px-1">kept</span>
              )
            }
          />
        );
      })}
      <div className="flex justify-end text-xs text-gray-500 pt-2">Total {formatBytes(total)}</div>
    </div>
  );
}

export default function StorageSection() {
  const { paths, error } = useAppPaths();
  const openSettings = useStore((s) => s.openSettings);
  const [recentCount, setRecentCount] = useState(getRecentProjects().length);

  return (
    <div>
      <SectionHeader
        icon={HardDrive}
        title="Storage"
        description="Everything Warpcore keeps on this disk. A project's files sit beside its warpcore.yaml; runs with no project open use your home directory."
      />
      {error && <EmptyNote>Could not resolve where files live: {error}</EmptyNote>}
      {!paths && !error && <EmptyNote>Finding where files live…</EmptyNote>}
      {paths && warpcoreRoots(paths).map((r) => <Root key={r.root} label={r.label} root={r.root} />)}

      <SubHeader title="In this app" />
      <MetricRow
        label="Recent projects"
        hint="Kept in the app, not on disk."
        value={`${recentCount} remembered`}
        onClick={() => openSettings('projects')}
        actions={
          <SmallButton
            onClick={() => { clearRecentProjects(); setRecentCount(0); }}
            disabled={recentCount === 0}
            danger
          >
            Forget all
          </SmallButton>
        }
      />
    </div>
  );
}
