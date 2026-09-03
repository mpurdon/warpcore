import { useState } from 'react';
import { Bot, Database, Mail, Cloud, Lock, Globe, Zap, Activity, Filter, FileText, Radio, Key, Settings, Workflow, Brain, Package, LayoutDashboard, ChevronDown, ChevronRight, Cpu } from 'lucide-react';
import { useReadOnly, useStore } from '../store/useStore';
import RailFooter from './RailFooter';

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
      { type: 'kinesis', label: 'Kinesis Stream', icon: Radio },
      { type: 'eventbridge', label: 'EventBridge', icon: Zap },
      { type: 'eventbridge-rule', label: 'EventBridge Rule', icon: Filter },
    ],
  },
  {
    name: 'API',
    icon: Globe,
    resources: [
      { type: 'api-gateway', label: 'API Gateway', icon: Globe },
      { type: 'api-route', label: 'API Route', icon: Globe },
    ],
  },
  {
    name: 'Compute',
    icon: Workflow,
    resources: [
      { type: 'lambda', label: 'Lambda Function', icon: Cpu },
      { type: 'step-functions', label: 'Step Functions', icon: Workflow },
      { type: 'bedrock', label: 'Bedrock Model', icon: Brain },
      { type: 'ecr', label: 'ECR Repository', icon: Package },
    ],
  },
  {
    name: 'Security',
    icon: Lock,
    resources: [
      // IAM Roles are managed via the Roles panel (not draggable)
      { type: 'secrets-manager', label: 'Secrets Manager', icon: Key },
      { type: 'ssm-parameter', label: 'SSM Parameter', icon: Settings },
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
      { type: 'cloudwatch-dashboard', label: 'CloudWatch Dashboard', icon: LayoutDashboard },
      { type: 'log-group', label: 'Log Group', icon: FileText },
    ],
  },
];

export default function ResourceLibrary() {
  const { setDraggedItem } = useStore();
  const readOnly = useReadOnly();
  // Initialize with first category (Agents) expanded
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(
    new Set(['Agents'])
  );

  const handleMouseDown = (resourceType: string, label: string) => {
    if (readOnly) return;
    setDraggedItem({ type: resourceType, label });
  };

  const toggleCategory = (categoryName: string) => {
    setExpandedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(categoryName)) {
        next.delete(categoryName);
      } else {
        next.add(categoryName);
      }
      return next;
    });
  };

  const expandAll = () => {
    setExpandedCategories(new Set(resourceCategories.map((c) => c.name)));
  };

  const collapseAll = () => {
    setExpandedCategories(new Set());
  };

  return (
    <div className="w-64 bg-gray-50 border-r border-gray-200 flex flex-col min-h-0">
      <div className="flex-1 overflow-y-auto p-4">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold text-gray-700">Resources</h2>
          <div className="flex gap-1">
            <button
              onClick={expandAll}
              className="text-xs text-gray-500 hover:text-gray-700 px-1"
              title="Expand all"
            >
              +
            </button>
            <button
              onClick={collapseAll}
              className="text-xs text-gray-500 hover:text-gray-700 px-1"
              title="Collapse all"
            >
              −
            </button>
          </div>
        </div>

        <div className="space-y-1">
          {resourceCategories.map((category) => {
            const isExpanded = expandedCategories.has(category.name);
            const ChevronIcon = isExpanded ? ChevronDown : ChevronRight;

            return (
              <div key={category.name} className="border border-gray-200 rounded-lg bg-white overflow-hidden">
                {/* Accordion Header */}
                <button
                  onClick={() => toggleCategory(category.name)}
                  className="w-full flex items-center gap-2 p-2.5 hover:bg-gray-50 transition-colors"
                >
                  <ChevronIcon size={14} className="text-gray-400" />
                  <category.icon size={16} className="text-gray-600" />
                  <span className="text-sm font-medium text-gray-700 flex-1 text-left">
                    {category.name}
                  </span>
                  <span className="text-xs text-gray-400">
                    {category.resources.length}
                  </span>
                </button>

                {/* Accordion Content */}
                {isExpanded && (
                  <div className="border-t border-gray-100 p-2 pt-1 space-y-1">
                    {category.resources.map((resource) => (
                      <div
                        key={resource.label}
                        onMouseDown={() => handleMouseDown(resource.type, resource.label)}
                        title={readOnly ? 'Unlock the project to add resources' : undefined}
                        className={`flex items-center gap-2 p-2 rounded transition-colors select-none ${readOnly ? 'opacity-50 cursor-not-allowed' : 'cursor-grab active:cursor-grabbing hover:bg-blue-50'}`}
                      >
                        <resource.icon size={14} className="text-gray-500" />
                        <span className="text-sm text-gray-700">{resource.label}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
      <RailFooter />
    </div>
  );
}
