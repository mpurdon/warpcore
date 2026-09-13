// Account discovery: types and calls for the Account Explorer.
//
// Everything here mirrors the JSON emitted by `warpcore discover inventory`
// and `warpcore discover detail`. The shapes are owned by the Python side;
// this file just names them for the UI.

import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { useEffect, useState } from 'react';
import { getPreferences } from './preferences';

// ---------------------------------------------------------------- inventory

export interface DiscoveredResource {
  id: string;
  type: string;                     // AWS::EC2::Instance
  physical_id: string;              // ARN
  region: string | null;
  sources: string[];                // "resource-explorer" | "service-api"
  tags: Record<string, string>;
  properties: Record<string, unknown>;
}

export interface InventoryError {
  physical_id: string;
  type: string;
  stage: string;
  message: string;
}

export interface AccountInventory {
  account: string;
  regions: Record<string, number>;  // region -> resource count
  scope: 'account' | 'project';
  resource_explorer: boolean;
  truncated: boolean;
  counts: Record<string, number>;   // type -> count
  unhydrated_types: Record<string, number>;
  resources: DiscoveredResource[];
  errors: InventoryError[];
}

// ------------------------------------------------------------------ detail

export interface RelatedResource {
  relation: string;
  arn: string;
  type: string;
  name: string;
  detail: string;
}

export interface SecurityGroupRule {
  direction: 'ingress' | 'egress';
  protocol: string;
  from_port: number | null;
  to_port: number | null;
  source: string;
  description: string;
}

export interface NetworkDetail {
  vpc_id: string | null;
  subnet_id: string | null;
  availability_zone: string | null;
  private_ips: string[];
  public_ips: string[];
  security_groups: { id: string; name?: string }[];
  rules: SecurityGroupRule[];
  interfaces: Record<string, unknown>[];
  flow_logs: { id: string; status: string; traffic: string; destination: string }[];
  routes: { destination: string; target: string; state: string }[];
  notes: string[];
}

export interface MetricSeries {
  name: string;
  statistic: string;
  unit: string;
  total: number | null;
  average: number | null;
  maximum: number | null;
  latest: number | null;
  datapoints: number;
  error: string | null;
  /** The series itself, oldest first: what a sparkline draws. */
  points?: { t: string; v: number }[];
}

export interface LogEvent {
  timestamp: string;
  message: string;
  stream: string;
}

export interface LogGroupSummary {
  name: string;
  arn: string;
  stored_bytes: number;
  retention_days: number | null;
  recent_events: LogEvent[];
}

export interface ResourceDetail {
  arn: string;
  type: string;
  region: string;
  name: string;
  tags: Record<string, string>;
  configuration: Record<string, unknown>;
  metrics: { window_hours: number; series: MetricSeries[]; notes: string[] } | null;
  logs: LogGroupSummary[];
  network: NetworkDetail | null;
  related: RelatedResource[];
  cost_hint: string | null;
  /** What the service says right now, in the import's terms. */
  health?: { level: 'ok' | 'warn' | 'unknown'; reason: string } | null;
  notes: string[];
  errors: Record<string, string>;
}

// ---------------------------------------------------------------- progress

/** One progress event from a running scan. Mirrors warpcore/utils/progress.py. */
export interface ScanEvent {
  event:
    | 'scan_start' | 'region_start' | 'region_plan' | 'phase'
    | 'service' | 'region_done' | 'scan_done';
  elapsed: number;
  region?: string;
  regions?: string[];
  account?: string;
  parallelism?: number;
  phases?: string[];
  services?: string[];
  phase?: string;
  service?: string;
  status?: 'running' | 'done' | 'failed' | 'skipped';
  found?: number;
  count?: number;
  errors?: number;
  explorer?: boolean;
  error?: string;
  total?: number;
}

/** Per-region scan state, assembled from the event stream. */
export interface RegionProgress {
  region: string;
  status: 'pending' | 'scanning' | 'done' | 'failed';
  /** Phase name -> status, for the service map. */
  phases: Record<string, 'pending' | 'running' | 'done' | 'failed' | 'skipped'>;
  /** Phase name -> resources found. */
  found: Record<string, number>;
  plan: string[];
  count: number;
  errors: number;
  error?: string;
  startedAt?: number;
  finishedAt?: number;
}

/** Subscribe to scan progress. Returns an unlisten function. */
export async function onScanProgress(handler: (e: ScanEvent) => void): Promise<UnlistenFn> {
  return listen<string>('scan-progress', (message) => {
    try {
      handler(JSON.parse(message.payload) as ScanEvent);
    } catch {
      // A malformed line must not break the listener for the rest of the scan.
    }
  });
}

/** Fold one event into the per-region progress map. */
export function applyScanEvent(
  current: Map<string, RegionProgress>,
  e: ScanEvent,
): Map<string, RegionProgress> {
  const next = new Map(current);

  const ensure = (region: string): RegionProgress => {
    const existing = next.get(region);
    if (existing) return { ...existing, phases: { ...existing.phases }, found: { ...existing.found } };
    return { region, status: 'pending', phases: {}, found: {}, plan: [], count: 0, errors: 0 };
  };

  switch (e.event) {
    case 'scan_start':
      for (const region of e.regions || []) {
        next.set(region, {
          region, status: 'pending', phases: {}, found: {}, plan: [], count: 0, errors: 0,
        });
      }
      break;

    case 'region_start': {
      if (!e.region) break;
      const r = ensure(e.region);
      r.status = 'scanning';
      r.startedAt = e.elapsed;
      next.set(e.region, r);
      break;
    }

    case 'region_plan': {
      if (!e.region) break;
      const r = ensure(e.region);
      r.plan = e.phases || [];
      for (const phase of r.plan) if (!r.phases[phase]) r.phases[phase] = 'pending';
      next.set(e.region, r);
      break;
    }

    case 'phase':
    case 'service': {
      if (!e.region) break;
      const r = ensure(e.region);
      const key = e.event === 'service' ? `service:${e.service}` : (e.phase || '');
      r.phases[key] = (e.status as RegionProgress['phases'][string]) || 'running';
      if (typeof e.found === 'number') r.found[key] = e.found;
      next.set(e.region, r);
      break;
    }

    case 'region_done': {
      if (!e.region) break;
      const r = ensure(e.region);
      r.status = e.status === 'failed' ? 'failed' : 'done';
      r.count = e.count ?? 0;
      r.errors = e.errors ?? 0;
      r.error = e.error;
      r.finishedAt = e.elapsed;
      // A finished region has finished every phase, whatever the last event
      // said - a region can complete while a phase event is still in flight.
      for (const phase of r.plan) {
        if (r.phases[phase] === 'pending' || r.phases[phase] === 'running') {
          r.phases[phase] = r.status === 'failed' ? 'failed' : 'done';
        }
      }
      next.set(e.region, r);
      break;
    }
  }

  return next;
}

/**
 * Live progress of the scan currently running, for a progress view: the
 * per-region map, the parallelism the CLI chose, and seconds elapsed.
 * Subscribes while `active`; `begin()` resets the clock and the map.
 */
export function useScanProgress(active: boolean) {
  const [progress, setProgress] = useState<Map<string, RegionProgress>>(new Map());
  const [parallelism, setParallelism] = useState<number | undefined>();
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (startedAt === null) return;
    const id = window.setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 500);
    return () => window.clearInterval(id);
  }, [startedAt]);

  useEffect(() => {
    if (!active) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    onScanProgress((event) => {
      if (event.event === 'scan_start') setParallelism(event.parallelism);
      setProgress((current) => applyScanEvent(current, event));
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => { cancelled = true; unlisten?.(); };
  }, [active]);

  const begin = () => { setProgress(new Map()); setStartedAt(Date.now()); setElapsed(0); };
  const end = () => setStartedAt(null);
  return { progress, parallelism, elapsed, begin, end };
}

/** Fraction 0-1 of a region's planned phases that have finished. */
export function regionFraction(r: RegionProgress): number {
  if (r.status === 'done' || r.status === 'failed') return 1;
  if (!r.plan.length) return r.status === 'scanning' ? 0.02 : 0;
  const finished = r.plan.filter(
    (p) => ['done', 'failed', 'skipped'].includes(r.phases[p]),
  ).length;
  return finished / r.plan.length;
}

/** Short label for a phase key: "service:ec2" -> "ec2". */
export function phaseLabel(phase: string): string {
  return phase.startsWith('service:') ? phase.slice('service:'.length) : phase;
}

// ------------------------------------------------------------------- calls

export async function listAwsProfiles(): Promise<string[]> {
  return invoke<string[]>('list_aws_profiles');
}

export interface ScanOptions {
  profile: string;
  regions: string[];
  allRegions: boolean;
  hydrate: boolean;
  /** Regions scanned concurrently; omitted means the CLI default. */
  parallelism?: number;
}

export async function discoverAccount(opts: ScanOptions): Promise<AccountInventory> {
  const raw = await invoke<string>('discover_account', {
    profile: opts.profile,
    regions: opts.regions,
    allRegions: opts.allRegions,
    hydrate: opts.hydrate,
    parallelism: opts.parallelism ?? null,
  });
  return parseInventory(raw);
}

/** Unwrap the CLI's JSON into an inventory, or throw if it is not one. */
export function parseInventory(raw: string): AccountInventory {
  // The scan streams progress events and ends with a `result` envelope, so the
  // inventory is under `data` rather than at the top level.
  const parsed = JSON.parse(raw) as { event?: string; data?: AccountInventory };
  const inventory = parsed.event === 'result' ? parsed.data : (parsed as AccountInventory);
  if (!inventory || !Array.isArray(inventory.resources)) {
    throw new Error('scan returned no inventory');
  }
  return inventory;
}

/**
 * Cache key for a scan: the profile and exactly which regions it covered.
 * Two scans with the same key would return the same inventory, staleness
 * aside, so one can stand in for the other.
 */
export function scanCacheKey(opts: Pick<ScanOptions, 'profile' | 'regions' | 'allRegions'>): string {
  const regions = opts.allRegions ? 'all' : ([...opts.regions].sort().join('+') || 'default');
  return `${opts.profile}__${regions}`;
}

/** localStorage key for the profile last used in the Account Explorer. */
export const LAST_PROFILE_KEY = 'warpcore-explorer-profile';

/**
 * The profile to use for incidental AWS calls, e.g. listing regions: the one
 * chosen in Settings › Exploration, else the one the Explorer used last, else
 * the first.
 */
export function preferredProfile(profiles: string[]): string {
  try {
    const configured = getPreferences().defaultProfile;
    if (configured && profiles.includes(configured)) return configured;
    const remembered = localStorage.getItem(LAST_PROFILE_KEY);
    if (remembered && profiles.includes(remembered)) return remembered;
  } catch {
    // Storage unavailable; fall through to the first profile.
  }
  return profiles[0] || '';
}

/** Regions this account has enabled. */
export async function listRegions(profile: string): Promise<string[]> {
  return invoke<string[]>('list_regions', { profile });
}

/** Kill the in-flight scan. Resolves true if one was running. */
export async function cancelScan(): Promise<boolean> {
  return invoke<boolean>('cancel_scan');
}

/** True when an error from discoverAccount was a user cancellation. */
export function isCancellation(error: unknown): boolean {
  return String(error).trim() === 'cancelled';
}

export async function fetchResourceDetail(
  profile: string,
  arn: string,
  hours = 24,
): Promise<ResourceDetail> {
  const raw = await invoke<string>('resource_detail', { profile, arn, hours });
  return JSON.parse(raw) as ResourceDetail;
}

// ---------------------------------------------------------------- helpers

// Types that are AWS/organisation baseline rather than anyone's workload.
// They are real and are still listed; this just lets the view hide them so
// the 343 Config rules do not bury the four instances.
export const BASELINE_TYPES = new Set<string>([
  'AWS::Config::ConfigRule',
  'AWS::Memorydb::Parametergroup',
  'AWS::Memorydb::User',
  'AWS::Memorydb::Acl',
  'AWS::Redshift::Parametergroup',
  'AWS::Elasticache::User',
  'AWS::Ssm::Association',
  'AWS::Ssm::ResourceDataSync',
  'AWS::Backup::BackupVault',
  'AWS::Xray::SamplingRule',
  'AWS::ResourceExplorer2::Index',
  'AWS::ResourceExplorer2::View',
  'AWS::Guardduty::Detector',
  'AWS::GuardDuty::Detector',
  'AWS::Athena::WorkGroup',
  'AWS::Athena::DataCatalog',
  'AWS::EC2::DHCPOptions',
  'AWS::EC2::NetworkAcl',
  // Shown inside their parent's Network tab; at the top level they only
  // bury the instances they belong to.
  'AWS::EC2::SecurityGroupRule',
  'AWS::EC2::NetworkInterface',
  'AWS::S3::StorageLens',
  'AWS::Apprunner::Autoscalingconfiguration',
  'AWS::Events::EventBus',
  'AWS::IAM::SAMLProvider',
]);

export const BASELINE_NAME_PREFIXES = ['AWSReservedSSO_', 'DO-NOT-DELETE-', 'AWSServiceRole', 'stacksets-exec-', 'stackset-'];

/** True for org/AWS-managed noise the user usually wants folded away. */
export function isBaseline(resource: DiscoveredResource): boolean {
  if (BASELINE_TYPES.has(resource.type)) return true;
  return BASELINE_NAME_PREFIXES.some((p) => resource.id.startsWith(p));
}

// Types a person is usually looking for, in the order they want to see them.
// Everything else follows alphabetically. Sorting by count put the twenty
// security-group rules above the four instances they protect.
const TYPE_PRIORITY = [
  'AWS::EC2::Instance',
  'AWS::Lambda::Function',
  'AWS::ECS::Service',
  'AWS::ECS::Cluster',
  'AWS::EKS::Cluster',
  'AWS::RDS::DBInstance',
  'AWS::RDS::DBCluster',
  'AWS::DynamoDB::Table',
  'AWS::S3::Bucket',
  'AWS::SQS::Queue',
  'AWS::SNS::Topic',
  'AWS::Kinesis::Stream',
  'AWS::StepFunctions::StateMachine',
  'AWS::ApiGatewayV2::Api',
  'AWS::ApiGateway::RestApi',
  'AWS::ElasticLoadBalancingV2::LoadBalancer',
  'AWS::EC2::NatGateway',
  'AWS::EC2::EIP',
  'AWS::EC2::Volume',
  'AWS::EC2::VPC',
  'AWS::EC2::Subnet',
  'AWS::EC2::SecurityGroup',
  'AWS::EC2::RouteTable',
  'AWS::EC2::InternetGateway',
  'AWS::EC2::VPCEndpoint',
  'AWS::IAM::Role',
  'AWS::Logs::LogGroup',
  'AWS::CloudFormation::Stack',
];

/** Sort key: priority index, then the type name. */
export function typeRank(type: string): number {
  const i = TYPE_PRIORITY.indexOf(type);
  return i === -1 ? TYPE_PRIORITY.length : i;
}

/** Short type label: AWS::EC2::Instance -> EC2 Instance */
export function shortType(type: string): string {
  const parts = type.replace(/^AWS::/, '').split('::');
  return parts.join(' ');
}

/** Human-readable byte count. */
export function formatBytes(n: number | null | undefined): string {
  if (n == null) return '-';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = n;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(value >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

/** Compact number for a metrics cell. */
export function formatMetric(value: number | null | undefined, unit: string): string {
  if (value == null) return '-';
  if (unit === 'Bytes') return formatBytes(value);
  if (unit === 'Percent') return `${value.toFixed(1)}%`;
  if (unit === 'Milliseconds') return `${value.toFixed(0)} ms`;
  return value >= 1000 ? value.toLocaleString(undefined, { maximumFractionDigits: 0 }) : value.toFixed(2);
}

/**
 * The profile that reaches the open project's current environment: what the
 * account import recorded on the environment block, else the preferred
 * profile. Null when nothing is known, so a caller can ask rather than guess.
 */
export function projectProfile(
  environmentExtras: Record<string, Record<string, unknown>>,
  environment: string,
): string | null {
  const recorded = environmentExtras[environment]?.profile;
  if (typeof recorded === 'string' && recorded) return recorded;
  try {
    return getPreferences().defaultProfile || localStorage.getItem(LAST_PROFILE_KEY) || null;
  } catch {
    return null;
  }
}
