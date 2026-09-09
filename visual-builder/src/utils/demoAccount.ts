// A small synthetic account for development: the webhook story from the
// scenarios design (API → authorizer → key; API → function → table, topic
// → queue → indexer), with log groups and one execution role. Exposed on
// window.__warpcore.demo in dev builds so the canvas, lenses and scenarios
// can be exercised without an AWS account. Never used by the app itself.

import type { AccountProject } from './projectFromAccount';
import { buildCanvas } from './projectFromAccount';
import { EMPTY_PROJECT, useStore } from '../store/useStore';

const ACCOUNT = '123456789012';
const REGION = 'us-east-1';
const arn = (svc: string, res: string) => `arn:aws:${svc}:${REGION}:${ACCOUNT}:${res}`;
const item = (name: string, type: string, a: string, config: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
  name, type, arn: a, region: REGION, config, tags: { Application: 'gitf' }, ...extra,
});

const API = arn('apigateway', 'gitf-api');
const AUTH = arn('lambda', 'function:gitf-authorizer');
const FN = arn('lambda', 'function:gitf');
const IDX = arn('lambda', 'function:gitf-indexer');
const KEY = arn('kms', 'key/1234');
const SESS = arn('dynamodb', 'table/gitf-sessions');
const EVT = arn('sns', 'gitf-events');
const Q = arn('sqs', 'gitf-index-queue');
const BUCKET = 'arn:aws:s3:::gitf-uploads';
const SECRET = arn('secretsmanager', 'secret:gitf/db-password');
const LG_FN = arn('logs', 'log-group:/aws/lambda/gitf');
const LG_AUTH = arn('logs', 'log-group:/aws/lambda/gitf-authorizer');
const LG_IDX = arn('logs', 'log-group:/aws/lambda/gitf-indexer');
const ROLE = `arn:aws:iam::${ACCOUNT}:role/gitf-exec-role`;

export const DEMO_ACCOUNT: AccountProject = {
  account: ACCOUNT,
  regions: { [REGION]: 13 },
  project: { name: 'gitf', region: REGION },
  environment: { key: 'prod', account: ACCOUNT, region: REGION },
  agents: [],
  resources: [
    item('gitf-api', 'api-gateway', API, { apiName: 'gitf-api' }),
    item('gitf-authorizer', 'lambda', AUTH, { functionName: 'gitf-authorizer', runtime: 'python3.12' }, { role_arn: ROLE }),
    item('gitf', 'lambda', FN, { functionName: 'gitf', runtime: 'python3.12' }, { role_arn: ROLE }),
    item('gitf-indexer', 'lambda', IDX, { functionName: 'gitf-indexer', runtime: 'python3.12' }, { role_arn: ROLE }),
    item('gitf-key', 'kms-key', KEY, { keyId: '1234', alias: 'alias/gitf' }),
    item('gitf-sessions', 'dynamodb', SESS, { tableName: 'gitf-sessions' }),
    item('gitf-events', 'sns', EVT, { topicName: 'gitf-events' }),
    item('gitf-index-queue', 'sqs', Q, { queueName: 'gitf-index-queue' }),
    item('gitf-uploads', 's3', BUCKET, { bucketName: 'gitf-uploads' }),
    item('gitf/db-password', 'secrets-manager', SECRET, { secretName: 'gitf/db-password' }),
    item('/aws/lambda/gitf', 'log-group', LG_FN, { logGroupPath: '/aws/lambda/gitf', retentionDays: 14 }),
    item('/aws/lambda/gitf-authorizer', 'log-group', LG_AUTH, { logGroupPath: '/aws/lambda/gitf-authorizer', retentionDays: 14 }),
    item('/aws/lambda/gitf-indexer', 'log-group', LG_IDX, { logGroupPath: '/aws/lambda/gitf-indexer', retentionDays: 14 }),
  ] as AccountProject['resources'],
  roles: [item('gitf-exec-role', 'iam-role', ROLE, { roleName: 'gitf-exec-role' })] as AccountProject['roles'],
  connections: [
    { from_arn: API, to_arn: AUTH, kind: 'invokes', detail: 'authorizer' },
    { from_arn: API, to_arn: FN, kind: 'invokes', detail: 'POST /webhook' },
    { from_arn: AUTH, to_arn: KEY, kind: 'access', detail: 'read', via: 'gitf-exec-role', actions: ['kms:Decrypt'] },
    { from_arn: AUTH, to_arn: SECRET, kind: 'access', detail: 'read', via: 'gitf-exec-role', actions: ['secretsmanager:GetSecretValue'] },
    { from_arn: FN, to_arn: SESS, kind: 'access', detail: 'read/write', via: 'gitf-exec-role', actions: ['dynamodb:PutItem', 'dynamodb:GetItem', 'dynamodb:Query'] },
    { from_arn: FN, to_arn: EVT, kind: 'access', detail: 'write', via: 'gitf-exec-role', actions: ['sns:Publish'] },
    { from_arn: FN, to_arn: BUCKET, kind: 'access', detail: 'write', via: 'gitf-exec-role', actions: ['s3:PutObject'] },
    { from_arn: EVT, to_arn: Q, kind: 'event-target', detail: 'sqs subscription' },
    { from_arn: Q, to_arn: IDX, kind: 'event-source', detail: 'event source mapping' },
    { from_arn: IDX, to_arn: SESS, kind: 'access', detail: 'read', via: 'gitf-exec-role', actions: ['dynamodb:GetItem'] },
    { from_arn: FN, to_arn: LG_FN, kind: 'logs', detail: 'function log group' },
    { from_arn: AUTH, to_arn: LG_AUTH, kind: 'logs', detail: 'function log group' },
    { from_arn: IDX, to_arn: LG_IDX, kind: 'logs', detail: 'function log group' },
    { from_arn: FN, to_arn: ROLE, kind: 'role', detail: 'execution role' },
    { from_arn: AUTH, to_arn: ROLE, kind: 'role', detail: 'execution role' },
    { from_arn: IDX, to_arn: ROLE, kind: 'role', detail: 'execution role' },
    { from_arn: SESS, to_arn: KEY, kind: 'reference', detail: 'encrypted with' },
  ],
  counts: { included: 14, shown: 14, skipped: 0, connections: 17, excluded: 0 },
  skipped: {},
  notes: [],
  adopted: null,
  explorer: false,
  errors: [],
};

/** Put the demo account on the canvas, unlocked, with the webhook scenario. */
export function loadDemo(): Record<string, string> {
  const built = buildCanvas(DEMO_ACCOUNT);
  const ids = Object.fromEntries(built.nodes.map((n) => [String(n.data?.label), n.id]));
  useStore.getState().loadProject({
    ...EMPTY_PROJECT,
    nodes: built.nodes,
    edges: built.edges,
    projectName: 'gitf',
    locked: false,
    scenarios: [{
      id: 'webhook-received',
      name: 'Webhook received',
      trigger: { at: ids['gitf-api'], event: 'POST /webhook' },
      steps: [
        { at: ids['gitf-authorizer'], takes: 40, note: 'validates the signature' },
        { at: ids['gitf-key'], note: 'decrypts the signing secret' },
        { at: ids['gitf'], takes: 180 },
        { at: ids['gitf-sessions'], note: 'writes the session row' },
        { at: ids['gitf-events'], detached: true, note: 'fan-out' },
        { at: ids['gitf-index-queue'] },
        { at: ids['gitf-indexer'], takes: 90 },
      ],
    }],
  });
  return ids;
}
