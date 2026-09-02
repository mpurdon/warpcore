import { useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useStore, NodeStatus, ExecutionLog, LogEntry } from '../store/useStore';

interface DeploymentUpdate {
  type: 'resource_status' | 'log_entry' | 'step_complete' | 'api_call' | 'deployment_started' | 'deployment_complete';
  resourceId: string;
  data: any;
}

export function useDeployment() {
  const {
    nodes,
    setNodes,
    configPath,
    currentEnvironment,
    setIsDeploying,
    addDeploymentHistory,
    setExecutionLog,
    executionLogs,
    debugMode,
  } = useStore();

  // Listen for deployment updates from Tauri
  useEffect(() => {
    const unlistenDeployment = listen<DeploymentUpdate>('deployment-update', (event) => {
      const update = event.payload;
      handleDeploymentUpdate(update);
    });

    const unlistenOutput = listen<string>('cli-output', (event) => {
      console.log('[CLI]', event.payload);
      // Could add to a global log viewer here
    });

    const unlistenError = listen<string>('cli-error', (event) => {
      console.error('[CLI Error]', event.payload);
    });

    return () => {
      unlistenDeployment.then((fn) => fn());
      unlistenOutput.then((fn) => fn());
      unlistenError.then((fn) => fn());
    };
  }, [nodes, setNodes, setIsDeploying, addDeploymentHistory, setExecutionLog]);

  const handleDeploymentUpdate = useCallback((update: DeploymentUpdate) => {
    switch (update.type) {
      case 'deployment_started':
        setIsDeploying(true);
        // Set all nodes to pending
        const pendingNodes = nodes.map((node) => ({
          ...node,
          data: { ...node.data, status: 'configured' as NodeStatus },
        }));
        setNodes(pendingNodes);
        break;

      case 'resource_status':
        // Update specific node status
        const updatedNodes = nodes.map((node) => {
          if (node.id === update.resourceId || node.data.label === update.resourceId) {
            return {
              ...node,
              data: { ...node.data, status: update.data.status as NodeStatus },
            };
          }
          return node;
        });
        setNodes(updatedNodes);

        // Update execution log for this resource
        const existingLog = executionLogs.get(update.resourceId);
        const newLog: ExecutionLog = {
          resourceId: update.resourceId,
          status: update.data.status,
          startTime: existingLog?.startTime || new Date(),
          endTime: update.data.status === 'deployed' || update.data.status === 'failed' ? new Date() : undefined,
          duration: existingLog?.startTime
            ? (Date.now() - existingLog.startTime.getTime()) / 1000
            : undefined,
          steps: existingLog?.steps || [],
          logs: existingLog?.logs || [],
          apiCalls: existingLog?.apiCalls || [],
          configuration: existingLog?.configuration || {},
          error: update.data.error ? {
            type: 'DeploymentError',
            message: update.data.error,
            suggestedFixes: ['Check CloudWatch logs', 'Verify IAM permissions'],
          } : undefined,
        };
        setExecutionLog(update.resourceId, newLog);
        break;

      case 'step_complete':
        // Add step to execution log
        const logWithStep = executionLogs.get(update.resourceId);
        if (logWithStep) {
          const updatedLog = {
            ...logWithStep,
            steps: [...logWithStep.steps, update.data.step],
          };
          setExecutionLog(update.resourceId, updatedLog);
        }
        break;

      case 'log_entry':
        // Add log entry
        const logWithEntry = executionLogs.get(update.resourceId);
        if (logWithEntry) {
          const entry: LogEntry = {
            timestamp: new Date(),
            level: update.data.level || 'INFO',
            message: update.data.message,
            context: update.data.context,
          };
          const updatedLog = {
            ...logWithEntry,
            logs: [...logWithEntry.logs, entry],
          };
          setExecutionLog(update.resourceId, updatedLog);
        }
        break;

      case 'api_call':
        // Add API call to log
        const logWithApiCall = executionLogs.get(update.resourceId);
        if (logWithApiCall) {
          const updatedLog = {
            ...logWithApiCall,
            apiCalls: [...logWithApiCall.apiCalls, update.data],
          };
          setExecutionLog(update.resourceId, updatedLog);
        }
        break;

      case 'deployment_complete':
        setIsDeploying(false);

        // Add to deployment history
        const changes = {
          created: [] as string[],
          updated: [] as string[],
          deleted: [] as string[],
        };

        // Count changes from execution logs
        executionLogs.forEach((log, resourceId) => {
          if (log.status === 'deployed') {
            changes.created.push(resourceId);
          }
        });

        addDeploymentHistory({
          id: `deploy-${Date.now()}`,
          timestamp: new Date(),
          status: update.data.status === 'deployed' ? 'deployed' : 'failed',
          duration: update.data.duration || 0,
          changes,
        });
        break;
    }
  }, [nodes, setNodes, setIsDeploying, addDeploymentHistory, setExecutionLog, executionLogs]);

  const deploy = useCallback(async () => {
    if (!configPath) {
      console.error('No config path set');
      return;
    }

    try {
      setIsDeploying(true);

      // Mark all nodes as pending initially
      const pendingNodes = nodes.map((node) => ({
        ...node,
        data: { ...node.data, status: 'configured' as NodeStatus },
      }));
      setNodes(pendingNodes);

      await invoke('execute_deployment', {
        configPath,
        environment: currentEnvironment,
        debug: debugMode,
      });
    } catch (error) {
      console.error('Deployment failed:', error);
      setIsDeploying(false);

      // Mark all deploying nodes as failed
      const failedNodes = nodes.map((node) => ({
        ...node,
        data: {
          ...node.data,
          status: node.data.status === 'deploying' ? 'failed' : node.data.status
        },
      }));
      setNodes(failedNodes);
    }
  }, [configPath, currentEnvironment, debugMode, nodes, setNodes, setIsDeploying]);

  const destroy = useCallback(async () => {
    if (!configPath) {
      console.error('No config path set');
      return;
    }

    try {
      setIsDeploying(true);
      await invoke('execute_destroy', {
        configPath,
        environment: currentEnvironment,
        debug: debugMode,
      });

      // Reset all nodes to draft status
      const draftNodes = nodes.map((node) => ({
        ...node,
        data: { ...node.data, status: 'draft' as NodeStatus },
      }));
      setNodes(draftNodes);
    } catch (error) {
      console.error('Destroy failed:', error);
    } finally {
      setIsDeploying(false);
    }
  }, [configPath, currentEnvironment, debugMode, nodes, setNodes, setIsDeploying]);

  const validate = useCallback(async () => {
    if (!configPath) {
      console.error('No config path set');
      return null;
    }

    try {
      const result = await invoke<string>('validate_config', {
        configPath,
      });
      return result;
    } catch (error) {
      console.error('Validation failed:', error);
      return error as string;
    }
  }, [configPath]);

  return {
    deploy,
    destroy,
    validate,
  };
}

export default useDeployment;
