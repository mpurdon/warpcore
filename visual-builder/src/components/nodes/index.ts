import AgentNode from './AgentNode';
import ResourceNode from './ResourceNode';
import EventBridgeNode from './EventBridgeNode';

export const nodeTypes = {
  agent: AgentNode,
  's3': ResourceNode,
  'dynamodb': ResourceNode,
  'sqs': ResourceNode,
  'sns': ResourceNode,
  'api-gateway': ResourceNode,
  'iam-role': ResourceNode,
  'security-group': ResourceNode,
  'vpc': ResourceNode,
  'eventbridge': EventBridgeNode,
  'lambda-url': ResourceNode,
  'cloudwatch-alarm': ResourceNode,
};
