// What the canvas shows when there is nothing on it and no project open:
// the ways in, and three lines on how the app works. It disappears the
// moment something is on the canvas, and while a palette item is being
// dragged so the drop still lands.

import { FolderOpen, Clock, FileText, Radar, MousePointer2, Command } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useStore } from '../store/useStore';
import { getRecentProjects, RecentProject } from '../utils/recentProjects';
import { openProjectDialog, openProjectFile } from '../utils/projectIO';

function Card({ icon: Icon, title, hint, onClick, shortcut }: { icon: typeof FolderOpen; title: string; hint: string; onClick: () => void; shortcut?: string }) {
  return (
    <button
      onClick={onClick}
      className="group text-left bg-white border border-gray-200 hover:border-blue-400 hover:shadow-md rounded-xl p-4 transition-all flex items-start gap-3"
    >
      <span className="p-2 rounded-lg bg-gray-100 text-gray-600 group-hover:bg-blue-50 group-hover:text-blue-700"><Icon size={18} /></span>
      <span className="flex-1 min-w-0">
        <span className="flex items-center gap-2">
          <span className="text-sm font-semibold text-gray-900">{title}</span>
          {shortcut && <kbd className="text-[10px] font-mono text-gray-400 border border-gray-200 rounded px-1">{shortcut}</kbd>}
        </span>
        <span className="block text-xs text-gray-500 mt-0.5">{hint}</span>
      </span>
    </button>
  );
}

export default function WelcomeScreen() {
  const { openDialog, draggedItem, setPaletteOpen } = useStore();
  const [recent, setRecent] = useState<RecentProject[]>([]);
  useEffect(() => { setRecent(getRecentProjects().slice(0, 4)); }, []);

  if (draggedItem) return null;

  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center p-8 pointer-events-none">
      <div className="pointer-events-auto max-w-3xl w-full">
        <div className="mb-6">
          <h1 className="text-2xl font-semibold text-gray-900 tracking-tight">Warpcore</h1>
          <p className="text-sm text-gray-600 mt-1">
            Design the infrastructure for your Strands agents, deploy it, and see what is actually running.
          </p>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Card icon={FolderOpen} title="Open a project" hint="A directory with a warpcore.yaml" shortcut="⌘O" onClick={() => { void openProjectDialog(); }} />
          <Card icon={FileText} title="Start from a template" hint="A single agent, a RAG pipeline, an event-driven workflow" onClick={() => openDialog('templates')} />
          <Card icon={Radar} title="Explore an AWS account" hint="Scan what is deployed and turn it into a project" onClick={() => openDialog('explorer')} />
          <Card icon={MousePointer2} title="Start blank" hint="Drag a resource from the palette on the left onto this canvas" onClick={() => setPaletteOpen(true)} shortcut="⌘K" />
        </div>

        {recent.length > 0 && (
          <div className="mt-5">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-gray-400 mb-1.5 flex items-center gap-1"><Clock size={11} /> Recent</div>
            <div className="bg-white border border-gray-200 rounded-xl divide-y divide-gray-100 overflow-hidden">
              {recent.map((p) => (
                <button key={p.path} onClick={() => { void openProjectFile(p.path); }} className="w-full text-left px-4 py-2 hover:bg-blue-50 flex items-center justify-between gap-3">
                  <span className="text-sm text-gray-900 truncate">{p.name}</span>
                  <span className="text-[11px] text-gray-400 font-mono truncate max-w-[60%]">{p.path}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        <ol className="mt-6 grid grid-cols-3 gap-3 text-xs text-gray-600">
          <li className="flex gap-2"><span className="font-semibold text-gray-400">1</span><span><strong className="text-gray-800">Design.</strong> Drop resources on the canvas and draw permissions between them. The right panel inspects whatever you select.</span></li>
          <li className="flex gap-2"><span className="font-semibold text-gray-400">2</span><span><strong className="text-gray-800">Deploy.</strong> Unlock the project, press Deploy. The Activity drawer shows every resource as the CLI touches it.</span></li>
          <li className="flex gap-2"><span className="font-semibold text-gray-400">3</span><span><strong className="text-gray-800">Understand.</strong> Switch lenses to see the security, network or data-flow picture. <Command size={10} className="inline" />K finds anything.</span></li>
        </ol>
      </div>
    </div>
  );
}
