// Node types that exist so an account can be drawn completely. None of them
// is in the palette: warpcore does not deploy EC2 instances or CloudFront
// distributions, but a project made from an account must show them, because
// a canvas that hides the VPC an agent runs in tells the operator nothing.
//
// `aws-resource` is the catch-all: any AWS type without a node of its own
// is drawn as a plain box with its service, name and ARN. Nothing scanned is
// ever dropped from the picture.
//
// Keep CANVAS_TYPES in projectFromAccount.ts and the Python emitter in step
// with the awsType column here.

import {
  Boxes, Cloud, Combine, Database, FileKey, Fingerprint, Globe, HardDrive, UserCheck, UserSquare, KeyRound, Layers,
  LucideIcon, Map, Network, Route, Search, Server, Shield, Split, Table2, Waypoints, Camera, Wifi,
} from 'lucide-react';

export interface DiscoveredTypeInfo {
  label: string;
  icon: LucideIcon;
  /** Tailwind text colour class for the icon. */
  color: string;
}

export const DISCOVERED_TYPES: Record<string, DiscoveredTypeInfo> = {
  'ec2-instance': { label: 'EC2 Instance', icon: Server, color: 'text-orange-600' },
  'ecs-cluster': { label: 'ECS Cluster', icon: Boxes, color: 'text-orange-500' },
  'ecs-service': { label: 'ECS Service', icon: Boxes, color: 'text-orange-500' },
  'eks-cluster': { label: 'EKS Cluster', icon: Boxes, color: 'text-orange-500' },
  'rds-instance': { label: 'RDS Instance', icon: Database, color: 'text-sky-700' },
  'rds-cluster': { label: 'RDS Cluster', icon: Database, color: 'text-sky-700' },
  'elasticache-cluster': { label: 'ElastiCache', icon: Database, color: 'text-red-600' },
  'ebs-volume': { label: 'EBS Volume', icon: HardDrive, color: 'text-gray-600' },
  'ebs-snapshot': { label: 'EBS Snapshot', icon: Camera, color: 'text-gray-500' },
  'subnet': { label: 'Subnet', icon: Layers, color: 'text-indigo-500' },
  'internet-gateway': { label: 'Internet Gateway', icon: Wifi, color: 'text-indigo-600' },
  'nat-gateway': { label: 'NAT Gateway', icon: Split, color: 'text-indigo-600' },
  'route-table': { label: 'Route Table', icon: Route, color: 'text-indigo-500' },
  'vpc-endpoint': { label: 'VPC Endpoint', icon: Waypoints, color: 'text-indigo-500' },
  'elastic-ip': { label: 'Elastic IP', icon: Network, color: 'text-indigo-500' },
  'load-balancer': { label: 'Load Balancer', icon: Split, color: 'text-purple-600' },
  'cloudfront': { label: 'CloudFront', icon: Globe, color: 'text-violet-600' },
  'route53-zone': { label: 'Route 53 Zone', icon: Map, color: 'text-violet-600' },
  'acm-certificate': { label: 'ACM Certificate', icon: Fingerprint, color: 'text-emerald-600' },
  'kms-key': { label: 'KMS Key', icon: KeyRound, color: 'text-amber-600' },
  'iam-instance-profile': { label: 'Instance Profile', icon: UserSquare, color: 'text-yellow-600' },
  'iam-user': { label: 'IAM User', icon: UserSquare, color: 'text-yellow-600' },
  'iam-policy': { label: 'IAM Policy', icon: FileKey, color: 'text-yellow-600' },
  // Services the Holodeck's reference architectures need.
  'cognito': { label: 'Cognito User Pool', icon: UserCheck, color: 'text-rose-600' },
  'opensearch': { label: 'OpenSearch Domain', icon: Search, color: 'text-sky-600' },
  'glue': { label: 'Glue Job', icon: Combine, color: 'text-purple-600' },
  'athena': { label: 'Athena Workgroup', icon: Table2, color: 'text-purple-600' },
  'waf': { label: 'WAF Web ACL', icon: Shield, color: 'text-red-600' },
  'aws-resource': { label: 'AWS Resource', icon: Cloud, color: 'text-gray-500' },
};

/** Type label for a node: the generic box shows the real AWS type. */
export function discoveredTypeLabel(type: string, config?: Record<string, unknown>): string | undefined {
  if (type === 'aws-resource') {
    const aws = config?.awsType;
    return typeof aws === 'string' ? aws.replace(/^AWS::/, '').replace('::', ' ') : 'AWS Resource';
  }
  return DISCOVERED_TYPES[type]?.label;
}
