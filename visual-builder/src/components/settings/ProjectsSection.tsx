import { useState } from 'react';
import { FolderOpen, X } from 'lucide-react';
import { open } from '@tauri-apps/plugin-dialog';
import { useStore } from '../../store/useStore';
import { RecentProject, clearRecentProjects, getRecentProjects, removeRecentProject } from '../../utils/recentProjects';
import { EmptyNote, Field, MetricRow, SectionHeader, SmallButton, SubHeader } from './primitives';

export default function ProjectsSection() {
  const { prefs, setPref, configPath } = useStore();
  const [recent, setRecent] = useState<RecentProject[]>(getRecentProjects());

  const chooseDir = async () => {
    const picked = await open({ directory: true, defaultPath: prefs.projectsDir || undefined });
    if (picked && typeof picked === 'string') setPref('projectsDir', picked);
  };

  const forget = (path: string) => {
    removeRecentProject(path);
    setRecent(getRecentProjects());
  };

  return (
    <div>
      <SectionHeader
        icon={FolderOpen}
        title="Projects"
        description="Which projects this app remembers, and where it looks for new ones. A project is a directory with a warpcore.yaml in it."
      />

      <Field label="Projects directory" description="Where the Open dialog starts. Leave empty for the system default.">
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={prefs.projectsDir}
            onChange={(e) => setPref('projectsDir', e.target.value)}
            placeholder="System default"
            className="text-sm border border-gray-300 rounded px-2 py-1.5 w-72 font-mono"
          />
          <SmallButton onClick={chooseDir}>Choose…</SmallButton>
          {prefs.projectsDir && (
            <button onClick={() => setPref('projectsDir', '')} className="p-1 rounded text-gray-400 hover:text-gray-700" title="Clear">
              <X size={14} />
            </button>
          )}
        </div>
      </Field>

      <SubHeader
        title={`Recent projects · ${recent.length}`}
        hint={
          recent.length > 0 && (
            <button onClick={() => { clearRecentProjects(); setRecent([]); }} className="text-red-600 hover:underline">
              Forget all
            </button>
          )
        }
      />
      {recent.length === 0 ? (
        <EmptyNote>Nothing yet. Projects you open appear here and in the Project menu.</EmptyNote>
      ) : (
        recent.map((p) => (
          <MetricRow
            key={p.path}
            label={p.name}
            hint={<span className="font-mono">{p.path}</span>}
            value={p.path === configPath ? <span className="text-emerald-600 text-xs">open</span> : ''}
            actions={
              <button onClick={() => forget(p.path)} className="p-1 rounded text-gray-400 hover:text-red-600 hover:bg-red-50" title="Forget">
                <X size={14} />
              </button>
            }
          />
        ))
      )}
    </div>
  );
}
