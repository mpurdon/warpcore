import { Position } from 'reactflow';
import ConnectedHandle from './ConnectedHandle';

interface Props {
  nodeId: string;
}

/**
 * Renders bidirectional handles (both source and target) at each position
 * allowing connections to be dragged from or to any handle point.
 *
 * Source handles are rendered first so target handles appear on top in DOM,
 * making it easier to drop connections on target handles.
 */
export default function BidirectionalHandles({ nodeId }: Props) {
  return (
    <>
      {/* Source handles (rendered first, so they're below in z-order) */}
      {/* Top */}
      <ConnectedHandle nodeId={nodeId} type="source" position={Position.Top} id="top-1-source" className="handle-pos-1" />
      <ConnectedHandle nodeId={nodeId} type="source" position={Position.Top} id="top-2-source" className="handle-pos-2" />
      <ConnectedHandle nodeId={nodeId} type="source" position={Position.Top} id="top-3-source" className="handle-pos-3" />
      {/* Bottom */}
      <ConnectedHandle nodeId={nodeId} type="source" position={Position.Bottom} id="bottom-1-source" className="handle-pos-1" />
      <ConnectedHandle nodeId={nodeId} type="source" position={Position.Bottom} id="bottom-2-source" className="handle-pos-2" />
      <ConnectedHandle nodeId={nodeId} type="source" position={Position.Bottom} id="bottom-3-source" className="handle-pos-3" />
      {/* Left */}
      <ConnectedHandle nodeId={nodeId} type="source" position={Position.Left} id="left-1-source" className="handle-pos-1" />
      <ConnectedHandle nodeId={nodeId} type="source" position={Position.Left} id="left-2-source" className="handle-pos-2" />
      <ConnectedHandle nodeId={nodeId} type="source" position={Position.Left} id="left-3-source" className="handle-pos-3" />
      {/* Right */}
      <ConnectedHandle nodeId={nodeId} type="source" position={Position.Right} id="right-1-source" className="handle-pos-1" />
      <ConnectedHandle nodeId={nodeId} type="source" position={Position.Right} id="right-2-source" className="handle-pos-2" />
      <ConnectedHandle nodeId={nodeId} type="source" position={Position.Right} id="right-3-source" className="handle-pos-3" />

      {/* Target handles (rendered last, so they're on top in z-order for receiving drops) */}
      {/* Top */}
      <ConnectedHandle nodeId={nodeId} type="target" position={Position.Top} id="top-1-target" className="handle-pos-1" />
      <ConnectedHandle nodeId={nodeId} type="target" position={Position.Top} id="top-2-target" className="handle-pos-2" />
      <ConnectedHandle nodeId={nodeId} type="target" position={Position.Top} id="top-3-target" className="handle-pos-3" />
      {/* Bottom */}
      <ConnectedHandle nodeId={nodeId} type="target" position={Position.Bottom} id="bottom-1-target" className="handle-pos-1" />
      <ConnectedHandle nodeId={nodeId} type="target" position={Position.Bottom} id="bottom-2-target" className="handle-pos-2" />
      <ConnectedHandle nodeId={nodeId} type="target" position={Position.Bottom} id="bottom-3-target" className="handle-pos-3" />
      {/* Left */}
      <ConnectedHandle nodeId={nodeId} type="target" position={Position.Left} id="left-1-target" className="handle-pos-1" />
      <ConnectedHandle nodeId={nodeId} type="target" position={Position.Left} id="left-2-target" className="handle-pos-2" />
      <ConnectedHandle nodeId={nodeId} type="target" position={Position.Left} id="left-3-target" className="handle-pos-3" />
      {/* Right */}
      <ConnectedHandle nodeId={nodeId} type="target" position={Position.Right} id="right-1-target" className="handle-pos-1" />
      <ConnectedHandle nodeId={nodeId} type="target" position={Position.Right} id="right-2-target" className="handle-pos-2" />
      <ConnectedHandle nodeId={nodeId} type="target" position={Position.Right} id="right-3-target" className="handle-pos-3" />
    </>
  );
}
