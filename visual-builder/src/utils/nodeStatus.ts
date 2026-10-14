// What each node status means on screen: its tone and its words. Shared
// by the inspector, the palette rows and anything else that names a status.

import type { NodeStatus } from '../store/useStore';
import type { Tone } from '../components/inspector/InspectorHeader';

export const STATUS_META: Record<NodeStatus, { tone: Tone; label: string; pulse?: boolean; hue: string; dot: string }> = {
  draft: { tone: 'muted', label: 'not configured', hue: 'gray', dot: 'var(--c-gray-400)' },
  warning: { tone: 'warn', label: 'needs attention', hue: 'amber', dot: 'var(--c-amber-500)' },
  configured: { tone: 'info', label: 'ready to deploy', hue: 'blue', dot: 'var(--c-blue-500)' },
  deploying: { tone: 'info', label: 'deploying', pulse: true, hue: 'blue', dot: 'var(--c-blue-500)' },
  deployed: { tone: 'ok', label: 'deployed', hue: 'emerald', dot: 'var(--c-emerald-500)' },
  failed: { tone: 'bad', label: 'deployment failed', hue: 'red', dot: 'var(--c-red-500)' },
  present: { tone: 'muted', label: 'exists in the account · health unknown', hue: 'gray', dot: 'var(--c-gray-300)' },
};

/** The minimap's tint for a status: the hue's 200 step, the same semantics as the node tints. */
export const minimapColor = (status: NodeStatus): string => `var(--c-${STATUS_META[status].hue}-200)`;
