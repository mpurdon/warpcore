// The Project, inspected: what the inspector shows when nothing narrower is
// selected. Summaries that double as navigation - click an environment to
// inspect it, click a resource type to select one.

import { useMemo, useState } from 'react';
import { FolderKanban } from 'lucide-react';
import { useReadOnly, useStore } from '../../store/useStore';
import { EXECUTION_STEPS, estimateCost, formatCost, formatExecutions } from '../../utils/costEstimation';
import RolesPanel from '../RolesPanel';
import InspectorHeader, { Fact, InspectorTabs, Section, StatusDot } from './InspectorHeader';

type Tab = 'overview' | 'roles';

export default function ProjectInspector() {
  const {
    projectName, configPath, hasUnsavedChanges, nodes, environmentConfigs, currentEnvironment,
    inspectEnvironment, deploymentHistory, executionsPerMonth, setExecutionsPerMonth, selectNode,
  } = useStore();
  const readOnly = useReadOnly();
  const [tab, setTab] = useState<Tab>('overview');

  const byType = useMemo(() => {
    const counts = new Map<string, string[]>();
    for (const n of nodes) {
      const t = n.type || 'unknown';
      counts.set(t, [...(counts.get(t) || []), n.id]);
    }
    return [...counts.entries()].sort((a, b) => b[1].length - a[1].length);
  }, [nodes]);

  const { total } = useMemo(() => estimateCost(nodes, executionsPerMonth), [nodes, executionsPerMonth]);
  const stepIndex = Math.max(0, EXECUTION_STEPS.findIndex((s) => s === executionsPerMonth));
  const last = deploymentHistory[0];

  return (
    <>
      <InspectorHeader
        icon={FolderKanban}
        kind="Project"
        name={projectName || (nodes.length ? 'Unsaved project' : 'No project open')}
        subtitle={configPath ? <span className="font-mono">{configPath}</span> : 'Open one from the Project menu, or drag resources onto the canvas.'}
        status={
          configPath
            ? hasUnsavedChanges
              ? <StatusDot tone="warn" label="unsaved changes" />
              : <StatusDot tone="ok" label="saved" />
            : nodes.length
              ? <StatusDot tone="warn" label="not saved anywhere yet" />
              : undefined
        }
        actions={readOnly ? <StatusDot tone="warn" label="locked" /> : undefined}
      />
      <InspectorTabs<Tab>
        tabs={[{ id: 'overview', label: 'Overview' }, { id: 'roles', label: 'Roles' }]}
        active={tab}
        onChange={setTab}
      />

      {tab === 'overview' && (
        <div className="flex-1 overflow-y-auto min-h-0">
          <Section title="Environments" hint="click to inspect">
            {Object.entries(environmentConfigs).map(([key, cfg]) => (
              <Fact
                key={key}
                label={cfg.name}
                value={
                  <span className="inline-flex items-center gap-2">
                    <span className="font-mono text-gray-500">{key}</span>
                    {key === currentEnvironment && <StatusDot tone="info" label="current" />}
                  </span>
                }
                onClick={() => inspectEnvironment(key)}
              />
            ))}
          </Section>

          <Section title="Resources" hint={`${nodes.length}`}>
            {byType.length === 0 ? (
              <p className="text-xs text-gray-500">Nothing on the canvas yet.</p>
            ) : (
              byType.map(([type, ids]) => (
                <Fact key={type} label={type} value={ids.length} onClick={() => selectNode(ids[0])} />
              ))
            )}
          </Section>

          <Section title="Cost" hint="estimate">
            <Fact label="Monthly" value={formatCost(total)} />
            <div className="pt-1">
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs text-gray-600">Executions per month</span>
                <span className="text-xs font-semibold text-blue-700">{formatExecutions(executionsPerMonth)}</span>
              </div>
              <input
                type="range"
                min={0}
                max={EXECUTION_STEPS.length - 1}
                value={stepIndex}
                onChange={(e) => setExecutionsPerMonth(EXECUTION_STEPS[parseInt(e.target.value, 10)])}
                disabled={readOnly}
                className="w-full h-1.5 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-blue-600 disabled:cursor-not-allowed"
              />
            </div>
          </Section>

          <Section title="Deployments" hint={`${deploymentHistory.length} this session`}>
            {last ? (
              <>
                <Fact label="Last" value={last.timestamp.toLocaleString()} />
                <Fact
                  label="Result"
                  value={<StatusDot tone={last.status === 'deployed' ? 'ok' : 'bad'} label={last.status} />}
                />
                <Fact label="Changes" value={`${last.changes.created.length} created · ${last.changes.updated.length} updated · ${last.changes.deleted.length} deleted`} />
              </>
            ) : (
              <p className="text-xs text-gray-500">No deployments from this app yet. The audit trail in Settings has the full history.</p>
            )}
          </Section>
        </div>
      )}

      {tab === 'roles' && (
        <div className="flex-1 min-h-0 overflow-hidden">
          <RolesPanel />
        </div>
      )}
    </>
  );
}
