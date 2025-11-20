import { Node, Edge } from 'reactflow';

export interface ValidationError {
  nodeId: string;
  severity: 'error' | 'warning';
  message: string;
}

export function validateCanvas(nodes: Node[], edges: Edge[]): ValidationError[] {
  const errors: ValidationError[] = [];

  // Check for agents without IAM roles
  const agentNodes = nodes.filter(n => n.type === 'agent');
  const iamNodes = nodes.filter(n => n.type === 'iam-role');
  
  if (agentNodes.length > 0 && iamNodes.length === 0) {
    agentNodes.forEach(agent => {
      errors.push({
        nodeId: agent.id,
        severity: 'error',
        message: 'Agent requires an IAM role for execution',
      });
    });
  }

  // Check for agents without API Gateway or Lambda URL
  const apiNodes = nodes.filter(n => n.type === 'api-gateway' || n.type === 'lambda-url');
  
  if (agentNodes.length > 0 && apiNodes.length === 0) {
    agentNodes.forEach(agent => {
      errors.push({
        nodeId: agent.id,
        severity: 'warning',
        message: 'Agent has no API Gateway or Lambda URL configured',
      });
    });
  }

  // Check for resources without connections
  nodes.forEach(node => {
    if (node.type !== 'agent' && node.type !== 'vpc') {
      const hasConnection = edges.some(e => e.source === node.id || e.target === node.id);
      if (!hasConnection) {
        errors.push({
          nodeId: node.id,
          severity: 'warning',
          message: 'Resource is not connected to any agent',
        });
      }
    }
  });

  // Check for edges without permissions
  edges.forEach(edge => {
    if (edge.type === 'permission' && (!edge.data?.permissions || edge.data.permissions.length === 0)) {
      errors.push({
        nodeId: edge.source,
        severity: 'error',
        message: 'Connection has no permissions defined',
      });
    }
  });

  // Check for circular dependencies (simplified)
  const visited = new Set<string>();
  const recursionStack = new Set<string>();

  function hasCycle(nodeId: string): boolean {
    visited.add(nodeId);
    recursionStack.add(nodeId);

    const outgoingEdges = edges.filter(e => e.source === nodeId);
    for (const edge of outgoingEdges) {
      if (!visited.has(edge.target)) {
        if (hasCycle(edge.target)) return true;
      } else if (recursionStack.has(edge.target)) {
        return true;
      }
    }

    recursionStack.delete(nodeId);
    return false;
  }

  for (const node of nodes) {
    if (!visited.has(node.id)) {
      if (hasCycle(node.id)) {
        errors.push({
          nodeId: node.id,
          severity: 'error',
          message: 'Circular dependency detected',
        });
      }
    }
  }

  return errors;
}
