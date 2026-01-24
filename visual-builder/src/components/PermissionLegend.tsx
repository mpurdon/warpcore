import { Eye, Pencil, Zap } from 'lucide-react';

const PERMISSION_COLORS = {
  read: '#3b82f6',    // Blue
  write: '#f59e0b',   // Amber
  execute: '#8b5cf6', // Purple
};

export default function PermissionLegend() {
  return (
    <div className="absolute bottom-4 left-72 bg-white/90 backdrop-blur-sm rounded-lg shadow-sm border border-gray-200 px-3 py-2">
      <div className="flex items-center gap-4 text-xs">
        <div className="flex items-center gap-1.5">
          <div
            className="w-4 h-4 rounded-full flex items-center justify-center"
            style={{ backgroundColor: `${PERMISSION_COLORS.read}20` }}
          >
            <Eye size={10} style={{ color: PERMISSION_COLORS.read }} />
          </div>
          <span className="text-gray-600">Read</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div
            className="w-4 h-4 rounded-full flex items-center justify-center"
            style={{ backgroundColor: `${PERMISSION_COLORS.write}20` }}
          >
            <Pencil size={10} style={{ color: PERMISSION_COLORS.write }} />
          </div>
          <span className="text-gray-600">Write</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div
            className="w-4 h-4 rounded-full flex items-center justify-center"
            style={{ backgroundColor: `${PERMISSION_COLORS.execute}20` }}
          >
            <Zap size={10} style={{ color: PERMISSION_COLORS.execute }} />
          </div>
          <span className="text-gray-600">Execute</span>
        </div>
      </div>
    </div>
  );
}
