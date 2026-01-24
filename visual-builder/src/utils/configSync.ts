import { Node, Edge } from 'reactflow';
import YAML from 'yaml';

export interface ResourceConfig {
  name: string;
  type: string;
  config?: Record<string, any>;
}

export interface ConnectionConfig {
  from: string;
  to: string;
  role?: string;
  config?: Record<string, any>;
}

export interface RoleConfig {
  name: string;
  description?: string;
}

export interface WarpcoreConfig {
  project: {
    name: string;
    region: string;
    cost_estimation?: {
      executions_per_month: number;
    };
  };
  agents: Array<{
    name: string;
    path?: string;
    runtime?: string;
    memory?: number;
    timeout?: number;
    environment?: Record<string, string>;
  }>;
  resources?: ResourceConfig[];
  roles?: RoleConfig[];
  connections?: ConnectionConfig[];
  shared?: {
    vpc?: {
      enabled: boolean;
      cidr?: string;
    };
    api_gateway?: {
      type: string;
      cors: boolean;
    };
  };
  environments: Record<string, {
    account: string;
    region: string;
  }>;
  canvas?: {
    nodes: Array<{
      id: string;
      type: string;
      x: number;
      y: number;
      label: string;
      config?: Record<string, any>;
    }>;
    edges: Array<{
      id: string;
      source: string;
      target: string;
      sourceHandle?: string;
      targetHandle?: string;
      roleId?: string;
      isResourceBased?: boolean;
      config?: Record<string, any>;
    }>;
  };
}

export function generateYAMLFromCanvas(nodes: Node[], edges: Edge[], executionsPerMonth: number = 100000): string {
  // Extract project name from agent nodes or use default
  const agentNodes = nodes.filter(node => node.type === 'agent');
  const projectName = agentNodes[0]?.data?.config?.name ||
                      agentNodes[0]?.data?.label?.toLowerCase().replace(/\s+/g, '-') ||
                      'my-warpcore-project';

  const config: WarpcoreConfig = {
    project: {
      name: projectName,
      region: 'us-east-1',
      cost_estimation: {
        executions_per_month: executionsPerMonth,
      },
    },
    agents: [],
    resources: [],
    roles: [],
    connections: [],
    shared: {},
    environments: {
      dev: {
        account: '123456789012',
        region: 'us-east-1',
      },
      prod: {
        account: '987654321098',
        region: 'us-east-1',
      },
    },
    canvas: {
      nodes: [],
      edges: [],
    },
  };

  // Process all nodes
  for (const node of nodes) {
    // Save canvas position for all nodes
    config.canvas!.nodes.push({
      id: node.id,
      type: node.type || 'unknown',
      x: node.position.x,
      y: node.position.y,
      label: node.data?.label || node.type || 'Unknown',
      config: node.data?.config,
    });

    if (node.type === 'agent') {
      config.agents.push({
        name: node.data?.config?.name || node.data?.label?.toLowerCase().replace(/\s+/g, '-') || 'agent',
        path: node.data?.config?.path || `./agents/${node.data?.label?.toLowerCase().replace(/\s+/g, '-') || 'agent'}`,
        runtime: node.data?.config?.runtime || 'python3.11',
        memory: node.data?.config?.memory || 512,
        timeout: node.data?.config?.timeout || 30,
        environment: node.data?.config?.environment || {},
      });
    } else if (node.type === 'iam-role') {
      config.roles!.push({
        name: node.data?.config?.roleName || node.data?.label || 'Role',
        description: node.data?.config?.description,
      });
    } else if (node.type !== 'vpc' && node.type !== 'api-gateway') {
      // Add as a resource (skip vpc and api-gateway as they go in shared)
      config.resources!.push({
        name: node.data?.config?.name || node.data?.label || node.type || 'resource',
        type: node.type || 'unknown',
        config: node.data?.config,
      });
    }
  }

  // Check for VPC nodes
  const hasVPC = nodes.some(node => node.type === 'vpc');
  if (hasVPC) {
    config.shared!.vpc = {
      enabled: true,
      cidr: '10.0.0.0/16',
    };
  }

  // Check for API Gateway nodes
  const hasAPIGateway = nodes.some(node => node.type === 'api-gateway');
  if (hasAPIGateway) {
    config.shared!.api_gateway = {
      type: 'http',
      cors: true,
    };
  }

  // Process edges
  for (const edge of edges) {
    config.canvas!.edges.push({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      sourceHandle: edge.sourceHandle || undefined,
      targetHandle: edge.targetHandle || undefined,
      roleId: edge.data?.roleId,
      isResourceBased: edge.data?.isResourceBased,
      config: edge.data?.config,
    });

    // Also add to connections for semantic representation
    const sourceNode = nodes.find(n => n.id === edge.source);
    const targetNode = nodes.find(n => n.id === edge.target);
    if (sourceNode && targetNode) {
      config.connections!.push({
        from: sourceNode.data?.config?.name || sourceNode.data?.label || edge.source,
        to: targetNode.data?.config?.name || targetNode.data?.label || edge.target,
        role: edge.data?.roleId ? nodes.find(n => n.id === edge.data?.roleId)?.data?.label : undefined,
        config: edge.data?.config,
      });
    }
  }

  return YAML.stringify(config);
}

export function parseYAMLToCanvas(yamlContent: string): { nodes: Node[], edges: Edge[], executionsPerMonth: number } {
  const config = YAML.parse(yamlContent) as WarpcoreConfig;
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  const executionsPerMonth = config.project.cost_estimation?.executions_per_month ?? 100000;

  // If we have canvas data, use it directly (preserves positions and IDs)
  if (config.canvas?.nodes && config.canvas.nodes.length > 0) {
    for (const canvasNode of config.canvas.nodes) {
      nodes.push({
        id: canvasNode.id,
        type: canvasNode.type,
        position: { x: canvasNode.x, y: canvasNode.y },
        data: {
          label: canvasNode.label,
          config: canvasNode.config,
          status: 'configured',
        },
      });
    }

    for (const canvasEdge of config.canvas.edges || []) {
      edges.push({
        id: canvasEdge.id,
        source: canvasEdge.source,
        target: canvasEdge.target,
        sourceHandle: canvasEdge.sourceHandle,
        targetHandle: canvasEdge.targetHandle,
        type: 'permission',
        data: {
          roleId: canvasEdge.roleId,
          isResourceBased: canvasEdge.isResourceBased,
          config: canvasEdge.config,
        },
      });
    }

    return { nodes, edges, executionsPerMonth };
  }

  // Fallback: Generate nodes from semantic config
  let xOffset = 100;
  let yOffset = 100;
  const nodeIdMap: Record<string, string> = {};

  // Create agent nodes
  config.agents.forEach((agent, index) => {
    const nodeId = `agent-${index}`;
    nodeIdMap[agent.name] = nodeId;
    nodes.push({
      id: nodeId,
      type: 'agent',
      position: { x: xOffset, y: yOffset },
      data: {
        label: agent.name,
        config: {
          name: agent.name,
          path: agent.path,
          runtime: agent.runtime,
          memory: agent.memory,
          timeout: agent.timeout,
          environment: agent.environment,
        },
        status: 'configured',
      },
    });
    yOffset += 150;
  });

  // Create resource nodes
  xOffset = 400;
  yOffset = 100;
  (config.resources || []).forEach((resource, index) => {
    const nodeId = `${resource.type}-${index}`;
    nodeIdMap[resource.name] = nodeId;
    nodes.push({
      id: nodeId,
      type: resource.type,
      position: { x: xOffset, y: yOffset },
      data: {
        label: resource.name,
        config: resource.config,
        status: 'configured',
      },
    });
    yOffset += 120;
    if (yOffset > 600) {
      yOffset = 100;
      xOffset += 250;
    }
  });

  // Create role nodes
  xOffset = 250;
  yOffset = 50;
  (config.roles || []).forEach((role, index) => {
    const nodeId = `role-${index}`;
    nodeIdMap[role.name] = nodeId;
    nodes.push({
      id: nodeId,
      type: 'iam-role',
      position: { x: xOffset, y: yOffset },
      data: {
        label: role.name,
        config: {
          roleName: role.name,
          description: role.description,
        },
        status: 'configured',
      },
    });
    yOffset += 150;
  });

  // Create shared resource nodes
  if (config.shared?.vpc?.enabled) {
    nodes.push({
      id: 'vpc-shared',
      type: 'vpc',
      position: { x: 700, y: 100 },
      data: {
        label: 'VPC',
        status: 'configured',
      },
    });
  }

  if (config.shared?.api_gateway) {
    nodes.push({
      id: 'api-gateway-shared',
      type: 'api-gateway',
      position: { x: 100, y: 50 },
      data: {
        label: 'API Gateway',
        status: 'configured',
      },
    });
  }

  // Create edges from connections
  (config.connections || []).forEach((conn, index) => {
    const sourceId = nodeIdMap[conn.from];
    const targetId = nodeIdMap[conn.to];
    const roleId = conn.role ? nodeIdMap[conn.role] : undefined;

    if (sourceId && targetId) {
      edges.push({
        id: `edge-${index}`,
        source: sourceId,
        target: targetId,
        type: 'permission',
        data: {
          roleId,
          config: conn.config,
        },
      });
    }
  });

  return { nodes, edges, executionsPerMonth };
}
