import { useEffect, useState } from 'react';
import { Radar, Trash2 } from 'lucide-react';
import { useStore } from '../../store/useStore';
import { listAwsProfiles } from '../../utils/accountExplorer';
import { clearDir, joinPath } from '../../utils/host';
import { useAppPaths } from '../../utils/useAppPaths';
import { Field, PathRow, SectionHeader, Select, SmallButton, SubHeader, useDirUsage } from './primitives';

const ASSISTANT_OPTIONS: { label: string; value: '' | 'anthropic' | 'openai' | 'bedrock' | 'local' }[] = [
  { label: 'None - rules only', value: '' },
  { label: 'Anthropic', value: 'anthropic' },
  { label: 'OpenAI', value: 'openai' },
  { label: 'Amazon Bedrock', value: 'bedrock' },
  { label: 'Local', value: 'local' },
];
const ASSISTANT_DEFAULTS: Record<string, string> = { anthropic: 'claude-opus-5', openai: 'gpt-4', bedrock: 'anthropic.claude-opus-5', local: 'llama2' };

const DRIFT_OPTIONS = [
  { label: 'Only when asked', value: 0 },
  { label: 'Every 15 minutes', value: 15 },
  { label: 'Every hour', value: 60 },
  { label: 'Every 4 hours', value: 240 },
];

const CACHE_OPTIONS = [
  { label: 'Off - always rescan', value: 0 },
  { label: '15 minutes', value: 15 },
  { label: '1 hour', value: 60 },
  { label: '4 hours', value: 240 },
  { label: '1 day', value: 1440 },
  { label: '1 week', value: 10080 },
];

export default function ExplorationSection() {
  const { prefs, setPref } = useStore();
  const [profiles, setProfiles] = useState<string[]>([]);
  const { paths } = useAppPaths();
  const cachePath = paths ? joinPath(paths.home_warpcore, 'cache', 'explorer') : null;
  const cache = useDirUsage(cachePath);

  useEffect(() => {
    listAwsProfiles().then(setProfiles).catch(() => setProfiles([]));
  }, []);

  const clearCache = async () => {
    if (!cachePath) return;
    if (!confirm('Delete every cached account scan? The next Explorer open will scan again.')) return;
    try {
      await clearDir(cachePath);
      cache.reload();
    } catch (e) {
      alert(String(e));
    }
  };

  const profileOptions = [
    { label: 'Last used', value: '' },
    ...profiles.map((p) => ({ label: p, value: p })),
    // Keep a configured profile visible even if it vanished from ~/.aws.
    ...(prefs.defaultProfile && !profiles.includes(prefs.defaultProfile)
      ? [{ label: `${prefs.defaultProfile} (not found)`, value: prefs.defaultProfile }]
      : []),
  ];

  return (
    <div>
      <SectionHeader
        icon={Radar}
        title="Exploration"
        description="How the Account Explorer scans. Scans are read-only; these settings only trade speed against freshness and API pressure."
      />

      <Field
        label="Default AWS profile"
        description="The profile the Explorer and region lookups start from. Profiles come from ~/.aws/config and ~/.aws/credentials."
      >
        <Select value={prefs.defaultProfile} onChange={(v) => setPref('defaultProfile', v)} options={profileOptions} />
      </Field>

      <Field
        label="Reuse a scan for"
        description="Opening the Explorer shows the last scan of the same profile and regions if it is younger than this. Rescan always fetches fresh."
      >
        <Select value={prefs.scanCacheMinutes} onChange={(v) => setPref('scanCacheMinutes', v)} options={CACHE_OPTIONS} />
      </Field>

      <SubHeader title="Assistant" hint="optional" />
      <Field
        label="Model provider"
        description="Ranks the findings of a review for this account and says why each matters here. The rules run without it. Credentials come from the environment the CLI runs in; nothing is stored here."
      >
        <Select value={prefs.assistantProvider} onChange={(v) => setPref('assistantProvider', v)} options={ASSISTANT_OPTIONS} />
      </Field>
      {prefs.assistantProvider && (
        <Field label="Model" description="Leave empty for the provider's default.">
          <input
            type="text"
            value={prefs.assistantModel}
            onChange={(e) => setPref('assistantModel', e.target.value)}
            placeholder={ASSISTANT_DEFAULTS[prefs.assistantProvider] || ''}
            className="w-56 px-2 py-1 text-sm border border-gray-300 rounded font-mono"
          />
        </Field>
      )}

      <SubHeader title="Drift" hint="state vs account" />
      <Field
        label="Check the deployment state against the account"
        description="Reads what the account has for every resource warpcore recorded and marks what changed behind its back. Read-only; the Review lists what it found."
      >
        <Select value={prefs.driftCheckMinutes} onChange={(v) => setPref('driftCheckMinutes', Number(v))} options={DRIFT_OPTIONS} />
      </Field>

      <SubHeader title="Scanning" />
      <Field
        label="Regions scanned at once"
        description="Higher is faster until AWS starts throttling. The CLI backs off on throttling either way; this is the ceiling."
      >
        <input
          type="number"
          min={1}
          max={16}
          value={prefs.scanParallelism}
          onChange={(e) => {
            const n = Math.max(1, Math.min(16, Number(e.target.value) || 1));
            setPref('scanParallelism', n);
          }}
          className="text-sm border border-gray-300 rounded px-2 py-1.5 w-20 text-right"
        />
      </Field>

      <SubHeader title="Scan cache" hint="Account scans are not project-specific, so they live in your home directory." />
      {cachePath && (
        <PathRow
          label="Cached scans"
          path={cachePath}
          usage={cache.usage}
          onReload={cache.reload}
          actions={
            <SmallButton onClick={clearCache} danger disabled={!cache.usage?.exists || cache.usage.files === 0} title="Delete cached scans">
              <span className="inline-flex items-center gap-1"><Trash2 size={12} /> Clear</span>
            </SmallButton>
          }
        />
      )}
    </div>
  );
}
