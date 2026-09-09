// The Holodeck drawer: the library of systems, by family, with a thumbnail
// of each laid-out stack; preview one in memory or save a copy as a
// project. The Mine tab holds the custom templates the old Templates
// dialog kept in localStorage.

import { useMemo, useState } from 'react';
import { AlertTriangle, Eye, Flame, LibraryBig, Plus, Route, Search, Star, Trash2, X } from 'lucide-react';
import { useStore } from '../store/useStore';
import { difficultyLabel, entryProblems, FAMILIES, familyInfo, HolodeckEntry, HolodeckFamily } from '../utils/holodeck';
import { ENTRY_COUNTS, HOLODECK_ENTRIES } from '../utils/holodeckLibrary';
import { loadTemplate, previewEntry } from '../utils/holodeckActions';
import { deleteCustomTemplate, loadCustomTemplates, saveCustomTemplate, Template } from '../utils/templates';
import { stackThumbnail, thumbnailDataUrl } from '../utils/thumbnail';
import { DISCOVERED_TYPES } from '../utils/discoveredTypes';
import { BUTTON, Difficulty, FamilyTag, HolodeckNotes, PRIMARY, QUIET, SaveCopyButton, ScenarioList, Thumbnail } from './HolodeckParts';

type Tab = 'holodeck' | 'mine';

// Chip-length names; DISCOVERED_TYPES has the long ones.
const SERVICE_LABELS: Record<string, string> = {
  s3: 'S3', dynamodb: 'DynamoDB', sqs: 'SQS', sns: 'SNS', 'api-gateway': 'API Gateway', 'api-route': 'Route', lambda: 'Lambda', agent: 'Agent',
  'kinesis-stream': 'Kinesis', 'kinesis-firehose': 'Firehose', eventbridge: 'EventBridge', 'eventbridge-rule': 'EventBridge rule', 'eventbridge-pipes': 'Pipes',
  'step-functions': 'Step Functions', bedrock: 'Bedrock', 'secrets-manager': 'Secrets Manager', 'ssm-parameter': 'SSM', 'kms-key': 'KMS',
  cloudfront: 'CloudFront', 'route53-zone': 'Route 53', 'load-balancer': 'ALB', 'ecs-service': 'ECS', 'ecs-cluster': 'ECS cluster', 'rds-cluster': 'Aurora',
  'rds-instance': 'RDS', 'elasticache-cluster': 'ElastiCache', cognito: 'Cognito', opensearch: 'OpenSearch', glue: 'Glue', athena: 'Athena', waf: 'WAF',
  vpc: 'VPC', subnet: 'Subnet', 'acm-certificate': 'ACM', 'cloudwatch-alarm': 'Alarm', 'cloudwatch-dashboard': 'Dashboard', 'security-group': 'Security group',
  'nat-gateway': 'NAT', 'internet-gateway': 'IGW', ecr: 'ECR', 'ec2-instance': 'EC2',
};
const serviceLabel = (type: string): string => SERVICE_LABELS[type] || DISCOVERED_TYPES[type]?.label || type;

function matches(entry: HolodeckEntry, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const f = familyInfo(entry.meta.family);
  const hay = [entry.meta.name, entry.meta.summary, f.label, f.tag, ...entry.services, ...entry.services.map(serviceLabel), ...entry.meta.lookAt, entry.meta.source?.title || '']
    .join(' ').toLowerCase();
  return q.split(/\s+/).every((t) => hay.includes(t));
}

function EntryCard({ entry, selected, onSelect, onPreview }: { entry: HolodeckEntry; selected: boolean; onSelect: () => void; onPreview: () => void }) {
  const shown = entry.services.slice(0, 6);
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onDoubleClick={onPreview}
      onKeyDown={(e) => { if (e.key === 'Enter') onPreview(); }}
      className={`group text-left border rounded-xl p-3 cursor-pointer transition-colors ${selected ? 'border-blue-500 ring-2 ring-blue-100 bg-blue-50/30' : 'border-gray-200 hover:border-blue-300'}`}
    >
      <Thumbnail src={entry.thumbnail} />
      <div className="mt-2 flex items-start gap-2">
        <h4 className="flex-1 min-w-0 text-sm font-semibold text-gray-900 truncate">{entry.meta.name}</h4>
        <FamilyTag family={entry.meta.family} />
      </div>
      <p className="text-xs text-gray-600 mt-0.5 line-clamp-2 min-h-[2rem]">{entry.meta.summary}</p>
      <div className="mt-2 flex flex-wrap gap-1">
        {shown.map((s) => <span key={s} className="text-[10px] bg-gray-100 text-gray-700 rounded px-1 py-px">{serviceLabel(s)}</span>)}
        {entry.services.length > shown.length && <span className="text-[10px] text-gray-400">+{entry.services.length - shown.length}</span>}
      </div>
      <div className="mt-2 flex items-center gap-2 text-[11px] text-gray-500">
        <span>{entry.resourceCount} resources</span>
        <span>·</span>
        <span className="inline-flex items-center gap-1"><Route size={10} /> {entry.scenarios.length}</span>
        {entry.unhappy > 0 && <span className="inline-flex items-center gap-0.5 text-red-700" title={`${entry.unhappy} unhappy path${entry.unhappy === 1 ? '' : 's'}`}><Flame size={10} /> {entry.unhappy}</span>}
        <span className="ml-auto"><Difficulty d={entry.meta.difficulty} /></span>
      </div>
      <div className={`mt-2 flex items-center gap-1.5 ${selected ? '' : 'opacity-0 group-hover:opacity-100'} transition-opacity`}>
        <button onClick={(e) => { e.stopPropagation(); onPreview(); }} className={PRIMARY} title="Load in memory, read only: play its scenarios, switch lenses, open the system view"><Eye size={12} /> Preview</button>
        <SaveCopyButton entry={entry} stop />
      </div>
    </div>
  );
}

function EntryDetail({ entry, onPreview }: { entry: HolodeckEntry; onPreview: () => void }) {
  const problems = useMemo(() => entryProblems(entry), [entry]);
  return (
    <div className="p-4 space-y-4">
      <Thumbnail src={entry.thumbnail} />
      <div>
        <div className="flex items-start gap-2">
          <h3 className="flex-1 text-base font-semibold text-gray-900">{entry.meta.name}</h3>
          <FamilyTag family={entry.meta.family} />
        </div>
        <p className="text-sm text-gray-700 mt-1">{entry.meta.summary}</p>
        <div className="mt-2 flex items-center gap-2 text-[11px] text-gray-500">
          <Difficulty d={entry.meta.difficulty} /> {difficultyLabel(entry.meta.difficulty)} · {entry.resourceCount} resources · {entry.edges.length} connections
        </div>
      </div>
      <div className="flex items-center gap-2">
        <button onClick={onPreview} className={PRIMARY}><Eye size={12} /> Preview</button>
        <SaveCopyButton entry={entry} />
      </div>
      <HolodeckNotes meta={entry.meta} />
      <div>
        <div className="text-[10px] font-semibold uppercase tracking-wide text-gray-400 mb-1">Scenarios</div>
        <ScenarioList entry={entry} />
      </div>
      <div>
        <div className="text-[10px] font-semibold uppercase tracking-wide text-gray-400 mb-1">Services</div>
        <div className="flex flex-wrap gap-1">
          {entry.services.map((s) => <span key={s} className="text-[10px] bg-gray-100 text-gray-700 rounded px-1.5 py-px">{serviceLabel(s)}</span>)}
        </div>
      </div>
      {problems.length > 0 && (
        <div className="text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded p-2">
          <div className="flex items-center gap-1 font-medium"><AlertTriangle size={12} /> The check flags {problems.length} hop{problems.length === 1 ? '' : 's'}</div>
          <ul className="mt-1 space-y-0.5">{problems.slice(0, 4).map((p) => <li key={p}>{p}</li>)}</ul>
        </div>
      )}
    </div>
  );
}

function TemplateCard({ template, onLoad, onDelete }: { template: Template; onLoad: () => void; onDelete: () => void }) {
  const src = useMemo(() => thumbnailDataUrl(stackThumbnail(template.nodes)), [template.nodes]);
  return (
    <div className="group border border-gray-200 rounded-xl p-3 hover:border-blue-300 transition-colors">
      <Thumbnail src={src} />
      <div className="mt-2 flex items-start gap-2">
        <Star size={14} className="text-purple-600 mt-0.5 shrink-0" />
        <div className="flex-1 min-w-0">
          <h4 className="text-sm font-semibold text-gray-900 truncate">{template.name}</h4>
          <p className="text-xs text-gray-600 line-clamp-2">{template.description || 'No description'}</p>
          <div className="text-[11px] text-gray-500 mt-1">{template.nodes.length} resources · {template.edges.length} connections</div>
        </div>
      </div>
      <div className="mt-2 flex items-center gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
        <button onClick={onLoad} className={PRIMARY}>Load</button>
        <button onClick={onDelete} className={`${BUTTON} border-red-200 text-red-700 hover:bg-red-50`} title="Delete this template"><Trash2 size={12} /></button>
      </div>
    </div>
  );
}

const FILTERS: { id: HolodeckFamily | 'all'; label: string; description: string }[] = [{ id: 'all', label: 'Everything', description: '' }, ...FAMILIES];

export default function HolodeckDrawer({ onClose }: { onClose: () => void }) {
  const canvasEmpty = useStore((s) => s.nodes.length === 0);
  const current = useStore((s) => s.holodeck);
  const [tab, setTab] = useState<Tab>('holodeck');
  const [family, setFamily] = useState<HolodeckFamily | 'all'>('all');
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(current?.id ?? null);
  const [notice, setNotice] = useState<string | null>(null);
  const [templates, setTemplates] = useState<Template[]>(() => loadCustomTemplates());
  const [savingTemplate, setSavingTemplate] = useState(false);
  const [templateName, setTemplateName] = useState('');
  const [templateDescription, setTemplateDescription] = useState('');

  const entries = useMemo(
    () => HOLODECK_ENTRIES.filter((e) => (family === 'all' || e.meta.family === family) && matches(e, query)),
    [family, query],
  );
  const selected = entries.find((e) => e.meta.id === selectedId) ?? null;

  const preview = (entry: HolodeckEntry) => setNotice(previewEntry(entry));
  const load = (t: Template) => setNotice(loadTemplate(t));
  const saveTemplate = () => {
    if (!templateName.trim()) return;
    const { nodes, edges } = useStore.getState();
    setTemplates([...templates, saveCustomTemplate(templateName.trim(), templateDescription.trim(), nodes, edges)]);
    setTemplateName('');
    setTemplateDescription('');
    setSavingTemplate(false);
  };
  const removeTemplate = (t: Template) => {
    if (!confirm(`Delete the template "${t.name}"?`)) return;
    deleteCustomTemplate(t.id);
    setTemplates(templates.filter((x) => x.id !== t.id));
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="bg-white text-gray-900 rounded-lg shadow-xl w-[95vw] h-[90vh] flex flex-col overflow-hidden" role="dialog" aria-label="Holodeck">
        {/* Header */}
        <div className="px-4 py-3 border-b border-gray-200 flex items-center gap-4">
          <div className="flex items-center gap-3 shrink-0">
            <LibraryBig size={20} className="text-indigo-600" />
            <div>
              <h2 className="text-lg font-semibold leading-tight">Holodeck</h2>
              <p className="text-[11px] text-gray-500">Systems to walk through and copy. Every entry plays its scenarios through the wiring.</p>
            </div>
          </div>
          <div className="flex items-center gap-1 ml-2 bg-gray-100 rounded-md p-0.5 shrink-0">
            {(['holodeck', 'mine'] as Tab[]).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`text-xs px-3 py-1 rounded ${tab === t ? 'bg-white shadow-sm text-gray-900 font-medium' : 'text-gray-600 hover:text-gray-900'}`}
              >
                {t === 'holodeck' ? `Library · ${HOLODECK_ENTRIES.length}` : `Mine · ${templates.length}`}
              </button>
            ))}
          </div>
          {tab === 'holodeck' && (
            <div className="relative ml-auto">
              <Search size={14} className="absolute left-2 top-2 text-gray-400" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search names, services, ideas"
                autoFocus
                className="text-sm border border-gray-300 rounded pl-7 pr-2 py-1 w-72"
              />
            </div>
          )}
          <button onClick={onClose} className={`p-2 hover:bg-gray-100 rounded-full ${tab === 'holodeck' ? '' : 'ml-auto'}`} title="Close (Esc)">
            <X size={20} className="text-gray-500" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 flex min-h-0">
          {/* Rail */}
          <div className="w-60 border-r border-gray-200 bg-gray-50 flex flex-col">
            {tab === 'holodeck' ? (
              <div className="p-3 space-y-0.5">
                {FILTERS.map((f) => {
                  const n = f.id === 'all' ? HOLODECK_ENTRIES.length : ENTRY_COUNTS[f.id];
                  const on = family === f.id;
                  return (
                    <button
                      key={f.id}
                      onClick={() => { setFamily(f.id); setSelectedId(null); }}
                      className={`w-full text-left px-2.5 py-1.5 rounded-md text-sm flex items-center gap-2 ${on ? 'bg-white shadow-sm text-gray-900 font-medium' : 'text-gray-700 hover:bg-white/70'}`}
                      title={f.description}
                    >
                      <span className="flex-1 truncate">{f.label}</span>
                      <span className="text-[11px] text-gray-400 tabular-nums">{n}</span>
                    </button>
                  );
                })}
                <div className="pt-4 px-1 text-[11px] text-gray-500 space-y-2">
                  <p><strong className="text-gray-700">Preview</strong> loads an entry in memory, read only: play, switch lenses, open the system view. Nothing is written.</p>
                  <p><strong className="text-gray-700">Save a copy</strong> writes a warpcore.yaml of your own and opens it unlocked.</p>
                  <p>Entries carry two to five scenarios each; <Flame size={10} className="inline text-red-600" /> marks an unhappy path: a timeout, a retry, a dead-letter queue.</p>
                </div>
              </div>
            ) : (
              <div className="p-3 space-y-3">
                <p className="text-[11px] text-gray-500">Custom templates live on this machine. Save the canvas as one to reuse it, or load one onto a fresh canvas.</p>
                {!savingTemplate ? (
                  <button
                    onClick={() => setSavingTemplate(true)}
                    disabled={canvasEmpty}
                    className={`${PRIMARY} w-full justify-center disabled:opacity-40`}
                    title={canvasEmpty ? 'Nothing on the canvas to save' : 'Save what is on the canvas as a template'}
                  >
                    <Plus size={12} /> Save this canvas as a template
                  </button>
                ) : (
                  <div className="space-y-2">
                    <input value={templateName} onChange={(e) => setTemplateName(e.target.value)} placeholder="Name" autoFocus className="w-full text-sm border border-gray-300 rounded px-2 py-1" onKeyDown={(e) => { if (e.key === 'Enter') saveTemplate(); }} />
                    <textarea value={templateDescription} onChange={(e) => setTemplateDescription(e.target.value)} placeholder="What it is for" rows={3} className="w-full text-xs border border-gray-300 rounded px-2 py-1" />
                    <div className="flex gap-1.5">
                      <button onClick={saveTemplate} disabled={!templateName.trim()} className={`${PRIMARY} disabled:opacity-40`}>Save</button>
                      <button onClick={() => setSavingTemplate(false)} className={QUIET}>Cancel</button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Main */}
          <div className="flex-1 overflow-y-auto p-5 min-w-0">
            {notice && (
              <div className="mb-4 flex items-start gap-2 text-xs text-amber-900 bg-amber-50 border border-amber-200 rounded p-2">
                <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                <span className="flex-1">{notice}</span>
                <button onClick={() => setNotice(null)} className="text-amber-700 hover:text-amber-900"><X size={12} /></button>
              </div>
            )}
            {tab === 'holodeck' ? (
              entries.length === 0 ? (
                <p className="text-sm text-gray-500 py-12 text-center">Nothing matches "{query}".</p>
              ) : (
                <div className="grid grid-cols-2 2xl:grid-cols-3 gap-4">
                  {entries.map((e) => (
                    <EntryCard key={e.meta.id} entry={e} selected={e.meta.id === selectedId} onSelect={() => setSelectedId(e.meta.id)} onPreview={() => preview(e)} />
                  ))}
                </div>
              )
            ) : templates.length === 0 ? (
              <p className="text-sm text-gray-500 py-12 text-center">No custom templates yet. Put something on the canvas and save it as one.</p>
            ) : (
              <div className="grid grid-cols-2 2xl:grid-cols-3 gap-4">
                {templates.map((t) => <TemplateCard key={t.id} template={t} onLoad={() => load(t)} onDelete={() => removeTemplate(t)} />)}
              </div>
            )}
          </div>

          {/* Detail */}
          {tab === 'holodeck' && (
            <div className="w-[340px] border-l border-gray-200 overflow-y-auto shrink-0">
              {selected ? (
                <EntryDetail entry={selected} onPreview={() => preview(selected)} />
              ) : (
                <div className="p-5 text-xs text-gray-500 space-y-3">
                  <p className="text-sm text-gray-700 font-medium">Pick a system.</p>
                  {FAMILIES.map((f) => (
                    <p key={f.id}><FamilyTag family={f.id} /> <span className="ml-1">{f.description}.</span></p>
                  ))}
                  <p>Double-click a card, or press Enter on it, to preview.</p>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
