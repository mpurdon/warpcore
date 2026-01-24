import { useMemo, useState, useCallback, useRef, useEffect } from 'react';
import { Node, useViewport } from 'reactflow';
import { X } from 'lucide-react';
import { NodeGroup, computeGroupBounds } from '../utils/nodeGrouping';

interface GroupingOverlayProps {
  groups: NodeGroup[];
  nodes: Node[];
  onBreakGroup?: (parentId: string, groupType: NodeGroup['groupType']) => void;
  onMoveGroup?: (groupNodeIds: string[], deltaX: number, deltaY: number) => void;
}

export default function GroupingOverlay({ groups, nodes, onBreakGroup, onMoveGroup }: GroupingOverlayProps) {
  const viewport = useViewport();

  // Drag state
  const [draggingGroup, setDraggingGroup] = useState<string | null>(null);
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);
  const lastPosRef = useRef<{ x: number; y: number } | null>(null);

  // Compute bounds for each group with current node positions
  const groupBoundsData = useMemo(() => {
    return groups.map(group => ({
      group,
      bounds: computeGroupBounds(group, nodes, 20),
    }));
  }, [groups, nodes]);

  // Handle mouse down on group background
  const handleMouseDown = useCallback((e: React.MouseEvent, group: NodeGroup) => {
    // Only start drag on left mouse button
    if (e.button !== 0) return;

    e.preventDefault();
    e.stopPropagation();

    setDraggingGroup(group.parentId);
    dragStartRef.current = { x: e.clientX, y: e.clientY };
    lastPosRef.current = { x: e.clientX, y: e.clientY };
  }, []);

  // Handle mouse move during drag
  useEffect(() => {
    if (!draggingGroup) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (!lastPosRef.current || !onMoveGroup) return;

      const group = groups.find(g => g.parentId === draggingGroup);
      if (!group) return;

      // Calculate delta in screen coordinates, then convert to flow coordinates
      const deltaX = (e.clientX - lastPosRef.current.x) / viewport.zoom;
      const deltaY = (e.clientY - lastPosRef.current.y) / viewport.zoom;

      if (Math.abs(deltaX) > 0.1 || Math.abs(deltaY) > 0.1) {
        // Get all node IDs in the group
        const groupNodeIds = [group.parentId, ...group.childIds];
        onMoveGroup(groupNodeIds, deltaX, deltaY);
        lastPosRef.current = { x: e.clientX, y: e.clientY };
      }
    };

    const handleMouseUp = () => {
      setDraggingGroup(null);
      dragStartRef.current = null;
      lastPosRef.current = null;
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [draggingGroup, groups, onMoveGroup, viewport.zoom]);

  if (groupBoundsData.length === 0) return null;

  // Use a consistent blue color
  const groupColor = '#3b82f6';

  return (
    <>
      {/* SVG layer for the dashed border - pointer-events-none so nodes are still draggable */}
      <svg
        className="absolute inset-0 pointer-events-none overflow-visible"
        style={{ zIndex: -1 }}
      >
        <g
          transform={`translate(${viewport.x}, ${viewport.y}) scale(${viewport.zoom})`}
        >
          {groupBoundsData.map(({ group, bounds }) => (
            <g key={group.parentId}>
              {/* Subtle background fill */}
              <rect
                x={bounds.x}
                y={bounds.y}
                width={bounds.width}
                height={bounds.height}
                rx={8}
                ry={8}
                fill={groupColor}
                fillOpacity={0.03}
              />
              {/* Dashed border */}
              <rect
                x={bounds.x}
                y={bounds.y}
                width={bounds.width}
                height={bounds.height}
                rx={8}
                ry={8}
                fill="none"
                stroke={groupColor}
                strokeWidth={2 / viewport.zoom}
                strokeDasharray={`${5 / viewport.zoom} ${5 / viewport.zoom}`}
                strokeOpacity={0.5}
              />
            </g>
          ))}
        </g>
      </svg>

      {/* Invisible drag handles for group backgrounds */}
      {groupBoundsData.map(({ group, bounds }) => {
        const screenX = bounds.x * viewport.zoom + viewport.x;
        const screenY = bounds.y * viewport.zoom + viewport.y;
        const screenWidth = bounds.width * viewport.zoom;
        const screenHeight = bounds.height * viewport.zoom;

        return (
          <div
            key={`drag-${group.parentId}`}
            className="absolute"
            style={{
              left: screenX,
              top: screenY,
              width: screenWidth,
              height: screenHeight,
              cursor: draggingGroup === group.parentId ? 'grabbing' : 'grab',
              zIndex: -1, // Behind nodes but interactive
              pointerEvents: 'auto',
            }}
            onMouseDown={(e) => handleMouseDown(e, group)}
          />
        );
      })}

      {/* HTML layer for the X button */}
      {groupBoundsData.map(({ group, bounds }) => {
        const screenX = bounds.x * viewport.zoom + viewport.x + bounds.width * viewport.zoom - 8;
        const screenY = bounds.y * viewport.zoom + viewport.y - 8;

        return (
          <div
            key={`btn-${group.parentId}`}
            className="absolute"
            style={{
              left: screenX,
              top: screenY,
              zIndex: 10,
            }}
          >
            <button
              onClick={() => onBreakGroup?.(group.parentId, group.groupType)}
              className="w-5 h-5 bg-red-500 hover:bg-red-600 rounded-full flex items-center justify-center shadow-md transition-colors"
              title="Break group relationship"
            >
              <X size={12} className="text-white" />
            </button>
          </div>
        );
      })}
    </>
  );
}
