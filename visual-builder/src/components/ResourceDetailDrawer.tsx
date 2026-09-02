import { useEffect, useState } from 'react';
import { X, RefreshCw, AlertCircle, Network, Activity, ScrollText, Link2, Info, ExternalLink } from 'lucide-react';
import {
  DiscoveredResource,
  ResourceDetail,
  fetchResourceDetail,
  formatBytes,
  formatMetric,
  shortType,
} from '../utils/accountExplorer';

interface Props {
  profile: string;
  resource: DiscoveredResource;
  onClose: () => void;
  onNavigate: (arn: string) => void;
}

type Tab = 'overview' | 'network' | 'metrics' | 'logs' | 'related';

const WINDOWS = [
  { label: '1h', hours: 1 },
  { label: '24h', hours: 24 },
  { label: '7d', hours: 168 },
  { label: '30d', hours: 720 },
];

export default function ResourceDetailDrawer({ profile, resource, onClose, onNavigate }: Props) {
  const [detail, setDetail] = useState<ResourceDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('overview');
  const [hours, setHours] = useState(24);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setDetail(null);
    fetchResourceDetail(profile, resource.physical_id, hours)
      .then((d) => { if (!cancelled) setDetail(d); })
      .catch((e) => { if (!cancelled) setError(String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [profile, resource.physical_id, hours]);

  const openIngress = detail?.network?.rules.filter(
    (r) => r.direction === 'ingress' && (r.source === '0.0.0.0/0' || r.source === '::/0'),
  ) ?? [];

  const tabs: { id: Tab; label: string; icon: JSX.Element; badge?: number | string }[] = [
    { id: 'overview', label: 'Overview', icon: <Info size={14} /> },
    { id: 'network', label: 'Network', icon: <Network size={14} />, badge: openIngress.length ? `${openIngress.length} open` : undefined },
    { id: 'metrics', label: 'Metrics', icon: <Activity size={14} />, badge: detail?.metrics?.series.filter((s) => s.datapoints).length || undefined },
    { id: 'logs', label: 'Logs', icon: <ScrollText size={14} />, badge: detail?.logs.reduce((n, g) => n + g.recent_events.length, 0) || undefined },
    { id: 'related', label: 'Related', icon: <Link2 size={14} />, badge: detail?.related.length || undefined },
  ];

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="px-4 py-3 border-b border-gray-200 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold uppercase tracking-wide text-blue-700 bg-blue-50 border border-blue-100 rounded px-1.5 py-0.5">
              {shortType(detail?.type || resource.type || 'Resource')}
            </span>
            {detail?.region && <span className="text-xs text-gray-500">{detail.region}</span>}
          </div>
          <h3 className="text-base font-semibold mt-1 truncate">{detail?.name || resource.id}</h3>
          <p className="text-xs font-mono text-gray-500 truncate" title={resource.physical_id}>{resource.physical_id}</p>
        </div>
        <button onClick={onClose} className="p-1.5 hover:bg-gray-100 rounded-full shrink-0" title="Close (Esc)">
          <X size={18} className="text-gray-500" />
        </button>
      </div>

      {/* Tabs */}
      <div className="px-4 border-b border-gray-200 flex items-center gap-1">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`flex items-center gap-1.5 px-3 py-2 text-sm border-b-2 -mb-px ${
              tab === t.id ? 'border-blue-600 text-blue-700' : 'border-transparent text-gray-600 hover:text-gray-900'
            }`}
          >
            {t.icon}
            {t.label}
            {t.badge !== undefined && (
              <span className={`text-[10px] px-1.5 rounded-full ${typeof t.badge === 'string' && t.badge.includes('open') ? 'bg-red-100 text-red-700' : 'bg-gray-100 text-gray-600'}`}>
                {t.badge}
              </span>
            )}
          </button>
        ))}
        <div className="flex-1" />
        <div className="flex items-center gap-1 text-xs text-gray-500">
          {WINDOWS.map((w) => (
            <button
              key={w.hours}
              onClick={() => setHours(w.hours)}
              className={`px-2 py-0.5 rounded ${hours === w.hours ? 'bg-gray-200 text-gray-900' : 'hover:bg-gray-100'}`}
            >
              {w.label}
            </button>
          ))}
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto p-4">
        {loading && (
          <div className="flex items-center gap-2 text-sm text-gray-500">
            <RefreshCw size={14} className="animate-spin" /> Loading configuration, network, metrics and logs…
          </div>
        )}
        {error && (
          <div className="p-3 bg-red-50 border border-red-200 rounded text-sm text-red-700 flex gap-2">
            <AlertCircle size={16} className="shrink-0 mt-0.5" />
            <pre className="whitespace-pre-wrap font-mono text-xs">{error}</pre>
          </div>
        )}
        {detail && !loading && (
          <>
            {tab === 'overview' && <Overview detail={detail} />}
            {tab === 'network' && <NetworkTab detail={detail} onNavigate={onNavigate} />}
            {tab === 'metrics' && <MetricsTab detail={detail} />}
            {tab === 'logs' && <LogsTab detail={detail} />}
            {tab === 'related' && <RelatedTab detail={detail} onNavigate={onNavigate} />}

            {Object.keys(detail.errors).length > 0 && (
              <div className="mt-4 p-2 bg-amber-50 border border-amber-200 rounded text-xs text-amber-800">
                <div className="font-semibold mb-1">Sections that could not be read</div>
                {Object.entries(detail.errors).map(([k, v]) => <div key={k}><span className="font-mono">{k}</span>: {v}</div>)}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ----------------------------------------------------------------- tabs

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-5">
      <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">{title}</h4>
      {children}
    </div>
  );
}

function KeyValue({ rows }: { rows: [string, unknown][] }) {
  if (!rows.length) return <p className="text-sm text-gray-400">None</p>;
  return (
    <table className="w-full text-sm">
      <tbody>
        {rows.map(([k, v]) => (
          <tr key={k} className="border-b border-gray-100">
            <td className="py-1 pr-3 text-gray-500 align-top whitespace-nowrap font-mono text-xs">{k}</td>
            <td className="py-1 font-mono text-xs break-all">{typeof v === 'object' ? JSON.stringify(v) : String(v)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Overview({ detail }: { detail: ResourceDetail }) {
  const scalars = Object.entries(detail.configuration).filter(([k, v]) => typeof v !== 'object' && k !== 'Tags');
  const nested = Object.entries(detail.configuration).filter(([, v]) => typeof v === 'object' && v !== null);
  return (
    <>
      {detail.cost_hint && (
        <div className="mb-4 p-2 bg-blue-50 border border-blue-100 rounded text-sm text-blue-900">{detail.cost_hint}</div>
      )}
      {detail.notes.map((n) => <p key={n} className="mb-2 text-xs text-gray-500">{n}</p>)}
      <Section title="Tags"><KeyValue rows={Object.entries(detail.tags)} /></Section>
      <Section title="Configuration"><KeyValue rows={scalars} /></Section>
      {nested.length > 0 && (
        <Section title="Nested configuration">
          {nested.map(([k, v]) => (
            <details key={k} className="mb-1">
              <summary className="text-xs font-mono cursor-pointer text-gray-700">{k}</summary>
              <pre className="mt-1 p-2 bg-gray-50 rounded text-[11px] overflow-x-auto">{JSON.stringify(v, null, 2)}</pre>
            </details>
          ))}
        </Section>
      )}
    </>
  );
}

function NetworkTab({ detail, onNavigate }: { detail: ResourceDetail; onNavigate: (arn: string) => void }) {
  const net = detail.network;
  if (!net) return <p className="text-sm text-gray-400">No network information for this resource type.</p>;
  const placement: [string, unknown][] = [];
  if (net.vpc_id) placement.push(['VPC', net.vpc_id]);
  if (net.subnet_id) placement.push(['Subnet', net.subnet_id]);
  if (net.availability_zone) placement.push(['AZ', net.availability_zone]);
  if (net.private_ips.length) placement.push(['Private IPs', net.private_ips.join(', ')]);
  if (net.public_ips.length) placement.push(['Public IPs', net.public_ips.join(', ')]);

  const arnFor = (kind: string, id: string) => `arn:aws:ec2:${detail.region}:${detail.arn.split(':')[4]}:${kind}/${id}`;

  return (
    <>
      {net.notes.map((n) => (
        <div key={n} className={`mb-2 p-2 rounded text-sm border ${n.includes('open to the internet') || n.includes('not being recorded') || n.includes('not enabled') ? 'bg-amber-50 border-amber-200 text-amber-900' : 'bg-gray-50 border-gray-200 text-gray-700'}`}>{n}</div>
      ))}
      <Section title="Placement"><KeyValue rows={placement} /></Section>

      {net.rules.length > 0 && (
        <Section title={`Security group rules (${net.rules.length})`}>
          <table className="w-full text-xs">
            <thead><tr className="text-left text-gray-500"><th className="py-1">Dir</th><th>Proto</th><th>Ports</th><th>Source / Dest</th><th>Description</th></tr></thead>
            <tbody>
              {net.rules.map((r, i) => {
                const worldOpen = r.direction === 'ingress' && (r.source === '0.0.0.0/0' || r.source === '::/0');
                const ports = r.from_port == null ? 'all' : r.from_port === r.to_port ? String(r.from_port) : `${r.from_port}-${r.to_port}`;
                return (
                  <tr key={i} className={`border-t border-gray-100 ${worldOpen ? 'bg-red-50' : ''}`}>
                    <td className="py-1">{r.direction}</td>
                    <td className="font-mono">{r.protocol}</td>
                    <td className="font-mono">{ports}</td>
                    <td className={`font-mono ${worldOpen ? 'text-red-700 font-semibold' : ''}`}>
                      {r.source.startsWith('sg-') ? <button className="underline" onClick={() => onNavigate(arnFor('security-group', r.source))}>{r.source}</button> : r.source}
                    </td>
                    <td className="text-gray-600">{r.description}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Section>
      )}

      {net.routes.length > 0 && (
        <Section title="Routes">
          <table className="w-full text-xs">
            <thead><tr className="text-left text-gray-500"><th className="py-1">Destination</th><th>Target</th><th>State</th></tr></thead>
            <tbody>{net.routes.map((r, i) => <tr key={i} className="border-t border-gray-100"><td className="py-1 font-mono">{r.destination}</td><td className="font-mono">{r.target}</td><td>{r.state}</td></tr>)}</tbody>
          </table>
        </Section>
      )}

      <Section title="Flow logs">
        {net.flow_logs.length
          ? net.flow_logs.map((f) => <div key={f.id} className="text-xs font-mono">{f.id} · {f.status} · {f.traffic} → {f.destination}</div>)
          : <p className="text-sm text-gray-400">None covering this resource.</p>}
      </Section>

      {net.interfaces.length > 0 && (
        <Section title={`Network interfaces (${net.interfaces.length})`}>
          {net.interfaces.map((eni, i) => <div key={i} className="text-xs font-mono">{JSON.stringify(eni)}</div>)}
        </Section>
      )}
    </>
  );
}

function MetricsTab({ detail }: { detail: ResourceDetail }) {
  const m = detail.metrics;
  if (!m) return <p className="text-sm text-gray-400">Metrics were not requested.</p>;
  const live = m.series.filter((s) => s.datapoints > 0);
  return (
    <>
      {m.notes.map((n) => <p key={n} className="mb-2 text-xs text-gray-500">{n}</p>)}
      {live.length === 0 ? (
        <p className="text-sm text-gray-400">No CloudWatch datapoints in the last {m.window_hours}h.</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-gray-500 text-xs"><th className="py-1">Metric</th><th>Stat</th><th className="text-right">Total</th><th className="text-right">Average</th><th className="text-right">Max</th><th className="text-right">Latest</th></tr>
          </thead>
          <tbody>
            {live.map((s, i) => (
              <tr key={i} className="border-t border-gray-100">
                <td className="py-1 font-mono text-xs">{s.name}</td>
                <td className="text-xs text-gray-500">{s.statistic}</td>
                <td className="text-right font-mono text-xs">{formatMetric(s.total, s.unit)}</td>
                <td className="text-right font-mono text-xs">{formatMetric(s.average, s.unit)}</td>
                <td className="text-right font-mono text-xs">{formatMetric(s.maximum, s.unit)}</td>
                <td className="text-right font-mono text-xs">{formatMetric(s.latest, s.unit)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {m.series.some((s) => s.error) && (
        <p className="mt-2 text-xs text-amber-700">{m.series.filter((s) => s.error).length} metric(s) could not be read.</p>
      )}
    </>
  );
}

function LogsTab({ detail }: { detail: ResourceDetail }) {
  if (!detail.logs.length) {
    return <p className="text-sm text-gray-400">No CloudWatch log group appears to belong to this resource.</p>;
  }
  return (
    <>
      {detail.logs.map((g) => (
        <Section key={g.name} title={g.name}>
          <p className="text-xs text-gray-500 mb-2">
            {formatBytes(g.stored_bytes)} stored · retention {g.retention_days ? `${g.retention_days}d` : 'never expires'}
          </p>
          {g.recent_events.length ? (
            <div className="bg-gray-900 text-gray-100 rounded p-2 font-mono text-[11px] max-h-80 overflow-y-auto">
              {g.recent_events.map((e, i) => (
                <div key={i} className="mb-0.5"><span className="text-gray-500">{e.timestamp.slice(11, 19)}</span> {e.message}</div>
              ))}
            </div>
          ) : <p className="text-sm text-gray-400">No events in the selected window.</p>}
        </Section>
      ))}
    </>
  );
}

function RelatedTab({ detail, onNavigate }: { detail: ResourceDetail; onNavigate: (arn: string) => void }) {
  if (!detail.related.length) return <p className="text-sm text-gray-400">No related resources found.</p>;
  const groups = new Map<string, typeof detail.related>();
  for (const r of detail.related) {
    if (!groups.has(r.relation)) groups.set(r.relation, []);
    groups.get(r.relation)!.push(r);
  }
  return (
    <>
      {[...groups.entries()].map(([relation, items]) => (
        <Section key={relation} title={`${relation.replace(/-/g, ' ')} (${items.length})`}>
          {items.map((r) => (
            <button
              key={r.arn}
              onClick={() => onNavigate(r.arn)}
              className="w-full text-left flex items-center gap-2 px-2 py-1 rounded hover:bg-gray-100 text-sm"
              title={r.arn}
            >
              <ExternalLink size={12} className="text-gray-400 shrink-0" />
              <span className="font-mono truncate">{r.name}</span>
              <span className="text-xs text-gray-400">{shortType(r.type)}</span>
              {r.detail && <span className="text-xs text-gray-500 ml-auto">{r.detail}</span>}
            </button>
          ))}
        </Section>
      ))}
    </>
  );
}
