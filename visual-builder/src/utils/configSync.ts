import { Node, Edge } from 'reactflow';
import YAML from 'yaml';
import { DEFAULT_ENVIRONMENT_CONFIGS, EnvironmentConfig, RemovalPolicy } from '../store/useStore';
import { orderParentsFirst } from './nodeTree';
import { Scenario, ScenarioYaml, scenariosFromYaml, scenariosToYaml } from './scenarios';
import { HolodeckMeta, holodeckMetaFromYaml, holodeckMetaToYaml } from './holodeck';

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
    handler?: string;
    description?: string;
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
  environments: Record<string, EnvironmentYaml>;
  /** Named events played through the canvas; see scenarios.ts. */
  scenarios?: ScenarioYaml[];
  /** The Holodeck entry this project was copied from, with its notes; see holodeck.ts. */
  holodeck?: Record<string, unknown>;
  canvas?: {
    nodes: Array<{
      id: string;
      type: string;
      x: number;
      y: number;
      label: string;
      config?: Record<string, any>;
      hidden?: boolean;
      /** Deployment status the node was last known to have. */
      status?: string;
      /** For resources discovered from an account: where they actually are. */
      arn?: string;
      region?: string;
      /** Containment: the group this node sits inside, and a group's size. */
      parent?: string;
      size?: { width: number; height: number };
      /** Badges, attachments, group and warning info; see NodeMeta. */
      meta?: Record<string, unknown>;
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
      /** Layer and discovered relationship; see EdgeMeta. */
      meta?: Record<string, unknown>;
    }>;
  };
}

/**
 * One environment as it appears in warpcore.yaml. `account` and `region`
 * are what the CLI validates; the builder's own settings sit beside them in
 * snake_case. Unknown keys (vpc, tags, anything a later CLI adds) are kept
 * verbatim through EnvironmentExtras so a round trip never drops them.
 */
export interface EnvironmentYaml {
  name?: string;
  account: string;
  region: string;
  removal_policies?: {
    default?: RemovalPolicy;
    s3?: RemovalPolicy;
    dynamodb?: RemovalPolicy;
    log_group?: RemovalPolicy;
    sqs?: RemovalPolicy;
  };
  logging?: {
    retention_days?: number;
    xray?: boolean;
  };
  defaults?: {
    lambda_memory?: number;
    lambda_timeout?: number;
    s3_versioning?: boolean;
    dynamodb_backup?: boolean;
  };
  [extra: string]: unknown;
}

/** Keys of an environment block the builder does not model, kept as-is. */
export type EnvironmentExtras = Record<string, Record<string, unknown>>;

const BUILDER_ENV_KEYS = new Set(['name', 'removal_policies', 'logging', 'defaults']);

// Placeholder accounts for environments that have never been given one. The
// CLI insists on a 12-digit account, so the file has to carry something.
const PLACEHOLDER_ACCOUNT: Record<string, string> = {
  dev: '123456789012',
  prod: '987654321098',
};

function stripUndefined<T extends Record<string, unknown>>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as T;
}

/** Builder settings for one environment, as YAML keys. */
export function environmentToYaml(config: EnvironmentConfig): Pick<EnvironmentYaml, 'name' | 'removal_policies' | 'logging' | 'defaults'> {
  return {
    name: config.name,
    removal_policies: stripUndefined({
      default: config.removalPolicies.default,
      s3: config.removalPolicies.s3,
      dynamodb: config.removalPolicies.dynamodb,
      log_group: config.removalPolicies.logGroup,
      sqs: config.removalPolicies.sqs,
    }),
    logging: {
      retention_days: config.logging.defaultRetentionDays,
      xray: config.logging.enableXRay,
    },
    defaults: {
      lambda_memory: config.defaults.lambdaMemory,
      lambda_timeout: config.defaults.lambdaTimeout,
      s3_versioning: config.defaults.s3Versioning,
      dynamodb_backup: config.defaults.dynamoDbBackup,
    },
  };
}

/** Builder settings from one environment's YAML, over the defaults for that key. */
export function environmentFromYaml(key: string, yaml: EnvironmentYaml | undefined): EnvironmentConfig {
  const base = DEFAULT_ENVIRONMENT_CONFIGS[key] ?? DEFAULT_ENVIRONMENT_CONFIGS.dev;
  const rp = yaml?.removal_policies ?? {};
  return {
    name: yaml?.name ?? base.name ?? key,
    removalPolicies: stripUndefined({
      default: rp.default ?? base.removalPolicies.default,
      s3: rp.s3,
      dynamodb: rp.dynamodb ?? (rp.default === undefined ? base.removalPolicies.dynamodb : undefined),
      logGroup: rp.log_group,
      sqs: rp.sqs,
    }),
    logging: {
      defaultRetentionDays: yaml?.logging?.retention_days ?? base.logging.defaultRetentionDays,
      enableXRay: yaml?.logging?.xray ?? base.logging.enableXRay,
    },
    defaults: {
      lambdaMemory: yaml?.defaults?.lambda_memory ?? base.defaults.lambdaMemory,
      lambdaTimeout: yaml?.defaults?.lambda_timeout ?? base.defaults.lambdaTimeout,
      s3Versioning: yaml?.defaults?.s3_versioning ?? base.defaults.s3Versioning,
      dynamoDbBackup: yaml?.defaults?.dynamodb_backup ?? base.defaults.dynamoDbBackup,
    },
  };
}

/**
 * One environment's YAML block: whatever the file already had (real account,
 * vpc, tags) with the builder's settings layered on top.
 */
export function environmentBlock(key: string, config: EnvironmentConfig, extras?: Record<string, unknown>): EnvironmentYaml {
  return {
    account: PLACEHOLDER_ACCOUNT[key] ?? '000000000000',
    region: 'us-east-1',
    ...(extras ?? {}),
    ...environmentToYaml(config),
  };
}

/** The exact `environments:` fragment one environment becomes. */
export function environmentFragment(key: string, config: EnvironmentConfig, extras?: Record<string, unknown>): string {
  return YAML.stringify({ environments: { [key]: environmentBlock(key, config, extras) } });
}

export function generateYAMLFromCanvas(
  nodes: Node[],
  edges: Edge[],
  executionsPerMonth: number = 100000,
  environments: Record<string, EnvironmentConfig> = DEFAULT_ENVIRONMENT_CONFIGS,
  extras: EnvironmentExtras = {},
  projectName?: string,
  scenarios: Scenario[] = [],
  holodeck: HolodeckMeta | null = null,
): string {
  // The project's own name when it has one; otherwise derived from the first
  // agent, which is how untitled canvases have always been named.
  const agentNodes = nodes.filter(node => node.type === 'agent');
  const resolvedName = projectName ||
                       agentNodes[0]?.data?.config?.name ||
                       agentNodes[0]?.data?.label?.toLowerCase().replace(/\s+/g, '-') ||
                       'my-warpcore-project';

  const config: WarpcoreConfig = {
    project: {
      name: resolvedName,
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
    environments: Object.fromEntries(
      Object.entries(environments).map(([key, cfg]) => [key, environmentBlock(key, cfg, extras[key])]),
    ),
    ...(scenarios.length ? { scenarios: scenariosToYaml(scenarios) } : {}),
    ...(holodeck ? { holodeck: holodeckMetaToYaml(holodeck) } : {}),
    canvas: {
      nodes: [],
      edges: [],
    },
  };

  // Process all nodes
  for (const node of nodes) {
    // Save canvas position for all nodes
    config.canvas!.nodes.push(stripUndefined({
      id: node.id,
      type: node.type || 'unknown',
      x: node.position.x,
      y: node.position.y,
      label: node.data?.label || node.type || 'Unknown',
      config: node.data?.config,
      hidden: node.hidden || undefined,
      status: node.data?.status,
      arn: node.data?.arn,
      region: node.data?.region,
      parent: node.parentNode || undefined,
      size: node.style && typeof node.style.width === 'number' && typeof node.style.height === 'number'
        ? { width: node.style.width, height: node.style.height }
        : undefined,
      meta: node.data?.meta && Object.keys(node.data.meta).length ? node.data.meta : undefined,
    }));

    if (node.type === 'agent') {
      config.agents.push({
        name: node.data?.config?.name || node.data?.label?.toLowerCase().replace(/\s+/g, '-') || 'agent',
        path: node.data?.config?.path || `./agents/${node.data?.label?.toLowerCase().replace(/\s+/g, '-') || 'agent'}`,
        runtime: node.data?.config?.runtime || 'python3.11',
        memory: node.data?.config?.memory || 512,
        timeout: node.data?.config?.timeout || 30,
        handler: node.data?.config?.handler || undefined,
        description: node.data?.config?.description || undefined,
        environment: node.data?.config?.environment || {},
      });
    } else if (node.type === 'iam-role') {
      config.roles!.push({
        name: node.data?.config?.roleName || node.data?.label || 'Role',
        description: node.data?.config?.description,
      });
    } else if (!['vpc', 'api-gateway', 'application', 'band', 'enclosure'].includes(node.type || '')) {
      // Add as a resource (skip vpc and api-gateway as they go in shared,
      // and the layout containers, which are canvas-only)
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
      meta: edge.data?.meta,
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

export interface ParsedCanvas {
  nodes: Node[];
  edges: Edge[];
  executionsPerMonth: number;
  /** Builder settings per environment, from the file or the defaults. */
  environmentConfigs: Record<string, EnvironmentConfig>;
  /** Everything else each environment block carried, kept for the round trip. */
  environmentExtras: EnvironmentExtras;
  scenarios: Scenario[];
  /** The Holodeck entry the file was copied from, when it says so. */
  holodeck: HolodeckMeta | null;
}

export function parseYAMLToCanvas(yamlContent: string): ParsedCanvas {
  const config = YAML.parse(yamlContent) as WarpcoreConfig;
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  const executionsPerMonth = config.project.cost_estimation?.executions_per_month ?? 100000;
  const scenarios = scenariosFromYaml(config.scenarios);
  const holodeck = holodeckMetaFromYaml(config.holodeck);

  // Environments: whatever the file declares, else the defaults. A file with
  // only `account`/`region` per environment (older builders, hand-written)
  // gets the builder defaults for that environment's key.
  const declared = config.environments && Object.keys(config.environments).length > 0
    ? config.environments
    : Object.fromEntries(Object.keys(DEFAULT_ENVIRONMENT_CONFIGS).map((k) => [k, undefined]));
  const environmentConfigs: Record<string, EnvironmentConfig> = {};
  const environmentExtras: EnvironmentExtras = {};
  for (const [key, block] of Object.entries(declared)) {
    environmentConfigs[key] = environmentFromYaml(key, block as EnvironmentYaml | undefined);
    if (block) {
      environmentExtras[key] = Object.fromEntries(
        Object.entries(block).filter(([k]) => !BUILDER_ENV_KEYS.has(k)),
      );
    }
  }

  // If we have canvas data, use it directly (preserves positions and IDs)
  if (config.canvas?.nodes && config.canvas.nodes.length > 0) {
    for (const canvasNode of config.canvas.nodes) {
      nodes.push({
        id: canvasNode.id,
        type: canvasNode.type,
        position: { x: canvasNode.x, y: canvasNode.y },
        // Roles are hidden nodes managed from the Roles panel; a file from an
        // older builder has no flag and they were never hidden, so keep that.
        ...(canvasNode.hidden || canvasNode.type === 'iam-role' ? { hidden: true } : {}),
        ...(canvasNode.parent ? { parentNode: canvasNode.parent, extent: 'parent' as const } : {}),
        ...(canvasNode.size ? { style: { width: canvasNode.size.width, height: canvasNode.size.height } } : {}),
        data: stripUndefined({
          label: canvasNode.label,
          config: canvasNode.config,
          status: canvasNode.status || 'configured',
          arn: canvasNode.arn,
          region: canvasNode.region,
          meta: canvasNode.meta,
        }),
      });
    }

    // React Flow requires a group before its children, at every depth.
    nodes.splice(0, nodes.length, ...orderParentsFirst(nodes));
    for (const canvasEdge of config.canvas.edges || []) {
      edges.push({
        id: canvasEdge.id,
        source: canvasEdge.source,
        target: canvasEdge.target,
        sourceHandle: canvasEdge.sourceHandle,
        targetHandle: canvasEdge.targetHandle,
        type: 'permission',
        data: stripUndefined({
          roleId: canvasEdge.roleId,
          isResourceBased: canvasEdge.isResourceBased,
          config: canvasEdge.config,
          meta: canvasEdge.meta,
        }),
      });
    }

    return { nodes, edges, executionsPerMonth, environmentConfigs, environmentExtras, scenarios, holodeck };
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

  return { nodes, edges, executionsPerMonth, environmentConfigs, environmentExtras, scenarios, holodeck };
}
