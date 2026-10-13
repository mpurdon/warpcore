import { Bot, Database, Mail, Globe, Lock, Cloud, Key, Settings, Workflow, Brain, Radio, Activity, Package, LayoutDashboard, FileText, Zap, Filter, Shield, Cpu, Flame, GitBranch } from 'lucide-react';

// Resource metadata for display
export interface ResourceInfo {
  type: string;
  label: string;
  icon: any;
  color: string;
}

export interface CategoryInfo {
  name: string;
  icon: any;
  color: string;
  resources: ResourceInfo[];
}

// All resources organized by category
export const resourceCategories: CategoryInfo[] = [
  {
    name: 'Agents',
    icon: Bot,
    color: 'var(--c-blue-500)', // blue
    resources: [
      { type: 'agent', label: 'Lambda Agent', icon: Bot, color: 'var(--c-blue-500)' },
    ],
  },
  {
    name: 'Storage',
    icon: Database,
    color: 'var(--c-orange-500)', // orange
    resources: [
      { type: 's3', label: 'S3 Bucket', icon: Database, color: 'var(--c-orange-500)' },
      { type: 'dynamodb', label: 'DynamoDB', icon: Database, color: 'var(--c-blue-500)' },
    ],
  },
  {
    name: 'Messaging',
    icon: Mail,
    color: 'var(--c-violet-500)', // purple
    resources: [
      { type: 'sqs', label: 'SQS Queue', icon: Mail, color: 'var(--c-violet-500)' },
      { type: 'sns', label: 'SNS Topic', icon: Mail, color: 'var(--c-pink-500)' },
      { type: 'kinesis-stream', label: 'Kinesis Stream', icon: Radio, color: 'var(--c-orange-500)' },
      { type: 'kinesis-firehose', label: 'Firehose', icon: Flame, color: 'var(--c-red-500)' },
      { type: 'eventbridge', label: 'EventBridge', icon: Zap, color: 'var(--c-orange-500)' },
      { type: 'eventbridge-rule', label: 'EB Rule', icon: Filter, color: 'var(--c-violet-500)' },
      { type: 'eventbridge-pipes', label: 'EB Pipes', icon: GitBranch, color: 'var(--c-orange-500)' },
    ],
  },
  {
    name: 'API',
    icon: Globe,
    color: 'var(--c-green-500)', // green
    resources: [
      { type: 'api-gateway', label: 'API Gateway', icon: Globe, color: 'var(--c-green-500)' },
      { type: 'api-route', label: 'API Route', icon: Globe, color: 'var(--c-green-500)' },
    ],
  },
  {
    name: 'Compute',
    icon: Workflow,
    color: 'var(--c-pink-500)', // pink
    resources: [
      { type: 'lambda', label: 'Lambda', icon: Cpu, color: 'var(--c-orange-500)' },
      { type: 'step-functions', label: 'Step Functions', icon: Workflow, color: 'var(--c-pink-500)' },
      { type: 'bedrock', label: 'Bedrock', icon: Brain, color: 'var(--c-violet-500)' },
      { type: 'ecr', label: 'ECR', icon: Package, color: 'var(--c-orange-500)' },
    ],
  },
  {
    name: 'Security',
    icon: Lock,
    color: 'var(--c-yellow-500)', // yellow
    resources: [
      { type: 'iam-role', label: 'IAM Role', icon: Shield, color: 'var(--c-yellow-500)' },
      { type: 'secrets-manager', label: 'Secrets', icon: Key, color: 'var(--c-red-500)' },
      { type: 'ssm-parameter', label: 'SSM Param', icon: Settings, color: 'var(--c-gray-500)' },
      { type: 'security-group', label: 'Sec Group', icon: Lock, color: 'var(--c-red-500)' },
    ],
  },
  {
    name: 'Network',
    icon: Cloud,
    color: 'var(--c-indigo-500)', // indigo
    resources: [
      { type: 'vpc', label: 'VPC', icon: Cloud, color: 'var(--c-indigo-500)' },
    ],
  },
  {
    name: 'Monitoring',
    icon: Activity,
    color: 'var(--c-amber-500)', // amber
    resources: [
      { type: 'cloudwatch-alarm', label: 'CW Alarm', icon: Activity, color: 'var(--c-amber-500)' },
      { type: 'cloudwatch-dashboard', label: 'Dashboard', icon: LayoutDashboard, color: 'var(--c-blue-500)' },
      { type: 'log-group', label: 'Log Group', icon: FileText, color: 'var(--c-emerald-500)' },
    ],
  },
];

// Connection rules: what each resource type can connect TO
// priority = common targets shown in main ring
// extended = less common targets shown in "More..." submenu
export const connectionRules: Record<string, {
  priority: string[];
  extended: string[];
}> = {
  // Agents (Strands agents) can connect to many resources (write/invoke)
  'agent': {
    priority: ['s3', 'dynamodb', 'sqs', 'sns', 'bedrock', 'lambda'],
    extended: ['kinesis-stream', 'kinesis-firehose', 'eventbridge', 'secrets-manager', 'ssm-parameter', 'step-functions', 'log-group', 'cloudwatch-alarm', 'ecr', 'vpc'],
  },

  // Lambda functions can connect to many resources (similar to agents)
  'lambda': {
    priority: ['s3', 'dynamodb', 'sqs', 'sns', 'bedrock', 'lambda'],
    extended: ['kinesis-stream', 'kinesis-firehose', 'eventbridge', 'secrets-manager', 'ssm-parameter', 'step-functions', 'log-group', 'cloudwatch-alarm', 'ecr', 'vpc'],
  },

  // Kinesis Data Streams - can trigger Lambda or write to S3/Firehose
  'kinesis-stream': {
    priority: ['lambda', 'agent', 'kinesis-firehose'],
    extended: ['s3', 'dynamodb'],
  },

  // Kinesis Firehose - delivers to S3, Redshift, or other destinations
  'kinesis-firehose': {
    priority: ['s3'],
    extended: ['lambda'], // Lambda for transformation
  },

  // EventBridge Pipes - connects sources to targets with optional transformation
  'eventbridge-pipes': {
    priority: ['lambda', 'agent', 'step-functions', 'sqs', 'sns'],
    extended: ['kinesis-stream', 'kinesis-firehose', 'eventbridge'],
  },

  // SQS can trigger Lambda
  'sqs': { priority: ['lambda', 'agent'], extended: [] },

  // DynamoDB Streams can trigger Lambda or feed into Kinesis/Pipes
  'dynamodb': {
    priority: ['lambda', 'agent', 'kinesis-stream'],
    extended: ['eventbridge-pipes', 'kinesis-firehose', 's3'],
  },

  // S3 events can trigger Lambda or send to SQS/SNS
  's3': {
    priority: ['lambda', 'agent', 'sqs', 'sns'],
    extended: ['eventbridge', 'kinesis-stream', 'kinesis-firehose', 's3'],
  },

  // SNS can fan out to multiple targets including Lambda
  'sns': { priority: ['lambda', 'agent', 'sqs'], extended: ['kinesis-firehose'] },

  // API Gateway routes to Lambda/agents
  'api-gateway': { priority: ['lambda', 'agent', 'api-route'], extended: [] },
  'api-route': { priority: ['lambda', 'agent'], extended: [] },

  // EventBridge hierarchy - rules can trigger Lambda
  'eventbridge': { priority: ['eventbridge-rule', 'eventbridge-pipes'], extended: [] },
  'eventbridge-rule': {
    priority: ['lambda', 'agent', 'step-functions', 'sqs'],
    extended: ['sns', 'kinesis-stream', 'kinesis-firehose', 'log-group', 'api-gateway', 'eventbridge'],
  },

  // Step Functions can invoke Lambda and agents
  'step-functions': { priority: ['lambda', 'agent'], extended: ['sns', 'sqs', 'dynamodb', 's3'] },

  // IAM Role is assigned, not connected
  'iam-role': { priority: [], extended: [] },

  // These are typically targets, not sources
  'secrets-manager': { priority: [], extended: [] },
  'ssm-parameter': { priority: [], extended: [] },
  'security-group': { priority: [], extended: [] },
  'vpc': { priority: [], extended: [] },
  'bedrock': { priority: [], extended: [] },
  'ecr': { priority: [], extended: [] },
  'cloudwatch-alarm': { priority: ['lambda'], extended: ['sns'] },
  'cloudwatch-dashboard': { priority: [], extended: [] },
  'log-group': { priority: [], extended: [] },
};

// Get all valid targets for a source type
export function getValidTargets(sourceType: string): { priority: string[], extended: string[] } {
  return connectionRules[sourceType] || { priority: [], extended: [] };
}

// Get all valid target types as a flat array
export function getAllValidTargets(sourceType: string): string[] {
  const rules = getValidTargets(sourceType);
  return [...rules.priority, ...rules.extended];
}

// Check if a connection is valid
export function isValidConnection(sourceType: string, targetType: string): boolean {
  const validTargets = getAllValidTargets(sourceType);
  return validTargets.includes(targetType);
}

// Get resource info by type
export function getResourceInfo(type: string): ResourceInfo | undefined {
  for (const category of resourceCategories) {
    const resource = category.resources.find(r => r.type === type);
    if (resource) return resource;
  }
  return undefined;
}

// Get category by resource type
export function getCategoryByResourceType(type: string): CategoryInfo | undefined {
  return resourceCategories.find(cat =>
    cat.resources.some(r => r.type === type)
  );
}

// Get categories that have valid targets for a source type
export function getValidCategories(sourceType: string): CategoryInfo[] {
  const validTargets = getAllValidTargets(sourceType);
  if (validTargets.length === 0) return [];

  return resourceCategories
    .map(category => ({
      ...category,
      resources: category.resources.filter(r => validTargets.includes(r.type)),
    }))
    .filter(category => category.resources.length > 0);
}

// Get priority categories (categories with priority targets)
export function getPriorityCategories(sourceType: string): CategoryInfo[] {
  const rules = getValidTargets(sourceType);
  if (rules.priority.length === 0) return [];

  return resourceCategories
    .map(category => ({
      ...category,
      resources: category.resources.filter(r => rules.priority.includes(r.type)),
    }))
    .filter(category => category.resources.length > 0);
}

// Get extended categories (categories with extended targets only)
export function getExtendedCategories(sourceType: string): CategoryInfo[] {
  const rules = getValidTargets(sourceType);
  if (rules.extended.length === 0) return [];

  return resourceCategories
    .map(category => ({
      ...category,
      resources: category.resources.filter(r => rules.extended.includes(r.type)),
    }))
    .filter(category => category.resources.length > 0);
}

// Check if source has extended targets (for "More..." button)
export function hasExtendedTargets(sourceType: string): boolean {
  const rules = getValidTargets(sourceType);
  return rules.extended.length > 0;
}
