import { describe, expect, it } from 'vitest';
import type { Edge, Node } from 'reactflow';
import { countFocus, LENS_LAYERS, lensEmphasis, pinnedBySelection } from './lenses';
import { DEFAULT_LAYERS } from './layers';

const node = (id: string, type: string, extra: Partial<Node> = {}): Node => ({
  id, type, position: { x: 0, y: 0 }, data: { label: id }, ...extra,
});

const vpc = node('vpc-1', 'vpc', { data: { label: 'vpc', meta: { isGroup: true } } });
const subnet = node('sn-1', 'subnet', { parentNode: 'vpc-1', data: { label: 'sn', meta: { isGroup: true } } });
const instance = node('i-1', 'ec2-instance', { parentNode: 'sn-1' });
const sg = node('sg-1', 'security-group');
const agent = node('agent-1', 'agent');
const bucket = node('bucket-1', 's3');
const secret = node('secret-1', 'secrets-manager');
const flagged = node('sg-default', 'security-group', { data: { label: 'default', meta: { warning: 'open to the world' } } });
const alarm = node('alarm-1', 'cloudwatch-alarm');
const nodes = [vpc, subnet, instance, sg, agent, bucket, secret, flagged, alarm];
const edges: Edge[] = [{ id: 'e1', source: 'agent-1', target: 'bucket-1' }];

const ctx = (selected: string | null = null) => ({
  byId: new Map(nodes.map((n) => [n.id, n])),
  pinned: pinnedBySelection(selected, edges),
});

describe('lens presets', () => {
  it('"All" is the default layer set', () => {
    expect(LENS_LAYERS.all).toEqual(DEFAULT_LAYERS);
  });
  it('Security shows access, network and encryption edges but not triggers', () => {
    expect(LENS_LAYERS.security).toMatchObject({ access: true, network: true, encryption: true, triggers: false });
  });
  it('Network shows only network edges', () => {
    expect(Object.entries(LENS_LAYERS.network).filter(([, on]) => on).map(([k]) => k)).toEqual(['network']);
  });
});

describe('lensEmphasis', () => {
  it('"All" and "Cost" foreground everything', () => {
    for (const n of nodes) {
      expect(lensEmphasis(n, 'all', ctx())).toBe('focus');
      expect(lensEmphasis(n, 'cost', ctx())).toBe('focus');
    }
  });

  it('Security foregrounds groups, secrets and flagged nodes; the rest is context', () => {
    expect(lensEmphasis(sg, 'security', ctx())).toBe('focus');
    expect(lensEmphasis(secret, 'security', ctx())).toBe('focus');
    expect(lensEmphasis(flagged, 'security', ctx())).toBe('focus');
    expect(lensEmphasis(agent, 'security', ctx())).toBe('context');
    expect(lensEmphasis(alarm, 'security', ctx())).toBe('context');
  });

  it('Security keeps members of a security group in focus', () => {
    const member = node('lambda-1', 'lambda', { data: { label: 'fn', meta: { securityGroups: [{ id: 'sg-1', name: 'web' }] } } });
    expect(lensEmphasis(member, 'security', ctx())).toBe('focus');
  });

  it('Network foregrounds network types and anything inside a VPC', () => {
    expect(lensEmphasis(vpc, 'network', ctx())).toBe('focus');
    expect(lensEmphasis(instance, 'network', ctx())).toBe('focus');
    expect(lensEmphasis(sg, 'network', ctx())).toBe('focus');
    expect(lensEmphasis(bucket, 'network', ctx())).toBe('context');
  });

  it('Data flow foregrounds compute, messaging and stores', () => {
    expect(lensEmphasis(agent, 'dataflow', ctx())).toBe('focus');
    expect(lensEmphasis(bucket, 'dataflow', ctx())).toBe('focus');
    expect(lensEmphasis(sg, 'dataflow', ctx())).toBe('context');
    expect(lensEmphasis(secret, 'dataflow', ctx())).toBe('context');
  });

  it('containers are never dimmed', () => {
    expect(lensEmphasis(vpc, 'dataflow', ctx())).toBe('focus');
    expect(lensEmphasis(subnet, 'security', ctx())).toBe('focus');
  });

  it('the selected node and its neighbours are always the subject', () => {
    expect(lensEmphasis(agent, 'security', ctx('agent-1'))).toBe('focus');
    expect(lensEmphasis(bucket, 'security', ctx('agent-1'))).toBe('focus');
    expect(lensEmphasis(alarm, 'security', ctx('agent-1'))).toBe('context');
  });
});

describe('countFocus', () => {
  it('counts what a lens would foreground', () => {
    expect(countFocus(nodes, edges, 'all', null)).toBe(nodes.length);
    // vpc, subnet (containers), sg, secret, flagged
    expect(countFocus(nodes, edges, 'security', null)).toBe(5);
    expect(countFocus(nodes, edges, 'security', 'agent-1')).toBe(7);
  });
  it('ignores hidden nodes', () => {
    const hidden = node('role-1', 'iam-role', { hidden: true });
    expect(countFocus([...nodes, hidden], edges, 'security', null)).toBe(5);
  });
});
