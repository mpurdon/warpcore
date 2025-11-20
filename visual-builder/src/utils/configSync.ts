import { Node, Edge } from 'reactflow';
import YAML from 'yaml';

export interface StrandsConfig {
  project: {
    name: string;
    region: string;
  };
  agents: Array<{
    name: string;
    path: string;
    runtime: string;
    memory: number;
    timeout: number;
    environment?: Record<string, string>;
  }>;
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
}

export function generateYAMLFromCanvas(nodes: Node[], edges: Edge[]): string {
  const config: StrandsConfig = {
    project: {
      name: 'my-strands-project',
      region: 'us-east-1',
    },
    agents: [],
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
  };

  // Extract agents from nodes
  const agentNodes = nodes.filter(node => node.type === 'agent');
  config.agents = agentNodes.map(node => ({
    name: node.data.label.toLowerCase().replace(/\s+/g, '-'),
    path: `./apps/${node.data.label.toLowerCase().replace(/\s+/g, '-')}`,
    runtime: node.data.runtime || 'python3.11',
    memory: node.data.memory || 512,
    timeout: node.data.timeout || 30,
    environment: node.data.environment || {},
  }));

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

  return YAML.stringify(config);
}

export function parseYAMLToCanvas(yamlContent: string): { nodes: Node[], edges: Edge[] } {
  const config = YAML.parse(yamlContent) as StrandsConfig;
  const nodes: Node[] = [];
  const edges: Edge[] = [];

  let yOffset = 100;

  // Create agent nodes
  config.agents.forEach((agent, index) => {
    nodes.push({
      id: `agent-${index}`,
      type: 'agent',
      position: { x: 100, y: yOffset },
      data: {
        label: agent.name,
        runtime: agent.runtime,
        memory: agent.memory,
        timeout: agent.timeout,
        environment: agent.environment,
        status: 'pending',
      },
    });
    yOffset += 120;
  });

  // Create shared resource nodes
  if (config.shared?.vpc?.enabled) {
    nodes.push({
      id: 'vpc-shared',
      type: 'vpc',
      position: { x: 400, y: 100 },
      data: {
        label: 'VPC',
        status: 'pending',
      },
    });
  }

  if (config.shared?.api_gateway) {
    nodes.push({
      id: 'api-gateway-shared',
      type: 'api-gateway',
      position: { x: 400, y: 250 },
      data: {
        label: 'API Gateway',
        status: 'pending',
      },
    });
  }

  return { nodes, edges };
}
