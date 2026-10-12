// Account commands: what touches AWS or the deployment state. Reads run
// when asked; changes are confirmed by the dispatcher whoever asks.

import type { Node } from 'reactflow';
import { selectCurrentEnvName as envName, useStore } from '../store/useStore';
import { fetchResourceDetail, projectProfile } from '../utils/accountExplorer';
import { blockedReason, runDeployment } from '../utils/deployRunner';
import { fetchConnectPlan, openConnectSession } from '../utils/connect';
import { setMuted } from '../utils/findings';
import { refreshDrift, refreshLive } from '../utils/live';
import { displayNameFor } from '../utils/nodeName';
import { runReview } from '../utils/review';
import { takeOver } from '../utils/takeover';
import { define } from './registry';
import { findNode, nameOf } from './view';

const needProfile = () => {
  const s = useStore.getState();
  const profile = projectProfile(s.environmentExtras, s.currentEnvironment);
  if (!profile) throw new Error('No AWS profile is recorded for this environment; re-import the account or choose a default profile in Settings');
  return profile;
};

define({
  id: 'account.deploy', title: (s) => `Deploy to ${envName(s)}`, description: 'Run warpcore deploy for the current environment and show the run in Activity. The plan is applied as the CLI reports it.', group: 'Actions', kind: 'aws-change',
  shortcut: { key: 'd', mod: true, label: '⌘D' },
  keywords: ['run', 'apply'],
  available: () => blockedReason('deploy'),
  confirm: (_a, s) => `Deploy the project to ${envName(s)}? This runs warpcore deploy against AWS.`,
  run: () => runDeployment('deploy'),
});

define({
  id: 'account.destroy', title: (s) => `Destroy ${envName(s)}`, description: 'Run warpcore destroy for the current environment: every managed resource is deleted. Adopted resources are kept.', group: 'Actions', kind: 'aws-change',
  keywords: ['delete', 'teardown', 'remove'],
  available: () => blockedReason('destroy'),
  confirm: (_a, s) => `Destroy every resource in the ${envName(s)} environment?\n\nThis runs warpcore destroy against AWS.`,
  run: () => runDeployment('destroy'),
});

define({
  id: 'account.review', title: 'Review', description: 'Read every metered resource\'s metrics over a window and run the rules: idle hosts, open ports, failing functions, waste. Findings land on the cards and in the Review drawer.', group: 'Account', kind: 'aws-read',
  params: { hours: { type: 'number', description: 'The window in hours: 1, 24, 168 or 720; default 24' } },
  keywords: ['findings', 'audit', 'cost', 'security'],
  available: (s) => (!s.configPath ? 'Save the project first' : s.reviewBusy ? 'A review is running' : null),
  describe: (a) => `Review over ${a.hours ?? 24}h`,
  run: async (a) => {
    needProfile();
    await runReview((a.hours as number | undefined) ?? 24);
    const r = useStore.getState().review;
    return r ? { findings: r.findings.length, errors: r.errors } : null;
  },
});

define({
  id: 'account.refreshLive', title: 'Read live health', description: 'Read what the account says now about every discovered resource; the Live lens colours the cards from it.', group: 'Account', kind: 'aws-read',
  keywords: ['live', 'health', 'status'],
  available: (s) => (!s.configPath ? 'Save the project first' : s.liveBusy ? 'Already reading' : null),
  run: async () => {
    needProfile();
    await refreshLive();
    const h = useStore.getState().liveHealth;
    return h ? { checked_at: h.checked_at, resources: Object.keys(h.resources).length } : null;
  },
});

define({
  id: 'account.checkDrift', title: 'Check drift', description: 'Compare the deployment state with the account: what changed behind warpcore\'s back, what is gone.', group: 'Account', kind: 'aws-read',
  keywords: ['drift', 'state'],
  available: (s) => (!s.configPath ? 'Save the project first' : s.driftBusy ? 'Already comparing' : null),
  run: async () => {
    needProfile();
    await refreshDrift();
    const d = useStore.getState().drift;
    return d ? { counts: d.counts, error: d.error } : null;
  },
});

define({
  id: 'account.liveDetail', title: 'Live detail', description: 'What AWS says about one discovered resource now: configuration, network, metrics over `hours`, logs, related resources.', group: 'Queries', kind: 'aws-read', hidden: true,
  params: { id: { type: 'string', description: 'Node id or label of a discovered resource', required: true }, hours: { type: 'number', description: 'Metrics window; default 24' } },
  describe: (a) => `Live detail of ${a.id}`,
  run: async (a, { state }) => {
    const node = findNode(state, a.id as string) as Node | undefined;
    if (!node) throw new Error(`no resource ${a.id} on the canvas`);
    if (!node.data?.arn) throw new Error(`${displayNameFor(node)} was not discovered from an account, so it has no live state`);
    return fetchResourceDetail(needProfile(), node.data.arn as string, (a.hours as number | undefined) ?? 24);
  },
});

define({
  id: 'account.connectPlan', title: 'How to reach an instance', description: 'The checks and the command for reaching an EC2 instance from this machine. Advice only; nothing is opened.', group: 'Queries', kind: 'aws-read', hidden: true,
  params: { id: { type: 'string', description: 'Node id or label of an instance', required: true } },
  describe: (a) => `Connect plan for ${a.id}`,
  run: async (a, { state }) => {
    const node = findNode(state, a.id as string) as Node | undefined;
    if (!node?.data?.arn) throw new Error(`no discovered instance ${a.id}`);
    return fetchConnectPlan(needProfile(), node.data.arn as string);
  },
});

define({
  id: 'account.connect', title: 'Connect to an instance', description: 'Open a terminal session to an EC2 instance using the method the connect plan chose.', group: 'Account', kind: 'aws-change', hidden: true,
  params: { id: { type: 'string', description: 'Node id or label of an instance', required: true } },
  confirm: (a, s) => `Open a terminal session to ${nameOf(s, a.id as string)}?`,
  describe: (a, s) => `Connect to ${nameOf(s, a.id as string)}`,
  run: async (a, { state }) => {
    const node = findNode(state, a.id as string) as Node | undefined;
    if (!node?.data?.arn) throw new Error(`no discovered instance ${a.id}`);
    return { command: await openConnectSession(needProfile(), node.data.arn as string) };
  },
});

define({
  id: 'account.takeOver', title: 'Take over resources', description: 'Take over adopted resources: from then on the canvas config is what a deploy enforces on them. Writes the deployment state only; nothing in AWS changes until a deploy.', group: 'Account', kind: 'aws-change', hidden: true,
  params: { ids: { type: 'string[]', description: 'Node ids or labels of discovered resources', required: true } },
  available: (s) => (!s.configPath ? 'Save the project first' : null),
  confirm: (a) => `Take over ${(a.ids as string[]).length} resource(s)? Deploy will then enforce the canvas configuration on them.`,
  describe: (a) => `Take over ${(a.ids as string[]).join(', ')}`,
  run: async (a, { state }) => {
    const ids = (a.ids as string[]).map((r) => { const n = findNode(state, r); if (!n) throw new Error(`no resource ${r} on the canvas`); return n.id; });
    return takeOver(state.configPath!, state.currentEnvironment, ids);
  },
});

define({
  id: 'account.muteFinding', title: 'Mute a finding', description: 'Accept a finding with a reason; it leaves the open list. Writes .warpcore/findings-mutes.yaml beside the project.', group: 'Account', kind: 'file', hidden: true,
  params: { findingId: { type: 'string', description: 'The finding id from the review', required: true }, reason: { type: 'string', description: 'Why it is accepted; empty unmutes' } },
  available: (s) => (!s.configPath ? 'Save the project first' : null),
  describe: (a) => `${a.reason ? 'Mute' : 'Unmute'} finding ${a.findingId}`,
  run: async (a, { state }) => {
    const reason = (a.reason as string | undefined) || null;
    await setMuted(state.configPath!, a.findingId as string, reason);
    // The file is the truth; the review on screen is patched to match rather
    // than read again, which would mean every metric over the window.
    const review = useStore.getState().review;
    if (review) {
      const findings = review.findings.map((f) => (f.id === a.findingId ? { ...f, status: reason ? 'muted' as const : 'open' as const, mute_reason: reason } : f));
      useStore.getState().setReview({ ...review, findings });
    }
  },
});
