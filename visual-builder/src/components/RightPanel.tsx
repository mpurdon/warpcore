import { Shield, Settings } from 'lucide-react';
import { useStore } from '../store/useStore';
import RolesPanel from './RolesPanel';

const tabs = [
  { id: 'roles' as const, label: 'Roles', icon: Shield },
  { id: 'environment' as const, label: 'Environment', icon: Settings },
];

export default function RightPanel() {
  const { rightPanelVisible, rightPanelTab, setRightPanelTab } = useStore();

  if (!rightPanelVisible) {
    return null;
  }

  return (
    <div className="w-80 bg-white border-l border-gray-200 flex flex-col h-full">
      {/* Tab Navigation */}
      <div className="flex border-b border-gray-200 flex-shrink-0">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const isActive = rightPanelTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setRightPanelTab(tab.id)}
              className={`flex-1 flex items-center justify-center gap-2 px-4 py-3 text-sm font-medium transition-colors ${
                isActive
                  ? 'text-blue-600 border-b-2 border-blue-600 bg-blue-50/50'
                  : 'text-gray-600 hover:text-gray-800 hover:bg-gray-50'
              }`}
            >
              <Icon size={16} />
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* Tab Content */}
      <div className="flex-1 overflow-hidden">
        {rightPanelTab === 'roles' && <RolesPanel />}
        {rightPanelTab === 'environment' && (
          <div className="p-4 text-sm text-gray-500">
            Environment configuration coming soon...
          </div>
        )}
      </div>
    </div>
  );
}
