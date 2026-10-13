import { Node, XYPosition } from 'reactflow';

// Constants for node sizing and positioning
const NODE_WIDTH = 180;
const NODE_HEIGHT = 80;
const CHILD_OFFSET_X = NODE_WIDTH / 2; // Child's left edge aligns with parent's center
const CHILD_OFFSET_Y = 10; // Vertical gap between parent bottom and child top

// A group represents a parent node with its child/satellite nodes
export interface NodeGroup {
  parentId: string;
  childIds: string[];
  groupType: 'dlq' | 'replication' | 'subnet' | 'route' | 'rule';
  // Bounding box for the group (computed from node positions)
  bounds?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

// Compute all node groups from the current node configuration
export function computeNodeGroups(nodes: Node[]): NodeGroup[] {
  const groups: NodeGroup[] = [];
  const childToParent = new Map<string, string>(); // Track which nodes are already children

  // Find DLQ relationships (SQS/Lambda/SNS/EventBridge with dlq.targetId)
  nodes.forEach(node => {
    const dlqConfig = node.data?.config?.dlq;
    if (dlqConfig?.enabled && dlqConfig?.targetId) {
      const targetExists = nodes.some(n => n.id === dlqConfig.targetId);
      if (targetExists && !childToParent.has(dlqConfig.targetId)) {
        groups.push({
          parentId: node.id,
          childIds: [dlqConfig.targetId],
          groupType: 'dlq',
        });
        childToParent.set(dlqConfig.targetId, node.id);
      }
    }
  });

  // Future: Add other relationship types
  // - S3 replication targets
  // - VPC subnets (subnet.vpcId references parent)
  // - API Gateway routes (route.apiGatewayId references parent)
  // - EventBridge rules (rule.eventBridgeId references parent)

  return groups;
}

// Find the group a node belongs to (either as parent or child)
export function findNodeGroup(nodeId: string, groups: NodeGroup[]): NodeGroup | null {
  for (const group of groups) {
    if (group.parentId === nodeId || group.childIds.includes(nodeId)) {
      return group;
    }
  }
  return null;
}

// Check if a node is a child in any group
export function isChildNode(nodeId: string, groups: NodeGroup[]): boolean {
  return groups.some(g => g.childIds.includes(nodeId));
}

// Check if a node is a parent in any group
export function isParentNode(nodeId: string, groups: NodeGroup[]): boolean {
  return groups.some(g => g.parentId === nodeId);
}

// Get all nodes in a group (parent + children)
export function getGroupNodes(group: NodeGroup, nodes: Node[]): Node[] {
  const groupNodeIds = [group.parentId, ...group.childIds];
  return nodes.filter(n => groupNodeIds.includes(n.id));
}

// Compute bounding box for a group of nodes
export function computeGroupBounds(
  group: NodeGroup,
  nodes: Node[],
  padding: number = 20,
  nodeWidth: number = 180,
  nodeHeight: number = 80
): { x: number; y: number; width: number; height: number } {
  const groupNodes = getGroupNodes(group, nodes);

  if (groupNodes.length === 0) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  groupNodes.forEach(node => {
    minX = Math.min(minX, node.position.x);
    minY = Math.min(minY, node.position.y);
    maxX = Math.max(maxX, node.position.x + nodeWidth);
    maxY = Math.max(maxY, node.position.y + nodeHeight);
  });

  return {
    x: minX - padding,
    y: minY - padding,
    width: maxX - minX + padding * 2,
    height: maxY - minY + padding * 2,
  };
}

// Calculate position delta when parent moves
export function calculateChildPositions(
  _parentId: string,
  oldPosition: XYPosition,
  newPosition: XYPosition,
  group: NodeGroup,
  nodes: Node[]
): Map<string, XYPosition> {
  const delta = {
    x: newPosition.x - oldPosition.x,
    y: newPosition.y - oldPosition.y,
  };

  const newPositions = new Map<string, XYPosition>();

  // Move all children by the same delta
  group.childIds.forEach(childId => {
    const childNode = nodes.find(n => n.id === childId);
    if (childNode) {
      newPositions.set(childId, {
        x: childNode.position.x + delta.x,
        y: childNode.position.y + delta.y,
      });
    }
  });

  return newPositions;
}

// Get a label for the group type
export function getGroupTypeLabel(groupType: NodeGroup['groupType']): string {
  switch (groupType) {
    case 'dlq': return 'Dead Letter Queue';
    case 'replication': return 'Replication';
    case 'subnet': return 'VPC Subnet';
    case 'route': return 'API Route';
    case 'rule': return 'Event Rule';
    default: return 'Group';
  }
}

// Get color for group type
export function getGroupTypeColor(groupType: NodeGroup['groupType']): string {
  switch (groupType) {
    case 'dlq': return 'var(--c-amber-500)'; // Amber
    case 'replication': return 'var(--c-blue-500)'; // Blue
    case 'subnet': return 'var(--c-violet-500)'; // Purple
    case 'route': return 'var(--c-emerald-500)'; // Green
    case 'rule': return 'var(--c-pink-500)'; // Pink
    default: return 'var(--c-gray-500)'; // Gray
  }
}

// Calculate position for a new child node in a group
// Children are positioned below the parent, stacked vertically
export function calculateChildPosition(
  parentNode: Node,
  existingChildIds: string[],
  nodes: Node[]
): XYPosition {
  // Get existing children positions to stack below them
  const existingChildren = nodes.filter(n => existingChildIds.includes(n.id));

  if (existingChildren.length === 0) {
    // First child - left edge aligns with parent center, positioned below parent
    return {
      x: parentNode.position.x + CHILD_OFFSET_X,
      y: parentNode.position.y + NODE_HEIGHT + CHILD_OFFSET_Y,
    };
  }

  // Find the lowest existing child
  const lowestChild = existingChildren.reduce((lowest, child) =>
    child.position.y > lowest.position.y ? child : lowest
  );

  // Position new child below the lowest existing child
  return {
    x: lowestChild.position.x,
    y: lowestChild.position.y + NODE_HEIGHT + CHILD_OFFSET_Y,
  };
}

// Get all existing child IDs for a parent (before adding a new one)
export function getExistingChildIds(parentId: string, groups: NodeGroup[]): string[] {
  const group = groups.find(g => g.parentId === parentId);
  return group ? group.childIds : [];
}

// Snap position to grid
export function snapToGrid(position: XYPosition, gridSize: number = 15): XYPosition {
  return {
    x: Math.round(position.x / gridSize) * gridSize,
    y: Math.round(position.y / gridSize) * gridSize,
  };
}
