// A resource on the canvas, inspected. Overview → Evidence (execution log)
// → Raw (the node as JSON). Relationships are navigable: click a connected
// resource to move to it.

import { useEffect, useMemo, useState } from 'react';
import { Node } from 'reactflow';
import { ArrowLeftRight, Box, MessageSquareText, Plus, Settings2, ShieldAlert } from 'lucide-react';
import { useReadOnly, useStore, NodeStatus } from '../../store/useStore';
import { displayNameFor, isOpenToWorld } from '../../utils/nodeName';
import { shortType } from '../../utils/accountExplorer';
import type { NodeMeta } from '../../utils/projectFromAccount';
import { estimateCost, formatCost, formatExecutions } from '../../utils/costEstimation';
import ExecutionLogPanel from '../ExecutionLogPanel';
import { canBeStep } from '../../utils/scenarios';
import ScenarioRow from './ScenarioRow';
import ExpertView from './ExpertView';
import LiveTab from './LiveTab';
import ConnectSection from './ConnectSection';
import FindingsSection from './FindingsSection';
import ManagedBySection from './ManagedBySection';
import { runFromUi } from '../../commands';
import { STATUS_META } from '../../utils/nodeStatus';
import InspectorHeader, { Fact, InspectorTabs, Section, StatusDot } from './InspectorHeader';

type Tab = 'overview' | 'live' | 'execution' | 'raw';

const STATUS = STATUS_META;

export default function NodeInspector({ node }: { node: Node }) {
  const { nodes, edges, executionsPerMonth, setEditingNode, selectNode, executionLogs, scenarios, setNodes } = useStore();
  const through = useMemo(() => scenarios.filter((sc) => sc.trigger.at === node.id || sc.steps.some((st) => st.at === node.id)), [scenarios, node.id]);
  const readOnly = useReadOnly();
  const [chosenTab, setTab] = useState<Tab>('overview');
  // Live exists only for a discovered resource; a drawn one shows Overview.
  const tab: Tab = chosenTab === 'live' && !node.data?.arn ? 'overview' : chosenTab;
  const status = (node.data?.status as NodeStatus | undefined) ?? 'draft';
  const s = STATUS[status] ?? STATUS.draft;
  const log = executionLogs.get(node.id);

  // Scalars from the config, for an at-a-glance summary. The full form is a
  // click away; this is the overview, not the editor.
  const summary = useMemo(() => {
    const config = (node.data?.config || {}) as Record<string, unknown>;
    return Object.entries(config)
      .filter(([, v]) => ['string', 'number', 'boolean'].includes(typeof v) && v !== '')
      .slice(0, 12);
  }, [node.data?.config]);

  const connections = useMemo(() => {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    return edges
      .filter((e) => e.source === node.id || e.target === node.id)
      .map((e) => {
        const outgoing = e.source === node.id;
        const otherId = outgoing ? e.target : e.source;
        const other = byId.get(otherId);
        const meta = (e.data?.meta || {}) as { discovered?: { kind: string; detail: string }; access?: { level: string; via: string; actions: string[] }; layer?: string };
        return { id: e.id, outgoing, otherId, label: other ? displayNameFor(other) : otherId, exists: Boolean(other), meta };
      });
  }, [edges, nodes, node.id]);
  const accessEdges = connections.filter((c) => c.meta.access);
  const plainConnections = connections.filter((c) => !c.meta.access);

  const meta = (node.data?.meta || {}) as NodeMeta;
  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  // A configuration value that names another resource on the canvas (a DLQ
  // target id, a bucket, a table, an ARN) is a link to it.
  const nodeForValue = useMemo(() => {
    const index = new Map<string, string>();
    for (const n of nodes) {
      if (n.id === node.id || n.hidden) continue;
      index.set(n.id, n.id);
      index.set(displayNameFor(n), n.id);
      if (n.data?.arn) index.set(String(n.data.arn), n.id);
    }
    return (value: unknown): string | undefined => (typeof value === 'string' ? index.get(value) : undefined);
  }, [nodes, node.id]);
  const children = useMemo(() => nodes.filter((n) => n.parentNode === node.id && !n.hidden), [nodes, node.id]);
  const members = useMemo(
    () => (node.type === 'security-group'
      ? nodes.filter((n) => !n.hidden && ((n.data?.meta?.securityGroups || []) as { id: string }[]).some((g) => g.id === node.id))
      : []),
    [nodes, node.id, node.type],
  );
  const rules = (node.data?.config?.inboundRules || []) as string[];

  const cost = useMemo(() => {
    const { estimates } = estimateCost([node], executionsPerMonth);
    return estimates[0]?.monthlyCost ?? 0;
  }, [node, executionsPerMonth]);

  return (
    <>
      <InspectorHeader
        icon={Box}
        kind={node.type || 'resource'}
        name={displayNameFor(node)}
        subtitle={<span className="font-mono">{node.id}</span>}
        status={<StatusDot tone={s.tone} label={(node.data?.meta?.health as { reason?: string } | undefined)?.reason ? `${s.label} · ${(node.data.meta.health as { reason: string }).reason}` : s.label} pulse={s.pulse} />}
        actions={
          <button
            onClick={() => setEditingNode(node.id)}
            disabled={readOnly}
            className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed"
            title={readOnly ? 'The project is locked' : 'Open the configuration form'}
          >
            <Settings2 size={12} /> Configure
          </button>
        }
      />
      <InspectorTabs<Tab>
        tabs={[
          { id: 'overview', label: 'Overview' },
          ...(node.data?.arn ? [{ id: 'live' as Tab, label: 'Live' }] : []),
          { id: 'execution', label: log ? 'Execution' : 'Execution · none' },
          { id: 'raw', label: 'Raw' },
        ]}
        active={tab}
        onChange={setTab}
      />

      {tab === 'overview' && (
        <div className="flex-1 overflow-y-auto min-h-0">
          {(meta.note || !readOnly) && (
            <NoteSection
              note={meta.note}
              readOnly={readOnly}
              onChange={(note) => setNodes(nodes.map((n) => (n.id === node.id ? { ...n, data: { ...n.data, meta: { ...(n.data?.meta || {}), note: note || undefined } } } : n)))}
            />
          )}
          <Section title="Configuration" hint={summary.length === 0 ? 'nothing set yet' : `${summary.length} shown`}>
            {summary.length === 0 ? (
              <button onClick={() => setEditingNode(node.id)} disabled={readOnly} className="text-xs text-blue-700 hover:underline disabled:text-gray-400 disabled:no-underline">
                {readOnly ? 'Nothing configured yet' : 'Configure this resource'}
              </button>
            ) : (
              summary.map(([k, v]) => {
                const target = nodeForValue(v);
                return (
                  <Fact
                    key={k}
                    label={k}
                    value={String(v)}
                    mono={typeof v === 'string' && String(v).includes('/')}
                    onClick={target ? () => selectNode(target) : undefined}
                  />
                );
              })
            )}
          </Section>

          {meta.application && node.type !== 'application' && (
            <Section title="Application" hint="how it was placed">
              <Fact
                label={meta.application.name}
                value={meta.application.reason}
                onClick={(() => { const tile = nodes.find((n) => n.type === 'application' && n.data?.meta?.application?.id === meta.application!.id); return tile ? () => selectNode(tile.id) : undefined; })()}
              />
            </Section>
          )}

          {meta.warning && (
            <Section title="Why this is flagged">
              <div className="flex items-start gap-2 text-xs text-amber-900 bg-amber-50 border border-amber-200 rounded p-2">
                <ShieldAlert size={14} className="mt-0.5 shrink-0 text-amber-600" />
                <span>{meta.warning}</span>
              </div>
            </Section>
          )}

          {node.type === 'security-group' && (
            <Section title="Inbound rules" hint={`${rules.length}`}>
              {rules.length === 0
                ? <p className="text-xs text-gray-500">No inbound rules: nothing can reach members from outside.</p>
                : rules.map((r, i) => <div key={i} className={`text-xs font-mono py-0.5 ${isOpenToWorld(r) ? 'text-amber-800' : 'text-gray-700'}`}>{r}</div>)}
            </Section>
          )}

          {node.type === 'security-group' && (
            <Section title="Members" hint={`${members.length}`}>
              {members.length === 0
                ? <p className="text-xs text-gray-500">Nothing on the canvas is in this group.</p>
                : members.map((m) => <Fact key={m.id} label={m.type || ''} value={displayNameFor(m)} onClick={() => selectNode(m.id)} />)}
            </Section>
          )}

          {(meta.securityGroups?.length ?? 0) > 0 && (
            <Section title="Security groups" hint={`${meta.securityGroups!.length}`}>
              {meta.securityGroups!.map((g) => (
                <Fact key={g.id} label="in" value={g.name} onClick={byId.has(g.id) ? () => selectNode(g.id) : undefined} />
              ))}
            </Section>
          )}

          {(node.parentNode && byId.get(node.parentNode)) && (
            <Section title="Inside">
              <Fact
                label={byId.get(node.parentNode)!.type || ''}
                value={displayNameFor(byId.get(node.parentNode)!)}
                onClick={() => selectNode(node.parentNode!)}
              />
            </Section>
          )}

          {meta.isGroup && (
            <Section title="Contains" hint={`${children.length}`}>
              {children.map((c) => <Fact key={c.id} label={c.type || ''} value={displayNameFor(c)} onClick={() => selectNode(c.id)} />)}
            </Section>
          )}

          {accessEdges.length > 0 && (
            <Section title="Access" hint="from IAM policies">
              {accessEdges.map((c) => (
                <div key={c.id} className="py-1">
                  <Fact
                    label={c.outgoing ? 'can' : 'readable by'}
                    value={<span><span className="font-semibold">{c.meta.access!.level}</span> {c.outgoing ? '→' : '←'} {c.label}</span>}
                    onClick={c.exists ? () => selectNode(c.otherId) : undefined}
                  />
                  <div className="text-[10px] text-gray-500 pl-1">via {c.meta.access!.via}{c.meta.access!.actions.length ? ` · ${c.meta.access!.actions.slice(0, 4).join(', ')}${c.meta.access!.actions.length > 4 ? ', …' : ''}` : ''}</div>
                </div>
              ))}
            </Section>
          )}

          {(meta.attachments?.length ?? 0) > 0 && (
            <Section title="Attached" hint={`${meta.attachments!.length} folded in`}>
              {meta.attachments!.map((a) => (
                <Fact key={a.arn} label={shortType(a.type)} value={<span title={a.arn}>{a.name}{a.detail ? <span className="text-gray-400"> · {a.detail}</span> : null}</span>} />
              ))}
            </Section>
          )}

          {node.data?.arn && <ManagedBySection node={node} />}
          {node.data?.arn && <FindingsSection node={node} />}
          {node.data?.arn && node.type === 'ec2-instance' && <ConnectSection node={node} />}

          {node.data?.arn && (
            <Section title="In AWS" hint={node.data?.region || 'global'}>
              <Fact label="ARN" value={node.data.arn} mono />
              {node.data?.region && <Fact label="Region" value={node.data.region} mono />}
              <button onClick={() => setTab('live')} className="text-xs text-blue-700 hover:underline mt-1">State, metrics, network and logs in the Live tab</button>
            </Section>
          )}

          <Section title="Connections" hint={`${plainConnections.length}`}>
            {plainConnections.length === 0 ? (
              <p className="text-xs text-gray-500">{accessEdges.length ? 'No other relationships.' : 'Not connected to anything. Drag from a handle on the canvas to grant a permission.'}</p>
            ) : (
              plainConnections.map((c) => (
                <Fact
                  key={c.id}
                  label={c.meta.discovered?.detail || (c.outgoing ? 'to' : 'from')}
                  value={
                    <span className="inline-flex items-center gap-1">
                      <ArrowLeftRight size={10} className="text-gray-400" />
                      {c.label}
                    </span>
                  }
                  onClick={c.exists ? () => selectNode(c.otherId) : undefined}
                />
              ))
            )}
          </Section>

          {(through.length > 0 || canBeStep(node)) && (
            <Section title="Scenarios" hint={through.length ? `${through.length} through here` : undefined}>
              {through.map((sc) => (
                <ScenarioRow key={sc.id} scenario={sc} trailing={sc.trigger.at === node.id ? 'starts here' : `step ${sc.steps.findIndex((st) => st.at === node.id) + 1}`} />
              ))}
              {canBeStep(node) && (
                <button
                  onClick={() => { void runFromUi('scenario.new', { triggerAt: node.id }); }}
                  disabled={readOnly}
                  className="mt-1 inline-flex items-center gap-1 text-[11px] text-gray-700 hover:text-gray-900 disabled:text-gray-400"
                  title={readOnly ? 'Unlock the project to add scenarios' : 'A new scenario whose request arrives here'}
                >
                  <Plus size={11} /> Start a scenario here
                </button>
              )}
            </Section>
          )}

          <Section title="Cost" hint={`at ${formatExecutions(executionsPerMonth)}/month`}>
            <Fact label="Estimated monthly" value={formatCost(cost)} />
          </Section>

          {log?.error && (
            <Section title="Why it failed">
              <div className="text-xs text-red-700 font-medium">{log.error.type}</div>
              <div className="text-xs text-gray-700 mt-1">{log.error.message}</div>
              <button onClick={() => setTab('execution')} className="text-xs text-blue-700 hover:underline mt-2">
                See the steps and API calls
              </button>
            </Section>
          )}
        </div>
      )}

      {tab === 'live' && <LiveTab node={node} />}

      {tab === 'execution' && (
        <div className="flex-1 min-h-0 flex flex-col">
          <ExecutionLogPanel nodeId={node.id} inline />
        </div>
      )}

      {tab === 'raw' && (
        <div className="flex-1 overflow-y-auto min-h-0">
          <ExpertView
            title="Node"
            language="json"
            defaultOpen
            text={JSON.stringify({ id: node.id, type: node.type, position: node.position, data: node.data }, null, 2)}
          />
        </div>
      )}
    </>
  );
}

/**
 * A note on the resource: the design decision worth teaching, saved with
 * the project (meta.note). Read-only projects show it; unlocked ones edit it.
 */
function NoteSection({ note, readOnly, onChange }: { note: string | undefined; readOnly: boolean; onChange: (note: string) => void }) {
  const [draft, setDraft] = useState(note ?? '');
  useEffect(() => setDraft(note ?? ''), [note]);
  const commit = () => { if (draft.trim() !== (note ?? '')) onChange(draft.trim()); };
  if (readOnly) {
    return (
      <Section title="Note">
        <div className="text-xs text-gray-800 bg-amber-50 border border-amber-200 rounded px-2.5 py-2 flex gap-2">
          <MessageSquareText size={13} className="text-amber-700 mt-0.5 shrink-0" />
          <span className="whitespace-pre-wrap">{note}</span>
        </div>
      </Section>
    );
  }
  return (
    <Section title="Note" hint={note ? undefined : 'why this is here'}>
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        placeholder="The decision worth remembering about this resource. Shown as a marker on the card."
        rows={draft ? Math.min(6, Math.max(2, draft.split('\n').length + 1)) : 2}
        className="w-full text-xs border border-gray-200 rounded px-2 py-1.5 leading-relaxed"
      />
    </Section>
  );
}
