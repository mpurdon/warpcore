import { useState, useRef, useEffect } from 'react';
import { ChevronDown, FolderOpen, Clock, Trash2 } from 'lucide-react';
import { getRecentProjects, removeRecentProject, clearRecentProjects, RecentProject } from '../utils/recentProjects';

interface FileMenuProps {
  onOpenFile: () => void;
  onOpenRecent: (path: string) => void;
}

export default function FileMenu({ onOpenFile, onOpenRecent }: FileMenuProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [showRecent, setShowRecent] = useState(false);
  const [recentProjects, setRecentProjects] = useState<RecentProject[]>([]);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setRecentProjects(getRecentProjects());
  }, [isOpen]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setIsOpen(false);
        setShowRecent(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleRemoveRecent = (e: React.MouseEvent, path: string) => {
    e.stopPropagation();
    removeRecentProject(path);
    setRecentProjects(getRecentProjects());
  };

  const handleClearRecent = () => {
    clearRecentProjects();
    setRecentProjects([]);
    setShowRecent(false);
  };

  const handleOpenRecent = (path: string) => {
    onOpenRecent(path);
    setIsOpen(false);
    setShowRecent(false);
  };

  return (
    <div className="relative" ref={menuRef}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="px-2.5 py-1.5 rounded-md text-sm text-gray-700 hover:bg-gray-100 flex items-center gap-1"
      >
        Project
        <ChevronDown size={14} />
      </button>

      {isOpen && (
        <div className="absolute top-full left-0 mt-1 w-56 bg-white text-gray-900 border border-gray-200 rounded-lg shadow-xl z-50">
          <div className="py-1">
            <button
              onClick={() => {
                onOpenFile();
                setIsOpen(false);
              }}
              className="w-full px-4 py-2 text-left text-sm hover:bg-gray-100 flex items-center gap-2"
            >
              <FolderOpen size={16} />
              Open...
              <span className="ml-auto text-gray-500 text-xs">⌘O</span>
            </button>

            <div
              className="relative"
              onMouseEnter={() => setShowRecent(true)}
              onMouseLeave={() => setShowRecent(false)}
            >
              <button
                className="w-full px-4 py-2 text-left text-sm hover:bg-gray-100 flex items-center gap-2 disabled:opacity-40"
                disabled={recentProjects.length === 0}
              >
                <Clock size={16} />
                Open Recent
                <ChevronDown size={14} className="ml-auto -rotate-90" />
              </button>

              {showRecent && recentProjects.length > 0 && (
                <div className="absolute left-full top-0 ml-1 w-64 bg-white border border-gray-200 rounded-lg shadow-xl">
                  <div className="py-1 max-h-80 overflow-y-auto">
                    {recentProjects.map((project) => (
                      <div
                        key={project.path}
                        onClick={() => handleOpenRecent(project.path)}
                        className="group px-4 py-2 text-sm hover:bg-gray-100 cursor-pointer flex items-center justify-between"
                      >
                        <div className="flex-1 min-w-0">
                          <div className="font-medium truncate">{project.name}</div>
                          <div className="text-xs text-gray-500 truncate">{project.path}</div>
                        </div>
                        <button
                          onClick={(e) => handleRemoveRecent(e, project.path)}
                          className="opacity-0 group-hover:opacity-100 p-1 hover:bg-gray-200 text-gray-500 rounded ml-2"
                          title="Remove from recent"
                        >
                          <Trash2 size={12} />
                        </button>
                      </div>
                    ))}
                  </div>
                  <div className="border-t border-gray-200">
                    <button
                      onClick={handleClearRecent}
                      className="w-full px-4 py-2 text-left text-sm text-gray-500 hover:bg-gray-100 hover:text-gray-900"
                    >
                      Clear Recent Projects
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
