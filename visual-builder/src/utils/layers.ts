// Edge layers: the map-layers idea from DESIGN_GUIDANCE.md §9.6. An account
// with every relationship drawn is a hairball; the default picture shows
// triggers and access, and the rest is one toggle away. Selecting a node
// always reveals all of its edges, dimmed for layers that are off.

export type Layer = 'triggers' | 'access' | 'network' | 'encryption' | 'plumbing';

export const LAYERS: { id: Layer; label: string; description: string }[] = [
  { id: 'triggers', label: 'Triggers', description: 'Event sources, rule targets, subscriptions, invocations, dead-letter queues' },
  { id: 'access', label: 'Access', description: 'Read and write arrows from IAM policies, and permission edges you drew' },
  { id: 'network', label: 'Network', description: 'Security-group membership and trust, routes, gateways' },
  { id: 'encryption', label: 'Encryption', description: 'Which key encrypts what' },
  { id: 'plumbing', label: 'Plumbing', description: 'Log groups, execution roles, instance profiles, volumes, origins, certificates' },
];

export const DEFAULT_LAYERS: Record<Layer, boolean> = {
  triggers: true,
  access: true,
  network: false,
  encryption: false,
  plumbing: false,
};

/** Which layer a discovered relationship belongs on. */
export function layerFor(kind: string, detail: string): Layer {
  switch (kind) {
    case 'event-source':
    case 'event-target':
    case 'invokes':
    case 'dlq':
      return 'triggers';
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
