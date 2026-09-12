// Which application each resource belongs to. An account exists to run one
// application or a few; the canvas draws one tile per application, so
// every resource needs a home and a reason it landed there. Three signals,
// in order of trust: tags, shared name prefixes, then the wiring. Resources
// used by more than one application are shared platform.
//
// Pure: takes plain descriptions, returns assignments. The import (buildCanvas)
// feeds it and writes the result into each node's meta so the inspector can
// show the reason and the operator can see when a guess is wrong.

export const SHARED_ID = 'shared';
export const SHARED_NAME = 'Shared platform';

export interface ApplicationAssignment {
  id: string;
  name: string;
  /** Why, in words the inspector shows: "tag Application=shop", "name prefix shop-", ... */
  reason: string;
}

export interface ClusterItem {
  id: string;
  name: string;
  type: string;
  tags?: Record<string, string>;
  /** True for things that belong to whoever uses them: keys, roles, VPCs, logs. */
  platform: boolean;
  /** Containing VPC or subnet, when inside one. */
  parent?: string;
}

export interface ClusterLink {
  source: string;
  target: string;
}

export interface Application {
  id: string;
  name: string;
  members: string[];
}

export interface Clustering {
  assignments: Map<string, ApplicationAssignment>;
  applications: Application[];
}

const TAG_KEYS = ['application', 'app', 'service', 'project', 'stack', 'component', 'system'];

// First tokens that name nothing in particular.
const GENERIC_PREFIXES = new Set([
  'aws', 'amazon', 'default', 'lambda', 'api', 'the', 'my', 'test', 'prod', 'production', 'dev', 'stage', 'staging',
  'main', 'app', 'service', 'data', 'log', 'logs', 'role', 'key', 'alias', 'arn', 'rds', 's3', 'sqs', 'sns', 'ec2', 'vpc',
  'subnet', 'sg', 'igw', 'nat', 'rtb', 'eni', 'vol', 'snap', 'ami', 'i', 'e', 'z', 'cloudfront', 'cloudwatch', 'events',
]);
// Environment tokens: "dev-talend-vpc" is talend's, in dev. Skipped, not stopped at.
const ENV_TOKENS = new Set(['dev', 'test', 'qa', 'uat', 'stage', 'staging', 'preprod', 'nonprod', 'prod', 'production', 'sandbox', 'my', 'the']);
// An AWS-generated id: a short type prefix and a hex tail. Names nothing.
const AWS_ID = /^[a-z]{1,8}-[0-9a-f]{8,17}$/;

export function slugId(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
}

/** The first meaningful token of a name: "shop-orders-table" -> "shop", "/shop/prod/db" -> "shop". */
export function namePrefix(name: string): string | null {
  const cleaned = name.replace(/^\/+/, '').replace(/^arn:[^:]*:[^:]*:[^:]*:[^:]*:/, '');
  if (AWS_ID.test(cleaned.toLowerCase())) return null;
  const tokens = cleaned.split(/[-_/.:\s]+/).map((t) => t.toLowerCase());
  // A whole name with no separator is not a prefix of anything.
  if (tokens.length < 2) return null;
  // Past the environment, the first token that names something.
  let i = 0;
  while (i < tokens.length - 1 && ENV_TOKENS.has(tokens[i])) i++;
  const token = tokens[i] ?? '';
  if (token.length < 3 || /^\d+$/.test(token) || GENERIC_PREFIXES.has(token)) return null;
  return token;
}

function tagApplication(tags: Record<string, string> | undefined): { key: string; value: string } | null {
  if (!tags) return null;
  for (const key of TAG_KEYS) {
    const hit = Object.entries(tags).find(([k]) => k.toLowerCase() === key);
    if (hit && hit[1].trim()) return { key: hit[0], value: hit[1].trim() };
  }
  return null;
}

/**
 * Assign every item to an application.
 *
 * `fallbackName` names the application when nothing else does: the project
 * name the operator chose for the import.
 */
export function clusterApplications(items: ClusterItem[], links: ClusterLink[], fallbackName: string): Clustering {
  const byId = new Map(items.map((i) => [i.id, i]));
  const assignments = new Map<string, ApplicationAssignment>();
  const names = new Map<string, string>(); // app id -> display name
  const setApp = (id: string, appId: string, name: string, reason: string) => {
    assignments.set(id, { id: appId, name, reason });
    if (!names.has(appId)) names.set(appId, name);
  };

  // 1. Tags.
  for (const item of items) {
    const tag = tagApplication(item.tags);
    if (tag) setApp(item.id, slugId(tag.value), tag.value, `tag ${tag.key}=${tag.value}`);
  }

  // 2. Name prefixes shared by three or more resources, or matching the
  //    project's own name.
  const fallbackSlug = slugId(fallbackName);
  const prefixes = new Map<string, string[]>();
  for (const item of items) {
    const p = namePrefix(item.name);
    if (!p) continue;
    const list = prefixes.get(p) || [];
    list.push(item.id);
    prefixes.set(p, list);
  }
  for (const [prefix, ids] of prefixes) {
    const known = names.has(prefix) || [...names.keys()].some((k) => k.startsWith(prefix));
    const strong = ids.length >= 3 || prefix === fallbackSlug || known;
    if (!strong) continue;
    const appId = [...names.keys()].find((k) => k === prefix || k.startsWith(prefix)) ?? prefix;
    for (const id of ids) {
      if (!assignments.has(id)) setApp(id, appId, names.get(appId) ?? prefix, `name prefix ${prefix}-`);
    }
  }

  // Neighbours: wiring plus containment (a thing inside a VPC is near the VPC).
  const neighbours = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    if (!byId.has(a) || !byId.has(b) || a === b) return;
    (neighbours.get(a) || neighbours.set(a, new Set()).get(a)!).add(b);
    (neighbours.get(b) || neighbours.set(b, new Set()).get(b)!).add(a);
  };
  for (const l of links) link(l.source, l.target);
  for (const item of items) if (item.parent) link(item.id, item.parent);

  // 3. Propagate along the wiring: an unassigned resource joins the
  //    application most of its assigned neighbours are in.
  for (let round = 0; round < 12; round++) {
    let changed = false;
    for (const item of items) {
      if (assignments.has(item.id)) continue;
      const votes = new Map<string, { n: number; via: string }>();
      for (const nb of neighbours.get(item.id) || []) {
        const a = assignments.get(nb);
        if (!a || a.id === SHARED_ID) continue;
        const v = votes.get(a.id) || { n: 0, via: nb };
        v.n += 1;
        votes.set(a.id, v);
      }
      if (votes.size === 0) continue;
      const [appId, best] = [...votes.entries()].sort((x, y) => y[1].n - x[1].n)[0];
      const viaName = byId.get(best.via)?.name ?? best.via;
      setApp(item.id, appId, names.get(appId)!, `wired to ${viaName}`);
      changed = true;
    }
    if (!changed) break;
  }

  // 4. What is left: connected components. Two or more together are an
  //    application of their own, provided they run something: a VPC with
  //    only its own plumbing in it is platform, not an application. A
  //    loner is shared platform.
  const unassigned = items.filter((i) => !assignments.has(i.id));
  const seen = new Set<string>();
  const components: ClusterItem[][] = [];
  for (const start of unassigned) {
    if (seen.has(start.id)) continue;
    const comp: ClusterItem[] = [];
    const stack = [start.id];
    seen.add(start.id);
    while (stack.length) {
      const id = stack.pop()!;
      const item = byId.get(id)!;
      comp.push(item);
      for (const nb of neighbours.get(id) || []) {
        if (!seen.has(nb) && !assignments.has(nb)) { seen.add(nb); stack.push(nb); }
      }
    }
    components.push(comp);
  }
  components.sort((a, b) => b.length - a.length);
  for (const comp of components) {
    if (comp.length === 1 || comp.every((c) => c.platform)) {
      for (const c of comp) setApp(c.id, SHARED_ID, SHARED_NAME, comp.length === 1 ? 'not wired to any application' : 'platform with nothing running on it');
      continue;
    }
    // Name it after the most common prefix, else the busiest member, else
    // the project when nothing else is named yet.
    const count = new Map<string, number>();
    for (const c of comp) { const p = namePrefix(c.name); if (p) count.set(p, (count.get(p) || 0) + 1); }
    const prefix = [...count.entries()].sort((x, y) => y[1] - x[1])[0]?.[0];
    const busiest = [...comp].sort((x, y) => (neighbours.get(y.id)?.size || 0) - (neighbours.get(x.id)?.size || 0))[0];
    const name = prefix ?? (names.size === 0 ? fallbackName : busiest.name);
    const appId = slugId(name) || `app-${components.indexOf(comp) + 1}`;
    for (const c of comp) setApp(c.id, appId, name, `connected to ${comp.length - 1} other resource${comp.length === 2 ? '' : 's'} with no application of their own`);
  }

  // 5. Shared platform: a platform resource wired into two or more
  //    applications belongs to neither.
  for (const item of items) {
    if (!item.platform) continue;
    const apps = new Set<string>();
    for (const nb of neighbours.get(item.id) || []) {
      const a = assignments.get(nb);
      if (a && a.id !== SHARED_ID) apps.add(a.id);
    }
    if (apps.size >= 2) setApp(item.id, SHARED_ID, SHARED_NAME, `used by ${apps.size} applications`);
  }

  // 6. One application and some shared bits is one application: a "shared"
  //    tile beside a single tenant is noise.
  const appIds = new Set([...assignments.values()].map((a) => a.id).filter((id) => id !== SHARED_ID));
  if (appIds.size === 1) {
    const only = [...appIds][0];
    for (const [id, a] of assignments) {
      if (a.id === SHARED_ID) assignments.set(id, { id: only, name: names.get(only)!, reason: a.reason });
    }
  }
  if (appIds.size === 0 && assignments.size > 0) {
    const appId = slugId(fallbackName) || 'app';
    for (const [id, a] of assignments) assignments.set(id, { id: appId, name: fallbackName, reason: a.reason });
  }

  const members = new Map<string, string[]>();
  for (const [id, a] of assignments) (members.get(a.id) || members.set(a.id, []).get(a.id)!).push(id);
  const applications: Application[] = [...members.entries()]
    .map(([id, ids]) => ({ id, name: id === SHARED_ID ? SHARED_NAME : (names.get(id) ?? id), members: ids }))
    .sort((a, b) => (a.id === SHARED_ID ? 1 : 0) - (b.id === SHARED_ID ? 1 : 0) || b.members.length - a.members.length);
  return { assignments, applications };
}
