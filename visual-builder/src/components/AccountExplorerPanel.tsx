import { useEffect, useMemo, useState } from 'react';
import { X, Radar, RefreshCw, AlertCircle, ChevronDown, ChevronRight, Search, EyeOff, Eye, Square, Settings, Clock, FolderPlus } from 'lucide-react';
import {
  AccountInventory,
  DiscoveredResource,
  cancelScan,
  discoverAccount,
  isBaseline,
  isCancellation,
  LAST_PROFILE_KEY,
  listAwsProfiles,
  parseInventory,
  preferredProfile,
  scanCacheKey,
  shortType,
  typeRank,
  useScanProgress,
} from '../utils/accountExplorer';
import { formatAgo, readScanCache, writeScanCache } from '../utils/host';
import ResourceDetailDrawer from './ResourceDetailDrawer';
import ScanProgressView from './ScanProgressView';
import CreateProjectDialog from './CreateProjectDialog';
import { useStore } from '../store/useStore';
import { regionLabel } from '../utils/regions';

interface Props {
  isOpen: boolean;
  onClose: () => void;
}

export default function AccountExplorerPanel({ isOpen, onClose }: Props) {
  const [profiles, setProfiles] = useState<string[]>([]);
  const [profile, setProfile] = useState<string>('');
  const [allRegions, setAllRegions] = useState(false);
  const { selectedRegions, prefs, openSettings } = useStore();
  // Which of the configured regions to scan this time. Empty = all of them.
  const [scanRegions, setScanRegions] = useState<string[]>([]);
  const [inventory, setInventory] = useState<AccountInventory | null>(null);
  // Unix seconds the shown inventory was scanned, when it came from the cache.
  const [cachedAt, setCachedAt] = useState<number | null>(null);
  const [isScanning, setIsScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hideBaseline, setHideBaseline] = useState(true);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<DiscoveredResource | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [autoExpanded, setAutoExpanded] = useState<Set<string>>(new Set());
  const [showCreate, setShowCreate] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || showCreate) return;
      // Escape closes the drawer first, then the panel.
      if (selected) setSelected(null);
      else onClose();
    };
    if (isOpen) window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose, selected, showCreate]);

  useEffect(() => {
    if (!isOpen || profiles.length) return;
    listAwsProfiles()
      .then((names) => {
        setProfiles(names);
        setProfile(preferredProfile(names));
      })
      .catch((e) => setError(String(e)));
  }, [isOpen, profiles.length]);

  const { progress, parallelism, elapsed, begin, end } = useScanProgress(isOpen);

  const cancel = async () => {
    try { await cancelScan(); } catch { /* nothing to cancel */ }
  };

  // Which regions this scan will actually cover. An empty selection means
  // every configured region; no configured regions at all falls back to the
  // profile's own, so a fresh install still does something sensible.
  const effectiveRegions = scanRegions.length ? scanRegions : selectedRegions;

  const scanOptions = () => ({
    profile,
    // Empty means "the profile's own region"; the CLI resolves it.
    regions: allRegions ? [] : effectiveRegions,
    allRegions,
  });

  /**
   * Show the cached scan for this profile and region set if it is younger
   * than Settings › Exploration allows. Returns true when one was used.
   */
  const loadFromCache = async (): Promise<boolean> => {
    if (!profile || prefs.scanCacheMinutes <= 0) return false;
    try {
      const hit = await readScanCache(scanCacheKey(scanOptions()));
      if (!hit) return false;
      const ageSeconds = Date.now() / 1000 - hit.saved_at;
      if (ageSeconds > prefs.scanCacheMinutes * 60) return false;
      setInventory(parseInventory(hit.content));
      setCachedAt(hit.saved_at);
      setError(null);
      return true;
    } catch {
      // A corrupt or unreadable cache entry is just a miss.
      return false;
    }
  };

  const scan = async (force = false) => {
    if (!profile) return;
    try { localStorage.setItem(LAST_PROFILE_KEY, profile); } catch { /* ignore */ }
    if (!force && await loadFromCache()) return;

    setIsScanning(true);
    begin();
    setError(null);
    setSelected(null);
    setCachedAt(null);
    try {
      const opts = scanOptions();
      const result = await discoverAccount({ ...opts, hydrate: false, parallelism: prefs.scanParallelism });
      setInventory(result);
      // Best effort: a failed cache write must not turn a good scan into an error.
      writeScanCache(scanCacheKey(opts), JSON.stringify(result)).catch(() => undefined);
    } catch (e) {
      // A cancellation is the user's own action, not something to report.
      if (!isCancellation(e)) setError(String(e));
    } finally {
      setIsScanning(false);
      end();
    }
  };

  // Opening the Explorer with a fresh-enough cached scan shows it at once,
  // without spending a scan. The operator can still press Rescan.
  useEffect(() => {
    if (!isOpen || !profile || inventory || isScanning) return;
    loadFromCache();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, profile]);

  // region -> type -> resources, after the baseline and search filters.
  const grouped = useMemo(() => {
    if (!inventory) return new Map<string, Map<string, DiscoveredResource[]>>();
    const q = query.trim().toLowerCase();
    const out = new Map<string, Map<string, DiscoveredResource[]>>();
    for (const r of inventory.resources) {
      if (hideBaseline && isBaseline(r)) continue;
      if (q && !`${r.id} ${r.type} ${r.physical_id} ${Object.values(r.tags).join(' ')}`.toLowerCase().includes(q)) continue;
      const region = r.region || 'global';
      if (!out.has(region)) out.set(region, new Map());
      const byType = out.get(region)!;
      if (!byType.has(r.type)) byType.set(r.type, []);
      byType.get(r.type)!.push(r);
    }
    for (const byType of out.values()) {
      for (const list of byType.values()) list.sort((a, b) => a.id.localeCompare(b.id));
    }
    return out;
  }, [inventory, hideBaseline, query]);

  const visibleCount = useMemo(() => {
    let n = 0;
    for (const byType of grouped.values()) for (const list of byType.values()) n += list.length;
    return n;
  }, [grouped]);

  const hiddenCount = inventory
    ? inventory.resources.filter((r) => hideBaseline && isBaseline(r)).length
    : 0;

  const toggle = (key: string, currentlyOpen: boolean) => {
    if (currentlyOpen) {
      setCollapsed((prev) => new Set(prev).add(key));
      setAutoExpanded((prev) => { const n = new Set(prev); n.delete(key); return n; });
    } else {
      setCollapsed((prev) => { const n = new Set(prev); n.delete(key); return n; });
      setAutoExpanded((prev) => new Set(prev).add(key));
    }
  };

  if (!isOpen) return null;

  const regionOrder = [...grouped.keys()].sort((a, b) => {
    // Busiest region first; "global" last.
    if (a === 'global') return 1;
    if (b === 'global') return -1;
    const size = (k: string) => [...grouped.get(k)!.values()].reduce((s, l) => s + l.length, 0);
    return size(b) - size(a);
  });

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      {/* text-gray-900: this modal is a DOM child of the dark Toolbar and would
          otherwise inherit its text-white, turning the title and the profile
          <select> invisible on the white panel. */}
      <div className="bg-surface text-gray-900 rounded-lg shadow-xl w-[95vw] h-[90vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="px-4 py-3 border-b border-gray-200 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Radar size={20} className="text-blue-600" />
            <h2 className="text-lg font-semibold">Account Explorer</h2>
            {inventory && (
              <span className="text-sm text-gray-500">
                {inventory.account} · {inventory.resources.length} resources across {Object.keys(inventory.regions).length} region{Object.keys(inventory.regions).length === 1 ? '' : 's'}
              </span>
            )}
            {inventory && cachedAt && (
              <button
                onClick={() => { onClose(); openSettings('exploration'); }}
                className="inline-flex items-center gap-1 text-xs text-gray-500 border border-gray-200 rounded-full px-2 py-0.5 hover:bg-gray-50"
                title="From the scan cache. Reuse time is set in Settings › Exploration."
              >
                <Clock size={12} />
                cached {formatAgo(cachedAt)}
              </button>
            )}
          </div>
          <button onClick={onClose} className="p-2 hover:bg-gray-100 rounded-full" title="Close (Esc)">
            <X size={20} className="text-gray-500" />
          </button>
        </div>

        {/* Controls */}
        <div className="px-4 py-2 border-b border-gray-200 bg-gray-50 flex items-center gap-3 flex-wrap">
          <label className="text-sm text-gray-600">Profile</label>
          <select
            value={profile}
            onChange={(e) => setProfile(e.target.value)}
            className="text-sm border border-gray-300 rounded px-2 py-1 bg-surface min-w-[200px]"
            disabled={isScanning}
          >
            {profiles.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>

          <label className="text-sm text-gray-600">Regions</label>
          <select
            multiple={false}
            value={allRegions ? '__all__' : (scanRegions[0] ?? '__configured__')}
            onChange={(e) => {
              const v = e.target.value;
              if (v === '__all__') { setAllRegions(true); setScanRegions([]); }
              else if (v === '__configured__') { setAllRegions(false); setScanRegions([]); }
              else { setAllRegions(false); setScanRegions([v]); }
            }}
            className="text-sm border border-gray-300 rounded px-2 py-1 bg-surface min-w-[240px]"
            disabled={isScanning}
            title="Regions of interest are chosen in Settings › Regions"
          >
            {selectedRegions.length > 0 && (
              <option value="__configured__">
                All configured ({selectedRegions.length})
              </option>
            )}
            {selectedRegions.length === 0 && (
              <option value="__configured__">Profile's region</option>
            )}
            {selectedRegions.map((r) => (
              <option key={r} value={r}>{regionLabel(r)}</option>
            ))}
            <option value="__all__">Every enabled region (slow)</option>
          </select>
          <button
            onClick={() => { onClose(); openSettings('regions'); }}
            className="p-1.5 rounded text-gray-500 hover:text-gray-800 hover:bg-gray-100"
            title="Choose regions of interest (Settings › Regions)"
          >
            <Settings size={14} />
          </button>

          {isScanning ? (
            <button
              onClick={cancel}
              className="flex items-center gap-2 px-3 py-1.5 bg-red-600 text-white text-sm rounded hover:bg-red-700"
              title="Kill the scan"
            >
              <Square size={12} fill="currentColor" />
              Cancel
              <span className="text-xs opacity-80 tabular-nums">{elapsed}s</span>
            </button>
          ) : (
            <button
              onClick={() => scan(Boolean(inventory))}
              disabled={!profile}
              className="flex items-center gap-2 px-3 py-1.5 bg-blue-600 text-white text-sm rounded hover:bg-blue-700 disabled:opacity-50"
              title={inventory ? 'Scan again now, ignoring the cache' : (prefs.scanCacheMinutes > 0 ? `Uses a scan younger than ${prefs.scanCacheMinutes} min if there is one` : 'Scan the account')}
            >
              <RefreshCw size={14} />
              {inventory ? 'Rescan' : 'Scan'}
            </button>
          )}

          <div className="flex-1" />

          {inventory && !isScanning && (
            <button
              onClick={() => setShowCreate(true)}
              className="flex items-center gap-2 px-3 py-1.5 bg-emerald-600 text-white text-sm rounded hover:bg-emerald-700"
              title="Turn what you are looking at into a project on the canvas"
            >
              <FolderPlus size={14} />
              Create project…
            </button>
          )}

          {inventory && (
            <>
              <div className="relative">
                <Search size={14} className="absolute left-2 top-2 text-gray-400" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Filter by name, type, ARN, tag"
                  className="text-sm border border-gray-300 rounded pl-7 pr-2 py-1 w-72"
                />
              </div>
              <button
                onClick={() => setHideBaseline((v) => !v)}
                className="flex items-center gap-1.5 text-sm text-gray-600 hover:text-gray-900 px-2 py-1 rounded hover:bg-gray-100"
                title="Org baseline: Config rules, SSO roles, Inspector rules, default parameter groups"
              >
                {hideBaseline ? <EyeOff size={14} /> : <Eye size={14} />}
                {hideBaseline ? `${hiddenCount} baseline hidden` : 'Showing baseline'}
              </button>
            </>
          )}
        </div>

        {/* Body */}
        <div className="flex-1 flex overflow-hidden">
          {/* Resource tree */}
          <div className={`${selected ? 'w-[40%]' : 'w-full'} overflow-y-auto border-r border-gray-200`}>
            {error && (
              <div className="m-4 p-3 bg-red-50 border border-red-200 rounded flex items-start gap-2 text-sm text-red-700">
                <AlertCircle size={16} className="mt-0.5 shrink-0" />
                <pre className="whitespace-pre-wrap font-mono text-xs">{error}</pre>
              </div>
            )}

            {!inventory && !isScanning && !error && (
              <div className="p-12 text-center text-gray-500">
                <Radar size={40} className="mx-auto mb-3 text-gray-300" />
                <p>Pick a profile and scan to see what is actually deployed in the account.</p>
                <p className="text-xs mt-2">Read-only. Nothing is created, modified or deleted.</p>
              </div>
            )}

            {isScanning && progress.size === 0 && (
              <div className="p-12 text-center text-gray-500">
                <RefreshCw size={32} className="mx-auto mb-3 animate-spin text-blue-500" />
                <p>Starting scan… {elapsed}s</p>
              </div>
            )}

            {isScanning && progress.size > 0 && (
              <ScanProgressView
                regions={progress}
                elapsed={elapsed}
                parallelism={parallelism}
              />
            )}

            {inventory && !isScanning && (
              <div className="p-2">
                {!inventory.resource_explorer && (
                  <div className="mx-2 mb-2 p-2 bg-amber-50 border border-amber-200 rounded text-xs text-amber-800">
                    AWS Resource Explorer is not enabled in this account; coverage is limited to the services warpcore enumerates directly.
                  </div>
                )}
                <div className="px-2 pb-2 text-xs text-gray-500">{visibleCount} shown</div>

                {regionOrder.map((region) => {
                  const byType = grouped.get(region)!;
                  const regionKey = `r:${region}`;
                  const regionCount = [...byType.values()].reduce((s, l) => s + l.length, 0);
                  const open = !collapsed.has(regionKey);
                  return (
                    <div key={region} className="mb-1">
                      <button onClick={() => toggle(regionKey, open)} className="w-full flex items-center gap-2 px-2 py-1.5 hover:bg-gray-100 rounded text-left">
                        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                        <span className="font-semibold text-sm">{region}</span>
                        <span className="text-xs text-gray-500">{regionCount}</span>
                      </button>
                      {open && [...byType.entries()]
                        .sort((a, b) => typeRank(a[0]) - typeRank(b[0]) || a[0].localeCompare(b[0]))
                        .map(([type, list]) => {
                        const typeKey = `${regionKey}:${type}`;
                        // Large groups start collapsed so they do not push everything
                        // else off-screen; the count is still visible on the header.
                        const typeOpen = collapsed.has(typeKey) ? false : (autoExpanded.has(typeKey) || list.length <= 8);
                        return (
                          <div key={type} className="ml-5">
                            <button onClick={() => toggle(typeKey, typeOpen)} className="w-full flex items-center gap-2 px-2 py-1 hover:bg-gray-100 rounded text-left">
                              {typeOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                              <span className="text-sm text-gray-700">{shortType(type)}</span>
                              <span className="text-xs text-gray-400">{list.length}</span>
                            </button>
                            {typeOpen && list.map((r) => (
                              <button
                                key={r.physical_id}
                                onClick={() => setSelected(r)}
                                className={`w-full text-left ml-5 px-2 py-1 rounded text-sm font-mono truncate ${
                                  selected?.physical_id === r.physical_id ? 'bg-blue-100 text-blue-900' : 'hover:bg-gray-100 text-gray-800'
                                }`}
                                title={r.physical_id}
                              >
                                {r.id}
                              </button>
                            ))}
                          </div>
                        );
                      })}
                    </div>
                  );
                })}

                {inventory.errors.length > 0 && (
                  <div className="mx-2 mt-3 p-2 bg-amber-50 border border-amber-200 rounded text-xs text-amber-800">
                    {inventory.errors.length} resource(s) could not be read (usually a permission the profile lacks).
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Detail drawer */}
          {selected && (
            <div className="flex-1 overflow-hidden">
              <ResourceDetailDrawer
                profile={profile}
                resource={selected}
                onClose={() => setSelected(null)}
                onNavigate={(arn) => {
                  const target = inventory?.resources.find((r) => r.physical_id === arn);
                  if (target) setSelected(target);
                  else setSelected({ id: arn.split(/[/:]/).pop() || arn, type: '', physical_id: arn, region: null, sources: [], tags: {}, properties: {} });
                }}
              />
            </div>
          )}
        </div>
      </div>

      {showCreate && inventory && (
        <CreateProjectDialog
          inventory={inventory}
          profile={profile}
          scannedAllRegions={allRegions}
          onClose={() => setShowCreate(false)}
          onCreated={() => { setShowCreate(false); onClose(); }}
        />
      )}
    </div>
  );
}
