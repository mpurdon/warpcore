import { X, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useStore } from '../store/useStore';

interface Props {
  edgeId: string;
  onClose: () => void;
}

const permissionTemplates = {
  read: {
    name: 'Read Only',
    s3: ['s3:GetObject', 's3:ListBucket'],
    dynamodb: ['dynamodb:GetItem', 'dynamodb:Query', 'dynamodb:Scan'],
    sqs: ['sqs:ReceiveMessage', 'sqs:GetQueueAttributes'],
    sns: ['sns:Subscribe', 'sns:ListSubscriptions'],
  },
  write: {
    name: 'Write Only',
    s3: ['s3:PutObject', 's3:DeleteObject'],
    dynamodb: ['dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem'],
    sqs: ['sqs:SendMessage', 'sqs:DeleteMessage'],
    sns: ['sns:Publish'],
  },
  full: {
    name: 'Full Access',
    s3: ['s3:*'],
    dynamodb: ['dynamodb:*'],
    sqs: ['sqs:*'],
    sns: ['sns:*'],
  },
};

export default function PermissionEditorModal({ edgeId, onClose }: Props) {
  const { edges, setEdges } = useStore();
  const edge = edges.find(e => e.id === edgeId);
  
  const [permissions, setPermissions] = useState<string[]>(edge?.data?.permissions || []);
  const [customPermission, setCustomPermission] = useState('');

  if (!edge) return null;

  const targetNode = edge.target;
  const resourceType = targetNode.split('-')[0]; // Extract type from node ID

  const handleApplyTemplate = (template: 'read' | 'write' | 'full') => {
    const templatePerms = permissionTemplates[template][resourceType as keyof typeof permissionTemplates.read] || [];
    setPermissions([...new Set([...permissions, ...templatePerms])]);
  };

  const handleAddCustom = () => {
    if (customPermission && !permissions.includes(customPermission)) {
      setPermissions([...permissions, customPermission]);
      setCustomPermission('');
    }
  };

  const handleRemove = (permission: string) => {
    setPermissions(permissions.filter(p => p !== permission));
  };

  const handleSave = () => {
    const updatedEdges = edges.map(e => 
      e.id === edgeId 
        ? { ...e, data: { ...e.data, permissions } }
        : e
    );
    setEdges(updatedEdges);
    onClose();
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-xl w-[600px] max-h-[80vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="p-4 border-b border-gray-200 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Edit Permissions</h2>
          <button
            onClick={onClose}
            className="p-1 hover:bg-gray-100 rounded"
          >
            <X size={20} />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4">
          {/* Templates */}
          <div className="mb-6">
            <h3 className="text-sm font-semibold mb-2">Permission Templates</h3>
            <div className="flex gap-2">
              <button
                onClick={() => handleApplyTemplate('read')}
                className="px-3 py-2 bg-blue-100 text-blue-700 rounded hover:bg-blue-200 text-sm"
              >
                Read Only
              </button>
              <button
                onClick={() => handleApplyTemplate('write')}
                className="px-3 py-2 bg-green-100 text-green-700 rounded hover:bg-green-200 text-sm"
              >
                Write Only
              </button>
              <button
                onClick={() => handleApplyTemplate('full')}
                className="px-3 py-2 bg-purple-100 text-purple-700 rounded hover:bg-purple-200 text-sm"
              >
                Full Access
              </button>
            </div>
          </div>

          {/* Current Permissions */}
          <div className="mb-6">
            <h3 className="text-sm font-semibold mb-2">Current Permissions ({permissions.length})</h3>
            {permissions.length === 0 ? (
              <div className="text-sm text-gray-500 italic">No permissions added yet</div>
            ) : (
              <div className="space-y-2">
                {permissions.map((permission, index) => (
                  <div
                    key={index}
                    className="flex items-center justify-between p-2 bg-gray-50 rounded border border-gray-200"
                  >
                    <code className="text-sm">{permission}</code>
                    <button
                      onClick={() => handleRemove(permission)}
                      className="p-1 hover:bg-red-100 rounded text-red-600"
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Add Custom Permission */}
          <div>
            <h3 className="text-sm font-semibold mb-2">Add Custom Permission</h3>
            <div className="flex gap-2">
              <input
                type="text"
                value={customPermission}
                onChange={(e) => setCustomPermission(e.target.value)}
                onKeyPress={(e) => e.key === 'Enter' && handleAddCustom()}
                placeholder="e.g., s3:GetObject"
                className="flex-1 px-3 py-2 border border-gray-300 rounded text-sm"
              />
              <button
                onClick={handleAddCustom}
                disabled={!customPermission}
                className="px-3 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
              >
                <Plus size={16} />
                Add
              </button>
            </div>
            <div className="mt-2 text-xs text-gray-500">
              Common IAM actions: s3:GetObject, dynamodb:PutItem, sqs:SendMessage, sns:Publish
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-gray-200 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-4 py-2 border border-gray-300 rounded hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
          >
            Save Permissions
          </button>
        </div>
      </div>
    </div>
  );
}
