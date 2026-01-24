import { Shield } from 'lucide-react';
import { NodeStatus, useStore } from '../../store/useStore';
import NodeWrapper from './NodeWrapper';
import BidirectionalHandles from './BidirectionalHandles';
import { computeRolePolicy } from '../../utils/rolePolicy';

interface IAMRoleNodeData {
  label: string;
  status?: NodeStatus;
  config?: {
    roleName?: string;
    description?: string;
  };
}

interface Props {
  id: string;
  data: IAMRoleNodeData;
  selected: boolean;
}

export default function IAMRoleNode({ id, data, selected }: Props) {
  const { edges, nodes } = useStore();
  const statusClass = data.status ? `node-${data.status}` : '';
  const config = data.config || {};

  // Compute the role's policy from all edges that reference this role
  const policy = computeRolePolicy(id, edges, nodes);
  const permissionCount = policy.statements.reduce((acc, s) => acc + s.actions.length, 0);
  const resourceCount = policy.statements.length;

  const displayName = config.roleName || data.label;
  const hasCustomName = !!config.roleName;

  return (
    <NodeWrapper nodeId={id} selected={selected}>
      <div className={`node-inner px-4 py-3 min-w-[180px] ${statusClass}`}>
        <BidirectionalHandles nodeId={id} />

        <div className="flex items-center gap-2">
          <Shield size={18} className="text-yellow-600" />
          <div>
            <div className="font-semibold text-sm text-gray-800">{displayName}</div>
            {hasCustomName && (
              <div className="text-xs text-gray-500">IAM Role</div>
            )}
          </div>
        </div>

        {config.description && (
          <div className="text-xs text-gray-500 mt-1 truncate max-w-[160px]">
            {config.description}
          </div>
        )}

        <div className="flex items-center gap-2 mt-2 text-xs">
          {permissionCount > 0 ? (
            <>
              <span className="px-1.5 py-0.5 bg-yellow-100 text-yellow-700 rounded">
                {permissionCount} permission{permissionCount !== 1 ? 's' : ''}
              </span>
              <span className="text-gray-400">
                {resourceCount} resource{resourceCount !== 1 ? 's' : ''}
              </span>
            </>
          ) : (
            <span className="text-gray-400 italic">No permissions yet</span>
          )}
        </div>
      </div>
    </NodeWrapper>
  );
}
