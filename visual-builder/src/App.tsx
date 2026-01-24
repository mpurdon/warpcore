import { useCallback, useState, useRef, useEffect, useMemo } from 'react';
import ReactFlow, {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  addEdge,
  applyNodeChanges,
  applyEdgeChanges,
  reconnectEdge,
  Connection,
  NodeChange,
  EdgeChange,
  useReactFlow,
  ReactFlowProvider,
  SelectionMode,
  Node,
  Edge,
  IsValidConnection,
} from 'reactflow';
import 'reactflow/dist/style.css';

import { useStore } from './store/useStore';
import { generateLogGroupPath } from './utils/logGroupPath';
import Toolbar from './components/Toolbar';
import ResourceLibrary from './components/ResourceLibrary';
import ExecutionLogPanel from './components/ExecutionLogPanel';
import DeploymentTimeline from './components/DeploymentTimeline';
import RoleAssignmentModal from './components/RoleAssignmentModal';
import ConfigurationPanel from './components/ConfigurationPanel';
import RadialMenu from './components/RadialMenu';
import RightPanel from './components/RightPanel';
import PermissionLegend from './components/PermissionLegend';
import { nodeTypes } from './components/nodes';
import { edgeTypes } from './components/edges';
import { validateCanvas } from './utils/validation';
import { isResourceBasedConnection } from './utils/rolePolicy';
import { getAllValidTargets } from './utils/connectionRules';
import { computeNodeGroups, findNodeGroup, isParentNode, isChildNode } from './utils/nodeGrouping';
import GroupingOverlay from './components/GroupingOverlay';

function Flow() {
  const {
    nodes,
    edges,
    setNodes,
    setEdges,
    selectedNode,
    setSelectedNode,
    showExecutionPanel,
    draggedItem,
    setDraggedItem,
  } = useStore();

  const { screenToFlowPosition } = useReactFlow();
  const canvasRef = useRef<HTMLDivElement>(null);

  // UI state
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null);
  const [editingNode, setEditingNode] = useState<string | null>(null); // For config panel (double-click)
  const [editingEdge, setEditingEdge] = useState<string | null>(null); // For edge modal (double-click)
  const [isDragging, setIsDragging] = useState(false);
  const [mousePos, setMousePos] = useState({ x: 0, y: 0 });
  const [isOverCanvas, setIsOverCanvas] = useState(false);
  const validationTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Radial menu state for quick node creation
  const [pendingConnection, setPendingConnection] = useState<{
    nodeId: string;
    nodeType: string;
    handleId: string;
  } | null>(null);
  const [radialMenuPos, setRadialMenuPos] = useState<{
    screen: { x: number; y: number };  // For menu positioning (relative to canvas)
    flow: { x: number; y: number };    // For node creation
  } | null>(null);
  const connectionCompletedRef = useRef(false);

  // Track selected nodes from React Flow's selection system
  const selectedNodes = nodes.filter(n => n.selected).map(n => n.id);

  // Compute DLQ edges from node configurations
  const dlqEdges = useMemo(() => {
    const dlqEdgeList: Edge[] = [];

    nodes.forEach(node => {
      const dlqConfig = node.data?.config?.dlq;
      if (dlqConfig?.enabled && dlqConfig?.targetId) {
        // Check if target node exists
        const targetExists = nodes.some(n => n.id === dlqConfig.targetId);
        if (targetExists) {
          dlqEdgeList.push({
            id: `dlq-${node.id}-${dlqConfig.targetId}`,
            source: node.id,
            target: dlqConfig.targetId,
            // Connect from bottom-left of parent to left-center of child
            sourceHandle: 'bottom-1-source',
            targetHandle: 'left-2-target',
            type: 'permission',
            animated: false,
            // Make DLQ edges non-interactive - they're managed via node config
            deletable: false,
            data: {
              isDLQ: true,
              maxRetries: dlqConfig.maxRetries || 3,
              // Mark as non-interactive for edge component to handle
              isComputed: true,
            },
            style: {
              stroke: '#f59e0b',
              strokeWidth: 2,
              strokeDasharray: '5 5',
            },
          } as Edge);
        }
      }
    });

    return dlqEdgeList;
  }, [nodes]);

  // Combine regular edges with DLQ edges
  const allEdges = useMemo(() => {
    return [...edges, ...dlqEdges];
  }, [edges, dlqEdges]);

  // Compute node groups (DLQ relationships, etc.)
  const nodeGroups = useMemo(() => computeNodeGroups(nodes), [nodes]);


  // Handle mouse-based drag from palette
  useEffect(() => {
    if (!draggedItem) return;

    const handleMouseMove = (e: MouseEvent) => {
      setMousePos({ x: e.clientX, y: e.clientY });

      const canvas = canvasRef.current;
      if (canvas) {
        const rect = canvas.getBoundingClientRect();
        const over =
          e.clientX >= rect.left &&
          e.clientX <= rect.right &&
          e.clientY >= rect.top &&
          e.clientY <= rect.bottom;
        setIsOverCanvas(over);
      }
    };

    const handleMouseUp = (e: MouseEvent) => {
      const canvas = canvasRef.current;
      if (!canvas) {
        setDraggedItem(null);
        return;
      }

      const rect = canvas.getBoundingClientRect();
      const isOverCanvas =
        e.clientX >= rect.left &&
        e.clientX <= rect.right &&
        e.clientY >= rect.top &&
        e.clientY <= rect.bottom;

      if (isOverCanvas) {
        const position = screenToFlowPosition({
          x: e.clientX,
          y: e.clientY,
        });

        const newNode = {
          id: `${draggedItem.type}-${Date.now()}`,
          type: draggedItem.type,
          position,
          data: { label: draggedItem.label, status: 'draft' },
        };

        setNodes([...nodes, newNode]);
      }

      setDraggedItem(null);
      setIsOverCanvas(false);
      setMousePos({ x: 0, y: 0 });
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [draggedItem, nodes, setNodes, setDraggedItem, screenToFlowPosition]);

  // Validate canvas on changes (debounced, skipped during drag)
  useEffect(() => {
    if (isDragging) return;

    if (validationTimeoutRef.current) {
      clearTimeout(validationTimeoutRef.current);
    }

    validationTimeoutRef.current = setTimeout(() => {
      const errors = validateCanvas(nodes, edges);
      const updatedNodes = nodes.map(node => {
        const nodeErrors = errors.filter(e => e.nodeId === node.id);
        if (nodeErrors.length > 0) {
          const hasError = nodeErrors.some(e => e.severity === 'error');
          return {
            ...node,
            className: hasError ? 'validation-error' : 'validation-warning',
          };
        }
        return { ...node, className: undefined };
      });

      const hasChanges = updatedNodes.some((node, i) => node.className !== nodes[i]?.className);
      if (hasChanges) {
        setNodes(updatedNodes);
      }
    }, 300);

    return () => {
      if (validationTimeoutRef.current) {
        clearTimeout(validationTimeoutRef.current);
      }
    };
  }, [nodes, edges, isDragging]);

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      // Process changes, handling group movement
      const filteredChanges: NodeChange[] = [];
      const childPositionUpdates: NodeChange[] = [];

      for (const change of changes) {
        // Handle ALL position changes (both mouse drag and keyboard navigation)
        if (change.type === 'position') {
          const nodeId = (change as { id: string }).id;

          // If this is a child node being moved (dragged or keyboard), block ALL position changes
          if (isChildNode(nodeId, nodeGroups)) {
            // Don't add this change - child can't be moved independently
            // Still need to explicitly NOT push to filteredChanges
          } else {
            // Not a child node - allow the position change
            filteredChanges.push(change);

            // If this is a parent node being moved, also move its children
            if (isParentNode(nodeId, nodeGroups) && 'position' in change && change.position) {
              const group = findNodeGroup(nodeId, nodeGroups);
              if (group) {
                const parentNode = nodes.find(n => n.id === nodeId);
                if (parentNode) {
                  const delta = {
                    x: change.position.x - parentNode.position.x,
                    y: change.position.y - parentNode.position.y,
                  };

                  // Create position changes for all children
                  for (const childId of group.childIds) {
                    const childNode = nodes.find(n => n.id === childId);
                    if (childNode) {
                      childPositionUpdates.push({
                        id: childId,
                        type: 'position',
                        position: {
                          x: childNode.position.x + delta.x,
                          y: childNode.position.y + delta.y,
                        },
                      } as NodeChange);
                    }
                  }
                }
              }
            }
          }
        } else {
          // Non-position change - allow it
          filteredChanges.push(change);
        }
      }

      // Apply all changes including child position updates
      const allChanges = [...filteredChanges, ...childPositionUpdates];
      setNodes(applyNodeChanges(allChanges, nodes));
    },
    [nodes, setNodes, nodeGroups]
  );

  const onNodeDragStart = useCallback(
    () => {
      setIsDragging(true);
    },
    []
  );

  const onNodeDragStop = useCallback(() => {
    setIsDragging(false);
  }, []);

  // Handle breaking a group relationship (e.g., removing DLQ config)
  const handleBreakGroup = useCallback(
    (parentId: string, groupType: string) => {
      if (groupType === 'dlq') {
        // Clear the DLQ config on the parent node
        setNodes(nodes.map(n => {
          if (n.id === parentId) {
            return {
              ...n,
              data: {
                ...n.data,
                config: {
                  ...n.data?.config,
                  dlq: {
                    enabled: false,
                    targetId: undefined,
                    maxRetries: 3,
                  },
                },
              },
            };
          }
          return n;
        }));
      }
      // Future: Handle other group types (replication, subnet, etc.)
    },
    [nodes, setNodes]
  );

  // Handle moving all nodes in a group together (from group background drag)
  const handleMoveGroup = useCallback(
    (groupNodeIds: string[], deltaX: number, deltaY: number) => {
      setNodes(currentNodes => currentNodes.map(n => {
        if (groupNodeIds.includes(n.id)) {
          return {
            ...n,
            position: {
              x: n.position.x + deltaX,
              y: n.position.y + deltaY,
            },
          };
        }
        return n;
      }));
    },
    [setNodes]
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      setEdges(applyEdgeChanges(changes, edges));
    },
    [edges, setEdges]
  );

  // Track when a connection drag starts
  const onConnectStart = useCallback(
    (_event: any, { nodeId, handleId }: { nodeId: string | null; handleId: string | null }) => {
      connectionCompletedRef.current = false;
      console.log('onConnectStart:', { nodeId, handleId });
      if (nodeId) {
        const node = nodes.find(n => n.id === nodeId);
        const nodeType = node?.type || '';
        console.log('Setting pendingConnection:', { nodeId, nodeType, handleId });
        // Always set pending connection - we'll check valid targets when showing menu
        setPendingConnection({
          nodeId,
          nodeType,
          handleId: handleId || '',
        });
      }
    },
    [nodes]
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      connectionCompletedRef.current = true; // Mark connection as completed
      setPendingConnection(null); // Clear pending connection

      const sourceNode = nodes.find(n => n.id === connection.source);
      const targetNode = nodes.find(n => n.id === connection.target);

      const sourceType = sourceNode?.type || '';
      const targetType = targetNode?.type || '';

      // Check if this is a resource-based connection (no role needed)
      const isResourceBased = isResourceBasedConnection(sourceType, targetType);

      const newEdge = {
        ...connection,
        type: 'permission',
        data: {
          isResourceBased,
          // roleId will be assigned via the RoleAssignmentModal
        },
      };

      // Auto-populate log group path if connecting Lambda/Agent to Log Group
      if (targetType === 'log-group' && targetNode && !targetNode.data?.config?.logGroupPath) {
        const { projectName } = useStore.getState();
        const suggestedPath = generateLogGroupPath(sourceNode, projectName);
        if (suggestedPath) {
          const updatedNodes = nodes.map(n => {
            if (n.id === targetNode.id) {
              return {
                ...n,
                data: {
                  ...n.data,
                  config: {
                    ...n.data?.config,
                    logGroupPath: suggestedPath,
                  },
                },
              };
            }
            return n;
          });
          setNodes(updatedNodes);
        }
      }

      setEdges(addEdge(newEdge, edges));
    },
    [edges, setEdges, nodes, setNodes]
  );

  // When connection drag ends, try to connect to nearby node or show radial menu
  const onConnectEnd = useCallback(
    (event: MouseEvent | TouchEvent) => {
      console.log('onConnectEnd:', { pendingConnection, completed: connectionCompletedRef.current, isReconnecting: isReconnecting.current });

      // Skip if we're reconnecting an existing edge (handled by onReconnect/onReconnectEnd)
      if (isReconnecting.current) {
        setPendingConnection(null);
        return;
      }

      // If connection was already completed by React Flow, nothing to do
      if (!pendingConnection || connectionCompletedRef.current) {
        setPendingConnection(null);
        return;
      }

      const clientX = 'clientX' in event ? event.clientX : event.touches[0]?.clientX || 0;
      const clientY = 'clientY' in event ? event.clientY : event.touches[0]?.clientY || 0;
      const flowPos = screenToFlowPosition({ x: clientX, y: clientY });

      // Check if we dropped on or near another node (within 30px tolerance)
      const targetNode = nodes.find(node => {
        if (node.id === pendingConnection.nodeId) return false; // Can't connect to self
        if (node.hidden) return false; // Skip hidden nodes (like roles)

        // Skip nodes that already have an edge from this source
        const hasExistingEdge = edges.some(
          e => e.source === pendingConnection.nodeId && e.target === node.id
        );
        if (hasExistingEdge) return false;

        // Get node bounds (approximate - nodes are typically ~180px wide, ~60px tall)
        const nodeWidth = 180;
        const nodeHeight = 80;
        const tolerance = 30; // Extra tolerance around node

        const left = node.position.x - tolerance;
        const right = node.position.x + nodeWidth + tolerance;
        const top = node.position.y - tolerance;
        const bottom = node.position.y + nodeHeight + tolerance;

        return flowPos.x >= left && flowPos.x <= right && flowPos.y >= top && flowPos.y <= bottom;
      });

      if (targetNode) {
        // Dropped on/near a node - create connection to it
        console.log('Auto-connecting to node:', targetNode.id);

        const sourceType = pendingConnection.nodeType;
        const targetType = targetNode.type || '';

        // Determine best target handle based on relative position
        const dx = flowPos.x - (targetNode.position.x + 90); // Center of node
        const dy = flowPos.y - (targetNode.position.y + 40);

        let targetHandle = 'left-2-target';
        if (Math.abs(dx) > Math.abs(dy)) {
          targetHandle = dx > 0 ? 'right-2-target' : 'left-2-target';
        } else {
          targetHandle = dy > 0 ? 'bottom-2-target' : 'top-2-target';
        }

        const newEdge = {
          id: `${pendingConnection.nodeId}-${targetNode.id}-${Date.now()}`,
          source: pendingConnection.nodeId,
          sourceHandle: pendingConnection.handleId,
          target: targetNode.id,
          targetHandle,
          type: 'permission',
          data: {
            isResourceBased: isResourceBasedConnection(sourceType, targetType),
          },
        };

        setEdges([...edges, newEdge]);
        setPendingConnection(null);
        return;
      }

      // Dropped on empty space - show radial menu if valid targets exist
      const validTargets = getAllValidTargets(pendingConnection.nodeType);
      console.log('Valid targets for', pendingConnection.nodeType, ':', validTargets);

      if (validTargets.length > 0) {
        const canvas = canvasRef.current;
        const canvasRect = canvas?.getBoundingClientRect();
        const screenX = canvasRect ? clientX - canvasRect.left : clientX;
        const screenY = canvasRect ? clientY - canvasRect.top : clientY;

        console.log('Showing radial menu at:', { screen: { x: screenX, y: screenY }, flow: flowPos });
        setRadialMenuPos({
          screen: { x: screenX, y: screenY },
          flow: flowPos,
        });
        return; // Keep pendingConnection for menu
      }

      // No valid targets - clear pending connection
      setPendingConnection(null);
    },
    [pendingConnection, screenToFlowPosition, nodes, edges, setEdges]
  );

  // Handle radial menu selection - create node and connect
  const handleRadialMenuSelect = useCallback(
    (resourceType: string, label: string) => {
      if (!pendingConnection || !radialMenuPos) return;

      const sourceNode = nodes.find(n => n.id === pendingConnection.nodeId);

      // Create new node at flow position (offset slightly from menu center)
      const newNodeId = `${resourceType}-${Date.now()}`;
      const newNode: Node = {
        id: newNodeId,
        type: resourceType,
        position: { x: radialMenuPos.flow.x + 50, y: radialMenuPos.flow.y - 20 },
        data: { label, status: 'draft' },
      };

      // Auto-populate log group path if creating a Log Group from Lambda/Agent
      if (resourceType === 'log-group' && sourceNode) {
        const { projectName } = useStore.getState();
        const suggestedPath = generateLogGroupPath(sourceNode, projectName);
        if (suggestedPath) {
          newNode.data = {
            ...newNode.data,
            config: {
              logGroupPath: suggestedPath,
            },
          };
        }
      }

      // Create edge from source to new node
      const newEdge = {
        id: `${pendingConnection.nodeId}-${newNodeId}`,
        source: pendingConnection.nodeId,
        sourceHandle: pendingConnection.handleId,
        target: newNodeId,
        targetHandle: 'left-2-target', // Default to left-center target handle
        type: 'permission',
        data: {
          isResourceBased: isResourceBasedConnection(pendingConnection.nodeType, resourceType),
        },
      };

      setNodes([...nodes, newNode]);
      setEdges([...edges, newEdge]);
      setRadialMenuPos(null);
      setPendingConnection(null);
    },
    [pendingConnection, radialMenuPos, nodes, edges, setNodes, setEdges]
  );

  // Close radial menu
  const handleRadialMenuClose = useCallback(() => {
    setRadialMenuPos(null);
    setPendingConnection(null);
  }, []);

  // Single click on node - just updates React Flow selection (handled automatically)
  // We sync our store's selectedNode with the first selected node
  const onSelectionChange = useCallback(
    ({ nodes: selectedFlowNodes }: { nodes: Node[] }) => {
      if (selectedFlowNodes.length === 1) {
        setSelectedNode(selectedFlowNodes[0].id);
      } else if (selectedFlowNodes.length === 0) {
        setSelectedNode(null);
      } else {
        // Multiple selected - set to first one for config panel purposes
        setSelectedNode(selectedFlowNodes[0].id);
      }
      // Clear editing state when selection changes
      setEditingNode(null);
      setEditingEdge(null);
    },
    [setSelectedNode]
  );

  // Double-click on node - open config panel
  const onNodeDoubleClick = useCallback(
    (_event: React.MouseEvent, node: Node) => {
      setEditingNode(node.id);
      setSelectedNode(node.id);
      setEditingEdge(null);
    },
    [setSelectedNode]
  );

  // Single click on edge - select it (visual feedback)
  const onEdgeClick = useCallback(
    (_event: React.MouseEvent, edge: any) => {
      setSelectedEdge(edge.id);
      setEditingEdge(null);
    },
    []
  );

  // Double-click on edge - open role assignment modal
  const onEdgeDoubleClick = useCallback(
    (_event: React.MouseEvent, edge: any) => {
      setEditingEdge(edge.id);
      setSelectedEdge(edge.id);
    },
    []
  );

  // Track edge being reconnected for visual feedback
  const edgeReconnectSuccessful = useRef(true);
  const isReconnecting = useRef(false);

  const onReconnectStart = useCallback(() => {
    edgeReconnectSuccessful.current = false;
    isReconnecting.current = true;
  }, []);

  // Handle edge reconnection (dragging edge endpoint to new handle)
  const onReconnect = useCallback(
    (oldEdge: Edge, newConnection: Connection) => {
      edgeReconnectSuccessful.current = true;

      // Check if this is a DLQ edge (derived from node config)
      if (oldEdge.id.startsWith('dlq-')) {
        // Update the source node's DLQ config to point to the new target
        const sourceNodeId = oldEdge.source;
        const newTargetId = newConnection.target;

        // Validate the new target is a valid DLQ target (SQS or SNS)
        const newTargetNode = nodes.find(n => n.id === newTargetId);
        if (!newTargetNode || !['sqs', 'sns'].includes(newTargetNode.type || '')) {
          return; // Invalid target, don't update
        }

        setNodes(nodes.map(n => {
          if (n.id === sourceNodeId) {
            return {
              ...n,
              data: {
                ...n.data,
                config: {
                  ...n.data?.config,
                  dlq: {
                    ...n.data?.config?.dlq,
                    targetId: newTargetId,
                  },
                },
              },
            };
          }
          return n;
        }));
        return; // DLQ edges are derived, don't update edges directly
      }

      // Check if the new connection is valid (uses same validation as new connections)
      const sourceNode = nodes.find(n => n.id === newConnection.source);
      const targetNode = nodes.find(n => n.id === newConnection.target);

      if (!sourceNode || !targetNode) return;

      const sourceType = sourceNode.type || '';
      const targetType = targetNode.type || '';

      // Update the edge with the new connection, preserving existing data
      const updatedEdge = {
        ...oldEdge,
        source: newConnection.source!,
        target: newConnection.target!,
        sourceHandle: newConnection.sourceHandle,
        targetHandle: newConnection.targetHandle,
        data: {
          ...oldEdge.data,
          // Update isResourceBased if the connection type changed
          isResourceBased: isResourceBasedConnection(sourceType, targetType),
        },
      };

      setEdges(reconnectEdge(oldEdge, newConnection, edges).map(e =>
        e.id === oldEdge.id ? updatedEdge : e
      ));
    },
    [edges, nodes, setEdges, setNodes]
  );

  const onReconnectEnd = useCallback(
    (_event: MouseEvent | TouchEvent, edge: Edge) => {
      // If reconnection failed (dropped on empty space), handle accordingly
      if (!edgeReconnectSuccessful.current) {
        // For DLQ edges, disable the DLQ config instead of removing (since it's derived)
        if (edge.id.startsWith('dlq-')) {
          const sourceNodeId = edge.source;
          setNodes(nodes.map(n => {
            if (n.id === sourceNodeId) {
              return {
                ...n,
                data: {
                  ...n.data,
                  config: {
                    ...n.data?.config,
                    dlq: {
                      ...n.data?.config?.dlq,
                      enabled: false,
                      targetId: undefined,
                    },
                  },
                },
              };
            }
            return n;
          }));
          isReconnecting.current = false;
          return;
        }
        // For regular edges, remove them
        setEdges(edges.filter(e => e.id !== edge.id));
      }
      isReconnecting.current = false;
    },
    [edges, nodes, setEdges, setNodes]
  );

  // Allow all connections - we handle validation via connection rules for radial menu only
  const isValidConnection: IsValidConnection = useCallback(() => {
    return true;
  }, []);

  // Click on empty canvas - deselect everything
  const onPaneClick = useCallback(() => {
    setSelectedNode(null);
    setSelectedEdge(null);
    setEditingNode(null);
    setEditingEdge(null);
  }, [setSelectedNode]);

  // Delete selected nodes or edges (supports multi-select)
  const deleteSelected = useCallback(() => {
    const nodesToDelete = nodes.filter(n => n.selected).map(n => n.id);

    if (nodesToDelete.length > 0) {
      // Remove selected nodes and any connected edges
      setNodes(nodes.filter(n => !n.selected));
      setEdges(edges.filter(e => !nodesToDelete.includes(e.source) && !nodesToDelete.includes(e.target)));
      setSelectedNode(null);
      setEditingNode(null);
    } else if (selectedEdge) {
      setEdges(edges.filter(e => e.id !== selectedEdge));
      setSelectedEdge(null);
      setEditingEdge(null);
    }
  }, [nodes, edges, setNodes, setEdges, setSelectedNode, selectedEdge]);

  // Keyboard handler for delete
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't delete if typing in an input
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }

      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        deleteSelected();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [deleteSelected]);

  return (
    <div className="h-screen w-screen flex flex-col overflow-hidden">
      <Toolbar />

      <div className="flex-1 flex relative min-h-0">
        <ResourceLibrary />

        <div ref={canvasRef} className="flex-1 relative min-h-0">
          <ReactFlow
            nodes={nodes}
            edges={allEdges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnectStart={onConnectStart}
            onConnect={onConnect}
            onConnectEnd={onConnectEnd}
            onSelectionChange={onSelectionChange}
            onNodeDoubleClick={onNodeDoubleClick}
            onEdgeClick={onEdgeClick}
            onEdgeDoubleClick={onEdgeDoubleClick}
            onPaneClick={onPaneClick}
            onNodeDragStart={onNodeDragStart}
            onNodeDragStop={onNodeDragStop}
            // Edge reconnection (drag endpoints to new handles)
            onReconnectStart={onReconnectStart}
            onReconnect={onReconnect}
            onReconnectEnd={onReconnectEnd}
            // Allow all connections
            isValidConnection={isValidConnection}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            fitView
            // Snap to grid for alignment
            snapToGrid
            snapGrid={[15, 15]}
            // Selection behavior like design tools
            selectionMode={SelectionMode.Partial} // Select nodes partially inside marquee
            selectionOnDrag={!draggedItem} // Enable marquee/box selection (disabled when dragging from palette)
            selectNodesOnDrag={false} // Don't auto-select when dragging nodes
            panOnDrag={draggedItem ? false : [1, 2]} // Pan with middle/right mouse button (disabled when dragging from palette)
            selectionKeyCode="Shift" // Hold Shift for multi-select
            multiSelectionKeyCode="Shift"
            deleteKeyCode={['Backspace', 'Delete']}
            className="h-full w-full"
          >
            <Background variant={BackgroundVariant.Dots} gap={15} size={1} />
            <Controls className="!bottom-4" />
            <MiniMap />
            {/* Visual grouping overlay for related nodes (DLQ, etc.) */}
            <GroupingOverlay groups={nodeGroups} nodes={nodes} onBreakGroup={handleBreakGroup} onMoveGroup={handleMoveGroup} />
          </ReactFlow>

          {/* Drop indicator overlay - just a border, no background */}
          {draggedItem && isOverCanvas && (
            <div className="absolute inset-0 z-10 pointer-events-none border-4 border-dashed border-blue-500" />
          )}

          <PermissionLegend />
          <DeploymentTimeline />

          {/* Radial menu for quick node creation */}
          {radialMenuPos && pendingConnection && (
            <RadialMenu
              position={radialMenuPos.screen}
              sourceNodeType={pendingConnection.nodeType}
              onSelect={handleRadialMenuSelect}
              onClose={handleRadialMenuClose}
            />
          )}
        </div>

        {/* Right panel with tabs (Roles, Environment) */}
        <RightPanel />

        {/* Execution log panel - shows during deployment */}
        {showExecutionPanel && selectedNode && (
          <ExecutionLogPanel nodeId={selectedNode} />
        )}

        {/* Configuration panel - shows on double-click */}
        {editingNode && !showExecutionPanel && nodes.find(n => n.id === editingNode) && (
          <ConfigurationPanel
            node={nodes.find(n => n.id === editingNode)!}
            onClose={() => setEditingNode(null)}
          />
        )}

        {/* Role assignment modal - shows on edge double-click */}
        {editingEdge && (
          <RoleAssignmentModal
            edgeId={editingEdge}
            onClose={() => {
              setEditingEdge(null);
              setSelectedEdge(null);
            }}
          />
        )}

        {/* Selection info bar */}
        {selectedNodes.length > 1 && (
          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 bg-gray-800 text-white px-4 py-2 rounded-lg text-sm shadow-lg">
            {selectedNodes.length} nodes selected
            <span className="ml-2 text-gray-400">• Press Delete to remove</span>
          </div>
        )}
      </div>

      {/* Floating drag preview - only show after mouse has moved */}
      {draggedItem && mousePos.x > 0 && mousePos.y > 0 && (
        <div
          className="fixed z-50 pointer-events-none bg-white border-2 border-blue-500 rounded-lg px-3 py-2 shadow-lg"
          style={{
            left: mousePos.x + 10,
            top: mousePos.y + 10,
          }}
        >
          <span className="text-sm font-medium text-gray-700">{draggedItem.label}</span>
        </div>
      )}
    </div>
  );
}

export default function App() {
  return (
    <ReactFlowProvider>
      <Flow />
    </ReactFlowProvider>
  );
}
