// Everything the app can show about a live resource, shared by the Account
// Explorer's drawer and the canvas inspector's Live section. One fetch of
// `warpcore discover detail` feeds it; the headline strip picks the few
// metrics that say how busy the thing is, and the tabs hold the rest.

import { useEffect, useState } from 'react';
import { RefreshCw, AlertCircle, Network, Activity, ScrollText, Link2, Info, ExternalLink } from 'lucide-react';
import { fetchResourceDetail, formatBytes, formatMetric, MetricSeries, ResourceDetail, shortType } from '../../utils/accountExplorer';
import Sparkline from './Sparkline';

export type LiveTab = 'overview' | 'network' | 'metrics' | 'logs' | 'related';

export const WINDOWS = [
  { label: '1h', hours: 1 },
  { label: '24h', hours: 24 },
  { label: '7d', hours: 168 },
  { label: '30d', hours: 720 },
];

/** Cached per ARN and window, so re-selecting a node does not re-read AWS. */
const cache = new Map<string, ResourceDetail>();

export interface LiveState {
  detail: ResourceDetail | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

/** Read a resource's live detail; `enabled` false leaves it unread until asked. */
export function useResourceDetail(profile: string | null, arn: string | null, hours: number, enabled = true): LiveState {
  const [detail, setDetail] = useState<ResourceDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const key = `${profile}|${arn}|${hours}`;

  useEffect(() => {
    if (!enabled || !profile || !arn) { setDetail(null); return; }
    const hit = tick === 0 ? cache.get(key) : undefined;
    if (hit) { setDetail(hit); setError(null); return; }
    let cancelled = false;
    setLoading(true);
    setError(null);
    setDetail(null);
    fetchResourceDetail(profile, arn, hours)
      .then((d) => { if (!cancelled) { cache.set(key, d); setDetail(d); } })
      .catch((e) => { if (!cancelled) setError(String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [key, enabled, profile, arn, hours, tick]);

  return { detail, loading, error, reload: () => setTick((t) => t + 1) };
}

// The two or three series that say how busy a resource is, by AWS type.
const HEADLINE: Record<string, [string, string][]> = {
  'AWS::EC2::Instance': [['CPUUtilization', 'Average'], ['NetworkIn', 'Sum'], ['NetworkOut', 'Sum'], ['StatusCheckFailed', 'Maximum']],
  'AWS::EC2::NatGateway': [['BytesOutToDestination', 'Sum'], ['BytesInFromSource', 'Sum'], ['ActiveConnectionCount', 'Maximum']],
  'AWS::Lambda::Function': [['Invocations', 'Sum'], ['Errors', 'Sum'], ['Duration', 'Average'], ['Throttles', 'Sum']],
  'AWS::DynamoDB::Table': [['ConsumedReadCapacityUnits', 'Sum'], ['ConsumedWriteCapacityUnits', 'Sum'], ['ThrottledRequests', 'Sum']],
  'AWS::SQS::Queue': [['NumberOfMessagesSent', 'Sum'], ['ApproximateNumberOfMessagesVisible', 'Maximum'], ['ApproximateAgeOfOldestMessage', 'Maximum']],
  'AWS::RDS::DBInstance': [['CPUUtilization', 'Average'], ['DatabaseConnections', 'Maximum'], ['FreeableMemory', 'Minimum'], ['FreeStorageSpace', 'Minimum']],
  'AWS::ElasticLoadBalancingV2::LoadBalancer': [['RequestCount', 'Sum'], ['TargetResponseTime', 'Average'], ['HTTPCode_Target_5XX_Count', 'Sum'], ['HealthyHostCount', 'Minimum']],
  'AWS::EC2::Volume': [['VolumeReadBytes', 'Sum'], ['VolumeWriteBytes', 'Sum'], ['VolumeQueueLength', 'Average']],
};

/** The headline series for a detail, in order, only those with data. */
export function headlineSeries(detail: ResourceDetail): MetricSeries[] {
  const wanted = HEADLINE[detail.type];
  const series = detail.metrics?.series ?? [];
  if (!wanted) return series.filter((s) => s.datapoints > 0).slice(0, 4);
  return wanted.flatMap(([name, stat]) => series.filter((s) => s.name === name && s.statistic === stat && s.datapoints > 0));
}

const SERIES_LABEL: Record<string, string> = {
  CPUUtilization: 'CPU', NetworkIn: 'Net in', NetworkOut: 'Net out', StatusCheckFailed: 'Status checks failed',
  BytesOutToDestination: 'Bytes out', BytesInFromSource: 'Bytes in', ActiveConnectionCount: 'Connections',
  Invocations: 'Invocations', Errors: 'Errors', Duration: 'Duration', Throttles: 'Throttles',
  ConsumedReadCapacityUnits: 'Read units', ConsumedWriteCapacityUnits: 'Write units', ThrottledRequests: 'Throttled',
  NumberOfMessagesSent: 'Sent', ApproximateNumberOfMessagesVisible: 'Visible', ApproximateAgeOfOldestMessage: 'Oldest',
  DatabaseConnections: 'Connections', FreeableMemory: 'Free memory', FreeStorageSpace: 'Free storage',
  RequestCount: 'Requests', TargetResponseTime: 'Response time', HTTPCode_Target_5XX_Count: 'Target 5xx', HealthyHostCount: 'Healthy hosts',
  VolumeReadBytes: 'Read', VolumeWriteBytes: 'Write', VolumeQueueLength: 'Queue',
};

/** The sparkline strip: a tile per headline metric. */
export function HeadlineMetrics({ detail, compact = false }: { detail: ResourceDetail; compact?: boolean }) {
  const series = headlineSeries(detail);
  if (series.length === 0) {
    return <p className="text-xs text-gray-400">No CloudWatch datapoints in the last {detail.metrics?.window_hours ?? 24}h.</p>;
  }
  return (
    <div className={`grid gap-2 ${compact ? 'grid-cols-2' : 'grid-cols-2 md:grid-cols-4'}`}>
      {series.map((s) => {
        const headline = s.statistic === 'Sum' ? s.total : s.statistic === 'Maximum' ? s.maximum : s.statistic === 'Minimum' ? s.latest : s.average;
        const bad = (s.name === 'StatusCheckFailed' || s.name === 'Errors' || s.name.includes('5XX') || s.name === 'Throttles' || s.name === 'ThrottledRequests') && (headline ?? 0) > 0;
        return (
          <div key={`${s.name}-${s.statistic}`} className={`rounded-md border px-2 py-1.5 ${bad ? 'border-red-200 bg-red-50' : 'border-gray-200 bg-white'}`} title={`${s.name} (${s.statistic}) over ${detail.metrics?.window_hours}h`}>
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-[10px] uppercase tracking-wide text-gray-500 truncate">{SERIES_LABEL[s.name] ?? s.name}</span>
              <span className={`text-xs font-semibold font-mono whitespace-nowrap ${bad ? 'text-red-700' : 'text-gray-900'}`}>{formatMetric(headline, s.unit)}</span>
            </div>
            {s.points && s.points.length > 1 && <Sparkline points={s.points} width={compact ? 108 : 140} height={24} color={bad ? 'var(--c-red-600)' : 'var(--c-blue-600)'} />}
            <div className="text-[10px] text-gray-400 whitespace-nowrap truncate">{s.statistic === 'Sum' ? 'total' : s.statistic === 'Maximum' ? 'peak' : s.statistic === 'Minimum' ? 'latest' : 'average'} · peak {formatMetric(s.maximum, s.unit)}</div>
          </div>
        );
      })}
    </div>
  );
}

interface TabsProps {
  state: LiveState;
  hours: number;
  onHours: (h: number) => void;
  onNavigate: (arn: string) => void;
  /** The sparkline strip above the tabs. */
  headline?: boolean;
  /** Narrow host (the inspector): two tiles across, smaller sparklines. */
  compact?: boolean;
}

/** Tabs, window picker and body: the drawer and the inspector both draw this. */
export function LiveDetailTabs({ state, hours, onHours, onNavigate, headline = true, compact = false }: TabsProps) {
  const { detail, loading, error } = state;
  const [tab, setTab] = useState<LiveTab>('overview');

  const openIngress = detail?.network?.rules.filter(
    (r) => r.direction === 'ingress' && (r.source === '0.0.0.0/0' || r.source === '::/0'),
  ) ?? [];

  const tabs: { id: LiveTab; label: string; icon: JSX.Element; badge?: number | string }[] = [
    { id: 'overview', label: 'Overview', icon: <Info size={14} /> },
    { id: 'network', label: 'Network', icon: <Network size={14} />, badge: openIngress.length ? `${openIngress.length} open` : undefined },
    { id: 'metrics', label: 'Metrics', icon: <Activity size={14} />, badge: detail?.metrics?.series.filter((s) => s.datapoints).length || undefined },
    { id: 'logs', label: 'Logs', icon: <ScrollText size={14} />, badge: detail?.logs.reduce((n, g) => n + g.recent_events.length, 0) || undefined },
    { id: 'related', label: 'Related', icon: <Link2 size={14} />, badge: detail?.related.length || undefined },
  ];

  return (
    <div className="flex flex-col min-h-0">
      <div className="border-b border-gray-200 flex items-center gap-0.5 flex-wrap">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`flex items-center gap-1 px-2 py-1.5 text-xs border-b-2 -mb-px ${
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
        <div className="flex items-center gap-0.5 text-xs text-gray-500">
          {WINDOWS.map((w) => (
            <button
              key={w.hours}
              onClick={() => onHours(w.hours)}
              className={`px-1.5 py-0.5 rounded ${hours === w.hours ? 'bg-gray-200 text-gray-900' : 'hover:bg-gray-100'}`}
            >
              {w.label}
            </button>
          ))}
        </div>
      </div>

      <div className="pt-3">
        {loading && (
          <div className="flex items-center gap-2 text-sm text-gray-500">
            <RefreshCw size={14} className="animate-spin" /> Reading configuration, network, metrics and logs…
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
            {headline && tab !== 'metrics' && <div className="mb-4"><HeadlineMetrics detail={detail} compact={compact} /></div>}
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
            <tr className="text-left text-gray-500 text-xs"><th className="py-1">Metric</th><th>Stat</th><th></th><th className="text-right">Total</th><th className="text-right">Average</th><th className="text-right">Max</th><th className="text-right">Latest</th></tr>
          </thead>
          <tbody>
            {live.map((s, i) => (
              <tr key={i} className="border-t border-gray-100">
                <td className="py-1 font-mono text-xs">{s.name}</td>
                <td className="text-xs text-gray-500">{s.statistic}</td>
                <td className="py-0.5">{s.points && s.points.length > 1 ? <Sparkline points={s.points} width={90} height={20} area={false} /> : null}</td>
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
            <div className="bg-chrome text-chrome-fg rounded p-2 font-mono text-[11px] max-h-80 overflow-y-auto">
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
