import { useState, useRef, useEffect } from 'react';
import { ChevronDown, Plus, ExternalLink, Search } from 'lucide-react';
import { runFromUi } from '../commands';
import { useStore, ENVIRONMENT_TEMPLATES, summariseEnvironment } from '../store/useStore';

interface Props {
  onOpenEnvironment: (env: string) => void;
}

export default function EnvironmentSelector({ onOpenEnvironment }: Props) {
  const { currentEnvironment, environmentConfigs } = useStore();
  const [isOpen, setIsOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [hoveredEnv, setHoveredEnv] = useState<string | null>(null);
  const [showNewEnvInput, setShowNewEnvInput] = useState(false);
  const [newEnvName, setNewEnvName] = useState('');
  // A new environment always starts from a template or an existing
  // environment, never from silently invented values.
  const [newEnvBase, setNewEnvBase] = useState('template:dev');
  const dropdownRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const envList = Object.keys(environmentConfigs);
  const filteredEnvs = envList.filter(env =>
    env.toLowerCase().includes(searchQuery.toLowerCase()) ||
    environmentConfigs[env].name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsOpen(false);
        setSearchQuery('');
        setShowNewEnvInput(false);
        setNewEnvName('');
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Focus search input when dropdown opens
  useEffect(() => {
    if (isOpen && searchInputRef.current) {
      searchInputRef.current.focus();
    }
  }, [isOpen]);

  const handleSelectEnv = (env: string) => {
    void runFromUi('project.switchEnvironment', { environment: env });
    setIsOpen(false);
    setSearchQuery('');
  };

  const handleOpenEnv = (env: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setIsOpen(false);
    setSearchQuery('');
    onOpenEnvironment(env);
  };

  // What the new environment starts from: a built-in template or a copy.
  const baseConfig = (() => {
    const [kind, key] = newEnvBase.split(':');
    return (kind === 'env' ? environmentConfigs[key] : ENVIRONMENT_TEMPLATES[key]) ?? ENVIRONMENT_TEMPLATES.dev;
  })();

  const handleAddEnvironment = () => {
    if (!newEnvName.trim()) return;

    const [, key] = newEnvBase.split(':');
    void runFromUi('project.addEnvironment', { name: newEnvName.trim(), from: key }).then((r) => {
      if (!r.ok) return;
      void runFromUi('project.switchEnvironment', { environment: (r.result as { key: string }).key });
    });
    setShowNewEnvInput(false);
    setNewEnvName('');
    setIsOpen(false);
  };

  const currentConfig = environmentConfigs[currentEnvironment];

  return (
    <div ref={dropdownRef} className="relative">
      {/* Trigger Button */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-2 px-2.5 py-1.5 bg-surface hover:bg-gray-50 border border-gray-300 rounded-md text-sm text-gray-800 min-w-[140px]"
      >
        <span className="flex-1 text-left truncate">{currentConfig?.name || currentEnvironment}</span>
        <ChevronDown size={16} className={`transition-transform ${isOpen ? 'rotate-180' : ''}`} />
      </button>

      {/* Dropdown */}
      {isOpen && (
        <div className="absolute top-full left-0 mt-1 w-72 bg-surface rounded-lg shadow-xl border border-gray-200 z-50 overflow-hidden">
          {/* Search */}
          <div className="p-2 border-b border-gray-200">
            <div className="relative">
              <Search size={16} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
              <input
                ref={searchInputRef}
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search environments..."
                className="w-full pl-8 pr-8 py-1.5 text-sm border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500 text-gray-900"
              />
              <button
                onClick={() => setShowNewEnvInput(true)}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 hover:bg-gray-100 rounded text-gray-500 hover:text-gray-700"
                title="Add environment"
              >
                <Plus size={16} />
              </button>
            </div>
          </div>

          {/* New Environment Input */}
          {showNewEnvInput && (
            <div className="p-2 border-b border-gray-200 bg-blue-50">
              <input
                type="text"
                value={newEnvName}
                onChange={(e) => setNewEnvName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleAddEnvironment();
                  if (e.key === 'Escape') {
                    setShowNewEnvInput(false);
                    setNewEnvName('');
                  }
                }}
                placeholder="New environment name..."
                className="w-full px-2 py-1.5 text-sm border border-blue-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500 text-gray-900"
                autoFocus
              />
              <select
                value={newEnvBase}
                onChange={(e) => setNewEnvBase(e.target.value)}
                className="w-full mt-2 px-2 py-1 text-xs border border-blue-300 rounded bg-surface text-gray-900"
                title="Settings to start from"
              >
                {Object.entries(ENVIRONMENT_TEMPLATES).map(([key, cfg]) => (
                  <option key={`template:${key}`} value={`template:${key}`}>Start from {cfg.name} (built-in)</option>
                ))}
                {Object.entries(environmentConfigs).map(([key, cfg]) => (
                  <option key={`env:${key}`} value={`env:${key}`}>Copy {cfg.name}</option>
                ))}
              </select>
              <div className="text-[10px] text-gray-500 mt-1">{summariseEnvironment(baseConfig)}</div>
              <div className="flex gap-2 mt-2">
                <button
                  onClick={handleAddEnvironment}
                  disabled={!newEnvName.trim()}
                  className="flex-1 px-2 py-1 bg-blue-600 text-white text-xs rounded hover:bg-blue-700 disabled:opacity-50"
                >
                  Create
                </button>
                <button
                  onClick={() => {
                    setShowNewEnvInput(false);
                    setNewEnvName('');
                  }}
                  className="flex-1 px-2 py-1 bg-gray-200 text-gray-700 text-xs rounded hover:bg-gray-300"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {/* Environment List */}
          <div className="max-h-64 overflow-y-auto">
            {filteredEnvs.length === 0 ? (
              <div className="p-4 text-sm text-gray-500 text-center">
                No environments found
              </div>
            ) : (
              filteredEnvs.map((env) => {
                const config = environmentConfigs[env];
                const isSelected = env === currentEnvironment;
                const isHovered = env === hoveredEnv;

                return (
                  <div
                    key={env}
                    onClick={() => handleSelectEnv(env)}
                    onMouseEnter={() => setHoveredEnv(env)}
                    onMouseLeave={() => setHoveredEnv(null)}
                    className={`flex items-center justify-between px-3 py-2 cursor-pointer ${
                      isSelected
                        ? 'bg-blue-50 border-l-2 border-blue-500'
                        : 'hover:bg-gray-50 border-l-2 border-transparent'
                    }`}
                  >
                    <div className="flex-1 min-w-0">
                      <div className={`text-sm font-medium truncate ${isSelected ? 'text-blue-700' : 'text-gray-900'}`}>
                        {config.name}
                      </div>
                      <div className="text-xs text-gray-500">
                        {config.removalPolicies.default} • {config.logging.defaultRetentionDays}d logs
                      </div>
                    </div>

                    {/* Open Environment Button */}
                    {(isHovered || isSelected) && (
                      <button
                        onClick={(e) => handleOpenEnv(env, e)}
                        className="ml-2 p-1.5 hover:bg-gray-200 rounded text-gray-500 hover:text-gray-700"
                        title="Open Environment"
                      >
                        <ExternalLink size={16} />
                      </button>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
