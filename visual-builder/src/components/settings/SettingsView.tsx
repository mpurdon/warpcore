// Application settings: the one surface in the app that is allowed to look
// like a settings page, because it is the one thing that is not a property
// of an object in the system. Opens in the workspace with a section list on
// the left, the way UniFi does it. See DESIGN_GUIDANCE.md §4.2.

import { SECTION_LABEL } from '../../utils/settingsSections';
import { LucideIcon, Bug, ClipboardList, FileText, FolderOpen, Globe, HardDrive, Info, Radar, Settings, X } from 'lucide-react';
import { SETTINGS_SECTIONS, SettingsSection, useStore } from '../../store/useStore';
import AboutSection from './AboutSection';
import AuditSection from './AuditSection';
import ExplorationSection from './ExplorationSection';
import GeneralSection from './GeneralSection';
import LogsSection from './LogsSection';
import ProjectsSection from './ProjectsSection';
import RegionsSection from './RegionsSection';
import SessionsSection from './SessionsSection';
import StorageSection from './StorageSection';

const SECTION_META: Record<SettingsSection, { label: string; icon: LucideIcon; group: string }> = {
  general: { label: SECTION_LABEL['general'], icon: Settings, group: 'Behaviour' },
  regions: { label: SECTION_LABEL['regions'], icon: Globe, group: 'Behaviour' },
  exploration: { label: SECTION_LABEL['exploration'], icon: Radar, group: 'Behaviour' },
  logs: { label: SECTION_LABEL['logs'], icon: FileText, group: 'On this machine' },
  audit: { label: SECTION_LABEL['audit'], icon: ClipboardList, group: 'On this machine' },
  sessions: { label: SECTION_LABEL['sessions'], icon: Bug, group: 'On this machine' },
  storage: { label: SECTION_LABEL['storage'], icon: HardDrive, group: 'On this machine' },
  projects: { label: SECTION_LABEL['projects'], icon: FolderOpen, group: 'On this machine' },
  about: { label: SECTION_LABEL['about'], icon: Info, group: 'App' },
};

const SECTION_BODY: Record<SettingsSection, () => JSX.Element> = {
  general: GeneralSection,
  regions: RegionsSection,
  exploration: ExplorationSection,
  logs: LogsSection,
  audit: AuditSection,
  sessions: SessionsSection,
  storage: StorageSection,
  projects: ProjectsSection,
  about: AboutSection,
};

export default function SettingsView() {
  const { settingsSection, openSettings, closeSettings } = useStore();
  const Body = SECTION_BODY[settingsSection];

  // Group headings in display order, without repeating one.
  const groups: string[] = [];
  for (const s of SETTINGS_SECTIONS) {
    const g = SECTION_META[s].group;
    if (!groups.includes(g)) groups.push(g);
  }

  return (
    <div className="flex-1 flex min-h-0 bg-white text-gray-900">
      {/* Section list */}
      <nav className="w-56 border-r border-gray-200 bg-gray-50 flex flex-col">
        <div className="px-4 py-3 border-b border-gray-200 flex items-center justify-between">
          <span className="text-sm font-semibold text-gray-800">Settings</span>
          <button onClick={closeSettings} className="p-1 rounded text-gray-400 hover:text-gray-700 hover:bg-gray-200" title="Back to canvas (Esc)">
            <X size={16} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto py-2">
          {groups.map((group) => (
            <div key={group} className="mb-2">
              <div className="px-4 pt-2 pb-1 text-[10px] uppercase tracking-wide font-semibold text-gray-400">{group}</div>
              {SETTINGS_SECTIONS.filter((s) => SECTION_META[s].group === group).map((s) => {
                const { label, icon: Icon } = SECTION_META[s];
                const active = s === settingsSection;
                return (
                  <button
                    key={s}
                    onClick={() => openSettings(s)}
                    className={`w-full flex items-center gap-2 px-4 py-1.5 text-sm text-left transition-colors ${
                      active
                        ? 'bg-white text-blue-700 font-medium border-l-2 border-blue-600'
                        : 'text-gray-700 hover:bg-gray-100 border-l-2 border-transparent'
                    }`}
                  >
                    <Icon size={14} className={active ? 'text-blue-600' : 'text-gray-400'} />
                    {label}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
        <div className="px-4 py-3 border-t border-gray-200 text-[11px] text-gray-400">
          Environment settings live on the environment: open one from the toolbar.
        </div>
      </nav>

      {/* Section content */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl px-8 py-6">
          <Body />
        </div>
      </div>
    </div>
  );
}
