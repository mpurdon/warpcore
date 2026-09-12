import { describe, expect, it } from 'vitest';
import { clusterApplications, ClusterItem, namePrefix, SHARED_ID } from './applications';

const item = (id: string, type: string, extra: Partial<ClusterItem> = {}): ClusterItem => ({
  id, name: id, type, platform: false, ...extra,
});

describe('namePrefix', () => {
  it('takes the first meaningful token', () => {
    expect(namePrefix('shop-orders-table')).toBe('shop');
    expect(namePrefix('/shop/prod/db-password')).toBe('shop');
    expect(namePrefix('shop_indexer')).toBe('shop');
  });
  it('ignores generic and short tokens and whole names', () => {
    expect(namePrefix('aws-controltower-role')).toBeNull();
    expect(namePrefix('default')).toBeNull();
    expect(namePrefix('i-0123456789')).toBeNull();
    expect(namePrefix('shop')).toBeNull();
  });
  it('looks past the environment, and sees through AWS ids', () => {
    expect(namePrefix('dev-talend-vpc')).toBe('talend');
    expect(namePrefix('prod-shop-orders')).toBe('shop');
    expect(namePrefix('dev-talend')).toBe('talend');
    expect(namePrefix('dev-sg-talend-bastion')).toBeNull();
    expect(namePrefix('vpce-07656bf32158c7829')).toBeNull();
    expect(namePrefix('subnet-01cfb23b1a7f8eaff')).toBeNull();
    expect(namePrefix('rtb-047e87a4fab853999')).toBeNull();
  });
});

describe('clusterApplications', () => {
  it('trusts tags first', () => {
    const items = [
      item('fn', 'lambda', { tags: { Application: 'Shop' } }),
      item('bucket', 's3', { tags: { app: 'billing' } }),
    ];
    const { assignments, applications } = clusterApplications(items, [], 'acct');
    expect(assignments.get('fn')).toEqual({ id: 'shop', name: 'Shop', reason: 'tag Application=Shop' });
    expect(assignments.get('bucket')?.id).toBe('billing');
    expect(applications.map((a) => a.id).sort()).toEqual(['billing', 'shop']);
  });

  it('uses a name prefix shared by three or more, and the project name always', () => {
    const items = [
      item('shop-api', 'lambda'), item('shop-orders', 'dynamodb'), item('shop-uploads', 's3'),
      item('acct-thing', 'sqs'),
      item('pair-one', 'sqs'), item('pair-two', 'sns'),
    ];
    const { assignments } = clusterApplications(items, [], 'acct');
    expect(assignments.get('shop-api')).toMatchObject({ id: 'shop', reason: 'name prefix shop-' });
    expect(assignments.get('acct-thing')).toMatchObject({ id: 'acct', reason: 'name prefix acct-' });
    // Two "pair-" resources are not enough for a prefix, and not wired to anything: shared.
    expect(assignments.get('pair-one')?.id).toBe(SHARED_ID);
  });

  it('propagates along the wiring, with the reason naming the neighbour', () => {
    const items = [
      item('shop-api', 'lambda'), item('shop-orders', 'dynamodb'), item('shop-uploads', 's3'),
      item('random-table', 'dynamodb'),
      item('billing-api', 'lambda'), item('billing-db', 'rds-instance'), item('billing-q', 'sqs'),
    ];
    const links = [{ source: 'shop-api', target: 'random-table' }];
    const { assignments } = clusterApplications(items, links, 'acct');
    expect(assignments.get('random-table')).toEqual({ id: 'shop', name: 'shop', reason: 'wired to shop-api' });
  });

  it('carries what is inside a VPC with the VPC', () => {
    const items = [
      item('shop-api', 'lambda'), item('shop-orders', 'dynamodb'), item('shop-uploads', 's3'),
      item('billing-api', 'lambda'), item('billing-db', 'rds-instance'), item('billing-q', 'sqs'),
      item('vpc-1', 'vpc', { platform: true }),
      item('subnet-1', 'subnet', { platform: true, parent: 'vpc-1' }),
      item('i-web', 'ec2-instance', { parent: 'subnet-1', name: 'i-0abc' }),
    ];
    const links = [{ source: 'shop-api', target: 'i-web' }];
    const { assignments } = clusterApplications(items, links, 'acct');
    expect(assignments.get('i-web')?.id).toBe('shop');
    expect(assignments.get('subnet-1')?.id).toBe('shop');
    expect(assignments.get('vpc-1')?.id).toBe('shop');
  });

  it('puts a platform resource used by two applications in shared', () => {
    const items = [
      item('shop-api', 'lambda'), item('shop-orders', 'dynamodb'), item('shop-uploads', 's3'),
      item('billing-api', 'lambda'), item('billing-db', 'rds-instance'), item('billing-q', 'sqs'),
      item('master-key', 'kms-key', { platform: true }),
    ];
    const links = [{ source: 'shop-uploads', target: 'master-key' }, { source: 'billing-db', target: 'master-key' }];
    const { assignments, applications } = clusterApplications(items, links, 'acct');
    expect(assignments.get('master-key')).toEqual({ id: SHARED_ID, name: 'Shared platform', reason: 'used by 2 applications' });
    expect(applications[applications.length - 1].id).toBe(SHARED_ID);
  });

  it('folds shared into the one application when there is only one', () => {
    const items = [
      item('shop-api', 'lambda'), item('shop-orders', 'dynamodb'), item('shop-uploads', 's3'),
      item('loner-alarm', 'cloudwatch-alarm', { platform: true }),
    ];
    const { assignments, applications } = clusterApplications(items, [], 'acct');
    expect(assignments.get('loner-alarm')?.id).toBe('shop');
    expect(applications.map((a) => a.id)).toEqual(['shop']);
  });

  it('does not make an application out of a VPC with nothing running in it', () => {
    const items = [
      item('shop-api', 'lambda'), item('shop-orders', 'dynamodb'), item('shop-uploads', 's3'),
      item('vpc-1', 'vpc', { platform: true, name: 'vpc-0abc12345678' }),
      item('subnet-1', 'subnet', { platform: true, parent: 'vpc-1', name: 'subnet-0abc12345678' }),
      item('igw-1', 'internet-gateway', { platform: true, name: 'igw-0abc12345678' }),
    ];
    const { assignments, applications } = clusterApplications(items, [{ source: 'igw-1', target: 'vpc-1' }], 'acct');
    // The one application takes the shared bits, with the reason kept.
    expect(applications.map((a) => a.id)).toEqual(['shop']);
    expect(assignments.get('vpc-1')?.reason).toBe('platform with nothing running on it');
  });

  it('names an unlabelled connected account after the project', () => {
    const items = [item('fn1', 'lambda', { name: 'processor' }), item('tbl', 'dynamodb', { name: 'records' })];
    const { assignments, applications } = clusterApplications(items, [{ source: 'fn1', target: 'tbl' }], 'gitf');
    expect(applications).toEqual([{ id: 'gitf', name: 'gitf', members: ['fn1', 'tbl'] }]);
    expect(assignments.get('fn1')?.reason).toMatch(/connected to 1 other resource/);
  });
});
