// Account discovery: types and calls for the Account Explorer.
//
// Everything here mirrors the JSON emitted by `warpcore discover inventory`
// and `warpcore discover detail`. The shapes are owned by the Python side;
// this file just names them for the UI.

import { invoke } from '@tauri-apps/api/core';

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
  notes: string[];
  errors: Record<string, string>;
}

// ------------------------------------------------------------------- calls

export async function listAwsProfiles(): Promise<string[]> {
  return invoke<string[]>('list_aws_profiles');
}

export async function discoverAccount(opts: {
  profile: string;
  regions: string[];
  allRegions: boolean;
  hydrate: boolean;
}): Promise<AccountInventory> {
  const raw = await invoke<string>('discover_account', {
    profile: opts.profile,
    regions: opts.regions,
    allRegions: opts.allRegions,
    hydrate: opts.hydrate,
  });
  return JSON.parse(raw) as AccountInventory;
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

const BASELINE_NAME_PREFIXES = ['AWSReservedSSO_', 'DO-NOT-DELETE-', 'AWSServiceRole', 'stacksets-exec-', 'stackset-'];

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
