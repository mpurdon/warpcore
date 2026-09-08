import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import type { Node } from 'reactflow';
import { DEFAULT_ENVIRONMENT_CONFIGS } from '../store/useStore';
import { generateYAMLFromCanvas, parseYAMLToCanvas } from './configSync';

const node = (id: string, type: string): Node => ({ id, type, position: { x: 10, y: 20 }, data: { label: id, status: 'present' } });

describe('scenarios in warpcore.yaml', () => {
  it('writes them beside the environments and reads them back', () => {
    const nodes = [node('api-gateway-x', 'api-gateway'), node('lambda-fn', 'lambda'), node('dynamodb-t', 'dynamodb')];
    const yaml = generateYAMLFromCanvas(nodes, [], 1000, DEFAULT_ENVIRONMENT_CONFIGS, {}, 'demo', [
      { id: 'webhook', name: 'Webhook', trigger: { at: 'api-gateway-x', event: 'POST /hook' }, steps: [{ at: 'lambda-fn', takes: 120, note: 'handles it' }, { at: 'dynamodb-t', detached: true }] },
    ]);
    const doc = YAML.parse(yaml);
    expect(doc.scenarios).toEqual([
      { name: 'Webhook', trigger: { at: 'api-gateway-x', event: 'POST /hook' }, steps: [{ at: 'lambda-fn', note: 'handles it', takes: '120ms' }, { at: 'dynamodb-t', detached: true }] },
    ]);
    const parsed = parseYAMLToCanvas(yaml);
    expect(parsed.scenarios).toEqual([
      { id: 'webhook', name: 'Webhook', trigger: { at: 'api-gateway-x', event: 'POST /hook' }, steps: [{ at: 'lambda-fn', note: 'handles it', takes: 120 }, { at: 'dynamodb-t', detached: true }] },
    ]);
    expect(parsed.nodes.map((n) => n.id)).toEqual(nodes.map((n) => n.id));
  });

  it('leaves the key out when there are none, and tolerates its absence', () => {
    const yaml = generateYAMLFromCanvas([node('lambda-fn', 'lambda')], [], 1000, DEFAULT_ENVIRONMENT_CONFIGS, {}, 'demo');
    expect(YAML.parse(yaml).scenarios).toBeUndefined();
    expect(parseYAMLToCanvas(yaml).scenarios).toEqual([]);
  });
});
