import { ComponentProps, CSSProperties } from 'react';
import { Handle, Position } from 'reactflow';
import { useStore } from '../../store/useStore';

type ConnectedHandleProps = ComponentProps<typeof Handle> & {
  nodeId: string;
};

// Get inline style for handle position based on className
function getPositionStyle(position: Position, className?: string): CSSProperties {
  const posMatch = className?.match(/handle-pos-(\d)/);
  if (!posMatch) return {};

  const posIndex = parseInt(posMatch[1], 10);
  const percentages = { 1: '25%', 2: '50%', 3: '75%' };
  const percent = percentages[posIndex as 1 | 2 | 3] || '50%';

  if (position === Position.Top || position === Position.Bottom) {
    return { left: percent };
  } else {
    return { top: percent };
  }
}

export default function ConnectedHandle({ nodeId, id, className, style, ...props }: ConnectedHandleProps) {
  const { edges } = useStore();

  // Check if this handle has any connections
  const isConnected = edges.some(edge => {
    if (props.type === 'source') {
      return edge.source === nodeId && edge.sourceHandle === id;
    } else {
      return edge.target === nodeId && edge.targetHandle === id;
    }
  });

  // Combine custom position style with any passed style
  const positionStyle = getPositionStyle(props.position, className);
  const combinedStyle = { ...positionStyle, ...style };

  // Source handles can only START connections, target handles can only END them
  // This helps React Flow distinguish overlapping bidirectional handles
  const isSource = props.type === 'source';

  return (
    <Handle
      {...props}
      id={id}
      style={combinedStyle}
      className={`${isConnected ? 'connected' : ''}`}
      isConnectableStart={isSource}
      isConnectableEnd={!isSource}
    />
  );
}
