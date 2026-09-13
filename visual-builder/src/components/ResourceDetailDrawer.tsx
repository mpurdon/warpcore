import { useState } from 'react';
import { X } from 'lucide-react';
import { DiscoveredResource, shortType } from '../utils/accountExplorer';
import { LiveDetailTabs, useResourceDetail } from './live/LiveDetail';

interface Props {
  profile: string;
  resource: DiscoveredResource;
  onClose: () => void;
  onNavigate: (arn: string) => void;
}

export default function ResourceDetailDrawer({ profile, resource, onClose, onNavigate }: Props) {
  const [hours, setHours] = useState(24);
  const state = useResourceDetail(profile, resource.physical_id, hours);
  const detail = state.detail;

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="px-4 py-3 border-b border-gray-200 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold uppercase tracking-wide text-blue-700 bg-blue-50 border border-blue-100 rounded px-1.5 py-0.5">
              {shortType(detail?.type || resource.type || 'Resource')}
            </span>
            {detail?.region && <span className="text-xs text-gray-500">{detail.region}</span>}
          </div>
          <h3 className="text-base font-semibold mt-1 truncate">{detail?.name || resource.id}</h3>
          <p className="text-xs font-mono text-gray-500 truncate" title={resource.physical_id}>{resource.physical_id}</p>
        </div>
        <button onClick={onClose} className="p-1.5 hover:bg-gray-100 rounded-full shrink-0" title="Close (Esc)">
          <X size={18} className="text-gray-500" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-4 pb-4">
        <LiveDetailTabs state={state} hours={hours} onHours={setHours} onNavigate={onNavigate} />
      </div>
    </div>
  );
}
