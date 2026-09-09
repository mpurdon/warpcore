import { describe, expect, it } from 'vitest';
import { entryProblems, holodeckMetaFromYaml, holodeckMetaToYaml, parseHolodeckEntry } from './holodeck';
import { HOLODECK_ENTRIES } from './holodeckLibrary';
import { checkScenario, hopIndex } from './scenarios';

const SMALL = `
holodeck:
  id: tiny
  name: Tiny
  family: classic
  summary: One function behind an API.
  look_at:
    - The function writes to the table.
  difficulty: 1
project: { name: tiny }
resources:
  - { name: tiny-api, type: api-gateway }
  - { name: handler, type: lambda, note: Does the work. }
  - { name: items, type: dynamodb }
  - { name: retries, type: sqs }
connections:
  - { from: tiny-api, to: handler, kind: invokes, detail: POST /items }
  - { from: handler, to: items, kind: writes }
  - { from: handler, to: retries, kind: dlq }
scenarios:
  - name: Create an item
    trigger: { at: tiny-api, event: POST /items }
    steps:
      - at: handler
        takes: 30ms
      - at: items
  - name: Handler gives up
    trigger: { at: tiny-api }
    steps:
      - { at: handler, outcome: fail, retry: 1 }
      - { at: retries }
`;

describe('parseHolodeckEntry', () => {
  const entry = parseHolodeckEntry(SMALL);

  it('reads the metadata', () => {
    expect(entry.meta).toMatchObject({ id: 'tiny', name: 'Tiny', family: 'classic', difficulty: 1, lookAt: ['The function writes to the table.'] });
  });

  it('gives every resource a predictable id and lays them out as a stack', () => {
    const ids = entry.nodes.map((n) => n.id);
    expect(ids).toContain('api-gateway-tiny-api');
    expect(ids).toContain('lambda-handler');
    expect(ids).toContain('dynamodb-items');
    expect(entry.nodes.some((n) => n.type === 'application')).toBe(true);
    expect(entry.nodes.some((n) => n.type === 'band')).toBe(true);
    const fn = entry.nodes.find((n) => n.id === 'lambda-handler')!;
    expect(fn.parentNode).toBeDefined();
    expect(fn.data.arn).toBeUndefined();
    expect(fn.data.status).toBe('configured');
    expect(fn.data.meta.note).toBe('Does the work.');
  });

  it('synthesises a role, a log group and the access actions', () => {
    expect(entry.nodes.find((n) => n.id === 'iam-role-handler-role')).toBeDefined();
    expect(entry.nodes.find((n) => n.type === 'log-group')).toBeDefined();
    const access = entry.edges.find((e) => e.source === 'lambda-handler' && e.target === 'dynamodb-items')!;
    expect(access.data.meta.access).toMatchObject({ level: 'write', via: 'handler-role', actions: ['dynamodb:PutItem', 'dynamodb:UpdateItem'] });
    const dlq = entry.edges.find((e) => e.target === 'sqs-retries')!;
    expect(dlq.data.isDLQ).toBe(true);
    expect(dlq.data.meta.layer).toBe('triggers');
  });

  it('resolves scenario steps by name and the checks pass', () => {
    expect(entry.scenarios[0].trigger.at).toBe('api-gateway-tiny-api');
    expect(entry.scenarios[0].steps.map((s) => s.at)).toEqual(['lambda-handler', 'dynamodb-items']);
    expect(entry.scenarios[1].steps[0]).toMatchObject({ at: 'lambda-handler', outcome: 'fail', retry: 1 });
    expect(entryProblems(entry)).toEqual([]);
    expect(entry.unhappy).toBe(1);
    expect(entry.services).toEqual(['api-gateway', 'lambda', 'sqs', 'dynamodb']);
    expect(entry.resourceCount).toBe(4);
    expect(entry.thumbnail.startsWith('data:image/svg+xml')).toBe(true);
  });

  it('lets two resources share a named role', () => {
    const shared = parseHolodeckEntry(SMALL.replace('type: lambda, note: Does the work.', 'type: lambda, role: app-role').replace('{ name: items, type: dynamodb }', '{ name: items, type: dynamodb }\n  - { name: other, type: lambda, role: app-role }'));
    expect(shared.nodes.filter((n) => n.type === 'iam-role').map((n) => n.id)).toEqual(['iam-role-app-role']);
    const access = shared.edges.find((e) => e.source === 'lambda-handler' && e.target === 'dynamodb-items')!;
    expect(access.data.meta.access.via).toBe('app-role');
  });

  it('rejects a connection to something that is not there', () => {
    expect(() => parseHolodeckEntry(SMALL.replace('to: items, kind: writes', 'to: nothing, kind: writes'))).toThrow(/nothing/);
  });

  it('round-trips the metadata through warpcore.yaml', () => {
    const back = holodeckMetaFromYaml(holodeckMetaToYaml(entry.meta));
    expect(back).toEqual(entry.meta);
    expect(holodeckMetaFromYaml(undefined)).toBeNull();
  });
});

describe('the bundled library', () => {
  it('has entries in every family', () => {
    const families = new Set(HOLODECK_ENTRIES.map((e) => e.meta.family));
    for (const f of ['reference', 'inspired', 'classic', 'starter']) expect(families.has(f as never)).toBe(true);
  });

  it('has unique ids, a summary, notes, and at least one scenario each', () => {
    const ids = new Set<string>();
    for (const e of HOLODECK_ENTRIES) {
      expect(ids.has(e.meta.id), e.meta.id).toBe(false);
      ids.add(e.meta.id);
      expect(e.meta.summary.length, e.meta.id).toBeGreaterThan(10);
      expect(e.meta.lookAt.length, e.meta.id).toBeGreaterThan(0);
      expect(e.scenarios.length, e.meta.id).toBeGreaterThan(0);
      if (e.meta.family === 'inspired') expect(e.meta.source?.title, e.meta.id).toBeTruthy();
    }
  });

  it('plays every scenario with evidence for every hop', () => {
    for (const e of HOLODECK_ENTRIES) {
      const index = hopIndex(e.nodes, e.edges);
      for (const s of e.scenarios) {
        const check = checkScenario(s, e.nodes, e.edges, index);
        expect(check.problems, `${e.meta.id} / ${s.name}`).toEqual([]);
        expect(s.steps.length, `${e.meta.id} / ${s.name}`).toBeGreaterThan(0);
      }
    }
  });
});
