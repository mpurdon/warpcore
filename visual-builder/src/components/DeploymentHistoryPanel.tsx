import { History, CheckCircle, XCircle, Clock, ChevronRight, RotateCcw, GitCompare, RefreshCw, Download, AlertTriangle } from 'lucide-react';
import { useStore, DeploymentHistory } from '../store/useStore';
import { useState, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/tauri';

export default function DeploymentHistoryPanel() {
  const { deploymentHistory, configPath, currentEnvironment, setIsDeploying } = useStore();
  const [selectedDeployment, setSelectedDeployment] = useState<string | null>(null);
  const [compareWith, setCompareWith] = useState<string | null>(null);
  const [isRollingBack, setIsRollingBack] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showConfirmRollback, setShowConfirmRollback] = useState(false);

  const handleRollback = useCallback(async (deploymentId: string) => {
    if (!configPath) return;

    try {
      setIsRollingBack(true);
      setError(null);
      setIsDeploying(true);

      await invoke('execute_cli_command', {
        command: 'warpcore',
        args: ['history', 'rollback', deploymentId, '--env', currentEnvironment, '-y'],
      });

      setShowConfirmRollback(false);
    } catch (err) {
      setError(`Rollback failed: ${err}`);
    } finally {
      setIsRollingBack(false);
      setIsDeploying(false);
    }
  }, [configPath, currentEnvironment, setIsDeploying]);

  const handleRefresh = useCallback(async () => {
    if (!configPath) return;

    try {
      setIsRefreshing(true);
      setError(null);
      await invoke('get_deployment_history', {
        configPath,
        environment: currentEnvironment,
        limit: 20,
      });
    } catch (err) {
      setError(`Failed to refresh history: ${err}`);
    } finally {
      setIsRefreshing(false);
    }
  }, [configPath, currentEnvironment]);

  const formatDuration = (seconds: number): string => {
    if (seconds < 60) return `${seconds.toFixed(1)}s`;
    const minutes = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${minutes}m ${secs}s`;
  };

  const exportHistory = (deployment: DeploymentHistory) => {
    const data = JSON.stringify(deployment, null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `deployment-${deployment.id}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (deploymentHistory.length === 0) {
    return (
      <div className="p-8 text-center text-gray-500">
        <History size={48} className="mx-auto mb-4 opacity-50" />
        <p className="text-lg mb-2">No deployment history yet</p>
        <p className="text-sm">Deploy your infrastructure to see history here</p>
        {configPath && (
          <button
            onClick={handleRefresh}
            disabled={isRefreshing}
            className="mt-4 px-4 py-2 bg-gray-100 hover:bg-gray-200 rounded-lg text-sm flex items-center gap-2 mx-auto disabled:opacity-50"
          >
            <RefreshCw size={14} className={isRefreshing ? 'animate-spin' : ''} />
            {isRefreshing ? 'Refreshing...' : 'Refresh from S3'}
          </button>
        )}
      </div>
    );
  }

  const selected = deploymentHistory.find(d => d.id === selectedDeployment);
  const compareDeployment = compareWith ? deploymentHistory.find(d => d.id === compareWith) : null;

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
            const StatusIcon = deployment.status === 'deployed' ? CheckCircle : XCircle;
            const statusColor = deployment.status === 'deployed' ? 'text-green-600' : 'text-red-600';
            
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
                selected.status === 'deployed' ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'
              }`}>
                {selected.status === 'deployed' ? <CheckCircle size={16} /> : <XCircle size={16} />}
                {selected.status === 'deployed' ? 'Deployed' : 'Failed'}
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
            <div className="pt-4 border-t border-gray-200 space-y-3">
              <div className="flex gap-2">
                <button
                  onClick={() => setShowConfirmRollback(true)}
                  disabled={isRollingBack}
                  className="flex-1 px-4 py-2 bg-amber-600 text-white rounded hover:bg-amber-700 disabled:opacity-50 flex items-center justify-center gap-2"
                >
                  <RotateCcw size={16} />
                  Rollback to this Deployment
                </button>
                <button
                  onClick={() => exportHistory(selected)}
                  className="px-4 py-2 bg-gray-100 text-gray-700 rounded hover:bg-gray-200 flex items-center gap-2"
                >
                  <Download size={16} />
                  Export
                </button>
              </div>

              {/* Compare selector */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  <GitCompare size={14} className="inline mr-1" />
                  Compare with:
                </label>
                <select
                  value={compareWith || ''}
                  onChange={(e) => setCompareWith(e.target.value || null)}
                  className="w-full px-3 py-2 border border-gray-300 rounded text-sm"
                >
                  <option value="">Select deployment to compare...</option>
                  {deploymentHistory
                    .filter(d => d.id !== selected.id)
                    .map(d => (
                      <option key={d.id} value={d.id}>
                        {d.timestamp.toLocaleString()} - {d.status}
                      </option>
                    ))}
                </select>
              </div>

              {/* Comparison view */}
              {compareDeployment && (
                <div className="mt-4 p-4 bg-blue-50 rounded-lg border border-blue-200">
                  <h4 className="font-medium text-sm text-blue-800 mb-2">
                    Comparison with {compareDeployment.timestamp.toLocaleString()}
                  </h4>
                  <div className="grid grid-cols-2 gap-4 text-sm">
                    <div>
                      <div className="text-gray-600">Duration</div>
                      <div className="font-medium">
                        {formatDuration(selected.duration)} vs {formatDuration(compareDeployment.duration)}
                      </div>
                    </div>
                    <div>
                      <div className="text-gray-600">Status</div>
                      <div className="font-medium">
                        {selected.status} vs {compareDeployment.status}
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {error && (
              <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded text-red-700 text-sm">
                {error}
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="flex-1 flex items-center justify-center text-gray-500">
          <div className="text-center">
            <History size={32} className="mx-auto mb-2 opacity-50" />
            <p>Select a deployment to view details</p>
          </div>
        </div>
      )}

      {/* Rollback confirmation modal */}
      {showConfirmRollback && selected && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl w-[450px] p-6">
            <div className="flex items-start gap-3 mb-4">
              <div className="p-2 bg-amber-100 rounded-full">
                <AlertTriangle size={24} className="text-amber-600" />
              </div>
              <div>
                <h3 className="text-lg font-semibold">Confirm Rollback</h3>
                <p className="text-sm text-gray-600 mt-1">
                  Are you sure you want to rollback to this deployment?
                </p>
              </div>
            </div>

            <div className="bg-gray-50 rounded-lg p-4 mb-4">
              <div className="text-sm space-y-1">
                <div><strong>Deployment:</strong> {selected.id}</div>
                <div><strong>Date:</strong> {selected.timestamp.toLocaleString()}</div>
                <div><strong>Status:</strong> {selected.status}</div>
              </div>
            </div>

            <div className="text-sm text-gray-600 mb-4">
              This will restore your infrastructure to match the state of this deployment.
              Any changes made after this deployment will be reverted.
            </div>

            <div className="flex justify-end gap-3">
              <button
                onClick={() => setShowConfirmRollback(false)}
                disabled={isRollingBack}
                className="px-4 py-2 border border-gray-300 rounded hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={() => handleRollback(selected.id)}
                disabled={isRollingBack}
                className="px-4 py-2 bg-amber-600 text-white rounded hover:bg-amber-700 disabled:opacity-50 flex items-center gap-2"
              >
                {isRollingBack ? (
                  <>
                    <RefreshCw size={16} className="animate-spin" />
                    Rolling back...
                  </>
                ) : (
                  <>
                    <RotateCcw size={16} />
                    Confirm Rollback
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
