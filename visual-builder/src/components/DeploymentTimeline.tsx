import { useStore } from '../store/useStore';

export default function DeploymentTimeline() {
  const { executionLogs, isDeploying } = useStore();

  if (!isDeploying && executionLogs.size === 0) {
    return null;
  }

  const logs = Array.from(executionLogs.values());
  const maxDuration = Math.max(...logs.map(log => {
    const end = log.endTime || new Date();
    return (end.getTime() - log.startTime.getTime()) / 1000;
  }));

  const totalDuration = logs.reduce((sum, log) => sum + (log.duration || 0), 0);
  const parallelEfficiency = maxDuration > 0 
    ? Math.round((1 - maxDuration / totalDuration) * 100)
    : 0;

  return (
    <div className="absolute bottom-0 left-0 right-0 bg-white border-t border-gray-200 p-4">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold">Deployment Timeline</h3>
        <div className="text-xs text-gray-500">
          Total Duration: {maxDuration.toFixed(1)}s | 
          Parallel Efficiency: {parallelEfficiency}% (saved {(totalDuration - maxDuration).toFixed(1)}s)
        </div>
      </div>
      
      <div className="relative h-24 bg-gray-50 rounded">
        {/* Time markers */}
        <div className="absolute top-0 left-0 right-0 flex justify-between text-xs text-gray-400 px-2">
          {[0, 10, 20, 30, 40, 50, 60].map(sec => (
            <span key={sec}>{sec}s</span>
          ))}
        </div>
        
        {/* Timeline bars */}
        <div className="absolute top-6 left-0 right-0 bottom-0 px-2">
          {logs.map((log, index) => {
            const startOffset = 0; // Simplified - would calculate based on actual start time
            const duration = log.duration || 0;
            const width = (duration / maxDuration) * 100;
            
            const bgColor = {
              success: 'bg-green-500',
              failed: 'bg-red-500',
              deploying: 'bg-blue-500',
              warning: 'bg-yellow-500',
              pending: 'bg-gray-300',
            }[log.status];
            
            return (
              <div
                key={log.resourceId}
                className="mb-1 flex items-center gap-2"
              >
                <div className="w-32 text-xs text-gray-600 truncate">
                  {log.resourceId}
                </div>
                <div className="flex-1 relative h-6">
                  <div
                    className={`timeline-bar ${bgColor}`}
                    style={{
                      left: `${startOffset}%`,
                      width: `${width}%`,
                    }}
                    title={`${log.resourceId}: ${duration}s`}
                  />
                </div>
                <div className="w-12 text-xs text-gray-500 text-right">
                  {duration.toFixed(1)}s
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
