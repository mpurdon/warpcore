import { Node, Edge } from 'reactflow';

export interface Template {
  id: string;
  name: string;
  description: string;
  category: 'starter' | 'production' | 'custom';
  nodes: Node[];
  edges: Edge[];
}

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
          status: 'pending',
        },
      },
      {
        id: 'iam-role-1',
        type: 'iam-role',
        position: { x: 500, y: 50 },
        data: {
          label: 'Execution Role',
          status: 'pending',
        },
      },
      {
        id: 'api-gateway-1',
        type: 'api-gateway',
        position: { x: 500, y: 150 },
        data: {
          label: 'API Gateway',
          status: 'pending',
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
          status: 'pending',
        },
      },
      {
        id: 'sqs-1',
        type: 'sqs',
        position: { x: 100, y: 200 },
        data: {
          label: 'Event Queue',
          status: 'pending',
        },
      },
      {
        id: 'dynamodb-1',
        type: 'dynamodb',
        position: { x: 700, y: 200 },
        data: {
          label: 'Data Store',
          status: 'pending',
        },
      },
      {
        id: 'iam-role-1',
        type: 'iam-role',
        position: { x: 400, y: 50 },
        data: {
          label: 'Execution Role',
          status: 'pending',
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
          status: 'pending',
        },
      },
      {
        id: 'security-group-1',
        type: 'security-group',
        position: { x: 100, y: 150 },
        data: {
          label: 'Security Group',
          status: 'pending',
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
          status: 'pending',
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
          status: 'pending',
        },
      },
      {
        id: 'api-gateway-1',
        type: 'api-gateway',
        position: { x: 700, y: 100 },
        data: {
          label: 'API Gateway',
          status: 'pending',
        },
      },
      {
        id: 'dynamodb-1',
        type: 'dynamodb',
        position: { x: 700, y: 250 },
        data: {
          label: 'Database',
          status: 'pending',
        },
      },
      {
        id: 'cloudwatch-alarm-1',
        type: 'cloudwatch-alarm',
        position: { x: 700, y: 400 },
        data: {
          label: 'Error Alarm',
          status: 'pending',
        },
      },
      {
        id: 'iam-role-1',
        type: 'iam-role',
        position: { x: 400, y: 400 },
        data: {
          label: 'Shared Execution Role',
          status: 'pending',
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
];

export function saveCustomTemplate(name: string, description: string, nodes: Node[], edges: Edge[]): Template {
  const template: Template = {
    id: `custom-${Date.now()}`,
    name,
    description,
    category: 'custom',
    nodes: nodes.map(node => ({
      ...node,
      data: { ...node.data, status: 'pending' },
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
