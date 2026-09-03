// The Environment object, inspected. Its settings are edited here, on the
// object, and are written to warpcore.yaml on save - they are shared with
// everyone who works on the project. Nothing personal belongs on this panel;
// that is Settings (gear, bottom-left).

import { Layers } from 'lucide-react';
import { useReadOnly, useStore, EnvironmentConfig, RemovalPolicy } from '../../store/useStore';
import { environmentFragment } from '../../utils/configSync';
import Toggle from '../ui/Toggle';
import ExpertView from './ExpertView';
import InspectorHeader, { Section, StatusDot } from './InspectorHeader';

// Slider over a fixed set of sensible values, so an operator picks "1 GB"
// rather than typing 1024 and hoping.
function SteppedSlider({
  value,
  onChange,
  options,
  label,
}: {
  value: number;
  onChange: (value: number) => void;
  options: { label: string; value: number }[];
  label: string;
}) {
  const currentIndex = options.findIndex((opt) => opt.value === value);
  const safeIndex = currentIndex >= 0 ? currentIndex : 0;
  return (
    <div className="py-1">
      <div className="flex justify-between items-center mb-1">
        <span className="text-xs text-gray-600">{label}</span>
        <span className="text-xs font-semibold text-blue-700">{options[safeIndex]?.label}</span>
      </div>
      <input
        type="range"
        min={0}
        max={options.length - 1}
        value={safeIndex}
        onChange={(e) => onChange(options[parseInt(e.target.value, 10)].value)}
        className="w-full h-1.5 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-blue-600"
      />
    </div>
  );
}

function PolicySelector({
  value,
  onChange,
  allowSnapshot = true,
  allowClear = false,
  defaultValue,
}: {
  value: RemovalPolicy | undefined;
  onChange: (value: RemovalPolicy | undefined) => void;
  allowSnapshot?: boolean;
  allowClear?: boolean;
  defaultValue?: RemovalPolicy;
}) {
  const options: { label: string; value: RemovalPolicy; color: string }[] = [
    { label: 'Destroy', value: 'destroy', color: 'bg-red-100 text-red-700 border-red-300' },
    { label: 'Retain', value: 'retain', color: 'bg-blue-100 text-blue-700 border-blue-300' },
    ...(allowSnapshot ? [{ label: 'Snapshot', value: 'snapshot' as RemovalPolicy, color: 'bg-purple-100 text-purple-700 border-purple-300' }] : []),
  ];
  const isUsingDefault = value === undefined;
  const displayValue = value || defaultValue;

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {options.map((opt) => {
        const isSelected = displayValue === opt.value;
        const isInheritedDefault = isUsingDefault && opt.value === defaultValue;
        return (
          <button
            key={opt.label}
            type="button"
            onClick={() => onChange(opt.value)}
            className={`px-2 py-0.5 rounded-full text-xs font-medium border transition-all ${
              isSelected
                ? isInheritedDefault
                  ? 'bg-gray-50 text-gray-500 border-gray-300 border-dashed'
                  : `${opt.color} ring-1 ring-offset-1 ring-blue-500`
                : 'bg-white text-gray-600 border-gray-200 hover:border-gray-400'
            }`}
          >
            {opt.label}
          </button>
        );
      })}
      {allowClear && !isUsingDefault && (
        <button type="button" onClick={() => onChange(undefined)} className="text-[11px] text-gray-400 hover:text-gray-600 ml-1">
          inherit
        </button>
      )}
    </div>
  );
}

const RETENTION_OPTIONS = [
  { label: '1 day', value: 1 },
  { label: '3 days', value: 3 },
  { label: '1 week', value: 7 },
  { label: '2 weeks', value: 14 },
  { label: '1 month', value: 30 },
  { label: '2 months', value: 60 },
  { label: '3 months', value: 90 },
  { label: '6 months', value: 180 },
  { label: '1 year', value: 365 },
];

const MEMORY_OPTIONS = [
  { label: '128 MB', value: 128 },
  { label: '256 MB', value: 256 },
  { label: '512 MB', value: 512 },
  { label: '1 GB', value: 1024 },
  { label: '2 GB', value: 2048 },
  { label: '4 GB', value: 4096 },
];

const TIMEOUT_OPTIONS = [
  { label: '10 sec', value: 10 },
  { label: '30 sec', value: 30 },
  { label: '1 min', value: 60 },
  { label: '5 min', value: 300 },
  { label: '15 min', value: 900 },
];

export default function EnvironmentInspector({ env }: { env: string }) {
  const {
    environmentConfigs, setEnvironmentConfig, currentEnvironment, setCurrentEnvironment,
    inspectEnvironment, configPath, deploymentHistory,
  } = useStore();
  const config = environmentConfigs[env];
  const isCurrent = env === currentEnvironment;
  const readOnly = useReadOnly();

  const updateConfig = (path: string, value: unknown) => {
    const next = JSON.parse(JSON.stringify(config)) as EnvironmentConfig;
    const keys = path.split('.');
    let obj: Record<string, unknown> = next as unknown as Record<string, unknown>;
    for (let i = 0; i < keys.length - 1; i++) obj = obj[keys[i]] as Record<string, unknown>;
    obj[keys[keys.length - 1]] = value;
    setEnvironmentConfig(env, next);
  };

  const lastDeployment = deploymentHistory[0];

  return (
    <>
      <InspectorHeader
        icon={Layers}
        kind="Environment"
        name={config.name}
        subtitle={<span className="font-mono">{env}</span>}
        onBack={() => inspectEnvironment(null)}
        status={
          isCurrent
            ? <StatusDot tone="info" label="current deploy scope" />
            : <StatusDot tone="muted" label="not the current scope" />
        }
        actions={
          !isCurrent && (
            <button
              onClick={() => setCurrentEnvironment(env)}
              className="text-xs px-2 py-1 rounded border border-gray-200 text-gray-700 hover:bg-gray-50"
              title="Deploy and destroy will target this environment"
            >
              Make current
            </button>
          )
        }
      />

      <fieldset disabled={readOnly} className={`flex-1 overflow-y-auto min-h-0 min-w-0 ${readOnly ? '[&_button]:cursor-not-allowed [&_input]:cursor-not-allowed' : ''}`}>
        {readOnly && (
          <div className="mx-4 mt-3 px-3 py-2 rounded bg-amber-50 border border-amber-200 text-[11px] text-amber-900">
            Locked: these settings are shown, not editable. Unlock from the toolbar to change them.
          </div>
        )}
        <Section title="Removal policies" hint="what happens on destroy">
          <div className="space-y-2">
            <div>
              <div className="text-xs text-gray-600 mb-1">Default</div>
              <PolicySelector
                value={config.removalPolicies.default}
                onChange={(v) => updateConfig('removalPolicies.default', v || 'destroy')}
              />
            </div>
            {([
              ['s3', 'S3 buckets', false],
              ['dynamodb', 'DynamoDB tables', true],
              ['logGroup', 'Log groups', false],
            ] as const).map(([key, label, snapshot]) => (
              <div key={key}>
                <div className="text-xs text-gray-600 mb-1">{label}</div>
                <PolicySelector
                  value={config.removalPolicies[key]}
                  onChange={(v) => updateConfig(`removalPolicies.${key}`, v)}
                  allowSnapshot={snapshot}
                  allowClear
                  defaultValue={config.removalPolicies.default}
                />
              </div>
            ))}
          </div>
        </Section>

        <Section title="Logging">
          <SteppedSlider
            label="Default log retention"
            value={config.logging.defaultRetentionDays}
            onChange={(v) => updateConfig('logging.defaultRetentionDays', v)}
            options={RETENTION_OPTIONS}
          />
          <div className="pt-2">
            <Toggle
              checked={config.logging.enableXRay}
              onChange={(v) => updateConfig('logging.enableXRay', v)}
              label="X-Ray tracing"
            />
          </div>
        </Section>

        <Section title="Lambda defaults" hint="unless a resource overrides">
          <SteppedSlider
            label="Memory"
            value={config.defaults.lambdaMemory}
            onChange={(v) => updateConfig('defaults.lambdaMemory', v)}
            options={MEMORY_OPTIONS}
          />
          <SteppedSlider
            label="Timeout"
            value={config.defaults.lambdaTimeout}
            onChange={(v) => updateConfig('defaults.lambdaTimeout', v)}
            options={TIMEOUT_OPTIONS}
          />
          <div className="pt-2 space-y-2">
            <Toggle
              checked={config.defaults.s3Versioning}
              onChange={(v) => updateConfig('defaults.s3Versioning', v)}
              label="S3 versioning"
            />
            <Toggle
              checked={config.defaults.dynamoDbBackup}
              onChange={(v) => updateConfig('defaults.dynamoDbBackup', v)}
              label="DynamoDB point-in-time backup"
            />
          </div>
        </Section>

        <Section title="Evidence">
          <div className="text-xs text-gray-600">
            {lastDeployment
              ? <>Last deployment {lastDeployment.status === 'deployed' ? 'succeeded' : 'failed'} at {lastDeployment.timestamp.toLocaleString()}.</>
              : 'No deployment has been run from this app yet, so nothing has consumed these values.'}
          </div>
        </Section>

        <ExpertView title="warpcore.yaml fragment" language="yaml" text={environmentFragment(env, config)} />
      </fieldset>

      <div className="px-4 py-2 border-t border-gray-200 bg-gray-50 text-[11px] text-gray-500 flex-shrink-0">
        {configPath
          ? 'Shared setting. Saved to warpcore.yaml with the project.'
          : 'Shared setting. Written to warpcore.yaml once the project is saved.'}
      </div>
    </>
  );
}
