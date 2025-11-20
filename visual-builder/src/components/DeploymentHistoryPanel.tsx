import { History, CheckCircle, XCircle, Clock, ChevronRight } from 'lucide-react';
import { useStore } from '../store/useStore';
import { useState } from 'react';

export default function DeploymentHistoryPanel() {
  const { deploymentHistory } = useStore();
  const [selectedDeployment, setSelectedDeployment] = useState<string | null>(null);

  if (deploymentHistory.length === 0) {
    return (
      <div className="p-4 text-center text-gray-500">
        <History size={48} className="mx-auto mb-2 opacity-50" />
        <p>No deployment history yet</p>
      </div>
    );
  }

  const selected = deploymentHistory.find(d => d.id === selectedDeployment);

  return (
    <div className="h-full flex">
      {/* History List */}
      <div className="w-80 border-r border-gray-200 overflow-y-auto">
        <div className="p-4 border-b border-gray-200">
          <h3 className="font-semibold flex items-center gap-2">
            <History size={18} />
            Deployment History
          </h3>
        </div>
        
        <div className="divide-y divide-gray-200">
          {deploymentHistory.map((deployment) => {
            const StatusIcon = deployment.status === 'success' ? CheckCircle : XCircle;
            const statusColor = deployment.status === 'success' ? 'text-green-600' : 'text-red-600';
            
            return (
              <div
                key={deployment.id}
                onClick={() => setSelectedDeployment(deployment.id)}
                className={`p-4 cursor-pointer hover:bg-gray-50 ${
                  selectedDeployment === deployment.id ? 'bg-blue-50' : ''
                }`}
              >
                <div className="flex items-start justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <StatusIcon size={16} className={statusColor} />
                    <span className="text-sm font-medium">
                      {deployment.timestamp.toLocaleDateString()} {deployment.timestamp.toLocaleTimeString()}
                    </span>
                  </div>
                  <ChevronRight size={16} className="text-gray-400" />
                </div>
                
                <div className="text-xs text-gray-600 space-y-1">
                  <div>Duration: {deployment.duration}s</div>
                  <div>
                    {deployment.changes.created.length > 0 && (
                      <span className="text-green-600">+{deployment.changes.created.length} created</span>
                    )}
                    {deployment.changes.updated.length > 0 && (
                      <span className="text-blue-600 ml-2">~{deployment.changes.updated.length} updated</span>
                    )}
                    {deployment.changes.deleted.length > 0 && (
                      <span className="text-red-600 ml-2">-{deployment.changes.deleted.length} deleted</span>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Deployment Details */}
      {selected ? (
        <div className="flex-1 overflow-y-auto p-6">
          <div className="mb-6">
            <h2 className="text-xl font-semibold mb-2">Deployment Details</h2>
            <div className="text-sm text-gray-600">
              {selected.timestamp.toLocaleString()}
            </div>
          </div>

          <div className="space-y-6">
            {/* Status */}
            <div>
              <h3 className="text-sm font-semibold mb-2">Status</h3>
              <div className={`inline-flex items-center gap-2 px-3 py-1 rounded ${
                selected.status === 'success' ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'
              }`}>
                {selected.status === 'success' ? <CheckCircle size={16} /> : <XCircle size={16} />}
                {selected.status === 'success' ? 'Success' : 'Failed'}
              </div>
            </div>

            {/* Duration */}
            <div>
              <h3 className="text-sm font-semibold mb-2">Duration</h3>
              <div className="flex items-center gap-2 text-gray-700">
                <Clock size={16} />
                {selected.duration} seconds
              </div>
            </div>

            {/* Changes */}
            <div>
              <h3 className="text-sm font-semibold mb-2">Changes</h3>
              
              {selected.changes.created.length > 0 && (
                <div className="mb-3">
                  <div className="text-sm font-medium text-green-700 mb-1">
                    Created ({selected.changes.created.length})
                  </div>
                  <ul className="list-disc list-inside text-sm text-gray-700 space-y-1">
                    {selected.changes.created.map((resource, index) => (
                      <li key={index}>{resource}</li>
                    ))}
                  </ul>
                </div>
              )}

              {selected.changes.updated.length > 0 && (
                <div className="mb-3">
                  <div className="text-sm font-medium text-blue-700 mb-1">
                    Updated ({selected.changes.updated.length})
                  </div>
                  <ul className="list-disc list-inside text-sm text-gray-700 space-y-1">
                    {selected.changes.updated.map((resource, index) => (
                      <li key={index}>{resource}</li>
                    ))}
                  </ul>
                </div>
              )}

              {selected.changes.deleted.length > 0 && (
                <div className="mb-3">
                  <div className="text-sm font-medium text-red-700 mb-1">
                    Deleted ({selected.changes.deleted.length})
                  </div>
                  <ul className="list-disc list-inside text-sm text-gray-700 space-y-1">
                    {selected.changes.deleted.map((resource, index) => (
                      <li key={index}>{resource}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>

            {/* Actions */}
            <div className="pt-4 border-t border-gray-200">
              <button className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700">
                Rollback to this Deployment
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="flex-1 flex items-center justify-center text-gray-500">
          Select a deployment to view details
        </div>
      )}
    </div>
  );
}
