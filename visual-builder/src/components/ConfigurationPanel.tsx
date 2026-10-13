import { useEffect, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { X, Link, Unlink, Trash2, ChevronDown, ChevronRight, Copy, Check, AlertTriangle, Mail } from 'lucide-react';
import { runFromUi } from '../commands';
import { useStore } from '../store/useStore';
import { Node } from 'reactflow';
import { computeRolePolicy, generateIAMPolicyJSON } from '../utils/rolePolicy';
import { calculateChildPosition, computeNodeGroups, getExistingChildIds, snapToGrid } from '../utils/nodeGrouping';

// Helper to get nested value from object by dot-notation path
function getNestedValue(obj: any, path: string): any {
  return path.split('.').reduce((current, key) => current?.[key], obj);
}

// Schedule Builder for EventBridge rules
function ScheduleBuilder({
  value,
  onChange,
}: {
  value: { type: 'rate' | 'cron'; expression: string } | undefined;
  onChange: (value: { type: 'rate' | 'cron'; expression: string }) => void;
}) {
  const schedule = value || { type: 'rate', expression: '' };

  const ratePresets = [
    { label: '1 minute', value: 'rate(1 minute)' },
    { label: '5 minutes', value: 'rate(5 minutes)' },
    { label: '15 minutes', value: 'rate(15 minutes)' },
    { label: '1 hour', value: 'rate(1 hour)' },
    { label: '6 hours', value: 'rate(6 hours)' },
    { label: '12 hours', value: 'rate(12 hours)' },
    { label: '1 day', value: 'rate(1 day)' },
    { label: '7 days', value: 'rate(7 days)' },
  ];

  const cronPresets = [
    { label: 'Every minute', value: 'cron(* * * * ? *)' },
    { label: 'Every hour', value: 'cron(0 * * * ? *)' },
    { label: 'Every day at midnight', value: 'cron(0 0 * * ? *)' },
    { label: 'Every day at 9 AM', value: 'cron(0 9 * * ? *)' },
    { label: 'Weekdays at 9 AM', value: 'cron(0 9 ? * MON-FRI *)' },
    { label: 'Every Monday at 9 AM', value: 'cron(0 9 ? * MON *)' },
    { label: 'First of month at midnight', value: 'cron(0 0 1 * ? *)' },
  ];

  return (
    <div className="space-y-3">
      {/* Schedule Type Toggle */}
      <div className="flex rounded-lg border border-gray-200 overflow-hidden">
        <button
          type="button"
          onClick={() => onChange({ type: 'rate', expression: '' })}
          className={`flex-1 px-3 py-2 text-sm font-medium transition-colors ${
            schedule.type === 'rate'
              ? 'bg-blue-50 text-blue-700 border-r border-blue-200'
              : 'bg-white text-gray-600 hover:bg-gray-50 border-r border-gray-200'
          }`}
        >
          Rate
        </button>
        <button
          type="button"
          onClick={() => onChange({ type: 'cron', expression: '' })}
          className={`flex-1 px-3 py-2 text-sm font-medium transition-colors ${
            schedule.type === 'cron'
              ? 'bg-blue-50 text-blue-700'
              : 'bg-white text-gray-600 hover:bg-gray-50'
          }`}
        >
          Cron
        </button>
      </div>

      {schedule.type === 'rate' ? (
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Rate Expression</label>
          <select
            value={schedule.expression}
            onChange={(e) => onChange({ type: 'rate', expression: e.target.value })}
            className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="">Select interval...</option>
            {ratePresets.map((preset) => (
              <option key={preset.value} value={preset.value}>
                {preset.label}
              </option>
            ))}
          </select>
          <p className="text-xs text-gray-400 mt-1">
            {schedule.expression || 'Select how often the rule should trigger'}
          </p>
        </div>
      ) : (
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Cron Expression</label>
          <select
            value={cronPresets.find(p => p.value === schedule.expression) ? schedule.expression : 'custom'}
            onChange={(e) => {
              if (e.target.value !== 'custom') {
                onChange({ type: 'cron', expression: e.target.value });
              }
            }}
            className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="">Select preset...</option>
            {cronPresets.map((preset) => (
              <option key={preset.value} value={preset.value}>
                {preset.label}
              </option>
            ))}
            <option value="custom">Custom...</option>
          </select>
          {(!cronPresets.find(p => p.value === schedule.expression) || schedule.expression === '') && (
            <input
              type="text"
              value={schedule.expression.replace(/^cron\(|\)$/g, '')}
              onChange={(e) => onChange({ type: 'cron', expression: e.target.value ? `cron(${e.target.value})` : '' })}
              placeholder="0 9 * * ? *"
              className="mt-2 w-full px-2 py-1.5 border border-gray-300 rounded text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          )}
          <p className="text-xs text-gray-400 mt-1">
            Format: minute hour day-of-month month day-of-week year
          </p>
        </div>
      )}
    </div>
  );
}

// Rule Type Selector - switches between Event Pattern and Schedule
function RuleTypeSelector({
  value,
  onChange,
  nodeConfig,
  updateNodeData,
}: {
  value: 'pattern' | 'schedule' | undefined;
  onChange: (value: 'pattern' | 'schedule') => void;
  nodeConfig: Record<string, any>;
  updateNodeData: (key: string, value: any) => void;
}) {
  const ruleType = value || 'pattern';

  return (
    <div className="space-y-3">
      {/* Rule Type Toggle */}
      <div className="flex rounded-lg border border-gray-200 overflow-hidden">
        <button
          type="button"
          onClick={() => onChange('pattern')}
          className={`flex-1 px-3 py-2 text-sm font-medium transition-colors ${
            ruleType === 'pattern'
              ? 'bg-purple-50 text-purple-700 border-r border-purple-200'
              : 'bg-white text-gray-600 hover:bg-gray-50 border-r border-gray-200'
          }`}
        >
          Event Pattern
        </button>
        <button
          type="button"
          onClick={() => onChange('schedule')}
          className={`flex-1 px-3 py-2 text-sm font-medium transition-colors ${
            ruleType === 'schedule'
              ? 'bg-purple-50 text-purple-700'
              : 'bg-white text-gray-600 hover:bg-gray-50'
          }`}
        >
          Schedule
        </button>
      </div>

      {/* Conditional Content */}
      {ruleType === 'pattern' ? (
        <div className="border border-gray-200 rounded-lg p-3 bg-gray-50">
          <EventPatternBuilder
            value={nodeConfig.eventPattern || ''}
            onChange={(v) => updateNodeData('eventPattern', v)}
          />
        </div>
      ) : (
        <div className="border border-gray-200 rounded-lg p-3 bg-gray-50">
          <ScheduleBuilder
            value={nodeConfig.schedule}
            onChange={(v) => updateNodeData('schedule', v)}
          />
        </div>
      )}
    </div>
  );
}

// EventBridge Pattern Builder
function EventPatternBuilder({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  // Parse existing pattern or use defaults
  const parsePattern = (json: string) => {
    try {
      const parsed = JSON.parse(json || '{}');
      return {
        source: parsed.source?.[0] || '',
        detailType: parsed['detail-type']?.[0] || '',
        detailKeys: Object.entries(parsed.detail || {}).map(([key, val]) => ({
          key,
          value: Array.isArray(val) ? val[0] : val,
        })),
      };
    } catch {
      return { source: '', detailType: '', detailKeys: [] };
    }
  };

  const pattern = parsePattern(value);

  const updatePattern = (updates: Partial<typeof pattern>) => {
    const newPattern = { ...pattern, ...updates };
    const json: Record<string, any> = {};

    if (newPattern.source) {
      json.source = [newPattern.source];
    }
    if (newPattern.detailType) {
      json['detail-type'] = [newPattern.detailType];
    }
    if (newPattern.detailKeys.length > 0) {
      json.detail = {};
      newPattern.detailKeys.forEach(({ key, value }) => {
        if (key && value) {
          json.detail[key] = [value];
        }
      });
    }

    onChange(Object.keys(json).length > 0 ? JSON.stringify(json, null, 2) : '');
  };

  const addDetailKey = () => {
    updatePattern({
      detailKeys: [...pattern.detailKeys, { key: '', value: '' }],
    });
  };

  const updateDetailKey = (index: number, field: 'key' | 'value', val: string) => {
    const newKeys = [...pattern.detailKeys];
    newKeys[index] = { ...newKeys[index], [field]: val };
    updatePattern({ detailKeys: newKeys });
  };

  const removeDetailKey = (index: number) => {
    updatePattern({
      detailKeys: pattern.detailKeys.filter((_, i) => i !== index),
    });
  };

  const commonSources = [
    { label: 'Custom App', value: '' },
    { label: 'AWS EC2', value: 'aws.ec2' },
    { label: 'AWS S3', value: 'aws.s3' },
    { label: 'AWS Lambda', value: 'aws.lambda' },
    { label: 'AWS ECS', value: 'aws.ecs' },
    { label: 'AWS CodePipeline', value: 'aws.codepipeline' },
    { label: 'AWS CloudWatch', value: 'aws.cloudwatch' },
    { label: 'AWS Auto Scaling', value: 'aws.autoscaling' },
  ];

  return (
    <div className="space-y-3">
      {/* Source */}
      <div>
        <label className="block text-xs font-medium text-gray-600 mb-1">Event Source</label>
        <div className="flex gap-2">
          <select
            value={commonSources.find(s => s.value === pattern.source) ? pattern.source : 'custom'}
            onChange={(e) => {
              if (e.target.value !== 'custom') {
                updatePattern({ source: e.target.value });
              }
            }}
            className="flex-1 px-2 py-1.5 border border-gray-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            {commonSources.map((s) => (
              <option key={s.value || 'empty'} value={s.value}>{s.label}</option>
            ))}
            <option value="custom">Custom...</option>
          </select>
        </div>
        {(!commonSources.find(s => s.value === pattern.source) || pattern.source === '') && (
          <input
            type="text"
            value={pattern.source}
            onChange={(e) => updatePattern({ source: e.target.value })}
            placeholder="com.myapp.service"
            className="mt-1 w-full px-2 py-1.5 border border-gray-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        )}
      </div>

      {/* Detail Type */}
      <div>
        <label className="block text-xs font-medium text-gray-600 mb-1">Detail Type</label>
        <input
          type="text"
          value={pattern.detailType}
          onChange={(e) => updatePattern({ detailType: e.target.value })}
          placeholder="e.g., order.created, user.signup"
          className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>

      {/* Detail Fields */}
      <div>
        <div className="flex items-center justify-between mb-1">
          <label className="block text-xs font-medium text-gray-600">Match Fields</label>
          <button
            type="button"
            onClick={addDetailKey}
            className="text-xs text-blue-600 hover:text-blue-700"
          >
            + Add field
          </button>
        </div>
        {pattern.detailKeys.length === 0 ? (
          <p className="text-xs text-gray-400 italic">No field filters (matches all)</p>
        ) : (
          <div className="space-y-2">
            {pattern.detailKeys.map((dk, i) => (
              <div key={i} className="flex gap-1 items-center">
                <input
                  type="text"
                  value={dk.key}
                  onChange={(e) => updateDetailKey(i, 'key', e.target.value)}
                  placeholder="field"
                  className="w-24 px-2 py-1 border border-gray-300 rounded text-xs focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
                <span className="text-gray-400">=</span>
                <input
                  type="text"
                  value={dk.value}
                  onChange={(e) => updateDetailKey(i, 'value', e.target.value)}
                  placeholder="value"
                  className="flex-1 px-2 py-1 border border-gray-300 rounded text-xs focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
                <button
                  type="button"
                  onClick={() => removeDetailKey(i)}
                  className="text-gray-400 hover:text-red-500 px-1"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Preview */}
      {value && (
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Generated Pattern</label>
          <pre className="text-xs bg-gray-50 p-2 rounded border border-gray-200 overflow-x-auto max-h-24">
            {value}
          </pre>
        </div>
      )}
    </div>
  );
}

// AWS Name Input - auto-formats to lowercase with hyphens
function AwsNameInput({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  const formatAwsName = (input: string, trimEnds: boolean = false) => {
    let result = input
      .toLowerCase()
      .replace(/\s+/g, '-')       // spaces to hyphens
      .replace(/[^a-z0-9-]/g, '') // remove invalid chars
      .replace(/-+/g, '-');       // collapse multiple hyphens

    if (trimEnds) {
      result = result.replace(/^-|-$/g, ''); // trim leading/trailing hyphens
    } else {
      result = result.replace(/^-/, ''); // only trim leading hyphen while typing
    }

    return result;
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const formatted = formatAwsName(e.target.value, false);
    onChange(formatted);
  };

  const handleBlur = () => {
    // Clean up trailing hyphens when field loses focus
    const cleaned = formatAwsName(value, true);
    if (cleaned !== value) {
      onChange(cleaned);
    }
  };

  return (
    <div className="relative">
      <input
        type="text"
        value={value}
        onChange={handleChange}
        onBlur={handleBlur}
        placeholder={placeholder}
        className="w-full px-3 py-2 pr-16 border border-gray-300 rounded-md text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
      />
      <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-gray-400">
        aws-name
      </span>
    </div>
  );
}

// Log Group Path Input - allows path-like names with slashes
function LogGroupPathInput({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  // CloudWatch Log Group names can contain: a-zA-Z0-9, '/', '-', '_', '.', '#'
  // Must be 1-512 characters, typically start with / for custom paths
  const formatLogGroupPath = (input: string) => {
    let result = input
      .replace(/\s+/g, '-')                    // spaces to hyphens
      .replace(/[^a-zA-Z0-9/_\-.#]/g, '')      // remove invalid chars
      .replace(/\/+/g, '/');                   // collapse multiple slashes

    return result;
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const formatted = formatLogGroupPath(e.target.value);
    onChange(formatted);
  };

  const handleBlur = () => {
    // Clean up trailing slashes when field loses focus
    let cleaned = value.replace(/\/+$/, '');
    // Ensure it starts with / if it has content and doesn't start with a letter
    if (cleaned && !cleaned.startsWith('/') && !/^[a-zA-Z]/.test(cleaned)) {
      cleaned = '/' + cleaned;
    }
    if (cleaned !== value) {
      onChange(cleaned);
    }
  };

  return (
    <div className="relative">
      <input
        type="text"
        value={value}
        onChange={handleChange}
        onBlur={handleBlur}
        placeholder={placeholder}
        className="w-full px-3 py-2 pr-12 border border-gray-300 rounded-md text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
      />
      <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-gray-400">
        path
      </span>
    </div>
  );
}

interface ConfigurationPanelProps {
  node: Node;
  onClose: () => void;
}

interface PresetOption {
  label: string;
  value: number;
}

// Option can be a simple string or an object with label and value
type SelectOption = string | { label: string; value: string };

interface ConfigField {
  key: string;
  label: string;
  type: 'text' | 'number' | 'select' | 'toggle' | 'textarea' | 'code' | 'aws-name' | 'log-group-path' | 'preset' | 'slider' | 'runtime-select' | 'event-pattern' | 'rule-type-selector' | 'inheritable-select' | 'inheritable-toggle' | 'dlq-selector';
  options?: SelectOption[];
  presets?: PresetOption[];
  placeholder?: string;
  min?: number;
  max?: number;
  unit?: string; // For slider display (e.g., 'MB', 'seconds')
  defaultValue?: any; // Default value for the field
  // For inheritable fields - path in environment config to inherit from
  inheritFrom?: string;
  inheritLabel?: string;
  // For security-sensitive toggles - shows green when on, red when off, with confirmation
  securityToggle?: boolean;
  securityWarning?: string; // Warning message shown when disabling
  // For DLQ selector - filter to specific target types (defaults to ['sqs'])
  dlqTargetTypes?: string[];
}

// Helper to normalize select options
function normalizeOption(opt: SelectOption): { label: string; value: string } {
  return typeof opt === 'string' ? { label: opt, value: opt } : opt;
}

// DLQ Selector Component - allows selecting an SQS queue (or SNS topic) as a Dead Letter Queue
function DLQSelector({
  value,
  onChange,
  currentNodeId,
  targetTypes = ['sqs'],
  nodes,
  onPositionChild,
}: {
  value: { enabled: boolean; targetId?: string; maxRetries?: number } | undefined;
  onChange: (value: { enabled: boolean; targetId?: string; maxRetries?: number }) => void;
  currentNodeId: string;
  targetTypes?: string[];
  nodes: Node[];
  onPositionChild?: (childId: string) => void;
}) {
  const dlqConfig = value || { enabled: false };

  // Find available DLQ targets (SQS queues or SNS topics, excluding current node)
  // Also filter out nodes that are already children of this parent
  const availableTargets = nodes.filter(
    n => targetTypes.includes(n.type || '') && n.id !== currentNodeId
  );

  // Get display name for a node
  const getNodeName = (node: Node) => {
    const config = node.data?.config || {};
    if (node.type === 'sqs') return config.queueName || node.data?.label || 'Unnamed Queue';
    if (node.type === 'sns') return config.topicName || node.data?.label || 'Unnamed Topic';
    return node.data?.label || node.id;
  };

  const handleTargetChange = (targetId: string | undefined) => {
    onChange({ ...dlqConfig, targetId });
    // Reposition the child node when a new target is selected
    if (targetId && onPositionChild) {
      onPositionChild(targetId);
    }
  };

  return (
    <div className="space-y-3 p-3 bg-amber-50 border border-amber-200 rounded-lg">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <AlertTriangle size={16} className="text-amber-600" />
          <span className="text-sm font-medium text-amber-800">Dead Letter Queue</span>
        </div>
        <button
          type="button"
          onClick={() => onChange({ ...dlqConfig, enabled: !dlqConfig.enabled })}
          className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
            dlqConfig.enabled ? 'bg-amber-500' : 'bg-gray-300'
          }`}
        >
          <span
            className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
              dlqConfig.enabled ? 'translate-x-5' : 'translate-x-1'
            }`}
          />
        </button>
      </div>

      {dlqConfig.enabled && (
        <div className="space-y-2">
          {availableTargets.length === 0 ? (
            <p className="text-xs text-amber-700 bg-amber-100 p-2 rounded">
              <Mail size={12} className="inline mr-1" />
              Add an SQS queue to the canvas to use as a DLQ
            </p>
          ) : (
            <>
              <div>
                <label className="block text-xs font-medium text-amber-700 mb-1">Target Queue</label>
                <select
                  value={dlqConfig.targetId || ''}
                  onChange={(e) => handleTargetChange(e.target.value || undefined)}
                  className="w-full px-2 py-1.5 border border-amber-300 rounded text-sm bg-white focus:outline-none focus:ring-2 focus:ring-amber-500"
                >
                  <option value="">Select queue...</option>
                  {availableTargets.map((node) => (
                    <option key={node.id} value={node.id}>
                      {getNodeName(node)}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-amber-700 mb-1">
                  Max Retries: <span className="font-bold">{dlqConfig.maxRetries || 3}</span>
                </label>
                <input
                  type="range"
                  min={1}
                  max={10}
                  value={dlqConfig.maxRetries || 3}
                  onChange={(e) => onChange({ ...dlqConfig, maxRetries: Number(e.target.value) })}
                  className="w-full h-2 bg-amber-200 rounded-lg appearance-none cursor-pointer accent-amber-500"
                />
                <div className="flex justify-between text-[10px] text-amber-600 mt-0.5">
                  <span>1</span>
                  <span>10</span>
                </div>
              </div>
            </>
          )}
          <p className="text-xs text-amber-600">
            Failed messages will be sent to this queue after max retries
          </p>
        </div>
      )}
    </div>
  );
}

// Policy Viewer for IAM Roles - shows computed policy from connections
function PolicyViewer({ roleId }: { roleId: string }) {
  const { edges, nodes } = useStore();
  const [isExpanded, setIsExpanded] = useState(true);
  const [copied, setCopied] = useState(false);

  const policy = computeRolePolicy(roleId, edges, nodes);
  const policyJSON = generateIAMPolicyJSON(policy);

  const handleCopy = () => {
    navigator.clipboard.writeText(JSON.stringify(policyJSON, null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (policy.statements.length === 0) {
    return (
      <div className="mt-4 p-3 bg-gray-50 rounded-lg border border-gray-200">
        <div className="text-sm text-gray-500 italic">
          No permissions yet. Connect this role to resources to automatically generate the policy.
        </div>
      </div>
    );
  }

  return (
    <div className="mt-4">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex items-center gap-2 text-sm font-semibold text-gray-700 mb-2"
      >
        {isExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        Computed Policy ({policy.statements.length} statement{policy.statements.length !== 1 ? 's' : ''})
      </button>

      {isExpanded && (
        <div className="space-y-3">
          {/* Resource summary */}
          <div className="space-y-2">
            {policy.statements.map((stmt, idx) => (
              <div
                key={idx}
                className="p-2 bg-green-50 border border-green-200 rounded text-xs"
              >
                <div className="font-medium text-green-800 mb-1">
                  {stmt.resourceLabel} ({stmt.resourceType})
                </div>
                <div className="flex flex-wrap gap-1">
                  {stmt.actions.map(action => (
                    <code key={action} className="px-1.5 py-0.5 bg-green-100 text-green-700 rounded">
                      {action}
                    </code>
                  ))}
                </div>
              </div>
            ))}
          </div>

          {/* JSON view */}
          <div className="relative">
            <button
              onClick={handleCopy}
              className="absolute top-2 right-2 p-1 bg-gray-100 hover:bg-gray-200 rounded text-gray-500"
              title="Copy policy JSON"
            >
              {copied ? <Check size={14} className="text-green-600" /> : <Copy size={14} />}
            </button>
            <pre className="p-3 bg-chrome text-chrome-fg rounded text-xs overflow-x-auto max-h-48">
              {JSON.stringify(policyJSON, null, 2)}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}

// Common preset values for AWS resources
const PRESETS = {
  visibilityTimeout: [
    { label: '30 seconds', value: 30 },
    { label: '1 minute', value: 60 },
    { label: '5 minutes', value: 300 },
    { label: '15 minutes', value: 900 },
    { label: '30 minutes', value: 1800 },
    { label: '1 hour', value: 3600 },
    { label: '6 hours', value: 21600 },
    { label: '12 hours', value: 43200 },
  ],
  messageRetention: [
    { label: '1 day', value: 1 },
    { label: '4 days', value: 4 },
    { label: '7 days', value: 7 },
    { label: '10 days', value: 10 },
    { label: '14 days', value: 14 },
  ],
  delaySeconds: [
    { label: 'No delay', value: 0 },
    { label: '15 seconds', value: 15 },
    { label: '30 seconds', value: 30 },
    { label: '1 minute', value: 60 },
    { label: '5 minutes', value: 300 },
    { label: '15 minutes', value: 900 },
  ],
  lambdaMemory: [
    { label: '128 MB', value: 128 },
    { label: '256 MB', value: 256 },
    { label: '512 MB', value: 512 },
    { label: '1 GB', value: 1024 },
    { label: '2 GB', value: 2048 },
    { label: '4 GB', value: 4096 },
    { label: '8 GB', value: 8192 },
    { label: '10 GB', value: 10240 },
  ],
  lambdaTimeout: [
    { label: '3 seconds', value: 3 },
    { label: '10 seconds', value: 10 },
    { label: '30 seconds', value: 30 },
    { label: '1 minute', value: 60 },
    { label: '5 minutes', value: 300 },
    { label: '10 minutes', value: 600 },
    { label: '15 minutes', value: 900 },
  ],
  alarmPeriod: [
    { label: '1 minute', value: 60 },
    { label: '5 minutes', value: 300 },
    { label: '15 minutes', value: 900 },
    { label: '1 hour', value: 3600 },
    { label: '6 hours', value: 21600 },
    { label: '1 day', value: 86400 },
  ],
  evaluationPeriods: [
    { label: '1 period', value: 1 },
    { label: '2 periods', value: 2 },
    { label: '3 periods', value: 3 },
    { label: '5 periods', value: 5 },
    { label: '10 periods', value: 10 },
  ],
  logRetention: [
    { label: '1 day', value: 1 },
    { label: '3 days', value: 3 },
    { label: '1 week', value: 7 },
    { label: '2 weeks', value: 14 },
    { label: '1 month', value: 30 },
    { label: '2 months', value: 60 },
    { label: '3 months', value: 90 },
    { label: '6 months', value: 180 },
    { label: '1 year', value: 365 },
    { label: 'Never expire', value: 0 },
  ],
};

// Configuration schemas for each node type
const configSchemas: Record<string, ConfigField[]> = {
  'agent': [
    { key: 'name', label: 'Agent Name', type: 'aws-name', placeholder: 'my-agent' },
    { key: 'runtime', label: 'Runtime', type: 'select', options: ['python3.11', 'python3.12', 'nodejs18.x', 'nodejs20.x'] },
    { key: 'handler', label: 'Handler', type: 'text', placeholder: 'main.handler' },
    { key: 'memory', label: 'Memory', type: 'preset', presets: PRESETS.lambdaMemory },
    { key: 'timeout', label: 'Timeout', type: 'preset', presets: PRESETS.lambdaTimeout },
    { key: 'description', label: 'Description', type: 'textarea' },
    { key: 'dlq', label: 'Async Invocation DLQ', type: 'dlq-selector', dlqTargetTypes: ['sqs', 'sns'] },
  ],
  's3': [
    { key: 'bucketName', label: 'Bucket Name', type: 'aws-name', placeholder: 'my-bucket' },
    { key: 'storageClass', label: 'Storage Class', type: 'select', options: [
      { label: 'Intelligent Tiering', value: 'INTELLIGENT_TIERING' },
      { label: 'Standard', value: 'STANDARD' },
      { label: 'Standard-IA (Infrequent)', value: 'STANDARD_IA' },
      { label: 'One Zone-IA', value: 'ONEZONE_IA' },
      { label: 'Glacier Instant Retrieval', value: 'GLACIER_IR' },
      { label: 'Glacier Flexible Retrieval', value: 'GLACIER' },
      { label: 'Glacier Deep Archive', value: 'DEEP_ARCHIVE' },
    ], defaultValue: 'INTELLIGENT_TIERING' },
    { key: 'versioning', label: 'Versioning', type: 'toggle' },
    { key: 'encryption', label: 'Encryption', type: 'select', options: [
      { label: 'AES-256 (SSE-S3)', value: 'AES256' },
      { label: 'AWS KMS (SSE-KMS)', value: 'aws:kms' },
      { label: 'None', value: 'none' },
    ], defaultValue: 'AES256' },
    { key: 'lifecycleRules', label: 'Lifecycle Rules', type: 'toggle' },
    { key: 'blockPublicAccess', label: 'Block Public Access', type: 'toggle', min: 1, securityToggle: true, securityWarning: 'Disabling Block Public Access can expose your S3 bucket and its contents to the public internet. This may lead to data breaches, unauthorized access, and compliance violations. Only disable this if you specifically need public access and understand the security implications.' },
  ],
  'dynamodb': [
    { key: 'tableName', label: 'Table Name', type: 'aws-name', placeholder: 'my-table' },
    { key: 'partitionKey', label: 'Partition Key', type: 'text', placeholder: 'pk' },
    { key: 'partitionKeyType', label: 'Partition Key Type', type: 'select', options: [
      { label: 'String', value: 'S' },
      { label: 'Number', value: 'N' },
      { label: 'Binary', value: 'B' },
    ] },
    { key: 'sortKey', label: 'Sort Key (optional)', type: 'text', placeholder: 'sk' },
    { key: 'sortKeyType', label: 'Sort Key Type', type: 'select', options: [
      { label: 'String', value: 'S' },
      { label: 'Number', value: 'N' },
      { label: 'Binary', value: 'B' },
    ] },
    { key: 'billingMode', label: 'Billing Mode', type: 'select', options: [
      { label: 'On-Demand', value: 'PAY_PER_REQUEST' },
      { label: 'Provisioned', value: 'PROVISIONED' },
    ], defaultValue: 'PAY_PER_REQUEST' },
  ],
  'sqs': [
    { key: 'queueName', label: 'Queue Name', type: 'aws-name', placeholder: 'my-queue' },
    { key: 'fifo', label: 'FIFO Queue', type: 'toggle' },
    { key: 'visibilityTimeout', label: 'Visibility Timeout', type: 'slider', presets: PRESETS.visibilityTimeout, defaultValue: 30 },
    { key: 'messageRetention', label: 'Message Retention', type: 'slider', presets: PRESETS.messageRetention, defaultValue: 4 },
    { key: 'delaySeconds', label: 'Delivery Delay', type: 'slider', presets: PRESETS.delaySeconds, defaultValue: 0 },
    { key: 'dlq', label: 'Dead Letter Queue', type: 'dlq-selector' },
  ],
  'sns': [
    { key: 'topicName', label: 'Topic Name', type: 'aws-name', placeholder: 'my-topic' },
    { key: 'displayName', label: 'Display Name', type: 'text' },
    { key: 'fifo', label: 'FIFO Topic', type: 'toggle' },
    { key: 'dlq', label: 'Dead Letter Queue', type: 'dlq-selector' },
  ],
  'kinesis-stream': [
    { key: 'streamName', label: 'Stream Name', type: 'aws-name', placeholder: 'my-stream' },
    { key: 'shardCount', label: 'Shard Count', type: 'number', placeholder: '1' },
    { key: 'retentionPeriod', label: 'Retention', type: 'select', options: [
      { label: '24 hours', value: '24' },
      { label: '48 hours', value: '48' },
      { label: '72 hours (3 days)', value: '72' },
      { label: '168 hours (7 days)', value: '168' },
    ] },
    { key: 'streamMode', label: 'Capacity Mode', type: 'select', options: [
      { label: 'On-Demand', value: 'ON_DEMAND' },
      { label: 'Provisioned', value: 'PROVISIONED' },
    ], defaultValue: 'ON_DEMAND' },
  ],
  'kinesis-firehose': [
    { key: 'deliveryStreamName', label: 'Delivery Stream Name', type: 'aws-name', placeholder: 'my-firehose' },
    { key: 'destinationType', label: 'Destination', type: 'select', options: ['S3', 'Redshift', 'OpenSearch', 'HTTP'] },
    { key: 'bufferInterval', label: 'Buffer Interval', type: 'select', options: [
      { label: '60 seconds', value: '60' },
      { label: '2 minutes', value: '120' },
      { label: '5 minutes', value: '300' },
      { label: '15 minutes', value: '900' },
    ] },
    { key: 'bufferSize', label: 'Buffer Size', type: 'select', options: [
      { label: '1 MB', value: '1' },
      { label: '5 MB', value: '5' },
      { label: '10 MB', value: '10' },
      { label: '64 MB', value: '64' },
      { label: '128 MB', value: '128' },
    ] },
    { key: 'compressionFormat', label: 'Compression', type: 'select', options: [
      { label: 'None', value: 'UNCOMPRESSED' },
      { label: 'GZIP', value: 'GZIP' },
      { label: 'ZIP', value: 'ZIP' },
      { label: 'Snappy', value: 'Snappy' },
    ] },
  ],
  'eventbridge-pipes': [
    { key: 'pipeName', label: 'Pipe Name', type: 'aws-name', placeholder: 'my-pipe' },
    { key: 'description', label: 'Description', type: 'textarea' },
    { key: 'desiredState', label: 'State', type: 'select', options: [
      { label: 'Running', value: 'RUNNING' },
      { label: 'Stopped', value: 'STOPPED' },
    ], defaultValue: 'RUNNING' },
  ],
  'eventbridge': [
    { key: 'busName', label: 'Event Bus Name', type: 'aws-name', placeholder: 'default' },
    { key: 'description', label: 'Description', type: 'textarea' },
  ],
  'eventbridge-rule': [
    { key: 'ruleName', label: 'Rule Name', type: 'aws-name', placeholder: 'my-rule' },
    { key: 'description', label: 'Description', type: 'textarea' },
    { key: 'ruleType', label: 'Rule Type', type: 'rule-type-selector' },
    { key: 'state', label: 'Enabled', type: 'toggle' },
    { key: 'dlq', label: 'Target Invocation DLQ', type: 'dlq-selector' },
  ],
  'api-gateway': [
    { key: 'apiName', label: 'API Name', type: 'aws-name', placeholder: 'my-api' },
    { key: 'stageName', label: 'Stage Name', type: 'aws-name', placeholder: 'prod' },
    { key: 'endpointType', label: 'Endpoint Type', type: 'select', options: [
      { label: 'Regional', value: 'REGIONAL' },
      { label: 'Edge (CloudFront)', value: 'EDGE' },
      { label: 'Private (VPC)', value: 'PRIVATE' },
    ], defaultValue: 'REGIONAL' },
    { key: 'cors', label: 'Enable CORS', type: 'toggle' },
  ],
  'api-route': [
    { key: 'path', label: 'Route Path', type: 'text', placeholder: '/users/{id}' },
    { key: 'method', label: 'HTTP Method', type: 'select', options: ['ANY', 'GET', 'POST', 'PUT', 'DELETE', 'PATCH'] },
    { key: 'authType', label: 'Auth Type', type: 'select', options: [
      { label: 'None (Public)', value: 'NONE' },
      { label: 'AWS IAM', value: 'AWS_IAM' },
      { label: 'JWT (Cognito/Auth0)', value: 'JWT' },
      { label: 'Custom Authorizer', value: 'CUSTOM' },
    ] },
  ],
  'iam-role': [
    { key: 'roleName', label: 'Role Name', type: 'aws-name', placeholder: 'my-role' },
    { key: 'description', label: 'Description', type: 'textarea' },
    { key: 'managedPolicies', label: 'Managed Policies (comma-separated)', type: 'text', placeholder: 'arn:aws:iam::aws:policy/...' },
  ],
  'security-group': [
    { key: 'groupName', label: 'Security Group Name', type: 'aws-name', placeholder: 'my-sg' },
    { key: 'description', label: 'Description', type: 'textarea' },
  ],
  'vpc': [
    { key: 'name', label: 'VPC Name', type: 'aws-name', placeholder: 'my-vpc' },
    { key: 'cidrBlock', label: 'CIDR Block', type: 'text', placeholder: '10.0.0.0/16' },
    { key: 'enableDnsHostnames', label: 'Enable DNS Hostnames', type: 'toggle' },
    { key: 'enableDnsSupport', label: 'Enable DNS Support', type: 'toggle' },
  ],
  'cloudwatch-alarm': [
    { key: 'alarmName', label: 'Alarm Name', type: 'aws-name', placeholder: 'my-alarm' },
    { key: 'metricName', label: 'Metric Name', type: 'text', placeholder: 'CPUUtilization' },
    { key: 'namespace', label: 'Namespace', type: 'text', placeholder: 'AWS/EC2' },
    { key: 'statistic', label: 'Statistic', type: 'select', options: ['Average', 'Sum', 'Minimum', 'Maximum', 'SampleCount'] },
    { key: 'threshold', label: 'Threshold', type: 'number' },
    { key: 'comparisonOperator', label: 'Comparison', type: 'select', options: ['GreaterThanThreshold', 'LessThanThreshold', 'GreaterThanOrEqualToThreshold', 'LessThanOrEqualToThreshold'] },
    { key: 'period', label: 'Period', type: 'preset', presets: PRESETS.alarmPeriod },
    { key: 'evaluationPeriods', label: 'Evaluation Periods', type: 'preset', presets: PRESETS.evaluationPeriods },
  ],
  'log-group': [
    { key: 'logGroupPath', label: 'Log Group Path', type: 'log-group-path', placeholder: '/my-app/service-name' },
    { key: 'retentionDays', label: 'Log Retention', type: 'inheritable-select', presets: PRESETS.logRetention, inheritFrom: 'logging.defaultRetentionDays', inheritLabel: 'Use environment default' },
    { key: 'removalPolicy', label: 'Removal Policy', type: 'inheritable-select', options: ['destroy', 'retain'], inheritFrom: 'removalPolicies.logGroup', inheritLabel: 'Use environment default' },
  ],
  'lambda': [
    { key: 'functionName', label: 'Function Name', type: 'aws-name', placeholder: 'my-function' },
    { key: 'runtime', label: 'Runtime', type: 'runtime-select' },
    { key: 'handler', label: 'Handler', type: 'text', placeholder: 'index.handler' },
    { key: 'memory', label: 'Memory', type: 'slider', presets: PRESETS.lambdaMemory, unit: 'MB', min: 1024 },
    { key: 'timeout', label: 'Timeout', type: 'slider', presets: PRESETS.lambdaTimeout, unit: 'sec', min: 10 },
    { key: 'architecture', label: 'Architecture', type: 'select', options: [
      { label: 'x86_64 (Intel/AMD)', value: 'x86_64' },
      { label: 'arm64 (Graviton)', value: 'arm64' },
    ], defaultValue: 'arm64' },
    { key: 'description', label: 'Description', type: 'textarea' },
    { key: 'dlq', label: 'Async Invocation DLQ', type: 'dlq-selector', dlqTargetTypes: ['sqs', 'sns'] },
  ],
  'ssm-parameter': [
    { key: 'parameterName', label: 'Parameter Name', type: 'text', placeholder: '/my-app/config/api-key' },
    { key: 'type', label: 'Parameter Type', type: 'select', options: [
      { label: 'String', value: 'String' },
      { label: 'String List', value: 'StringList' },
      { label: 'Secure String (Encrypted)', value: 'SecureString' },
    ] },
    { key: 'tier', label: 'Tier', type: 'select', options: [
      { label: 'Standard (free, 4KB limit)', value: 'Standard' },
      { label: 'Advanced (paid, 8KB limit)', value: 'Advanced' },
    ], defaultValue: 'Standard' },
    { key: 'description', label: 'Description', type: 'textarea' },
  ],
  'secrets-manager': [
    { key: 'secretName', label: 'Secret Name', type: 'text', placeholder: 'my-app/api-key' },
    { key: 'description', label: 'Description', type: 'textarea' },
    { key: 'generateSecretString', label: 'Auto-generate Secret', type: 'toggle' },
  ],
  'step-functions': [
    { key: 'stateMachineName', label: 'State Machine Name', type: 'aws-name', placeholder: 'my-state-machine' },
    { key: 'type', label: 'Type', type: 'select', options: [
      { label: 'Standard (long-running)', value: 'STANDARD' },
      { label: 'Express (high-volume)', value: 'EXPRESS' },
    ], defaultValue: 'STANDARD' },
    { key: 'description', label: 'Description', type: 'textarea' },
  ],
  'bedrock': [
    { key: 'modelId', label: 'Model', type: 'select', options: [
      { label: 'Claude 3.5 Sonnet v2', value: 'anthropic.claude-3-5-sonnet-20241022-v2:0' },
      { label: 'Claude 3.5 Haiku', value: 'anthropic.claude-3-5-haiku-20241022-v1:0' },
      { label: 'Claude 3 Opus', value: 'anthropic.claude-3-opus-20240229-v1:0' },
      { label: 'Titan Text Express', value: 'amazon.titan-text-express-v1' },
      { label: 'Titan Embeddings', value: 'amazon.titan-embed-text-v1' },
    ] },
    { key: 'maxTokens', label: 'Max Tokens', type: 'number', placeholder: '4096' },
    { key: 'temperature', label: 'Temperature', type: 'number', placeholder: '0.7', min: 0, max: 1 },
  ],

  // Types drawn from an account. warpcore does not deploy these, so the form
  // is a place to read what was found and annotate it, not to design it.
  'ec2-instance': [
    { key: 'name', label: 'Name', type: 'text' },
    { key: 'instanceId', label: 'Instance ID', type: 'text' },
    { key: 'instanceType', label: 'Instance Type', type: 'text' },
    { key: 'state', label: 'State', type: 'text' },
    { key: 'privateIp', label: 'Private IP', type: 'text' },
    { key: 'publicIp', label: 'Public IP', type: 'text' },
    { key: 'imageId', label: 'AMI', type: 'text' },
    { key: 'description', label: 'Notes', type: 'textarea' },
  ],
  'subnet': [
    { key: 'name', label: 'Name', type: 'text' },
    { key: 'subnetId', label: 'Subnet ID', type: 'text' },
    { key: 'cidrBlock', label: 'CIDR Block', type: 'text' },
    { key: 'availabilityZone', label: 'Availability Zone', type: 'text' },
    { key: 'public', label: 'Public (auto-assign IP)', type: 'toggle' },
    { key: 'description', label: 'Notes', type: 'textarea' },
  ],
  'internet-gateway': [{ key: 'name', label: 'Name', type: 'text' }, { key: 'description', label: 'Notes', type: 'textarea' }],
  'nat-gateway': [
    { key: 'name', label: 'Name', type: 'text' },
    { key: 'state', label: 'State', type: 'text' },
    { key: 'publicIp', label: 'Public IP', type: 'text' },
    { key: 'description', label: 'Notes', type: 'textarea' },
  ],
  'route-table': [{ key: 'name', label: 'Name', type: 'text' }, { key: 'routes', label: 'Routes', type: 'textarea' }, { key: 'description', label: 'Notes', type: 'textarea' }],
  'vpc-endpoint': [{ key: 'name', label: 'Name', type: 'text' }, { key: 'serviceName', label: 'Service', type: 'text' }, { key: 'endpointType', label: 'Type', type: 'text' }],
  'elastic-ip': [{ key: 'name', label: 'Name', type: 'text' }, { key: 'publicIp', label: 'Public IP', type: 'text' }],
  'load-balancer': [
    { key: 'name', label: 'Name', type: 'text' },
    { key: 'scheme', label: 'Scheme', type: 'text' },
    { key: 'lbType', label: 'Type', type: 'text' },
    { key: 'dnsName', label: 'DNS Name', type: 'text' },
  ],
  'ebs-volume': [
    { key: 'name', label: 'Name', type: 'text' },
    { key: 'size', label: 'Size (GiB)', type: 'number' },
    { key: 'volumeType', label: 'Type', type: 'text' },
    { key: 'encrypted', label: 'Encrypted', type: 'toggle' },
  ],
  'ebs-snapshot': [{ key: 'name', label: 'Name', type: 'text' }, { key: 'size', label: 'Size (GiB)', type: 'number' }, { key: 'description', label: 'Description', type: 'textarea' }],
  'cloudfront': [
    { key: 'name', label: 'Name', type: 'text' },
    { key: 'domainName', label: 'Domain', type: 'text' },
    { key: 'aliases', label: 'Aliases', type: 'text' },
    { key: 'enabled', label: 'Enabled', type: 'toggle' },
    { key: 'description', label: 'Comment', type: 'textarea' },
  ],
  'route53-zone': [{ key: 'name', label: 'Zone', type: 'text' }, { key: 'recordCount', label: 'Records', type: 'number' }, { key: 'privateZone', label: 'Private', type: 'toggle' }],
  'kms-key': [
    { key: 'name', label: 'Name', type: 'text' },
    { key: 'keyId', label: 'Key ID', type: 'text' },
    { key: 'keyState', label: 'State', type: 'text' },
    { key: 'description', label: 'Description', type: 'textarea' },
  ],
  'acm-certificate': [
    { key: 'name', label: 'Domain', type: 'text' },
    { key: 'status', label: 'Status', type: 'text' },
    { key: 'notAfter', label: 'Expires', type: 'text' },
    { key: 'alternativeNames', label: 'Alternative Names', type: 'text' },
  ],
  'iam-instance-profile': [{ key: 'name', label: 'Name', type: 'text' }, { key: 'roles', label: 'Roles', type: 'text' }],
  'iam-user': [{ key: 'name', label: 'Name', type: 'text' }],
  'iam-policy': [{ key: 'name', label: 'Name', type: 'text' }, { key: 'description', label: 'Description', type: 'textarea' }],
  'rds-instance': [
    { key: 'name', label: 'Identifier', type: 'text' },
    { key: 'engine', label: 'Engine', type: 'text' },
    { key: 'instanceClass', label: 'Class', type: 'text' },
    { key: 'endpoint', label: 'Endpoint', type: 'text' },
    { key: 'multiAz', label: 'Multi-AZ', type: 'toggle' },
  ],
  'rds-cluster': [{ key: 'name', label: 'Identifier', type: 'text' }, { key: 'engine', label: 'Engine', type: 'text' }],
  'ecs-cluster': [{ key: 'name', label: 'Name', type: 'text' }],
  'ecs-service': [{ key: 'name', label: 'Name', type: 'text' }],
  'eks-cluster': [{ key: 'name', label: 'Name', type: 'text' }],
  'elasticache-cluster': [{ key: 'name', label: 'Name', type: 'text' }, { key: 'engine', label: 'Engine', type: 'text' }],
  'aws-resource': [
    { key: 'name', label: 'Name', type: 'text' },
    { key: 'awsType', label: 'AWS Type', type: 'text' },
    { key: 'description', label: 'Notes', type: 'textarea' },
  ],
};

export default function ConfigurationPanel({ node, onClose }: ConfigurationPanelProps) {
  const { nodes, setNodes, currentEnvironment, environmentConfigs } = useStore();
  const envConfig = environmentConfigs[currentEnvironment];
  const schema = configSchemas[node.type || ''] || [];

  const handleDelete = () => {
    void runFromUi('canvas.removeNodes', { ids: [node.id] });
    onClose();
  };

  // Handle repositioning a child node when a DLQ relationship is created
  const handlePositionChild = useCallback((childId: string) => {
    // Use functional update to avoid race condition with DLQ config update
    setNodes(currentNodes => {
      const childNode = currentNodes.find(n => n.id === childId);
      if (!childNode) {
        return currentNodes;
      }

      // Get current groups to find existing children of this parent
      // Filter out the child we're currently positioning (it shouldn't count as "existing")
      const groups = computeNodeGroups(currentNodes);
      const existingChildIds = getExistingChildIds(node.id, groups).filter(id => id !== childId);

      // Calculate new position for the child (use current node position from currentNodes)
      const currentParentNode = currentNodes.find(n => n.id === node.id) || node;
      const newPosition = calculateChildPosition(currentParentNode, existingChildIds, currentNodes);
      const snappedPosition = snapToGrid(newPosition);

      return currentNodes.map(n => {
        if (n.id === childId) {
          return { ...n, position: snappedPosition };
        }
        return n;
      });
    });
  }, [node, setNodes]);

  // Close on Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  // One field at a time, through the command the assistant would use.
  const updateNodeData = (key: string, value: any) => {
    void runFromUi('canvas.setConfig', { id: node.id, config: { [key]: value } });
  };

  const getConfigValue = (key: string, defaultValue: any = '') => {
    return node.data?.config?.[key] ?? defaultValue;
  };

  const renderField = (field: ConfigField) => {
    // Use field's defaultValue if specified, otherwise use type-specific defaults
    const defaultValue = field.defaultValue !== undefined
      ? field.defaultValue
      : field.type === 'toggle'
        ? (field.min === 1 ? true : false)
        : '';
    const value = getConfigValue(field.key, defaultValue);

    switch (field.type) {
      case 'text':
        return (
          <input
            type="text"
            value={value}
            onChange={(e) => updateNodeData(field.key, e.target.value)}
            placeholder={field.placeholder}
            className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        );

      case 'number':
        return (
          <input
            type="number"
            value={value}
            onChange={(e) => updateNodeData(field.key, Number(e.target.value))}
            min={field.min}
            max={field.max}
            className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        );

      case 'select':
        return (
          <select
            value={value}
            onChange={(e) => updateNodeData(field.key, e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="">Select...</option>
            {field.options?.map((opt) => {
              const { label, value: optValue } = normalizeOption(opt);
              return (
                <option key={optValue} value={optValue}>{label}</option>
              );
            })}
          </select>
        );

      case 'toggle': {
        const isSecurityToggle = field.securityToggle;

        const handleToggle = () => {
          if (isSecurityToggle && value) {
            // Turning OFF a security toggle - show confirmation
            const confirmed = window.confirm(
              `Security Warning\n\n${field.securityWarning || 'Are you sure you want to disable this security setting?'}\n\nClick OK to disable, or Cancel to keep it enabled.`
            );
            if (confirmed) {
              updateNodeData(field.key, false);
            }
          } else {
            updateNodeData(field.key, !value);
          }
        };

        // Security toggles: green when on (secure), red when off (risky)
        // Regular toggles: blue when on, gray when off
        const getToggleColor = () => {
          if (isSecurityToggle) {
            return value ? 'bg-green-500' : 'bg-red-500';
          }
          return value ? 'bg-blue-600' : 'bg-gray-200';
        };

        return (
          <button
            type="button"
            onClick={handleToggle}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${getToggleColor()}`}
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                value ? 'translate-x-6' : 'translate-x-1'
              }`}
            />
          </button>
        );
      }

      case 'textarea':
        return (
          <textarea
            value={value}
            onChange={(e) => updateNodeData(field.key, e.target.value)}
            placeholder={field.placeholder}
            rows={3}
            className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        );

      case 'code':
        return (
          <textarea
            value={value}
            onChange={(e) => updateNodeData(field.key, e.target.value)}
            placeholder={field.placeholder}
            rows={5}
            className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm font-mono bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        );

      case 'aws-name':
        return (
          <AwsNameInput
            value={value}
            onChange={(v) => updateNodeData(field.key, v)}
            placeholder={field.placeholder}
          />
        );

      case 'log-group-path':
        return (
          <LogGroupPathInput
            value={value}
            onChange={(v) => updateNodeData(field.key, v)}
            placeholder={field.placeholder}
          />
        );

      case 'preset':
        return (
          <select
            value={value}
            onChange={(e) => updateNodeData(field.key, Number(e.target.value))}
            className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="">Select...</option>
            {field.presets?.map((preset) => (
              <option key={preset.value} value={preset.value}>
                {preset.label}
              </option>
            ))}
          </select>
        );

      case 'slider': {
        const presets = field.presets || [];
        // Use min field as default value if no value is set
        const defaultValue = field.min;
        const effectiveValue = value || defaultValue;
        const currentIndex = presets.findIndex(p => p.value === effectiveValue);
        const defaultIndex = defaultValue ? presets.findIndex(p => p.value === defaultValue) : 0;
        const selectedIndex = currentIndex >= 0 ? currentIndex : (defaultIndex >= 0 ? defaultIndex : 0);
        const selectedPreset = presets[selectedIndex];

        return (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <input
                type="range"
                min={0}
                max={presets.length - 1}
                value={selectedIndex}
                onChange={(e) => {
                  const idx = parseInt(e.target.value);
                  updateNodeData(field.key, presets[idx].value);
                }}
                className="flex-1 h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-blue-600"
              />
              <span className="ml-3 min-w-[80px] text-right text-sm font-medium text-gray-700">
                {selectedPreset?.label || presets[0]?.label}
              </span>
            </div>
            <div className="flex justify-between text-xs text-gray-400">
              <span>{presets[0]?.label}</span>
              <span>{presets[presets.length - 1]?.label}</span>
            </div>
          </div>
        );
      }

      case 'runtime-select': {
        // Pinned runtimes at the top (latest versions)
        const pinnedRuntimes = [
          { value: 'python3.13', label: 'Python 3.13 (Latest)' },
          { value: 'nodejs22.x', label: 'Node.js 22.x (Latest)' },
          { value: 'provided.al2023', label: 'Rust / Custom Runtime' },
        ];
        // Other supported runtimes
        const otherRuntimes = [
          { value: 'python3.12', label: 'Python 3.12' },
          { value: 'python3.11', label: 'Python 3.11' },
          { value: 'nodejs20.x', label: 'Node.js 20.x' },
          { value: 'nodejs18.x', label: 'Node.js 18.x' },
          { value: 'java21', label: 'Java 21' },
          { value: 'java17', label: 'Java 17' },
          { value: 'dotnet8', label: '.NET 8' },
          { value: 'ruby3.3', label: 'Ruby 3.3' },
          { value: 'go1.x', label: 'Go 1.x' },
        ];

        return (
          <select
            value={value}
            onChange={(e) => updateNodeData(field.key, e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="">Select runtime...</option>
            {pinnedRuntimes.map((rt) => (
              <option key={rt.value} value={rt.value}>
                {rt.label}
              </option>
            ))}
            <option disabled>──────────────</option>
            {otherRuntimes.map((rt) => (
              <option key={rt.value} value={rt.value}>
                {rt.label}
              </option>
            ))}
          </select>
        );
      }

      case 'event-pattern':
        return (
          <EventPatternBuilder
            value={value}
            onChange={(v) => updateNodeData(field.key, v)}
          />
        );

      case 'rule-type-selector':
        return (
          <RuleTypeSelector
            value={value}
            onChange={(v) => updateNodeData(field.key, v)}
            nodeConfig={node.data?.config || {}}
            updateNodeData={updateNodeData}
          />
        );

      case 'inheritable-select': {
        const isInheriting = value === 'inherit' || value === undefined;
        const inheritedValue = field.inheritFrom ? getNestedValue(envConfig, field.inheritFrom) : null;

        // Get display label for inherited value
        const getInheritedLabel = () => {
          if (field.presets) {
            const preset = field.presets.find(p => p.value === inheritedValue);
            return preset?.label || String(inheritedValue);
          }
          return String(inheritedValue);
        };

        return (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => updateNodeData(field.key, isInheriting ? (field.presets?.[0]?.value ?? field.options?.[0] ?? '') : 'inherit')}
                className={`flex items-center gap-1.5 px-2 py-1 rounded text-xs font-medium transition-colors ${
                  isInheriting
                    ? 'bg-blue-100 text-blue-700'
                    : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                }`}
              >
                {isInheriting ? <Link size={12} /> : <Unlink size={12} />}
                {isInheriting ? 'Inheriting' : 'Override'}
              </button>
              {isInheriting && (
                <span className="text-xs text-gray-500">
                  → {getInheritedLabel()}
                </span>
              )}
            </div>
            {!isInheriting && (
              <select
                value={value}
                onChange={(e) => {
                  const val = field.presets ? Number(e.target.value) : e.target.value;
                  updateNodeData(field.key, val);
                }}
                className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                {field.presets?.map((preset) => (
                  <option key={preset.value} value={preset.value}>
                    {preset.label}
                  </option>
                ))}
                {field.options?.map((opt) => {
                  const { label, value: optValue } = normalizeOption(opt);
                  return (
                    <option key={optValue} value={optValue}>
                      {label}
                    </option>
                  );
                })}
              </select>
            )}
          </div>
        );
      }

      case 'inheritable-toggle': {
        const isInheriting = value === 'inherit' || value === undefined;
        const inheritedValue = field.inheritFrom ? getNestedValue(envConfig, field.inheritFrom) : false;

        return (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => updateNodeData(field.key, isInheriting ? false : 'inherit')}
                className={`flex items-center gap-1.5 px-2 py-1 rounded text-xs font-medium transition-colors ${
                  isInheriting
                    ? 'bg-blue-100 text-blue-700'
                    : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                }`}
              >
                {isInheriting ? <Link size={12} /> : <Unlink size={12} />}
                {isInheriting ? 'Inheriting' : 'Override'}
              </button>
              {isInheriting && (
                <span className="text-xs text-gray-500">
                  → {inheritedValue ? 'Enabled' : 'Disabled'}
                </span>
              )}
            </div>
            {!isInheriting && (
              <button
                type="button"
                onClick={() => updateNodeData(field.key, !value)}
                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                  value ? 'bg-blue-600' : 'bg-gray-200'
                }`}
              >
                <span
                  className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                    value ? 'translate-x-6' : 'translate-x-1'
                  }`}
                />
              </button>
            )}
          </div>
        );
      }

      case 'dlq-selector':
        return (
          <DLQSelector
            value={value}
            onChange={(v) => updateNodeData(field.key, v)}
            currentNodeId={node.id}
            targetTypes={field.dlqTargetTypes || ['sqs']}
            nodes={nodes}
            onPositionChild={handlePositionChild}
          />
        );

      default:
        return null;
    }
  };

  // A sheet, not a modal: it slides in over the inspector and leaves the
  // canvas in view, so configuring a resource never means losing the picture.
  // Clicking the canvas closes it.
  return createPortal(
    <div
      className="fixed left-0 right-0 top-12 bottom-0 z-50 flex justify-end"
      onClick={onClose}
    >
      <div className="absolute inset-0 bg-black/10" />

      <div
        className="config-sheet relative bg-white border-l border-gray-200 shadow-2xl flex flex-col w-[480px] max-w-[92vw] h-full"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-gray-200 flex-shrink-0">
          <h2 className="font-semibold text-gray-800 truncate">Configure {node.data?.label}</h2>
          <div className="flex items-center gap-1">
            <button
              onClick={handleDelete}
              className="p-1.5 hover:bg-red-50 rounded text-gray-400 hover:text-red-500 transition-colors"
              title="Delete resource"
            >
              <Trash2 size={16} />
            </button>
            <button
              onClick={onClose}
              className="p-1.5 hover:bg-gray-100 rounded text-gray-400 hover:text-gray-600 transition-colors"
              title="Close (Esc)"
            >
              <X size={18} />
            </button>
          </div>
        </div>

        {/* Body - scrollable */}
        <div className="flex-1 overflow-y-auto p-4">
          {schema.length === 0 ? (
            <p className="text-sm text-gray-500">No configuration options available for this component.</p>
          ) : (
            <div className="space-y-4">
              {/* Render enabled/state toggles first */}
              {schema
                .filter((field) => ['state', 'enabled', 'isEnabled'].includes(field.key) && field.type === 'toggle')
                .map((field) => {
                  const value = getConfigValue(field.key, true);
                  return (
                    <div key={field.key} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg border border-gray-200">
                      <label className="text-sm font-medium text-gray-700">
                        {field.label}
                      </label>
                      <button
                        type="button"
                        onClick={() => updateNodeData(field.key, !value)}
                        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                          value ? 'bg-green-500' : 'bg-gray-300'
                        }`}
                      >
                        <span
                          className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                            value ? 'translate-x-6' : 'translate-x-1'
                          }`}
                        />
                      </button>
                    </div>
                  );
                })}

              {/* Render remaining fields */}
              {schema
                .filter((field) => !(['state', 'enabled', 'isEnabled'].includes(field.key) && field.type === 'toggle'))
                .map((field) => (
                  <div key={field.key}>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      {field.label}
                    </label>
                    {renderField(field)}
                  </div>
                ))}

              {/* Show computed policy for IAM roles */}
              {node.type === 'iam-role' && (
                <PolicyViewer roleId={node.id} />
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-gray-200 flex-shrink-0">
          <div className="text-xs text-gray-500">
            Node ID: {node.id}
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
