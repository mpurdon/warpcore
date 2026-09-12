import { describe, expect, it } from 'vitest';
import { AccountProject, buildCanvas, ProjectConnection, ProjectItem } from './projectFromAccount';

const item = (name: string, type: string, config: Record<string, unknown> = {}): ProjectItem => ({
  name, type, arn: `arn:${type}:${name}`, region: 'us-east-1', config, tags: {},
});
const link = (from: string, to: string, detail: string, kind: ProjectConnection['kind'] = 'vpc'): ProjectConnection => ({
  from_arn: from, to_arn: to, kind, detail,
});

/** A VPC with a public subnet, a bastion, a host, two groups and a route out. */
function vpcAccount(): AccountProject {
  const resources = [
    item('dev-shop-vpc', 'vpc'), item('dev-shop-public', 'subnet', { public: true }),
    item('dev-shop-bastion', 'ec2-instance'), item('dev-shop-host', 'ec2-instance'),
    item('sg-bastion', 'security-group', { groupName: 'dev-shop-bastion-sg' }), item('sg-host', 'security-group', { groupName: 'dev-shop-host-sg' }),
    item('dev-shop-igw', 'internet-gateway'), item('dev-shop-rtb', 'route-table'),
  ];
  const a = (n: string) => resources.find((r) => r.name === n)!.arn;
  return {
    account: '1', regions: { 'us-east-1': 8 }, project: { name: 'acct', region: 'us-east-1' },
    environment: { key: 'dev', account: '1', region: 'us-east-1' },
    agents: [], resources, roles: [],
    connections: [
      link(a('dev-shop-public'), a('dev-shop-vpc'), 'in VPC'),
      link(a('dev-shop-bastion'), a('dev-shop-public'), 'in subnet'), link(a('dev-shop-bastion'), a('dev-shop-vpc'), 'in VPC'),
      link(a('dev-shop-host'), a('dev-shop-public'), 'in subnet'), link(a('dev-shop-host'), a('dev-shop-vpc'), 'in VPC'),
      link(a('dev-shop-bastion'), a('sg-bastion'), 'security group'), link(a('dev-shop-host'), a('sg-host'), 'security group'),
      link(a('sg-bastion'), a('sg-host'), 'allowed inbound'),
      link(a('sg-bastion'), a('dev-shop-vpc'), 'in VPC'), link(a('sg-host'), a('dev-shop-vpc'), 'in VPC'),
      link(a('dev-shop-igw'), a('dev-shop-vpc'), 'attached to VPC'), link(a('dev-shop-rtb'), a('dev-shop-vpc'), 'in VPC'),
      link(a('dev-shop-public'), a('dev-shop-rtb'), 'routes via'), link(a('dev-shop-rtb'), a('dev-shop-igw'), 'route 0.0.0.0/0'),
    ],
    counts: { included: 8, shown: 8, skipped: 0, connections: 14, excluded: 0 }, skipped: {}, notes: [], adopted: null, explorer: true, errors: [],
  };
}

describe('buildCanvas', () => {
  it('names the application past the environment and holds a lone VPC without a band', () => {
    const { nodes } = buildCanvas(vpcAccount());
    const tiles = nodes.filter((n) => n.type === 'application');
    expect(tiles.map((t) => t.data.label)).toEqual(['shop']);
    expect(nodes.filter((n) => n.type === 'band')).toHaveLength(0);
    const vpc = nodes.find((n) => n.type === 'vpc')!;
    expect(vpc.parentNode).toBe(tiles[0].id);
  });

  it('draws security groups as badges, and trust between their members', () => {
    const { nodes, edges } = buildCanvas(vpcAccount());
    for (const sg of nodes.filter((n) => n.type === 'security-group')) expect(sg.hidden).toBe(true);
    const bastion = nodes.find((n) => n.data.label === 'dev-shop-bastion')!;
    expect(bastion.data.meta.securityGroups).toEqual([{ id: 'security-group-sg-bastion', name: 'dev-shop-bastion-sg' }]);
    expect(edges.some((e) => e.target.startsWith('security-group'))).toBe(false);
    const trust = edges.find((e) => e.source === bastion.id && e.target === 'ec2-instance-dev-shop-host')!;
    expect(trust.data.meta).toEqual({ layer: 'network', discovered: { kind: 'vpc', detail: 'allowed inbound via dev-shop-bastion-sg' } });
  });

  it('draws containment as nesting at any depth, and the plumbing as chips in the VPC', () => {
    const { nodes, edges } = buildCanvas(vpcAccount());
    expect(edges.some((e) => e.target === 'vpc-dev-shop-vpc')).toBe(false);
    expect(edges.map((e) => e.data.meta.discovered.detail).sort()).toEqual(['allowed inbound via dev-shop-bastion-sg', 'route 0.0.0.0/0', 'routes via']);
    const igw = nodes.find((n) => n.type === 'internet-gateway')!;
    expect(igw.parentNode).toBe('vpc-dev-shop-vpc');
    expect(igw.data.meta.compact).toBe(true);
    expect(nodes.find((n) => n.type === 'subnet')!.data.meta.compact).toBeUndefined();
  });
});
