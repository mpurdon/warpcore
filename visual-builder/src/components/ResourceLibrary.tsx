import { Bot, Database, Mail, Cloud, Lock, Globe } from 'lucide-react';
import { useStore } from '../store/useStore';

import { Zap, Activity } from 'lucide-react';

const resourceCategories = [
  {
    name: 'Agents',
    icon: Bot,
    resources: [
      { type: 'agent', label: 'Python Agent', icon: Bot },
      { type: 'agent', label: 'Node.js Agent', icon: Bot },
    ],
  },
  {
    name: 'Storage',
    icon: Database,
    resources: [
      { type: 's3', label: 'S3 Bucket', icon: Database },
      { type: 'dynamodb', label: 'DynamoDB Table', icon: Database },
    ],
  },
  {
    name: 'Messaging',
    icon: Mail,
    resources: [
      { type: 'sqs', label: 'SQS Queue', icon: Mail },
      { type: 'sns', label: 'SNS Topic', icon: Mail },
      { type: 'eventbridge', label: 'EventBridge', icon: Zap },
    ],
  },
  {
    name: 'API',
    icon: Globe,
    resources: [
      { type: 'api-gateway', label: 'API Gateway', icon: Globe },
      { type: 'lambda-url', label: 'Lambda URL', icon: Globe },
    ],
  },
  {
    name: 'Security',
    icon: Lock,
    resources: [
      { type: 'iam-role', label: 'IAM Role', icon: Lock },
      { type: 'security-group', label: 'Security Group', icon: Lock },
    ],
  },
  {
    name: 'Network',
    icon: Cloud,
    resources: [
      { type: 'vpc', label: 'VPC', icon: Cloud },
    ],
  },
  {
    name: 'Monitoring',
    icon: Activity,
    resources: [
      { type: 'cloudwatch-alarm', label: 'CloudWatch Alarm', icon: Activity },
    ],
  },
];

export default function ResourceLibrary() {
  const { nodes, setNodes } = useStore();

  const handleDragStart = (event: React.DragEvent, resourceType: string, label: string) => {
    event.dataTransfer.setData('application/reactflow', JSON.stringify({ type: resourceType, label }));
    event.dataTransfer.effectAllowed = 'move';
  };

  const addNode = (resourceType: string, label: string) => {
    const newNode = {
      id: `${resourceType}-${Date.now()}`,
      type: resourceType,
      position: { x: 250, y: 100 + nodes.length * 100 },
      data: { label, status: 'pending' },
    };
    
    setNodes([...nodes, newNode]);
  };

  return (
    <div className="w-64 bg-gray-50 border-r border-gray-200 overflow-y-auto">
      <div className="p-4">
        <h2 className="text-sm font-semibold text-gray-700 mb-4">Resource Library</h2>
        
        {resourceCategories.map((category) => (
          <div key={category.name} className="mb-6">
            <div className="flex items-center gap-2 mb-2">
              <category.icon size={16} className="text-gray-600" />
              <h3 className="text-xs font-medium text-gray-600 uppercase">{category.name}</h3>
            </div>
            
            <div className="space-y-1">
              {category.resources.map((resource) => (
                <div
                  key={resource.label}
                  draggable
                  onDragStart={(e) => handleDragStart(e, resource.type, resource.label)}
                  onClick={() => addNode(resource.type, resource.label)}
                  className="flex items-center gap-2 p-2 bg-white border border-gray-200 rounded cursor-move hover:border-blue-400 hover:bg-blue-50 transition-colors"
                >
                  <resource.icon size={16} className="text-gray-500" />
                  <span className="text-sm text-gray-700">{resource.label}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
