// Edge layers: the map-layers idea from DESIGN_GUIDANCE.md §9.6. An account
// with every relationship drawn is a hairball; the default picture shows
// triggers and access, and the rest is one toggle away. Selecting a node
// always reveals all of its edges, dimmed for layers that are off.

export type Layer = 'triggers' | 'access' | 'network' | 'encryption' | 'plumbing';

export const LAYERS: { id: Layer; label: string; description: string }[] = [
  { id: 'triggers', label: 'Traffic & triggers', description: 'DNS records, CloudFront origins, event sources, rule targets, subscriptions, invocations, dead-letter queues' },
  { id: 'access', label: 'Access', description: 'Read and write arrows from IAM policies, and permission edges you drew' },
  { id: 'network', label: 'Network', description: 'Security-group membership and trust, routes, gateways' },
  { id: 'encryption', label: 'Encryption', description: 'Which key encrypts what' },
  { id: 'plumbing', label: 'Plumbing', description: 'Log groups, execution roles, instance profiles, volumes, certificates' },
];

export const DEFAULT_LAYERS: Record<Layer, boolean> = {
  triggers: true,
  access: true,
  network: false,
  encryption: false,
  plumbing: false,
};

/** Discovered relationship kinds that carry traffic: drawn as flow, and the hops a request can take. */
export const TRAFFIC_KINDS: ReadonlySet<string> = new Set(['event-source', 'event-target', 'invokes', 'dlq', 'dns', 'origin']);

/** Which layer a discovered relationship belongs on. */
export function layerFor(kind: string, detail: string): Layer {
  if (TRAFFIC_KINDS.has(kind)) return 'triggers';
  switch (kind) {
    case 'access':
      return 'access';
    case 'vpc':
      return 'network';
    case 'reference':
      if (detail === 'encrypted with') return 'encryption';
      if (detail.startsWith('env ')) return 'access';
      return 'plumbing';
    default:
      return 'plumbing';
  }
}

/**
 * The layers to switch on so a canvas shows something: when no edge sits on
 * a layer that is on, every layer that carries an edge. A network-only
 * account opened with the default layers would otherwise draw no lines at
 * all, and "0 of 21" is not a picture.
 */
export function layersToReveal(edgeLayers: (Layer | undefined)[], layers: Record<Layer, boolean>): Layer[] {
  const carrying = new Set<Layer>();
  for (const l of edgeLayers) if (l) carrying.add(l);
  if ([...carrying].some((l) => layers[l])) return [];
  return [...carrying].filter((l) => !layers[l]);
}
