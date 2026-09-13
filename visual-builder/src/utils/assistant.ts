// The configured model's suggestions over the canvas's facts, through the
// CLI (warpcore discover suggest). Both shapes are checked on the way
// back: names land only on clusters the rules could not name, and a
// drafted scenario is run through the scenario checker like any other.

import { invoke } from '@tauri-apps/api/core';
import { Edge, Node } from 'reactflow';
import { hopIndex, Scenario, uniqueScenarioId } from './scenarios';
import { getPreferences } from './preferences';

export interface AssistantConfig { provider: string; model: string }

/** The assistant preference, or null when none is configured. */
export function assistantConfig(): AssistantConfig | null {
  const prefs = getPreferences();
  return prefs.assistantProvider ? { provider: prefs.assistantProvider, model: prefs.assistantModel } : null;
}

async function suggest<T>(kind: 'names' | 'scenario', input: unknown, llm: AssistantConfig, ask = ''): Promise<T> {
  const raw = await invoke<string>('assistant_suggest', {
    kind, input: JSON.stringify(input), llmProvider: llm.provider, llmModel: llm.model || null, ask: ask || null,
  });
  return JSON.parse(raw) as T;
}

export interface ClusterToName {
  id: string;
  current_name: string;
  members: { name: string; type: string; tags?: Record<string, string> }[];
}

/** Names for clusters the rules could not name. */
export async function suggestNames(clusters: ClusterToName[], projectName: string, llm: AssistantConfig): Promise<{ id: string; name: string; reason: string }[]> {
  if (clusters.length === 0) return [];
  const out = await suggest<{ clusters: { id: string; name: string; reason: string }[] }>('names', { clusters, project_name: projectName }, llm);
  return out.clusters;
}

/**
 * The application tiles whose name came from a guess rather than a tag or
 * a shared prefix: every member was placed by "connected to ..." or is
 * shared platform, so the tile is named after its busiest member or an id.
 */
export function unnamedClusters(nodes: Node[]): ClusterToName[] {
  const tiles = nodes.filter((n) => n.type === 'application');
  const out: ClusterToName[] = [];
  for (const tile of tiles) {
    const appId = tile.data?.meta?.application?.id as string | undefined;
    if (!appId || appId === 'shared') continue;
    const members = nodes.filter((n) => n.type !== 'application' && n.type !== 'band' && n.data?.meta?.application?.id === appId);
    if (members.length === 0) continue;
    const guessed = members.every((m) => /^(connected to|not wired|platform with)/.test(String(m.data?.meta?.application?.reason || '')));
    if (!guessed) continue;
    out.push({
      id: appId,
      current_name: String(tile.data?.label ?? appId),
      members: members.slice(0, 40).map((m) => ({ name: String(m.data?.label ?? m.id), type: m.type || '', tags: m.data?.config?.tags })),
    });
  }
  return out;
}

/** Rename an application tile and every member's application record, in place on copies. */
export function applyNames(nodes: Node[], names: { id: string; name: string; reason: string }[]): Node[] {
  const byId = new Map(names.map((n) => [n.id, n]));
  return nodes.map((n) => {
    const app = n.data?.meta?.application as { id: string; name: string; reason: string } | undefined;
    if (!app || !byId.has(app.id)) return n;
    const named = byId.get(app.id)!;
    const meta = { ...n.data.meta, application: { ...app, name: named.name, reason: n.type === 'application' ? `named by the assistant: ${named.reason}` : app.reason } };
    if (n.type === 'application') {
      return { ...n, data: { ...n.data, label: named.name, config: { ...(n.data.config || {}), name: named.name }, meta } };
    }
    return { ...n, data: { ...n.data, meta } };
  });
}

/** The graph as the model sees it: names, types, edges, and the hops the checker allows. */
export function graphForDraft(nodes: Node[], edges: Edge[], trigger?: { at: string; event?: string }) {
  const index = hopIndex(nodes, edges);
  const visible = nodes.filter((n) => !n.hidden && n.type !== 'application' && n.type !== 'band');
  const ids = new Set(visible.map((n) => n.id));
  return {
    nodes: visible.map((n) => ({ id: n.id, type: n.type, name: index.name(n.id), ...(n.data?.meta?.band ? { band: n.data.meta.band } : {}) })),
    edges: edges.filter((e) => ids.has(e.source) && ids.has(e.target)).map((e) => ({
      source: e.source, target: e.target,
      kind: e.data?.meta?.discovered?.kind ?? (e.data?.meta?.access ? 'access' : 'permission'),
      detail: e.data?.meta?.discovered?.detail ?? e.data?.meta?.access?.level ?? '',
    })),
    hops: Object.fromEntries([...index.hops.entries()].map(([from, hops]) => [from, hops.map((h) => h.to)])),
    ...(trigger ? { trigger } : {}),
  };
}

/** A scenario drafted by the model; the caller runs checkScenario on it. */
export async function draftScenario(
  nodes: Node[], edges: Edge[], existing: Scenario[], llm: AssistantConfig, ask = '', trigger?: { at: string; event?: string },
): Promise<Scenario> {
  const out = await suggest<{ name: string; trigger: { at: string; event?: string }; steps: Scenario['steps'] }>('scenario', graphForDraft(nodes, edges, trigger), llm, ask);
  return { id: uniqueScenarioId(out.name, existing), name: out.name, trigger: out.trigger, steps: out.steps };
}
