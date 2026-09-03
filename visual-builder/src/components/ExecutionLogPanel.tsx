import { useState } from 'react';
import { X, CheckCircle, XCircle, Clock, AlertTriangle, Bug } from 'lucide-react';
import { useStore } from '../store/useStore';
import type { LogEntry } from '../store/useStore';

type LevelFilter = 'ALL' | LogEntry['level'];

// DEBUG lines are hidden unless the user asked for them, either by turning on
// debug mode or by picking DEBUG explicitly in the filter.
const LEVEL_ORDER: LogEntry['level'][] = ['DEBUG', 'INFO', 'WARNING', 'ERROR'];

interface Props {
  nodeId: string;
  /**
   * Render as a block inside the inspector rather than as the slide-in
   * overlay. The content is identical; only the frame and the close button
   * differ, because the inspector owns its own header.
   */
  inline?: boolean;
}

export default function ExecutionLogPanel({ nodeId, inline = false }: Props) {
  const { executionLogs, setShowExecutionPanel, debugMode } = useStore();
  const log = executionLogs.get(nodeId);
  const [levelFilter, setLevelFilter] = useState<LevelFilter>('ALL');
  const frameClass = inline ? 'flex flex-col min-h-0 overflow-y-auto' : 'execution-log-panel open';

  if (!log) {
    return (
      <div className={frameClass}>
        {!inline && (
          <div className="p-4 border-b border-gray-200 flex items-center justify-between">
            <h2 className="text-lg font-semibold">Execution Log</h2>
            <button
              onClick={() => setShowExecutionPanel(false)}
              className="p-1 hover:bg-gray-100 rounded"
            >
              <X size={20} />
            </button>
          </div>
        )}
        <div className="p-4 text-sm text-gray-500">
          No execution data yet. It appears here after this resource has been deployed.
        </div>
      </div>
    );
  }

  const StatusIcon = {
    deployed: CheckCircle,
    failed: XCircle,
    deploying: Clock,
    warning: AlertTriangle,
    configured: CheckCircle,
    draft: Clock,
    present: Clock,
  }[log.status];

  // DEBUG is noise unless it was asked for; everything else always shows.
  const showDebug = debugMode || levelFilter === 'DEBUG';
  const visibleLogs = log.logs.filter((entry) => {
    if (entry.level === 'DEBUG' && !showDebug) return false;
    return levelFilter === 'ALL' || entry.level === levelFilter;
  });
  const hiddenDebugCount = showDebug
    ? 0
    : log.logs.filter((entry) => entry.level === 'DEBUG').length;

  const statusColor = {
    deployed: 'text-green-600',
    failed: 'text-red-600',
    deploying: 'text-blue-600',
    warning: 'text-yellow-600',
    configured: 'text-blue-600',
    draft: 'text-gray-600',
    present: 'text-gray-600',
  }[log.status];

  return (
    <div className={frameClass}>
      {/* Header */}
      <div className="p-4 border-b border-gray-200 flex items-center justify-between">
        <div>
          {!inline && <h2 className="text-lg font-semibold">{nodeId}</h2>}
          <div className={`flex items-center gap-2 mt-1 ${statusColor}`}>
            <StatusIcon size={16} />
            <span className="text-sm font-medium">
              {log.status === 'deployed' && 'Deployed Successfully'}
              {log.status === 'failed' && 'Deployment Failed'}
              {log.status === 'deploying' && 'Deploying...'}
              {log.status === 'warning' && 'Deployed with Warnings'}
              {log.status === 'configured' && 'Ready to Deploy'}
              {log.status === 'draft' && 'Not Configured'}
            </span>
          </div>
          {log.duration && (
            <span className="text-xs text-gray-500">Duration: {log.duration}s</span>
          )}
        </div>
        {!inline && (
          <button
            onClick={() => setShowExecutionPanel(false)}
            className="p-1 hover:bg-gray-100 rounded"
          >
            <X size={20} />
          </button>
        )}
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
              deployed: CheckCircle,
              failed: XCircle,
              deploying: Clock,
              warning: AlertTriangle,
              configured: CheckCircle,
              draft: Clock,
              present: Clock,
            }[step.status] || Clock;

            const stepColor = {
              deployed: 'text-green-600',
              failed: 'text-red-600',
              deploying: 'text-blue-600',
              warning: 'text-yellow-600',
              configured: 'text-blue-600',
              draft: 'text-gray-400',
              present: 'text-gray-400',
            }[step.status] || 'text-gray-400';

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
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold">📝 Logs</h3>
            {debugMode && (
              <span
                className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-amber-700 bg-amber-100 border border-amber-200 rounded px-1.5 py-0.5"
                title="Debug mode is on - this run was executed with --dev"
              >
                <Bug size={10} /> debug
              </span>
            )}
          </div>
          <select
            value={levelFilter}
            onChange={(e) => setLevelFilter(e.target.value as LevelFilter)}
            className="text-xs border border-gray-300 rounded px-2 py-1"
          >
            <option value="ALL">All</option>
            {[...LEVEL_ORDER].reverse().map((level) => (
              <option key={level} value={level}>{level}</option>
            ))}
          </select>
        </div>
        <div className="bg-gray-900 text-gray-100 rounded p-3 font-mono text-xs max-h-64 overflow-y-auto">
          {visibleLogs.length === 0 && (
            <div className="text-gray-500">
              {hiddenDebugCount > 0
                ? `No matching entries. ${hiddenDebugCount} DEBUG entr${hiddenDebugCount === 1 ? 'y is' : 'ies are'} hidden - turn on debug mode in settings, or select DEBUG above.`
                : 'No log entries.'}
            </div>
          )}
          {visibleLogs.map((entry, index) => (
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
        {hiddenDebugCount > 0 && visibleLogs.length > 0 && (
          <p className="text-xs text-gray-400 mt-2">
            {hiddenDebugCount} DEBUG entr{hiddenDebugCount === 1 ? 'y' : 'ies'} hidden.
            Turn on debug mode in settings to see them.
          </p>
        )}
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
