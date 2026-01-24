import { Node, Edge } from 'reactflow';

export interface Template {
  id: string;
  name: string;
  description: string;
  category: 'starter' | 'production' | 'ai-ml' | 'custom';
  nodes: Node[];
  edges: Edge[];
}

export interface TemplateCategory {
  id: string;
  name: string;
  description: string;
}

export const templateCategories: TemplateCategory[] = [
  { id: 'starter', name: 'Starter Templates', description: 'Get started quickly with common patterns' },
  { id: 'production', name: 'Production Ready', description: 'Battle-tested configurations for production' },
  { id: 'ai-ml', name: 'AI/ML Agents', description: 'Templates optimized for AI and ML workloads' },
  { id: 'custom', name: 'My Templates', description: 'Your saved custom templates' },
];

export const builtInTemplates: Template[] = [
  {
    id: 'simple-agent',
    name: 'Simple Agent',
    description: 'Basic agent with API Gateway and IAM role',
    category: 'starter',
    nodes: [
      {
        id: 'agent-1',
        type: 'agent',
        position: { x: 250, y: 100 },
        data: {
          label: 'My Agent',
          runtime: 'python3.11',
          memory: 512,
          timeout: 30,
          status: 'draft',
        },
      },
      {
        id: 'iam-role-1',
        type: 'iam-role',
        position: { x: 500, y: 50 },
        data: {
          label: 'Execution Role',
          status: 'draft',
        },
      },
      {
        id: 'api-gateway-1',
        type: 'api-gateway',
        position: { x: 500, y: 150 },
        data: {
          label: 'API Gateway',
          status: 'draft',
        },
      },
    ],
    edges: [
      {
        id: 'agent-1-iam-role-1',
        source: 'agent-1',
        target: 'iam-role-1',
        type: 'permission',
        data: { permissions: ['sts:AssumeRole'] },
      },
      {
        id: 'agent-1-api-gateway-1',
        source: 'agent-1',
        target: 'api-gateway-1',
        type: 'permission',
        data: { permissions: [] },
      },
    ],
  },
  {
    id: 'event-driven-agent',
    name: 'Event-Driven Agent',
    description: 'Agent triggered by SQS queue with DynamoDB storage',
    category: 'starter',
    nodes: [
      {
        id: 'agent-1',
        type: 'agent',
        position: { x: 400, y: 200 },
        data: {
          label: 'Event Processor',
          runtime: 'python3.11',
          memory: 1024,
          timeout: 60,
          status: 'draft',
        },
      },
      {
        id: 'sqs-1',
        type: 'sqs',
        position: { x: 100, y: 200 },
        data: {
          label: 'Event Queue',
          status: 'draft',
        },
      },
      {
        id: 'dynamodb-1',
        type: 'dynamodb',
        position: { x: 700, y: 200 },
        data: {
          label: 'Data Store',
          status: 'draft',
        },
      },
      {
        id: 'iam-role-1',
        type: 'iam-role',
        position: { x: 400, y: 50 },
        data: {
          label: 'Execution Role',
          status: 'draft',
        },
      },
    ],
    edges: [
      {
        id: 'sqs-1-agent-1',
        source: 'sqs-1',
        target: 'agent-1',
        type: 'permission',
        data: { permissions: ['sqs:ReceiveMessage', 'sqs:DeleteMessage'] },
      },
      {
        id: 'agent-1-dynamodb-1',
        source: 'agent-1',
        target: 'dynamodb-1',
        type: 'permission',
        data: { permissions: ['dynamodb:PutItem', 'dynamodb:GetItem', 'dynamodb:Query'] },
      },
      {
        id: 'agent-1-iam-role-1',
        source: 'agent-1',
        target: 'iam-role-1',
        type: 'permission',
        data: { permissions: ['sts:AssumeRole'] },
      },
    ],
  },
  {
    id: 'production-setup',
    name: 'Production Setup',
    description: 'Production-ready setup with VPC, monitoring, and multiple agents',
    category: 'production',
    nodes: [
      {
        id: 'vpc-1',
        type: 'vpc',
        position: { x: 100, y: 50 },
        data: {
          label: 'VPC',
          status: 'draft',
        },
      },
      {
        id: 'security-group-1',
        type: 'security-group',
        position: { x: 100, y: 150 },
        data: {
          label: 'Security Group',
          status: 'draft',
        },
      },
      {
        id: 'agent-1',
        type: 'agent',
        position: { x: 400, y: 100 },
        data: {
          label: 'API Agent',
          runtime: 'python3.11',
          memory: 1024,
          timeout: 30,
          status: 'draft',
        },
      },
      {
        id: 'agent-2',
        type: 'agent',
        position: { x: 400, y: 250 },
        data: {
          label: 'Worker Agent',
          runtime: 'python3.11',
          memory: 2048,
          timeout: 300,
          status: 'draft',
        },
      },
      {
        id: 'api-gateway-1',
        type: 'api-gateway',
        position: { x: 700, y: 100 },
        data: {
          label: 'API Gateway',
          status: 'draft',
        },
      },
      {
        id: 'dynamodb-1',
        type: 'dynamodb',
        position: { x: 700, y: 250 },
        data: {
          label: 'Database',
          status: 'draft',
        },
      },
      {
        id: 'cloudwatch-alarm-1',
        type: 'cloudwatch-alarm',
        position: { x: 700, y: 400 },
        data: {
          label: 'Error Alarm',
          status: 'draft',
        },
      },
      {
        id: 'iam-role-1',
        type: 'iam-role',
        position: { x: 400, y: 400 },
        data: {
          label: 'Shared Execution Role',
          status: 'draft',
        },
      },
    ],
    edges: [
      {
        id: 'agent-1-api-gateway-1',
        source: 'agent-1',
        target: 'api-gateway-1',
        type: 'permission',
        data: { permissions: [] },
      },
      {
        id: 'agent-1-dynamodb-1',
        source: 'agent-1',
        target: 'dynamodb-1',
        type: 'permission',
        data: { permissions: ['dynamodb:GetItem', 'dynamodb:Query'] },
      },
      {
        id: 'agent-2-dynamodb-1',
        source: 'agent-2',
        target: 'dynamodb-1',
        type: 'permission',
        data: { permissions: ['dynamodb:PutItem', 'dynamodb:UpdateItem'] },
      },
      {
        id: 'agent-1-iam-role-1',
        source: 'agent-1',
        target: 'iam-role-1',
        type: 'permission',
        data: { permissions: ['sts:AssumeRole'] },
      },
      {
        id: 'agent-2-iam-role-1',
        source: 'agent-2',
        target: 'iam-role-1',
        type: 'permission',
        data: { permissions: ['sts:AssumeRole'] },
      },
    ],
  },
  // AI/ML Agent template
  {
    id: 'bedrock-agent',
    name: 'Bedrock AI Agent',
    description: 'AI agent with Bedrock integration and conversation history',
    category: 'ai-ml' as const,
    nodes: [
      {
        id: 'agent-1',
        type: 'agent',
        position: { x: 400, y: 200 },
        data: {
          label: 'AI Agent',
          runtime: 'python3.11',
          memory: 2048,
          timeout: 120,
          status: 'draft',
        },
      },
      {
        id: 'api-gateway-1',
        type: 'api-gateway',
        position: { x: 100, y: 200 },
        data: {
          label: 'Chat API',
          status: 'draft',
        },
      },
      {
        id: 'bedrock-1',
        type: 'bedrock',
        position: { x: 700, y: 100 },
        data: {
          label: 'Claude Model',
          status: 'draft',
          config: {
            modelId: 'anthropic.claude-3-sonnet-20240229-v1:0',
          },
        },
      },
      {
        id: 'dynamodb-1',
        type: 'dynamodb',
        position: { x: 700, y: 300 },
        data: {
          label: 'Conversation History',
          status: 'draft',
        },
      },
      {
        id: 'iam-role-1',
        type: 'iam-role',
        position: { x: 400, y: 50 },
        data: {
          label: 'Agent Role',
          status: 'draft',
        },
      },
    ],
    edges: [
      {
        id: 'api-agent',
        source: 'api-gateway-1',
        target: 'agent-1',
        type: 'permission',
        data: { isResourceBased: true },
      },
      {
        id: 'agent-bedrock',
        source: 'agent-1',
        target: 'bedrock-1',
        type: 'permission',
        data: { permissions: ['bedrock:InvokeModel'] },
      },
      {
        id: 'agent-dynamo',
        source: 'agent-1',
        target: 'dynamodb-1',
        type: 'permission',
        data: { permissions: ['dynamodb:PutItem', 'dynamodb:Query'] },
      },
      {
        id: 'agent-role',
        source: 'agent-1',
        target: 'iam-role-1',
        type: 'permission',
        data: { permissions: ['sts:AssumeRole'] },
      },
    ],
  },
  // RAG Agent template
  {
    id: 'rag-agent',
    name: 'RAG Agent',
    description: 'Retrieval-Augmented Generation agent with S3 document storage',
    category: 'ai-ml' as const,
    nodes: [
      {
        id: 'agent-1',
        type: 'agent',
        position: { x: 400, y: 200 },
        data: {
          label: 'RAG Agent',
          runtime: 'python3.11',
          memory: 3008,
          timeout: 180,
          status: 'draft',
        },
      },
      {
        id: 'api-gateway-1',
        type: 'api-gateway',
        position: { x: 100, y: 200 },
        data: {
          label: 'Query API',
          status: 'draft',
        },
      },
      {
        id: 's3-1',
        type: 's3',
        position: { x: 700, y: 50 },
        data: {
          label: 'Document Store',
          status: 'draft',
        },
      },
      {
        id: 'bedrock-1',
        type: 'bedrock',
        position: { x: 700, y: 200 },
        data: {
          label: 'Embeddings',
          status: 'draft',
          config: {
            modelId: 'amazon.titan-embed-text-v1',
          },
        },
      },
      {
        id: 'bedrock-2',
        type: 'bedrock',
        position: { x: 700, y: 350 },
        data: {
          label: 'LLM',
          status: 'draft',
          config: {
            modelId: 'anthropic.claude-3-sonnet-20240229-v1:0',
          },
        },
      },
      {
        id: 'iam-role-1',
        type: 'iam-role',
        position: { x: 400, y: 50 },
        data: {
          label: 'Agent Role',
          status: 'draft',
        },
      },
    ],
    edges: [
      {
        id: 'api-agent',
        source: 'api-gateway-1',
        target: 'agent-1',
        type: 'permission',
        data: { isResourceBased: true },
      },
      {
        id: 'agent-s3',
        source: 'agent-1',
        target: 's3-1',
        type: 'permission',
        data: { permissions: ['s3:GetObject', 's3:ListBucket'] },
      },
      {
        id: 'agent-embed',
        source: 'agent-1',
        target: 'bedrock-1',
        type: 'permission',
        data: { permissions: ['bedrock:InvokeModel'] },
      },
      {
        id: 'agent-llm',
        source: 'agent-1',
        target: 'bedrock-2',
        type: 'permission',
        data: { permissions: ['bedrock:InvokeModel'] },
      },
      {
        id: 'agent-role',
        source: 'agent-1',
        target: 'iam-role-1',
        type: 'permission',
        data: { permissions: ['sts:AssumeRole'] },
      },
    ],
  },
  // Multi-agent workflow
  {
    id: 'multi-agent',
    name: 'Multi-Agent Workflow',
    description: 'Orchestrator with specialized sub-agents using Step Functions',
    category: 'ai-ml' as const,
    nodes: [
      {
        id: 'agent-orchestrator',
        type: 'agent',
        position: { x: 400, y: 50 },
        data: {
          label: 'Orchestrator',
          runtime: 'python3.11',
          memory: 1024,
          timeout: 30,
          status: 'draft',
        },
      },
      {
        id: 'step-functions-1',
        type: 'step-functions',
        position: { x: 400, y: 200 },
        data: {
          label: 'Workflow',
          status: 'draft',
        },
      },
      {
        id: 'agent-research',
        type: 'agent',
        position: { x: 150, y: 350 },
        data: {
          label: 'Research Agent',
          runtime: 'python3.11',
          memory: 2048,
          timeout: 120,
          status: 'draft',
        },
      },
      {
        id: 'agent-writer',
        type: 'agent',
        position: { x: 400, y: 350 },
        data: {
          label: 'Writer Agent',
          runtime: 'python3.11',
          memory: 2048,
          timeout: 120,
          status: 'draft',
        },
      },
      {
        id: 'agent-reviewer',
        type: 'agent',
        position: { x: 650, y: 350 },
        data: {
          label: 'Reviewer Agent',
          runtime: 'python3.11',
          memory: 1024,
          timeout: 60,
          status: 'draft',
        },
      },
      {
        id: 'api-gateway-1',
        type: 'api-gateway',
        position: { x: 100, y: 50 },
        data: {
          label: 'API',
          status: 'draft',
        },
      },
      {
        id: 's3-1',
        type: 's3',
        position: { x: 700, y: 50 },
        data: {
          label: 'Output Store',
          status: 'draft',
        },
      },
    ],
    edges: [
      {
        id: 'api-orch',
        source: 'api-gateway-1',
        target: 'agent-orchestrator',
        type: 'permission',
        data: { isResourceBased: true },
      },
      {
        id: 'orch-sf',
        source: 'agent-orchestrator',
        target: 'step-functions-1',
        type: 'permission',
        data: { permissions: ['states:StartExecution'] },
      },
      {
        id: 'sf-research',
        source: 'step-functions-1',
        target: 'agent-research',
        type: 'permission',
        data: { permissions: ['lambda:InvokeFunction'] },
      },
      {
        id: 'sf-writer',
        source: 'step-functions-1',
        target: 'agent-writer',
        type: 'permission',
        data: { permissions: ['lambda:InvokeFunction'] },
      },
      {
        id: 'sf-reviewer',
        source: 'step-functions-1',
        target: 'agent-reviewer',
        type: 'permission',
        data: { permissions: ['lambda:InvokeFunction'] },
      },
      {
        id: 'orch-s3',
        source: 'agent-orchestrator',
        target: 's3-1',
        type: 'permission',
        data: { permissions: ['s3:PutObject'] },
      },
    ],
  },
  // Async processing pipeline
  {
    id: 'async-pipeline',
    name: 'Async Processing Pipeline',
    description: 'Event-driven pipeline with SNS fan-out and SQS queues',
    category: 'production',
    nodes: [
      {
        id: 'api-gateway-1',
        type: 'api-gateway',
        position: { x: 100, y: 200 },
        data: {
          label: 'Ingest API',
          status: 'draft',
        },
      },
      {
        id: 'agent-ingest',
        type: 'agent',
        position: { x: 300, y: 200 },
        data: {
          label: 'Ingestion',
          runtime: 'python3.11',
          memory: 512,
          timeout: 30,
          status: 'draft',
        },
      },
      {
        id: 'sns-1',
        type: 'sns',
        position: { x: 500, y: 200 },
        data: {
          label: 'Event Topic',
          status: 'draft',
        },
      },
      {
        id: 'sqs-1',
        type: 'sqs',
        position: { x: 700, y: 100 },
        data: {
          label: 'Process Queue',
          status: 'draft',
        },
      },
      {
        id: 'sqs-2',
        type: 'sqs',
        position: { x: 700, y: 300 },
        data: {
          label: 'Analytics Queue',
          status: 'draft',
        },
      },
      {
        id: 'agent-process',
        type: 'agent',
        position: { x: 900, y: 100 },
        data: {
          label: 'Processor',
          runtime: 'python3.11',
          memory: 1024,
          timeout: 60,
          status: 'draft',
        },
      },
      {
        id: 'agent-analytics',
        type: 'agent',
        position: { x: 900, y: 300 },
        data: {
          label: 'Analytics',
          runtime: 'python3.11',
          memory: 512,
          timeout: 30,
          status: 'draft',
        },
      },
    ],
    edges: [
      {
        id: 'api-ingest',
        source: 'api-gateway-1',
        target: 'agent-ingest',
        type: 'permission',
        data: { isResourceBased: true },
      },
      {
        id: 'ingest-sns',
        source: 'agent-ingest',
        target: 'sns-1',
        type: 'permission',
        data: { permissions: ['sns:Publish'] },
      },
      {
        id: 'sns-sqs1',
        source: 'sns-1',
        target: 'sqs-1',
        type: 'permission',
        data: { isResourceBased: true },
      },
      {
        id: 'sns-sqs2',
        source: 'sns-1',
        target: 'sqs-2',
        type: 'permission',
        data: { isResourceBased: true },
      },
      {
        id: 'sqs1-process',
        source: 'sqs-1',
        target: 'agent-process',
        type: 'permission',
        data: { isResourceBased: true },
      },
      {
        id: 'sqs2-analytics',
        source: 'sqs-2',
        target: 'agent-analytics',
        type: 'permission',
        data: { isResourceBased: true },
      },
    ],
  },
];

export function saveCustomTemplate(name: string, description: string, nodes: Node[], edges: Edge[]): Template {
  const template: Template = {
    id: `custom-${Date.now()}`,
    name,
    description,
    category: 'custom',
    nodes: nodes.map(node => ({
      ...node,
      data: { ...node.data, status: 'draft' },
    })),
    edges,
  };

  // In a real app, save to local storage or backend
  const customTemplates = JSON.parse(localStorage.getItem('customTemplates') || '[]');
  customTemplates.push(template);
  localStorage.setItem('customTemplates', JSON.stringify(customTemplates));

  return template;
}

export function loadCustomTemplates(): Template[] {
  try {
    return JSON.parse(localStorage.getItem('customTemplates') || '[]');
  } catch {
    return [];
  }
}

export function deleteCustomTemplate(templateId: string): void {
  const customTemplates = loadCustomTemplates();
  const filtered = customTemplates.filter(t => t.id !== templateId);
  localStorage.setItem('customTemplates', JSON.stringify(filtered));
}

export function exportTemplate(template: Template): string {
  return JSON.stringify(template, null, 2);
}

export function importTemplate(jsonString: string): Template | null {
  try {
    const template = JSON.parse(jsonString);
    // Validate required fields
    if (!template.name || !template.nodes || !template.edges) {
      return null;
    }
    // Assign new ID and mark as custom
    return {
      ...template,
      id: `imported-${Date.now()}`,
      category: 'custom' as const,
    };
  } catch {
    return null;
  }
}

export function getAllTemplates(): Template[] {
  return [...builtInTemplates, ...loadCustomTemplates()];
}

export function getTemplatesByCategory(category: string): Template[] {
  return getAllTemplates().filter(t => t.category === category);
}

export function applyTemplate(template: Template): { nodes: Node[]; edges: Edge[] } {
  // Generate new IDs to avoid conflicts
  const idMap = new Map<string, string>();
  const timestamp = Date.now();

  const nodes = template.nodes.map((node, index) => {
    const newId = `${node.type}-${timestamp}-${index}`;
    idMap.set(node.id, newId);
    return {
      ...node,
      id: newId,
      data: { ...node.data, status: 'draft' },
    };
  });

  const edges = template.edges.map((edge, index) => ({
    ...edge,
    id: `edge-${timestamp}-${index}`,
    source: idMap.get(edge.source) || edge.source,
    target: idMap.get(edge.target) || edge.target,
  }));

  return { nodes, edges };
}
