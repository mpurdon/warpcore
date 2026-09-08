// The config field that names a node of each type. The canvas label, the
// inspector header and the security-group badges all ask this one table.

import { Node } from 'reactflow';

export const NAME_FIELDS: Record<string, string> = {
  s3: 'bucketName',
  dynamodb: 'tableName',
  sqs: 'queueName',
  sns: 'topicName',
  'api-gateway': 'apiName',
  'api-route': 'path',
  'iam-role': 'roleName',
  'security-group': 'groupName',
  vpc: 'name',
  'kinesis-stream': 'streamName',
  'kinesis-firehose': 'deliveryStreamName',
  'secrets-manager': 'secretName',
  'ssm-parameter': 'parameterName',
  'step-functions': 'stateMachineName',
  bedrock: 'modelId',
  'cloudwatch-alarm': 'alarmName',
  ecr: 'repositoryName',
  'cloudwatch-dashboard': 'dashboardName',
  eventbridge: 'busName',
  'eventbridge-rule': 'ruleName',
  'eventbridge-pipes': 'pipeName',
  'log-group': 'logGroupPath',
  lambda: 'functionName',
};

export function nameFieldFor(type: string | undefined): string {
  return NAME_FIELDS[type || ''] || 'name';
}

/** The name a node shows: its type's name field, else its label, else its id. */
export function displayNameFor(node: Pick<Node, 'id' | 'type' | 'data'>): string {
  const config = (node.data?.config || {}) as Record<string, unknown>;
  const named = config[nameFieldFor(node.type)];
  return (typeof named === 'string' && named) || node.data?.label || node.id;
}

/** A display name for any node id, falling back to the id itself for one not on the canvas. */
export function displayNameById(nodes: Pick<Node, 'id' | 'type' | 'data'>[]): (id: string) => string {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return (id) => { const n = byId.get(id); return n ? displayNameFor(n) : id; };
}

const OPEN_TO_WORLD = /0\.0\.0\.0\/0|::\/0/;

/** True for an inbound rule that admits the whole internet. */
export function isOpenToWorld(rule: string): boolean {
  return OPEN_TO_WORLD.test(rule);
}
