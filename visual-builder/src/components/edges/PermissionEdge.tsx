import { BaseEdge, EdgeLabelRenderer, EdgeProps, getBezierPath } from 'reactflow';

export default function PermissionEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  markerEnd,
}: EdgeProps) {
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  const permissions = data?.permissions || [];
  const status = data?.status || 'pending';
  
  const edgeClass = status ? `edge-${status}` : '';

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={markerEnd}
        className={edgeClass}
      />
      <EdgeLabelRenderer>
        <div
          style={{
            position: 'absolute',
            transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
            pointerEvents: 'all',
          }}
          className="nodrag nopan"
        >
          <div className="bg-white px-2 py-1 rounded border border-gray-300 text-xs">
            {permissions.length > 0 ? (
              <span>{permissions.length} permission{permissions.length !== 1 ? 's' : ''}</span>
            ) : (
              <span className="text-gray-400">No permissions</span>
            )}
          </div>
        </div>
      </EdgeLabelRenderer>
    </>
  );
}
