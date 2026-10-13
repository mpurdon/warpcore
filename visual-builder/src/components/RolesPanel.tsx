import { useState, useMemo, useEffect } from 'react';
import { createPortal } from 'react-dom';
import {
  Shield,
  Plus,
  AlertTriangle,
  Check,
  Bot,
  Zap,
  Globe,
  X,
  Sparkles,
  Copy,
  ChevronRight,
  ChevronDown,
} from 'lucide-react';
import { useStore } from '../store/useStore';
import { computeRolePolicy, getPolicySummary, roleAssumableSources, generateIAMPolicyJSON } from '../utils/rolePolicy';

// Icons for different principal types
const principalIcons: Record<string, typeof Bot> = {
  agent: Bot,
  lambda: Bot,
  'api-gateway': Globe,
  eventbridge: Zap,
  'eventbridge-rule': Zap,
};

// Get the actual name of a resource from its config
function getResourceName(node: { type?: string; data?: { label?: string; config?: Record<string, any> }; id: string }): string {
  const config = node.data?.config || {};
  const nodeType = node.type || '';

  // Type-specific name fields
  const nameFields: Record<string, string[]> = {
    'agent': ['name', 'functionName'],
    'lambda': ['functionName', 'name'],
    'api-gateway': ['apiName', 'name'],
    'eventbridge': ['busName', 'name'],
    'eventbridge-rule': ['ruleName', 'name'],
    'eventbridge-pipes': ['pipeName', 'name'],
    'kinesis-firehose': ['deliveryStreamName', 'name'],
  };

  const fields = nameFields[nodeType] || ['name'];
  for (const field of fields) {
    if (config[field]) return config[field];
  }

  // Fall back to label, then id
  return node.data?.label || node.id;
}

interface RoleSummary {
  id: string;
  name: string;
  permissionCount: number;
  resourceCount: number;
  principals: Array<{ id: string; label: string; type: string }>;
  summary: string;
}

// Role Detail Drawer Component
function RoleDetailDrawer({
  role,
  onClose,
  onDelete,
  onUpdateName,
}: {
  role: RoleSummary;
  onClose: () => void;
  onDelete: () => void;
  onUpdateName: (name: string) => void;
}) {
  const { nodes, edges } = useStore();
  const [editingName, setEditingName] = useState(false);
  const [nameValue, setNameValue] = useState(role.name);
  const [copied, setCopied] = useState(false);
  const [policyExpanded, setPolicyExpanded] = useState(true);

  // Compute full policy for this role
  const policy = useMemo(() => computeRolePolicy(role.id, edges, nodes), [role.id, edges, nodes]);
  const policyJSON = useMemo(() => generateIAMPolicyJSON(policy), [policy]);

  // Close on ESC
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const handleCopyPolicy = () => {
    navigator.clipboard.writeText(JSON.stringify(policyJSON, null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleSaveName = () => {
    if (nameValue.trim()) {
      onUpdateName(nameValue.trim());
    }
    setEditingName(false);
  };

  return createPortal(
    <div className="fixed inset-0 z-50 flex justify-end">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/20"
        onClick={onClose}
      />

      {/* Drawer */}
      <div className="relative w-96 max-w-full bg-surface shadow-2xl flex flex-col h-full animate-slide-in-right">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-gray-200 flex-shrink-0">
          <div className="flex items-center gap-2 min-w-0 flex-1">
            <Shield size={18} className="text-yellow-600 flex-shrink-0" />
            {editingName ? (
              <input
                type="text"
                value={nameValue}
                onChange={(e) => setNameValue(e.target.value)}
                onBlur={handleSaveName}
                onKeyDown={(e) => e.key === 'Enter' && handleSaveName()}
                className="flex-1 px-2 py-1 border border-yellow-400 rounded text-sm font-semibold focus:outline-none focus:ring-2 focus:ring-yellow-200"
                autoFocus
              />
            ) : (
              <h2
                className="font-semibold text-gray-800 truncate cursor-pointer hover:text-yellow-600"
                onClick={() => setEditingName(true)}
                title="Click to edit name"
              >
                {role.name}
              </h2>
            )}
          </div>
          <button
            onClick={onClose}
            className="p-1.5 hover:bg-gray-100 rounded text-gray-400 hover:text-gray-600 transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {/* Trust Policy */}
          <div className="p-3 bg-green-50 border border-green-200 rounded-lg">
            <div className="flex items-center gap-2 text-sm text-green-700">
              <Sparkles size={14} />
              <span>Can be assumed by Lambda functions</span>
            </div>
          </div>

          {/* Principals */}
          <div>
            <h3 className="text-sm font-medium text-gray-700 mb-2">Used By</h3>
            {role.principals.length === 0 ? (
              <p className="text-xs text-amber-600 bg-amber-50 p-3 rounded-lg border border-amber-200">
                This role is not assigned to any connections yet. Assign it when connecting an agent to a resource.
              </p>
            ) : (
              <div className="space-y-1.5">
                {role.principals.map(principal => {
                  const Icon = principalIcons[principal.type] || Bot;
                  return (
                    <div
                      key={principal.id}
                      className="flex items-center gap-2 p-2 bg-blue-50 rounded-lg text-sm text-blue-700"
                    >
                      <Icon size={14} />
                      <span>{principal.label}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Computed Policy */}
          <div>
            <button
              onClick={() => setPolicyExpanded(!policyExpanded)}
              className="flex items-center gap-2 text-sm font-medium text-gray-700 mb-2 hover:text-gray-900"
            >
              {policyExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
              IAM Policy ({policy.statements.length} statement{policy.statements.length !== 1 ? 's' : ''})
            </button>

            {policyExpanded && (
              <>
                {policy.statements.length === 0 ? (
                  <p className="text-xs text-gray-500 italic p-3 bg-gray-50 rounded-lg">
                    No permissions configured. Connect this role to resources to generate policy.
                  </p>
                ) : (
                  <div className="space-y-3">
                    {/* Permission summary cards */}
                    <div className="space-y-2">
                      {policy.statements.map((stmt, idx) => (
                        <div
                          key={idx}
                          className="p-2 bg-gray-50 border border-gray-200 rounded-lg"
                        >
                          <div className="font-medium text-xs text-gray-700 mb-1">
                            {stmt.resourceLabel} ({stmt.resourceType})
                          </div>
                          <div className="flex flex-wrap gap-1">
                            {stmt.actions.map(action => (
                              <code key={action} className="px-1.5 py-0.5 bg-yellow-100 text-yellow-700 rounded text-[10px]">
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
                        onClick={handleCopyPolicy}
                        className="absolute top-2 right-2 p-1.5 bg-chrome-hover hover:bg-chrome-muted/40 rounded text-chrome-fg z-10"
                        title="Copy policy JSON"
                      >
                        {copied ? <Check size={12} className="text-green-400" /> : <Copy size={12} />}
                      </button>
                      <pre className="p-3 bg-chrome text-chrome-fg rounded-lg text-[10px] overflow-x-auto max-h-48">
                        {JSON.stringify(policyJSON, null, 2)}
                      </pre>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-gray-200 flex-shrink-0">
          <button
            onClick={() => {
              if (confirm('Are you sure you want to delete this role?')) {
                onDelete();
              }
            }}
            className="w-full py-2 text-sm text-red-600 bg-red-50 hover:bg-red-100 rounded-lg border border-red-200 transition-colors"
          >
            Delete Role
          </button>
        </div>
      </div>

      <style>{`
        @keyframes slide-in-right {
          from {
            transform: translateX(100%);
          }
          to {
            transform: translateX(0);
          }
        }
        .animate-slide-in-right {
          animation: slide-in-right 0.2s ease-out;
        }
      `}</style>
    </div>,
    document.body
  );
}

export default function RolesPanel() {
  const { nodes, edges, setNodes } = useStore();
  const [showCreateRole, setShowCreateRole] = useState(false);
  const [newRoleName, setNewRoleName] = useState('');
  const [selectedRoleId, setSelectedRoleId] = useState<string | null>(null);

  // Get all role nodes and compute their summaries
  const roleSummaries = useMemo((): RoleSummary[] => {
    const roleNodes = nodes.filter(n => n.type === 'iam-role');

    return roleNodes.map(roleNode => {
      const policy = computeRolePolicy(roleNode.id, edges, nodes);

      // Find all principals (nodes that use this role via edges)
      const principals: Array<{ id: string; label: string; type: string }> = [];
      edges.forEach(edge => {
        if (edge.data?.roleId === roleNode.id) {
          const sourceNode = nodes.find(n => n.id === edge.source);
          if (sourceNode && roleAssumableSources.includes(sourceNode.type || '')) {
            if (!principals.find(p => p.id === sourceNode.id)) {
              principals.push({
                id: sourceNode.id,
                label: getResourceName(sourceNode),
                type: sourceNode.type || '',
              });
            }
          }
        }
      });

      return {
        id: roleNode.id,
        name: roleNode.data?.config?.roleName || roleNode.data?.label || 'Unnamed Role',
        permissionCount: policy.statements.reduce((acc, s) => acc + s.actions.length, 0),
        resourceCount: policy.statements.length,
        principals,
        summary: getPolicySummary(policy),
      };
    });
  }, [nodes, edges]);

  // Count roles and check thresholds
  const roleCount = roleSummaries.length;
  const hasWarning = roleCount > 10;
  const hasCritical = roleCount > 20;

  // Suggestions for role consolidation
  const consolidationSuggestions = useMemo(() => {
    const suggestions: string[] = [];

    // Check for roles with no principals
    const orphanRoles = roleSummaries.filter(r => r.principals.length === 0);
    if (orphanRoles.length > 0) {
      suggestions.push(`${orphanRoles.length} role${orphanRoles.length > 1 ? 's have' : ' has'} no assigned principals`);
    }

    // Check for roles with similar permission patterns
    if (roleCount > 3) {
      const permPatterns = new Map<string, string[]>();
      roleSummaries.forEach(role => {
        if (!permPatterns.has(role.summary)) {
          permPatterns.set(role.summary, []);
        }
        permPatterns.get(role.summary)!.push(role.name);
      });

      permPatterns.forEach((roles, pattern) => {
        if (roles.length > 1 && pattern !== 'No permissions configured') {
          suggestions.push(`${roles.length} roles have similar permissions (${pattern})`);
        }
      });
    }

    return suggestions;
  }, [roleSummaries, roleCount]);

  const handleCreateRole = () => {
    if (!newRoleName.trim()) return;

    const roleId = `iam-role-${Date.now()}`;
    const newRoleNode = {
      id: roleId,
      type: 'iam-role',
      position: { x: 100, y: 100 }, // Default position (won't be shown)
      hidden: true, // Always hidden - roles are managed via panel only
      data: {
        label: newRoleName,
        config: {
          roleName: newRoleName,
        },
      },
    };

    setNodes([...nodes, newRoleNode]);
    setShowCreateRole(false);
    setNewRoleName('');
  };

  const deleteRole = (roleId: string) => {
    const updatedNodes = nodes.filter(n => n.id !== roleId);
    setNodes(updatedNodes);
    setSelectedRoleId(null);
  };

  const updateRoleName = (roleId: string, newName: string) => {
    setNodes(nodes.map(n => {
      if (n.id === roleId) {
        return {
          ...n,
          data: {
            ...n.data,
            label: newName,
            config: {
              ...n.data?.config,
              roleName: newName,
            },
          },
        };
      }
      return n;
    }));
  };

  const selectedRole = roleSummaries.find(r => r.id === selectedRoleId);

  if (roleCount === 0 && !showCreateRole) {
    return (
      <div className="flex flex-col h-full">
        <div className="p-4">
          <p className="text-xs text-gray-500 mb-3">
            No roles yet. Roles are automatically suggested when you connect agents to resources.
          </p>
          <button
            onClick={() => setShowCreateRole(true)}
            className="w-full py-2 text-sm text-yellow-700 bg-yellow-50 hover:bg-yellow-100 rounded-lg border border-yellow-200 transition-colors flex items-center justify-center gap-2"
          >
            <Plus size={14} />
            Create Role
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Role count header */}
      <div className="p-3 border-b border-gray-100 flex-shrink-0">
        <div className="flex items-center gap-2">
          <span className={`px-2 py-1 text-xs font-medium rounded-full ${
            hasCritical ? 'bg-red-100 text-red-700' :
            hasWarning ? 'bg-amber-100 text-amber-700' :
            'bg-gray-100 text-gray-600'
          }`}>
            {roleCount} role{roleCount !== 1 ? 's' : ''}
          </span>
        </div>
      </div>

      {/* Warning banner */}
      {(hasWarning || consolidationSuggestions.length > 0) && (
        <div className={`mx-3 mt-2 p-2 rounded-lg text-xs ${
          hasCritical ? 'bg-red-50 border border-red-200' :
          'bg-amber-50 border border-amber-200'
        }`}>
          <div className="flex items-start gap-2">
            <AlertTriangle size={14} className={hasCritical ? 'text-red-500' : 'text-amber-500'} />
            <div>
              {hasCritical && (
                <p className="font-medium text-red-700 mb-1">Too many roles ({roleCount})</p>
              )}
              {hasWarning && !hasCritical && (
                <p className="font-medium text-amber-700 mb-1">Consider consolidating roles</p>
              )}
              {consolidationSuggestions.slice(0, 2).map((suggestion, i) => (
                <p key={i} className={hasCritical ? 'text-red-600' : 'text-amber-600'}>
                  {suggestion}
                </p>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Role list */}
      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-2">
        {roleSummaries.map(role => (
          <div
            key={role.id}
            className="p-3 rounded-lg border border-gray-200 hover:border-yellow-300 hover:bg-yellow-50/50 transition-all cursor-pointer group"
            onClick={() => setSelectedRoleId(role.id)}
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 min-w-0">
                <Shield size={14} className="text-yellow-600 flex-shrink-0" />
                <span className="font-medium text-sm text-gray-800 truncate">
                  {role.name}
                </span>
              </div>
              <ChevronRight size={16} className="text-gray-400 group-hover:text-yellow-600 transition-colors" />
            </div>

            {/* Permissions summary */}
            <div className="flex items-center gap-2 mt-1.5 text-xs">
              {role.permissionCount > 0 ? (
                <>
                  <span className="px-1.5 py-0.5 bg-yellow-100 text-yellow-700 rounded">
                    {role.permissionCount} perm
                  </span>
                  <span className="text-gray-400 truncate">{role.summary}</span>
                </>
              ) : (
                <span className="text-gray-400 italic">No permissions</span>
              )}
            </div>

            {/* Principals using this role */}
            {role.principals.length > 0 && (
              <div className="flex items-center gap-1.5 mt-2 flex-wrap">
                <span className="text-xs text-gray-500">Used by:</span>
                {role.principals.slice(0, 2).map(principal => {
                  const Icon = principalIcons[principal.type] || Bot;
                  return (
                    <span
                      key={principal.id}
                      className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-blue-50 text-blue-700 rounded text-xs"
                    >
                      <Icon size={10} />
                      {principal.label}
                    </span>
                  );
                })}
                {role.principals.length > 2 && (
                  <span className="text-xs text-gray-400">
                    +{role.principals.length - 2}
                  </span>
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Create role section */}
      <div className="p-3 border-t border-gray-200 flex-shrink-0">
        {showCreateRole ? (
          <div className="space-y-2">
            <input
              type="text"
              value={newRoleName}
              onChange={(e) => setNewRoleName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleCreateRole()}
              placeholder="Role name..."
              className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-yellow-200 focus:border-yellow-400"
              autoFocus
            />
            <div className="flex gap-2">
              <button
                onClick={handleCreateRole}
                disabled={!newRoleName.trim()}
                className="flex-1 py-1.5 text-sm bg-yellow-500 text-white rounded-lg hover:bg-yellow-600 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-1"
              >
                <Check size={14} />
                Create
              </button>
              <button
                onClick={() => {
                  setShowCreateRole(false);
                  setNewRoleName('');
                }}
                className="px-3 py-1.5 text-sm bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button
            onClick={() => setShowCreateRole(true)}
            className="w-full py-2 text-sm text-yellow-700 bg-yellow-50 hover:bg-yellow-100 rounded-lg border border-yellow-200 transition-colors flex items-center justify-center gap-2"
          >
            <Plus size={14} />
            Create Role
          </button>
        )}
      </div>

      {/* Role Detail Drawer */}
      {selectedRole && (
        <RoleDetailDrawer
          role={selectedRole}
          onClose={() => setSelectedRoleId(null)}
          onDelete={() => deleteRole(selectedRole.id)}
          onUpdateName={(name) => updateRoleName(selectedRole.id, name)}
        />
      )}
    </div>
  );
}
