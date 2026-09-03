import AgentNode from './AgentNode';
import ResourceNode from './ResourceNode';
import EventBridgeNode from './EventBridgeNode';
import EventBridgeRuleNode from './EventBridgeRuleNode';
import LogGroupNode from './LogGroupNode';
import ContainerNode from './ContainerNode';
import { DISCOVERED_TYPES } from '../../utils/discoveredTypes';

// Note: IAM roles are managed via the RolesPanel only (no canvas nodes)
// Role data is stored as hidden nodes for policy computation

export const nodeTypes = {
  agent: AgentNode,
  's3': ResourceNode,
  'dynamodb': ResourceNode,
  'sqs': ResourceNode,
  'sns': ResourceNode,
  'api-gateway': ResourceNode,
  'api-route': ResourceNode,
  // 'iam-role' removed - roles are managed via panel only
  'security-group': ResourceNode,
  // VPCs and subnets contain things; the vault and keyring are containers only.
  'vpc': ContainerNode,
  'eventbridge': EventBridgeNode,
  'eventbridge-rule': EventBridgeRuleNode,
  'eventbridge-pipes': ResourceNode,
  'cloudwatch-alarm': ResourceNode,
  'cloudwatch-dashboard': ResourceNode,
  'log-group': LogGroupNode,
  'kinesis-stream': ResourceNode,
  'kinesis-firehose': ResourceNode,
  'secrets-manager': ResourceNode,
  'ssm-parameter': ResourceNode,
  'step-functions': ResourceNode,
  'bedrock': ResourceNode,
  'ecr': ResourceNode,
  'lambda': ResourceNode,
  // Types that only appear when a project is made from an account.
  ...Object.fromEntries(Object.keys(DISCOVERED_TYPES).map((t) => [t, ResourceNode])),
  'subnet': ContainerNode,
  'enclosure': ContainerNode,
};
