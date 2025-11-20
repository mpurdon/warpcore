import { useCallback, useState } from 'react';
import ReactFlow, {
  Background,
  Controls,
  MiniMap,
  addEdge,
  applyNodeChanges,
  applyEdgeChanges,
  Connection,
  NodeChange,
  EdgeChange,
} from 'reactflow';
import 'reactflow/dist/style.css';

import { useStore } from './store/useStore';
import Toolbar from './components/Toolbar';
import ResourceLibrary from './components/ResourceLibrary';
import ExecutionLogPanel from './components/ExecutionLogPanel';
import DeploymentTimeline from './components/DeploymentTimeline';
import PermissionEditorModal from './components/PermissionEditorModal';
import CostEstimatePanel from './components/CostEstimatePanel';
import { nodeTypes } from './components/nodes';
import { edgeTypes } from './components/edges';
import { validateCanvas } from './utils/validation';
import { useEffect } from 'react';

function App() {
  const {
    nodes,
    edges,
    setNodes,
    setEdges,
    selectedNode,
    setSelectedNode,
    showExecutionPanel,
  } = useStore();

  const [selectedEdge, setSelectedEdge] = useState<string | null>(null);

  // Validate canvas on changes
  useEffect(() => {
    const errors = validateCanvas(nodes, edges);
    // Update node styles based on validation errors
    const updatedNodes = nodes.map(node => {
      const nodeErrors = errors.filter(e => e.nodeId === node.id);
      if (nodeErrors.length > 0) {
        const hasError = nodeErrors.some(e => e.severity === 'error');
        return {
          ...node,
          className: hasError ? 'validation-error' : 'validation-warning',
        };
      }
      return node;
    });
    if (JSON.stringify(updatedNodes) !== JSON.stringify(nodes)) {
      setNodes(updatedNodes);
    }
  }, [nodes, edges]);

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      setNodes(applyNodeChanges(changes, nodes));
    },
    [nodes, setNodes]
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      setEdges(applyEdgeChanges(changes, edges));
    },
    [edges, setEdges]
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      setEdges(addEdge({ ...connection, type: 'permission' }, edges));
    },
    [edges, setEdges]
  );

  const onNodeClick = useCallback(
    (_event: React.MouseEvent, node: any) => {
      setSelectedNode(node.id);
    },
    [setSelectedNode]
  );

  const onEdgeClick = useCallback(
    (_event: React.MouseEvent, edge: any) => {
      setSelectedEdge(edge.id);
    },
    []
  );

  const onDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  }, []);

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();

      const data = event.dataTransfer.getData('application/reactflow');
      if (!data) return;

      const { type, label } = JSON.parse(data);
      const position = {
        x: event.clientX - 300, // Adjust for sidebar width
        y: event.clientY - 60,  // Adjust for toolbar height
      };

      const newNode = {
        id: `${type}-${Date.now()}`,
        type,
        position,
        data: { label, status: 'pending' },
      };

      setNodes([...nodes, newNode]);
    },
    [nodes, setNodes]
  );

  return (
    <div className="h-screen w-screen flex flex-col">
      <Toolbar />
      
      <div className="flex-1 flex relative">
        <ResourceLibrary />
        
        <div className="flex-1 relative">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={onNodeClick}
            onEdgeClick={onEdgeClick}
            onDragOver={onDragOver}
            onDrop={onDrop}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            fitView
          >
            <Background />
            <Controls />
            <MiniMap />
          </ReactFlow>
          
          <CostEstimatePanel />
          <DeploymentTimeline />
        </div>
        
        {showExecutionPanel && selectedNode && (
          <ExecutionLogPanel nodeId={selectedNode} />
        )}
        
        {selectedEdge && (
          <PermissionEditorModal
            edgeId={selectedEdge}
            onClose={() => setSelectedEdge(null)}
          />
        )}
      </div>
    </div>
  );
}

export default App;
