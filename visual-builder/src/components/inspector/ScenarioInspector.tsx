// A scenario, inspected: its trigger, its steps in order with the evidence
// for every hop, the hops the graph allows next while recording, and the
// synthetic log ticker while it plays. Editing is a project change and
// respects the lock; playing never does.

import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Circle, CircleDot, Flame, Info, Pause, Play, Route, ShieldAlert, Sparkles, Square, Trash2, Wand2, X } from 'lucide-react';
import { useReadOnly, useStore } from '../../store/useStore';
import { displayNameFor } from '../../utils/nodeName';
import { canvas } from '../../utils/canvasActions';
import {
  canBeStep, checkScenario, clockFor, formatTakes, hopIndex, logLinesUpTo, modelledTimeMs, parseTakes, outcomeLabel, Scenario, ScenarioStep, StepOutcome, stepFails, suggestPath,
} from '../../utils/scenarios';
import InspectorHeader, { Fact, Section, StatusDot } from './InspectorHeader';

const LEVEL_CLASS: Record<string, string> = {
  START: 'text-gray-400', END: 'text-gray-400', REPORT: 'text-gray-400', INFO: 'text-emerald-300', WARN: 'text-amber-300', ERROR: 'text-red-300',
};

export default function ScenarioInspector({ scenario }: { scenario: Scenario }) {
  const {
    nodes, edges, updateScenario, removeScenario, inspectScenario, selectNode, playhead, playScenario, setPlaying, stopPlayback,
    seekPlayback, recording, setRecording,
  } = useStore();
  const readOnly = useReadOnly();
  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const index = useMemo(() => hopIndex(nodes, edges), [nodes, edges]);
  const { name } = index;
  const check = useMemo(() => checkScenario(scenario, nodes, edges, index), [scenario, nodes, edges, index]);
  const head = playhead && playhead.scenarioId === scenario.id ? playhead : null;
  const playing = Boolean(head?.playing);
  const lastId = scenario.steps[scenario.steps.length - 1]?.at ?? scenario.trigger.at;
  const nextHops = useMemo(() => (recording || scenario.steps.length === 0 ? index.hops.get(lastId) ?? [] : []), [recording, scenario.steps.length, lastId, index]);
  const logs = useMemo(() => logLinesUpTo(scenario, head, nodes, edges), [scenario, head, nodes, edges]);
  const candidates = useMemo(() => nodes.filter(canBeStep).sort((a, b) => displayNameFor(a).localeCompare(displayNameFor(b))), [nodes]);
  const logRef = useRef<HTMLPreElement>(null);
  useEffect(() => { logRef.current?.scrollTo({ top: logRef.current.scrollHeight }); }, [logs]);

  const [draftName, setDraftName] = useState(scenario.name);
  useEffect(() => setDraftName(scenario.name), [scenario.name]);
  const commitName = () => {
    const trimmed = draftName.trim();
    if (trimmed && trimmed !== scenario.name) updateScenario(scenario.id, (s) => ({ ...s, name: trimmed }));
    else setDraftName(scenario.name);
  };

  const setSteps = (steps: ScenarioStep[]) => updateScenario(scenario.id, (s) => ({ ...s, steps }));
  const patchStep = (i: number, patch: Partial<ScenarioStep>) => setSteps(scenario.steps.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const move = (i: number, d: number) => {
    const steps = [...scenario.steps];
    const j = i + d;
    if (j < 0 || j >= steps.length) return;
    [steps[i], steps[j]] = [steps[j], steps[i]];
    setSteps(steps);
  };
  const remove = (i: number) => setSteps(scenario.steps.filter((_, j) => j !== i));
  const append = (id: string) => setSteps([...scenario.steps, { at: id }]);
  const suggest = () => setSteps(suggestPath(scenario.trigger.at, nodes, edges, 12, index));

  const show = (id: string) => { if (byId.has(id)) { selectNode(id); canvas.fitToNodes([id]); } };
  const jump = (i: number) => { if (head) seekPlayback(i); else show(scenario.steps[i]?.at ?? scenario.trigger.at); };

  const status = scenario.steps.length === 0
    ? <StatusDot tone="muted" label="no steps yet" />
    : check.ok
      ? <StatusDot tone="ok" label="every hop has evidence" />
      : <StatusDot tone="warn" label={`${check.problems.length} ${check.problems.length === 1 ? 'problem' : 'problems'}`} />;

  // With no steps, the next hops are the ones from the trigger: a path can be drafted when there are any.
  const suggested = scenario.steps.length === 0 && nextHops.length > 0;

  return (
    <>
      <InspectorHeader
        icon={Route}
        kind="Scenario"
        name={scenario.name}
        subtitle={<span>from <span className="text-gray-700">{name(scenario.trigger.at)}</span>{scenario.trigger.event ? <span> · {scenario.trigger.event}</span> : null}</span>}
        status={status}
        onBack={() => inspectScenario(null)}
        actions={
          <>
            {head ? (
              <>
                <button onClick={() => setPlaying(!playing)} className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded bg-blue-600 text-white hover:bg-blue-700" title={playing ? 'Pause (space)' : 'Play (space)'}>
                  {playing ? <Pause size={12} /> : <Play size={12} />} {playing ? 'Pause' : head.phase === 'end' ? 'Replay' : 'Play'}
                </button>
                <button onClick={stopPlayback} className="p-1 rounded text-gray-500 hover:bg-gray-100" title="Stop"><Square size={12} /></button>
              </>
            ) : (
              <button
                onClick={() => playScenario(scenario.id)}
                disabled={scenario.steps.length === 0}
                className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed"
                title={scenario.steps.length ? 'Play this scenario through the canvas' : 'Add steps first'}
              >
                <Play size={12} /> Play
              </button>
            )}
            {!readOnly && (
              <button
                onClick={() => setRecording(!recording)}
                className={`inline-flex items-center gap-1 text-xs px-2 py-1 rounded border ${recording ? 'bg-red-600 border-red-600 text-white hover:bg-red-700' : 'border-gray-200 text-gray-700 hover:bg-gray-50'}`}
                title={recording ? 'Stop recording' : 'Record: click resources on the canvas to add them as steps'}
              >
                <CircleDot size={12} className={recording ? 'animate-pulse' : ''} /> {recording ? 'Recording' : 'Record'}
              </button>
            )}
          </>
        }
      />

      <div className="flex-1 overflow-y-auto min-h-0">
        {recording && (
          <div className="mx-4 mt-3 text-xs rounded border border-red-200 bg-red-50 text-red-900 px-3 py-2">
            Recording. Click a resource on the canvas to add it as the next step, or pick one of the hops below. Log groups are never steps: they tick on their own.
          </div>
        )}

        <Section title="Name">
          <input
            value={draftName}
            onChange={(e) => setDraftName(e.target.value)}
            onBlur={commitName}
            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') { setDraftName(scenario.name); (e.target as HTMLInputElement).blur(); } }}
            disabled={readOnly}
            className="w-full text-sm border border-gray-200 rounded px-2 py-1 disabled:bg-gray-50 disabled:text-gray-600"
          />
        </Section>

        <Section title="Trigger" hint="where the request starts">
          {readOnly ? (
            <Fact label={byId.get(scenario.trigger.at)?.type || 'resource'} value={name(scenario.trigger.at)} onClick={byId.has(scenario.trigger.at) ? () => show(scenario.trigger.at) : undefined} />
          ) : (
            <div className="flex items-center gap-2">
              <select
                value={check.triggerExists ? scenario.trigger.at : ''}
                onChange={(e) => updateScenario(scenario.id, (s) => ({ ...s, trigger: { ...s.trigger, at: e.target.value } }))}
                className="flex-1 min-w-0 text-xs border border-gray-200 rounded px-1.5 py-1 bg-white"
                title="The resource the event arrives at"
              >
                {!check.triggerExists && <option value="">{scenario.trigger.at} (missing)</option>}
                {candidates.map((n) => <option key={n.id} value={n.id}>{displayNameFor(n)} · {n.type}</option>)}
              </select>
              <button onClick={() => show(scenario.trigger.at)} disabled={!check.triggerExists} className="text-[11px] text-blue-700 hover:underline disabled:text-gray-400 shrink-0">show</button>
            </div>
          )}
          {!check.triggerExists && <p className="text-xs text-amber-800 mt-1">This resource is not on the canvas any more.</p>}
          <div className="flex items-center gap-2 mt-1">
            <span className="text-xs text-gray-500 shrink-0">event</span>
            <input
              value={scenario.trigger.event ?? ''}
              placeholder="POST /webhook, cron, object created…"
              onChange={(e) => updateScenario(scenario.id, (s) => ({ ...s, trigger: { ...s.trigger, event: e.target.value || undefined } }))}
              disabled={readOnly}
              className="flex-1 text-xs border border-gray-200 rounded px-2 py-1 disabled:bg-gray-50"
            />
          </div>
        </Section>

        <Section
          title="Steps"
          hint={scenario.steps.length ? `${scenario.steps.length} · ${formatTakes(modelledTimeMs(scenario, { index: scenario.steps.length - 1, phase: 'end' }))} modelled` : undefined}
        >
          {scenario.steps.length === 0 && (
            <div className="text-xs text-gray-600 space-y-2">
              <p>No steps yet. {readOnly ? 'Unlock the project to record or draft them.' : 'Press Record and click resources in order, or let the graph propose a path.'}</p>
              {!readOnly && suggested && (
                <button onClick={suggest} className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded border border-gray-200 text-gray-800 hover:bg-gray-50">
                  <Wand2 size={12} /> Suggest a path from {name(scenario.trigger.at)}
                </button>
              )}
            </div>
          )}
          <ol className="space-y-1">
            {scenario.steps.map((step, i) => {
              const c = check.steps[i];
              const isActive = head && head.index === i && head.phase !== 'end';
              const done = head && (head.phase === 'end' || head.index > i);
              return (
                <li
                  key={`${i}-${step.at}`}
                  className={`rounded border px-2 py-1.5 ${isActive ? 'border-blue-400 bg-blue-50' : done ? 'border-gray-200 bg-gray-50' : 'border-gray-100'}`}
                >
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => jump(i)}
                      className={`w-5 h-5 rounded-full text-[10px] font-semibold flex items-center justify-center shrink-0 ${isActive ? 'bg-blue-600 text-white' : done ? 'bg-gray-700 text-white' : 'bg-gray-200 text-gray-700'}`}
                      title={head ? 'Jump the playhead here' : 'Show on the canvas'}
                    >
                      {i + 1}
                    </button>
                    <button onClick={() => show(step.at)} className="flex-1 min-w-0 text-left text-xs font-medium text-gray-900 hover:underline truncate" title={step.at}>
                      {name(step.at)}
                      <span className="text-gray-400 font-normal"> · {byId.get(step.at)?.type || 'missing'}</span>
                    </button>
                    {step.detached && <span className="text-[10px] text-gray-500 border border-gray-200 rounded px-1" title="Fire and forget: the request does not wait for this step">detached</span>}
                    {step.retry ? <span className="text-[10px] text-amber-800 bg-amber-50 border border-amber-200 rounded px-1" title={`Retried ${step.retry} time${step.retry === 1 ? '' : 's'} before the outcome`}>×{step.retry + 1}</span> : null}
                    {stepFails(step) && <span className="text-[10px] text-red-700 bg-red-50 border border-red-200 rounded px-1 inline-flex items-center gap-0.5" title={`The last attempt ${outcomeLabel(step)}`}><Flame size={9} /> {outcomeLabel(step)}</span>}
                    {!readOnly && (
                      <span className="flex items-center gap-0.5 shrink-0">
                        <button onClick={() => move(i, -1)} disabled={i === 0} className="p-0.5 rounded text-gray-400 hover:text-gray-700 hover:bg-gray-100 disabled:opacity-30" title="Move up"><ArrowUp size={11} /></button>
                        <button onClick={() => move(i, 1)} disabled={i === scenario.steps.length - 1} className="p-0.5 rounded text-gray-400 hover:text-gray-700 hover:bg-gray-100 disabled:opacity-30" title="Move down"><ArrowDown size={11} /></button>
                        <button onClick={() => remove(i)} className="p-0.5 rounded text-gray-400 hover:text-red-700 hover:bg-red-50" title="Remove this step"><X size={11} /></button>
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 mt-1 pl-7">
                    <input
                      value={step.note ?? ''}
                      placeholder="what happens here"
                      onChange={(e) => patchStep(i, { note: e.target.value || undefined })}
                      disabled={readOnly}
                      className="flex-1 min-w-0 text-[11px] border border-gray-200 rounded px-1.5 py-0.5 disabled:bg-transparent disabled:border-transparent disabled:px-0"
                    />
                    <TakesInput value={step.takes} disabled={readOnly} onChange={(takes) => patchStep(i, { takes })} />
                    {!readOnly && (<>
                      <select
                        value={step.outcome ?? 'ok'}
                        onChange={(e) => patchStep(i, { outcome: e.target.value === 'ok' ? undefined : (e.target.value as StepOutcome) })}
                        className={`text-[10px] border rounded px-1 py-0.5 bg-white shrink-0 ${stepFails(step) ? 'border-red-300 text-red-700' : 'border-gray-200 text-gray-600'}`}
                        title="How the last attempt ends"
                      >
                        <option value="ok">ok</option>
                        <option value="fail">fails</option>
                        <option value="timeout">times out</option>
                      </select>
                      <input
                        type="number"
                        min={0}
                        max={9}
                        value={step.retry ?? 0}
                        onChange={(e) => { const n = Math.max(0, Math.min(9, parseInt(e.target.value || '0', 10) || 0)); patchStep(i, { retry: n || undefined }); }}
                        className="w-10 text-[10px] border border-gray-200 rounded px-1 py-0.5 tabular-nums shrink-0"
                        title="Retries before the outcome; each replays the hop"
                      />
                      <label className="flex items-center gap-1 text-[10px] text-gray-500 shrink-0" title="Fire and forget: the request does not wait for this step">
                        <input type="checkbox" checked={Boolean(step.detached)} onChange={(e) => patchStep(i, { detached: e.target.checked || undefined })} />
                        detached
                      </label>
                    </>)}
                  </div>
                  <div className="pl-7 mt-0.5 text-[10px] leading-snug">
                    {c?.evidence ? (
                      <span className="text-gray-500">
                        from <span className="text-gray-700">{name(c.evidence.from)}</span> · {c.evidence.label}
                        {c.evidence.actions?.length ? <span className="font-mono"> · {c.evidence.actions.slice(0, 3).join(', ')}{c.evidence.actions.length > 3 ? ', …' : ''}</span> : null}
                      </span>
                    ) : null}
                    {c?.problems.map((p) => (
                      <span key={p} className="flex items-center gap-1 text-amber-800"><ShieldAlert size={10} className="shrink-0" /> {p}</span>
                    ))}
                    {c?.notes.map((p) => (
                      <span key={p} className="flex items-center gap-1 text-gray-500"><Info size={10} className="shrink-0" /> {p}</span>
                    ))}
                  </div>
                </li>
              );
            })}
          </ol>
          {!readOnly && scenario.steps.length > 0 && !recording && (
            <button onClick={suggest} className="mt-2 inline-flex items-center gap-1 text-[11px] text-gray-600 hover:text-gray-900" title="Replace the steps with what the graph proposes from the trigger">
              <Wand2 size={11} /> Replace with a suggested path
            </button>
          )}
        </Section>

        {!readOnly && (recording || (scenario.steps.length === 0 && nextHops.length > 0)) && (
          <Section title="Next" hint={`from ${name(lastId)}`}>
            {nextHops.length === 0 ? (
              <p className="text-xs text-gray-500">The graph offers no hop from here. Click any resource to add it anyway; the hop will be flagged as unverified.</p>
            ) : nextHops.map((h) => (
              <button
                key={h.edge.id}
                onClick={() => append(h.to)}
                className="w-full flex items-center justify-between gap-2 py-1 -mx-1 px-1 rounded hover:bg-blue-50 text-left"
                title="Add as the next step"
              >
                <span className="text-xs text-blue-700 truncate">{name(h.to)}</span>
                <span className="text-[10px] text-gray-500 truncate shrink-0 max-w-[55%]">{h.label}</span>
              </button>
            ))}
          </Section>
        )}

        {head && (
          <Section title="Logs" hint={logs.length ? `${logs.reduce((n, b) => n + b.lines.length, 0)} lines · synthetic` : 'synthetic'}>
            {logs.length === 0 ? (
              <p className="text-xs text-gray-500">Lines appear when a function or agent runs. They show data moving and are not what the code logs.</p>
            ) : (
              <pre ref={logRef} className="m-0 max-h-56 overflow-auto rounded bg-gray-950 text-gray-200 px-2 py-1.5 text-[10px] leading-relaxed font-mono">
                {logs.map((block) => (
                  <div key={block.at} className="mb-1.5">
                    <div className="text-gray-500">— {name(block.at)}</div>
                    {block.lines.map((l, i) => (
                      <div key={i}><span className="text-gray-500">{clockFor(l.t)}</span> <span className={LEVEL_CLASS[l.level] || ''}>{l.level.padEnd(6)}</span> {l.text}</div>
                    ))}
                  </div>
                ))}
              </pre>
            )}
          </Section>
        )}

        <Section title="Check" hint={check.ok && scenario.steps.length ? 'passes' : undefined}>
          {scenario.steps.length === 0 ? (
            <p className="text-xs text-gray-500">Nothing to check until there are steps.</p>
          ) : check.ok ? (
            <p className="text-xs text-emerald-800 flex items-center gap-1"><Circle size={10} className="fill-emerald-500 text-emerald-500" /> Every hop has a trigger or permission behind it, and every function has a log group.</p>
          ) : (
            <ul className="space-y-0.5">
              {check.problems.map((p) => <li key={p} className="text-xs text-amber-800 flex items-start gap-1"><ShieldAlert size={12} className="mt-0.5 shrink-0" /> {p}</li>)}
            </ul>
          )}
          {check.notes.length > 0 && (
            <ul className="mt-2 space-y-0.5">
              {check.notes.map((p) => <li key={p} className="text-xs text-gray-600 flex items-start gap-1"><Info size={12} className="mt-0.5 shrink-0 text-gray-400" /> {p}</li>)}
            </ul>
          )}
          <p className="text-[10px] text-gray-400 mt-2">Checked against the wiring on the canvas: invocations, event sources and targets, dead-letter queues, and access arrows from IAM policies.</p>
        </Section>

        {!readOnly && (
          <Section title="Danger">
            <button
              onClick={() => { if (confirm(`Delete the scenario "${scenario.name}"?`)) removeScenario(scenario.id); }}
              className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded border border-red-200 text-red-700 hover:bg-red-50"
            >
              <Trash2 size={12} /> Delete scenario
            </button>
          </Section>
        )}

        {readOnly && (
          <div className="px-4 py-3 text-[11px] text-gray-500 flex items-start gap-1.5">
            <Sparkles size={12} className="mt-0.5 shrink-0" />
            <span>The project is locked: play freely, unlock to edit the steps.</span>
          </div>
        )}
      </div>
    </>
  );
}

/** "40ms" / "1.5s" in, milliseconds out; blank means unset. */
function TakesInput({ value, disabled, onChange }: { value: number | undefined; disabled: boolean; onChange: (ms: number | undefined) => void }) {
  const [text, setText] = useState(value === undefined ? '' : formatTakes(value));
  useEffect(() => setText(value === undefined ? '' : formatTakes(value)), [value]);
  const commit = () => {
    if (!text.trim()) { onChange(undefined); return; }
    const ms = parseTakes(text);
    if (ms === undefined) setText(value === undefined ? '' : formatTakes(value));
    else onChange(ms);
  };
  if (disabled) return value === undefined ? null : <span className="text-[10px] text-gray-500 tabular-nums shrink-0">{formatTakes(value)}</span>;
  return (
    <input
      value={text}
      placeholder="takes"
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
      className="w-14 text-[11px] border border-gray-200 rounded px-1.5 py-0.5 tabular-nums shrink-0"
      title="How long this step takes: 40ms, 1.5s"
    />
  );
}

