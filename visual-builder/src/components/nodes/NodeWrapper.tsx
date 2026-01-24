import { useState } from 'react';
import { X } from 'lucide-react';
import { useStore } from '../../store/useStore';

interface Props {
  nodeId: string;
  selected: boolean;
  children: React.ReactNode;
  className?: string;
}

export default function NodeWrapper({ nodeId, selected, children, className = '' }: Props) {
  const [isHovered, setIsHovered] = useState(false);
  const { nodes, setNodes, edges, setEdges, setSelectedNode } = useStore();

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation(); // Prevent node selection
    setNodes(nodes.filter(n => n.id !== nodeId));
    setEdges(edges.filter(e => e.source !== nodeId && e.target !== nodeId));
    setSelectedNode(null);
  };

  const showDelete = isHovered || selected;

  return (
    <div
      className={`relative ${className}`}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {children}

      {/* Delete button - appears on hover or selection */}
      {showDelete && (
        <button
          onClick={handleDelete}
          className="absolute -top-2 -right-2 w-5 h-5 bg-red-500 hover:bg-red-600 rounded-full flex items-center justify-center shadow-md transition-colors z-10"
          title="Delete resource"
        >
          <X size={12} className="text-white" />
        </button>
      )}
    </div>
  );
}
