// "Create project from this account": a task dialog over the Explorer.
//
// The operator has just scanned an account. This turns what they are looking
// at into a project on the canvas: pick regions and resources (with a live
// preview of what the patterns select), decide what environment this
// account is and which settings it inherits, then run one hydrating scan,
// write warpcore.yaml, and open it. See DESIGN_GUIDANCE.md §5.4.

import { useEffect, useMemo, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import { AlertCircle, AlertTriangle, Check, FolderOpen, Info, RefreshCw, Square, X } from 'lucide-react';
import {
  ENVIRONMENT_TEMPLATES, EnvironmentConfig, environmentFromTemplate, summariseEnvironment, useStore,
} from '../store/useStore';
import { AccountInventory, cancelScan, isCancellation, shortType, useScanProgress } from '../utils/accountExplorer';
import { generateYAMLFromCanvas } from '../utils/configSync';
import { joinPath } from '../utils/host';
import {
  AccountProject, baselineExcludes, buildCanvas, createProjectFromAccount, hasOwnNode, selectResources, slug,
} from '../utils/projectFromAccount';
import { openProjectFile } from '../utils/projectIO';
import { regionLabel } from '../utils/regions';
import ScanProgressView from './ScanProgressView';
import Toggle from './ui/Toggle';

interface Props {
  inventory: AccountInventory;
  profile: string;
  /** The last scan covered every enabled region, so "all regions" is on the table. */
  scannedAllRegions: boolean;
  onClose: () => void;
  /** Called once the project is open on the canvas; the Explorer closes too. */
  onCreated: () => void;
}

type Phase = 'form' | 'running' | 'done';

const NAME_RE = /^[a-z][a-z0-9-]*$/;
const slugify = (s: string) => slug(s, 64, true);

function PatternList({
  label, patterns, onChange, placeholder, hint,
}: {
  label: string; patterns: string[]; onChange: (p: string[]) => void; placeholder: string; hint: string;
}) {
  const [draft, setDraft] = useState('');
  const add = () => {
    const v = draft.trim();
    if (!v || patterns.includes(v)) { setDraft(''); return; }
    onChange([...patterns, v]);
    setDraft('');
  };
  return (
    <div>
      <div className="text-xs font-medium text-gray-700 mb-1">{label}</div>
      <div className="flex flex-wrap gap-1 mb-1">
        {patterns.map((p) => (
          <span key={p} className="inline-flex items-center gap-1 text-xs font-mono bg-gray-100 border border-gray-200 rounded px-1.5 py-0.5">
            {p}
            <button onClick={() => onChange(patterns.filter((x) => x !== p))} className="text-gray-400 hover:text-gray-700" title="Remove">
              <X size={11} />
            </button>
          </span>
        ))}
        {patterns.length === 0 && <span className="text-xs text-gray-400">none</span>}
      </div>
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add(); } }}
        onBlur={add}
        placeholder={placeholder}
        className="w-full text-xs font-mono border border-gray-300 rounded px-2 py-1"
      />
      <p className="text-[11px] text-gray-500 mt-1">{hint}</p>
    </div>
  );
}

export default function CreateProjectDialog({ inventory, profile, scannedAllRegions, onClose, onCreated }: Props) {
  const { prefs, environmentConfigs, configPath, projectName: openProjectName, setCurrentEnvironment } = useStore();

  // ---- project
  const [name, setName] = useState(slugify(profile) || 'my-account');
  const [parentDir, setParentDir] = useState(prefs.projectsDir);
  // ---- scope
  const scannedRegions = useMemo(() => Object.keys(inventory.regions).sort(), [inventory.regions]);
  const [regions, setRegions] = useState<Set<string>>(new Set(scannedRegions));
  const [allRegions, setAllRegions] = useState(false);
  const [include, setInclude] = useState<string[]>(['*']);
  const [exclude, setExclude] = useState<string[]>([]);
  const [hideBaseline, setHideBaseline] = useState(true);
  const [excludedTypes, setExcludedTypes] = useState<Set<string>>(new Set());
  const [lambdaAs, setLambdaAs] = useState<'agent' | 'lambda'>('agent');
  // ---- environment
  const [envKey, setEnvKey] = useState(slugify(profile) || 'prod');
  const [envName, setEnvName] = useState(profile ? profile.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) : 'Production');
  const templateOptions = useMemo(() => {
    const builtIn = Object.entries(ENVIRONMENT_TEMPLATES).map(([key, cfg]) => ({
      id: `template:${key}`, label: `${cfg.name} (built-in)`, config: cfg,
    }));
    const fromProject = configPath
      ? Object.entries(environmentConfigs).map(([key, cfg]) => ({
        id: `project:${key}`, label: `${cfg.name} (from ${openProjectName || 'open project'})`, config: cfg,
      }))
      : [];
    return [...builtIn, ...fromProject];
  }, [environmentConfigs, configPath, openProjectName]);
  const [templateId, setTemplateId] = useState(() => (
    /prod/i.test(profile) ? 'template:prod' : /stag|uat|test/i.test(profile) ? 'template:staging' : 'template:dev'
  ));
  const templateOption = templateOptions.find((t) => t.id === templateId) ?? templateOptions[0];
  // ---- options
  const [includeEnvValues, setIncludeEnvValues] = useState(false);
  const [adopt, setAdopt] = useState(true);

  // ---- run state
  const [phase, setPhase] = useState<Phase>('form');
  const scan = useScanProgress(phase === 'running');
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ project: AccountProject; path: string; dropped: number } | null>(null);

  // ---- live preview over the inventory already in hand
  const baseExclude = useMemo(() => [...exclude, ...(hideBaseline ? baselineExcludes() : [])], [exclude, hideBaseline]);
  const effectiveExclude = useMemo(() => [...baseExclude, ...[...excludedTypes].map((t) => `type:${t}`)], [baseExclude, excludedTypes]);

  const inScope = useMemo(
    () => inventory.resources.filter((r) => allRegions || !r.region || regions.has(r.region)),
    [inventory.resources, regions, allRegions],
  );
  // Types are listed from the pattern selection alone, so unchecking a type
  // does not make it vanish from the list it is unchecked in.
  const patternKept = useMemo(() => selectResources(inScope, include, baseExclude).kept, [inScope, include, baseExclude]);
  const preview = useMemo(() => selectResources(inScope, include, effectiveExclude), [inScope, include, effectiveExclude]);
  const typeCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of patternKept) counts.set(r.type, (counts.get(r.type) || 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [patternKept]);
  // Everything selected is drawn; types without a node of their own get a
  // generic box, and are called out so the count is not a surprise.
  const generic = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of preview.kept) if (!hasOwnNode(r.type)) counts.set(r.type, (counts.get(r.type) || 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [preview.kept]);
  const genericCount = generic.reduce((s, [, n]) => s + n, 0);

  const template = templateOption?.config ?? ENVIRONMENT_TEMPLATES.dev;
  const projectDir = parentDir ? joinPath(parentDir, name) : '';
  const primaryRegion = allRegions ? scannedRegions[0] : [...regions].sort()[0];

  const problems: string[] = [];
  if (!NAME_RE.test(name)) problems.push('Project name must be lowercase letters, digits and hyphens, starting with a letter.');
  if (!parentDir) problems.push('Choose where to create the project.');
  if (!allRegions && regions.size === 0) problems.push('Pick at least one region.');
  if (!NAME_RE.test(envKey)) problems.push('Environment key must be lowercase letters, digits and hyphens.');
  if (!envName.trim()) problems.push('Give the environment a name.');
  if (!primaryRegion) problems.push('No region to use as the environment default.');

  const chooseDir = async () => {
    const picked = await open({ directory: true, defaultPath: parentDir || undefined, title: 'Create the project inside…' });
    if (picked && typeof picked === 'string') setParentDir(picked);
  };

  const run = async () => {
    if (problems.length) return;
    setPhase('running');
    setError(null);
    scan.begin();
    try {
      const project = await createProjectFromAccount({
        profile,
        projectDir,
        projectName: name,
        environment: envKey,
        regions: allRegions ? [] : [...regions],
        allRegions,
        include,
        exclude: effectiveExclude,
        lambdaAs,
        includeEnvValues,
        adopt,
        parallelism: prefs.scanParallelism,
      });

      // Build the canvas, attach the environment this account is, write the
      // file, then open it through the one loading path everything else uses.
      const built = buildCanvas(project);
      const envConfig: EnvironmentConfig = environmentFromTemplate(template, envName.trim());
      const extras = { [envKey]: { account: project.environment.account, region: project.environment.region } };
      const yaml = generateYAMLFromCanvas(built.nodes, built.edges, 100000, { [envKey]: envConfig }, extras, name);
      const path = joinPath(projectDir, 'warpcore.yaml');
      await invoke('write_config_file', { path, content: yaml });
      await openProjectFile(path);
      setCurrentEnvironment(envKey);

      setResult({ project, path, dropped: built.droppedConnections });
      setPhase('done');
    } catch (e) {
      if (isCancellation(e)) { setPhase('form'); return; }
      setError(String(e));
      setPhase('form');
    } finally {
      scan.end();
    }
  };

  const cancel = async () => { try { await cancelScan(); } catch { /* nothing running */ } };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      if (phase === 'running') return;
      if (phase === 'done') onCreated(); else onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [phase, onClose, onCreated]);

  const warnings = result?.project.notes.filter((n) => n.level === 'warning') ?? [];
  const infos = result?.project.notes.filter((n) => n.level === 'info') ?? [];

  return (
    <div className="fixed inset-0 z-[60] bg-black/40 flex items-center justify-center" onClick={(e) => { if (e.target === e.currentTarget && phase === 'form') onClose(); }}>
      <div className="bg-white text-gray-900 rounded-lg shadow-2xl w-[880px] max-h-[88vh] flex flex-col overflow-hidden">
        <div className="px-5 py-3 border-b border-gray-200 flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold">Create a project from this account</h2>
            <p className="text-xs text-gray-500">
              {inventory.account} via <span className="font-mono">{profile}</span> · one fresh scan with full detail, then the project opens on the canvas.
            </p>
          </div>
          {phase !== 'running' && (
            <button onClick={phase === 'done' ? onCreated : onClose} className="p-2 rounded-full hover:bg-gray-100" title="Close (Esc)">
              <X size={18} className="text-gray-500" />
            </button>
          )}
        </div>

        {phase === 'form' && (
          <div className="flex-1 overflow-y-auto px-5 py-4 space-y-6">
            {error && (
              <div className="p-3 bg-red-50 border border-red-200 rounded flex items-start gap-2 text-sm text-red-700">
                <AlertCircle size={16} className="mt-0.5 shrink-0" />
                <pre className="whitespace-pre-wrap font-mono text-xs">{error}</pre>
              </div>
            )}

            {/* Project */}
            <section className="grid grid-cols-[160px_1fr] gap-x-6 gap-y-3 items-start">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500 pt-1">Project</h3>
              <div className="space-y-3">
                <label className="block">
                  <span className="text-xs font-medium text-gray-700">Name</span>
                  <input value={name} onChange={(e) => setName(e.target.value)} className="mt-1 w-64 text-sm font-mono border border-gray-300 rounded px-2 py-1" />
                </label>
                <div>
                  <span className="text-xs font-medium text-gray-700">Location</span>
                  <div className="mt-1 flex items-center gap-2">
                    <button onClick={chooseDir} className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded border border-gray-300 hover:bg-gray-50">
                      <FolderOpen size={12} /> Choose…
                    </button>
                    <span className="text-xs font-mono text-gray-600 truncate">{projectDir ? joinPath(projectDir, 'warpcore.yaml') : 'not chosen'}</span>
                  </div>
                </div>
              </div>
            </section>

            {/* Scope */}
            <section className="grid grid-cols-[160px_1fr] gap-x-6 gap-y-3 items-start border-t border-gray-100 pt-5">
              <div>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500 pt-1">Scope</h3>
                <p className="text-[11px] text-gray-500 mt-1">Preview counts come from the scan you already have.</p>
              </div>
              <div className="space-y-4">
                <div>
                  <span className="text-xs font-medium text-gray-700">Regions</span>
                  <div className="mt-1 flex flex-wrap gap-2">
                    {scannedRegions.map((r) => (
                      <label key={r} className={`inline-flex items-center gap-1.5 text-xs border rounded px-2 py-1 cursor-pointer ${regions.has(r) && !allRegions ? 'border-blue-300 bg-blue-50' : 'border-gray-200'} ${allRegions ? 'opacity-50' : ''}`}>
                        <input
                          type="checkbox"
                          checked={regions.has(r)}
                          disabled={allRegions}
                          onChange={(e) => setRegions((prev) => { const n = new Set(prev); if (e.target.checked) n.add(r); else n.delete(r); return n; })}
                        />
                        {regionLabel(r)} <span className="text-gray-400">{inventory.regions[r]}</span>
                      </label>
                    ))}
                    {scannedAllRegions && (
                      <label className="inline-flex items-center gap-1.5 text-xs border border-gray-200 rounded px-2 py-1 cursor-pointer">
                        <input type="checkbox" checked={allRegions} onChange={(e) => setAllRegions(e.target.checked)} />
                        Every enabled region
                      </label>
                    )}
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <PatternList
                    label="Include"
                    patterns={include}
                    onChange={(p) => setInclude(p.length ? p : ['*'])}
                    placeholder="AWS::Lambda::*, name:orders-*, tag:Project=shop"
                    hint="Globs, any of which may match. Prefix type:, name:, tag: or region: to pin a field; * is everything."
                  />
                  <PatternList
                    label="Exclude"
                    patterns={exclude}
                    onChange={setExclude}
                    placeholder="name:*-test, type:AWS::Logs::*"
                    hint="Anything matching one of these is left out, even if included above."
                  />
                </div>

                <Toggle
                  checked={hideBaseline}
                  onChange={setHideBaseline}
                  label="Leave out the organisation baseline"
                  description="Config rules, SSO and service roles, default parameter groups: the same set the Explorer hides."
                />

                <div>
                  <div className="flex items-baseline justify-between">
                    <span className="text-xs font-medium text-gray-700">Resource types</span>
                    <span className="text-xs text-gray-500">
                      <strong className="text-gray-800">{preview.kept.length}</strong> of {inScope.length} selected, all drawn
                      {genericCount > 0 && ` · ${genericCount} as generic boxes`}
                    </span>
                  </div>
                  <div className="mt-1 max-h-44 overflow-y-auto border border-gray-200 rounded divide-y divide-gray-100">
                    {typeCounts.length === 0 && <p className="text-xs text-gray-500 p-2">Nothing matches.</p>}
                    {typeCounts.map(([type, count]) => {
                      const representable = hasOwnNode(type);
                      const checked = !excludedTypes.has(type);
                      return (
                        <label key={type} className="flex items-center gap-2 px-2 py-1 text-xs cursor-pointer hover:bg-gray-50">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={(e) => setExcludedTypes((prev) => { const n = new Set(prev); if (e.target.checked) n.delete(type); else n.add(type); return n; })}
                          />
                          <span className={`flex-1 ${representable ? 'text-gray-800' : 'text-gray-400'}`}>{shortType(type)}</span>
                          {!representable && <span className="text-[10px] uppercase tracking-wide text-gray-400" title="No node of its own yet: drawn as a generic box with its type, name and ARN">generic</span>}
                          <span className="text-gray-500 tabular-nums">{count}</span>
                        </label>
                      );
                    })}
                  </div>
                  {generic.length > 0 && (
                    <p className="text-[11px] text-gray-500 mt-1">
                      Generic boxes: {generic.slice(0, 6).map(([t, n]) => `${shortType(t)} (${n})`).join(', ')}{generic.length > 6 ? ', …' : ''}. Uncheck a type above to leave it out.
                    </p>
                  )}
                </div>

                <div>
                  <span className="text-xs font-medium text-gray-700">Lambda functions become</span>
                  <div className="mt-1 flex gap-2">
                    {([['agent', 'Agents', 'Deployable from source by warpcore. Names are coerced to the agent schema.'],
                       ['lambda', 'Lambda nodes', 'Shown as they are, names untouched. Not deployed from source.']] as const).map(([v, l, d]) => (
                      <label key={v} className={`flex-1 border rounded p-2 cursor-pointer ${lambdaAs === v ? 'border-blue-300 bg-blue-50' : 'border-gray-200'}`}>
                        <span className="flex items-center gap-2 text-xs font-medium"><input type="radio" checked={lambdaAs === v} onChange={() => setLambdaAs(v)} />{l}</span>
                        <span className="block text-[11px] text-gray-500 mt-0.5">{d}</span>
                      </label>
                    ))}
                  </div>
                </div>
              </div>
            </section>

            {/* Environment */}
            <section className="grid grid-cols-[160px_1fr] gap-x-6 gap-y-3 items-start border-t border-gray-100 pt-5">
              <div>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500 pt-1">Environment</h3>
                <p className="text-[11px] text-gray-500 mt-1">This account becomes one environment of the project. Add more later from the toolbar.</p>
              </div>
              <div className="space-y-3">
                <div className="grid grid-cols-3 gap-3">
                  <label className="block">
                    <span className="text-xs font-medium text-gray-700">Key</span>
                    <input value={envKey} onChange={(e) => setEnvKey(e.target.value)} className="mt-1 w-full text-sm font-mono border border-gray-300 rounded px-2 py-1" />
                  </label>
                  <label className="block col-span-2">
                    <span className="text-xs font-medium text-gray-700">Name</span>
                    <input value={envName} onChange={(e) => setEnvName(e.target.value)} className="mt-1 w-full text-sm border border-gray-300 rounded px-2 py-1" />
                  </label>
                </div>
                <div className="grid grid-cols-3 gap-3 text-xs">
                  <div><span className="text-gray-500">Account</span><div className="font-mono">{inventory.account}</div></div>
                  <div><span className="text-gray-500">Default region</span><div className="font-mono">{primaryRegion || '-'}</div></div>
                  <div><span className="text-gray-500">Regions</span><div className="font-mono">{allRegions ? 'all enabled' : regions.size}</div></div>
                </div>
                <label className="block">
                  <span className="text-xs font-medium text-gray-700">Inherit settings from</span>
                  <select value={templateId} onChange={(e) => setTemplateId(e.target.value)} className="mt-1 w-full text-sm border border-gray-300 rounded px-2 py-1 bg-white">
                    {templateOptions.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
                  </select>
                  <span className="block text-[11px] text-gray-500 mt-1">
                    {summariseEnvironment(template)}. Edit any of it afterwards on the environment in the inspector.
                  </span>
                </label>
              </div>
            </section>

            {/* Options */}
            <section className="grid grid-cols-[160px_1fr] gap-x-6 gap-y-3 items-start border-t border-gray-100 pt-5">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500 pt-1">Options</h3>
              <div className="space-y-3">
                <Toggle
                  checked={adopt}
                  onChange={setAdopt}
                  label="Register resources in deployment state"
                  description="So Deploy updates what exists instead of creating a second copy. Writes only local state under the project; nothing in AWS changes."
                />
                <Toggle
                  checked={includeEnvValues}
                  onChange={setIncludeEnvValues}
                  label="Copy Lambda environment variable values"
                  description="Off keeps the names and redacts the values. Live functions often hold credentials there, and this file is meant to be committed."
                />
              </div>
            </section>
          </div>
        )}

        {phase === 'running' && (
          <div className="flex-1 overflow-y-auto">
            {scan.progress.size === 0 ? (
              <div className="p-12 text-center text-gray-500">
                <RefreshCw size={32} className="mx-auto mb-3 animate-spin text-blue-500" />
                <p>Starting… {scan.elapsed}s</p>
              </div>
            ) : (
              <ScanProgressView regions={scan.progress} elapsed={scan.elapsed} parallelism={scan.parallelism} />
            )}
          </div>
        )}

        {phase === 'done' && result && (
          <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
            <div className="flex items-start gap-3 p-3 bg-emerald-50 border border-emerald-200 rounded">
              <Check size={18} className="text-emerald-600 mt-0.5" />
              <div className="text-sm">
                <div className="font-medium text-emerald-900">
                  {result.project.counts.shown} resource{result.project.counts.shown === 1 ? '' : 's'} on the canvas, {result.project.counts.connections} connection{result.project.counts.connections === 1 ? '' : 's'}.
                </div>
                <div className="text-xs text-emerald-800 mt-0.5 font-mono">{result.path}</div>
                <div className="text-xs text-emerald-800 mt-1">
                  {result.project.adopted !== null
                    ? `${result.project.adopted} registered in deployment state.`
                    : 'Not registered in deployment state: a Deploy would create new copies.'}
                  {result.project.counts.excluded > 0 && ` ${result.project.counts.excluded} excluded by your patterns.`}
                  {result.project.counts.skipped > 0 && ` ${result.project.counts.skipped} left out.`}
                </div>
              </div>
            </div>

            {Object.keys(result.project.skipped).length > 0 && (
              <div className="text-xs text-gray-600">
                <span className="font-medium text-gray-800">Left out: </span>
                {Object.entries(result.project.skipped).map(([t, n]) => `${shortType(t)} (${n})`).join(', ')}
              </div>
            )}

            {warnings.length > 0 && (
              <div>
                <div className="flex items-center gap-1.5 text-xs font-semibold text-amber-800 mb-1"><AlertTriangle size={13} /> {warnings.length} thing{warnings.length === 1 ? '' : 's'} to review</div>
                <ul className="text-xs space-y-1 max-h-48 overflow-y-auto border border-amber-200 bg-amber-50 rounded p-2">
                  {warnings.map((n, i) => (
                    <li key={i}><span className="font-mono text-amber-900">{n.physical_id.split(':').pop()}</span> <span className="text-amber-900">{n.message}</span></li>
                  ))}
                </ul>
              </div>
            )}

            {infos.length > 0 && (
              <details className="text-xs">
                <summary className="cursor-pointer text-gray-600 inline-flex items-center gap-1"><Info size={12} /> {infos.length} note{infos.length === 1 ? '' : 's'}</summary>
                <ul className="mt-1 space-y-1 text-gray-600 max-h-40 overflow-y-auto">
                  {infos.map((n, i) => <li key={i}>{n.message}</li>)}
                </ul>
              </details>
            )}

            <div className="text-xs text-gray-600 border-t border-gray-100 pt-3">
              <span className="font-medium text-gray-800">Before you deploy this project: </span>
              agent source paths are guesses, so point them at real code; environment variable values are
              {includeEnvValues ? ' copied from the live functions, so check them for credentials' : ' redacted, so fill them in'}.
              The environment's settings were inherited from {templateOption?.label}; open it from the toolbar to adjust.
            </div>
          </div>
        )}

        <div className="px-5 py-3 border-t border-gray-200 bg-gray-50 flex items-center justify-between">
          {phase === 'form' && (
            <>
              <div className="text-xs text-red-600">{problems[0] || ''}</div>
              <div className="flex items-center gap-2">
                <button onClick={onClose} className="text-sm px-3 py-1.5 rounded border border-gray-300 hover:bg-white">Cancel</button>
                <button
                  onClick={run}
                  disabled={problems.length > 0}
                  className="text-sm px-3 py-1.5 rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
                  title={problems[0] || `Scan ${allRegions ? 'every region' : `${regions.size} region(s)`} with full detail and create the project`}
                >
                  Create project
                </button>
              </div>
            </>
          )}
          {phase === 'running' && (
            <>
              <div className="text-xs text-gray-600">Scanning with full detail, then writing the project. {scan.elapsed}s</div>
              <button onClick={cancel} className="inline-flex items-center gap-2 text-sm px-3 py-1.5 rounded bg-red-600 text-white hover:bg-red-700">
                <Square size={12} fill="currentColor" /> Cancel
              </button>
            </>
          )}
          {phase === 'done' && (
            <>
              <div className="text-xs text-gray-600">The project is open on the canvas behind this dialog.</div>
              <button onClick={onCreated} className="text-sm px-3 py-1.5 rounded bg-blue-600 text-white hover:bg-blue-700">Done</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
