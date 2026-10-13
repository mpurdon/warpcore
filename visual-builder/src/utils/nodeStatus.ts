// What each node status means on screen: its tone and its words. Shared
// by the inspector, the palette rows and anything else that names a status.

import type { NodeStatus } from '../store/useStore';
import type { Tone } from '../components/inspector/InspectorHeader';

export const STATUS_META: Record<NodeStatus, { tone: Tone; label: string; pulse?: boolean }> = {
  draft: { tone: 'muted', label: 'not configured' },
  warning: { tone: 'warn', label: 'needs attention' },
  configured: { tone: 'info', label: 'ready to deploy' },
  deploying: { tone: 'info', label: 'deploying', pulse: true },
  deployed: { tone: 'ok', label: 'deployed' },
  failed: { tone: 'bad', label: 'deployment failed' },
  present: { tone: 'muted', label: 'exists in the account · health unknown' },
};
