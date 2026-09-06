import { Asterisk, Eye, Pencil, Zap } from 'lucide-react';
import { PERMISSION_COLORS } from './edges/PermissionEdge';

function Swatch({ color, children, title }: { color: string; children: React.ReactNode; title?: string }) {
  return (
    <div className="w-4 h-4 rounded-full flex items-center justify-center" style={{ backgroundColor: `${color}20` }} title={title}>
      {children}
    </div>
  );
}

// Line colours mean one thing everywhere: what the connection lets the
// source do to the target. Structure (membership, routes, origins) is grey
// and dashed so it never reads as a permission.
export default function PermissionLegend({ bottomOffset = 0 }: { bottomOffset?: number }) {
  return (
    <div className="absolute left-72 bg-white/90 backdrop-blur-sm rounded-lg shadow-sm border border-gray-200 px-3 py-2" style={{ bottom: bottomOffset + 16 }}>
      <div className="flex items-center gap-4 text-xs">
        <div className="flex items-center gap-1.5">
          <Swatch color={PERMISSION_COLORS.read}><Eye size={10} style={{ color: PERMISSION_COLORS.read }} /></Swatch>
          <span className="text-gray-600">Read</span>
        </div>
        <div className="flex items-center gap-1.5">
          <Swatch color={PERMISSION_COLORS.write}><Pencil size={10} style={{ color: PERMISSION_COLORS.write }} /></Swatch>
          <span className="text-gray-600">Write</span>
        </div>
        <div className="flex items-center gap-1.5" title="Blue-to-amber gradient: read and write">
          <span className="inline-block w-5 h-1 rounded" style={{ background: `linear-gradient(90deg, ${PERMISSION_COLORS.read}, ${PERMISSION_COLORS.write})` }} />
          <span className="text-gray-600">Read/write</span>
        </div>
        <div className="flex items-center gap-1.5">
          <Swatch color={PERMISSION_COLORS.execute}><Zap size={10} style={{ color: PERMISSION_COLORS.execute }} /></Swatch>
          <span className="text-gray-600">Execute</span>
        </div>
        <div className="flex items-center gap-1.5" title="service:* or *: everything, including delete">
          <Swatch color={PERMISSION_COLORS.admin}><Asterisk size={10} style={{ color: PERMISSION_COLORS.admin }} /></Swatch>
          <span className="text-gray-600">Admin</span>
        </div>
        <div className="flex items-center gap-1.5" title="Structure, not permission: membership, routes, origins, log groups">
          <span className="inline-block w-5 border-t-2 border-dashed" style={{ borderColor: PERMISSION_COLORS.relationship }} />
          <span className="text-gray-600">Relationship</span>
        </div>
      </div>
    </div>
  );
}
