import { X, CheckCircle, XCircle, Clock, AlertTriangle } from 'lucide-react';
import { useStore } from '../store/useStore';

interface Props {
  nodeId: string;
}

export default function ExecutionLogPanel({ nodeId }: Props) {
  const { executionLogs, setShowExecutionPanel } = useStore();
  const log = executionLogs.get(nodeId);

  if (!log) {
    return (
      <div className="execution-log-panel open">
        <div className="p-4 border-b border-gray-200 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Execution Log</h2>
          <button
            onClick={() => setShowExecutionPanel(false)}
            className="p-1 hover:bg-gray-100 rounded"
          >
            <X size={20} />
          </button>
        </div>
        <div className="p-4 text-gray-500">No execution data available</div>
      </div>
    );
  }

  const StatusIcon = {
    success: CheckCircle,
    failed: XCircle,
    deploying: Clock,
    warning: AlertTriangle,
    pending: Clock,
  }[log.status];

  const statusColor = {
    success: 'text-green-600',
    failed: 'text-red-600',
    deploying: 'text-blue-600',
    warning: 'text-yellow-600',
    pending: 'text-gray-600',
  }[log.status];

  return (
    <div className="execution-log-panel open">
      {/* Header */}
      <div className="p-4 border-b border-gray-200 flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">{nodeId}</h2>
          <div className={`flex items-center gap-2 mt-1 ${statusColor}`}>
            <StatusIcon size={16} />
            <span className="text-sm font-medium">
              {log.status === 'success' && 'Deployed Successfully'}
              {log.status === 'failed' && 'Deployment Failed'}
              {log.status === 'deploying' && 'Deploying...'}
              {log.status === 'warning' && 'Deployed with Warnings'}
              {log.status === 'pending' && 'Pending'}
            </span>
          </div>
          {log.duration && (
            <span className="text-xs text-gray-500">Duration: {log.duration}s</span>
          )}
        </div>
        <button
          onClick={() => setShowExecutionPanel(false)}
          className="p-1 hover:bg-gray-100 rounded"
        >
          <X size={20} />
        </button>
      </div>

      {/* Physical ID */}
      {log.physicalId && (
        <div className="p-4 bg-gray-50 border-b border-gray-200">
          <div className="text-xs text-gray-500">Physical ID</div>
          <div className="text-sm font-mono text-gray-700 mt-1">{log.physicalId}</div>
        </div>
      )}

      {/* Execution Steps */}
      <div className="p-4 border-b border-gray-200">
        <h3 className="text-sm font-semibold mb-3">📋 Execution Steps</h3>
        <div className="space-y-2">
          {log.steps.map((step, index) => {
            const StepIcon = {
              success: CheckCircle,
              failed: XCircle,
              running: Clock,
              pending: Clock,
            }[step.status];

            const stepColor = {
              success: 'text-green-600',
              failed: 'text-red-600',
              running: 'text-blue-600',
              pending: 'text-gray-400',
            }[step.status];

            return (
              <div key={step.id} className="flex items-center gap-2">
                <StepIcon size={16} className={stepColor} />
                <span className="text-sm flex-1">{index + 1}. {step.name}</span>
                {step.duration && (
                  <span className="text-xs text-gray-500">{step.duration}s</span>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Logs */}
      <div className="p-4 border-b border-gray-200">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold">📝 Logs</h3>
          <select className="text-xs border border-gray-300 rounded px-2 py-1">
            <option>All</option>
            <option>ERROR</option>
            <option>WARNING</option>
            <option>INFO</option>
            <option>DEBUG</option>
          </select>
        </div>
        <div className="bg-gray-900 text-gray-100 rounded p-3 font-mono text-xs max-h-64 overflow-y-auto">
          {log.logs.map((entry, index) => (
            <div key={index} className="mb-1">
              <span className="text-gray-500">
                {entry.timestamp.toLocaleTimeString()}
              </span>{' '}
              <span className={
                entry.level === 'ERROR' ? 'text-red-400' :
                entry.level === 'WARNING' ? 'text-yellow-400' :
                entry.level === 'INFO' ? 'text-blue-400' :
                'text-gray-400'
              }>
                {entry.level}
              </span>{' '}
              <span>{entry.message}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Configuration */}
      <div className="p-4 border-b border-gray-200">
        <h3 className="text-sm font-semibold mb-3">🔧 Configuration</h3>
        <pre className="bg-gray-50 rounded p-3 text-xs overflow-x-auto">
          {JSON.stringify(log.configuration, null, 2)}
        </pre>
      </div>

      {/* AWS API Calls */}
      <div className="p-4">
        <h3 className="text-sm font-semibold mb-3">📊 AWS API Calls ({log.apiCalls.length})</h3>
        <div className="space-y-2">
          {log.apiCalls.map((call, index) => (
            <div key={index} className="flex items-center justify-between p-2 bg-gray-50 rounded">
              <div className="flex items-center gap-2">
                <CheckCircle size={14} className="text-green-600" />
                <span className="text-sm font-mono">{call.service}:{call.operation}</span>
              </div>
              <div className="flex items-center gap-3 text-xs text-gray-500">
                <span>{call.duration}s</span>
                <span className="text-green-600">{call.statusCode} OK</span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Error Details */}
      {log.error && (
        <div className="p-4 bg-red-50 border-t border-red-200">
          <h3 className="text-sm font-semibold text-red-900 mb-2">❌ Error Details</h3>
          <div className="text-sm text-red-800 mb-2">
            <div className="font-semibold">{log.error.type}</div>
            <div className="mt-1">{log.error.message}</div>
          </div>
          {log.error.suggestedFixes.length > 0 && (
            <div className="mt-3">
              <div className="text-sm font-semibold text-red-900 mb-1">📋 Suggested Fixes:</div>
              <ul className="list-disc list-inside text-sm text-red-800 space-y-1">
                {log.error.suggestedFixes.map((fix, index) => (
                  <li key={index}>{fix}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
