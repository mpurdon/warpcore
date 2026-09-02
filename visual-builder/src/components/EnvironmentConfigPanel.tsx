import { useEffect, useRef, useState } from 'react';
import { X, Settings, FileText, Database, Trash2, Bug, Globe } from 'lucide-react';
import { useStore, EnvironmentConfig, RemovalPolicy } from '../store/useStore';
import RegionPicker, { summariseRegions } from './RegionPicker';
import { listAwsProfiles, listRegions, preferredProfile } from '../utils/accountExplorer';

interface Props {
  environment: string;
  onClose: () => void;
}

// Toggle switch, shared by every boolean setting in this panel.
function Toggle({
  checked,
  onChange,
  label,
  description,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  description?: string;
}) {
  return (
    <label className="flex items-start gap-3 cursor-pointer">
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
        className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${
          checked ? 'bg-blue-600' : 'bg-gray-200'
        }`}
      >
        <span
          className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
            checked ? 'translate-x-6' : 'translate-x-1'
          }`}
        />
      </button>
      <span>
        <span className="block text-sm font-medium text-gray-700">{label}</span>
        {description && (
          <span className="block text-xs text-gray-500 mt-0.5">{description}</span>
        )}
      </span>
    </label>
  );
}

// Slider component for stepped values
function SteppedSlider({
  value,
  onChange,
  options,
}: {
  value: number;
  onChange: (value: number) => void;
  options: { label: string; value: number }[];
}) {
  const currentIndex = options.findIndex(opt => opt.value === value);
  const safeIndex = currentIndex >= 0 ? currentIndex : 0;
  const currentLabel = options[safeIndex]?.label || '';

  return (
    <div className="space-y-2">
      <div className="flex justify-between items-center">
        <span className="text-sm font-semibold text-blue-600">{currentLabel}</span>
      </div>
      <input
        type="range"
        min={0}
        max={options.length - 1}
        value={safeIndex}
        onChange={(e) => {
          const idx = parseInt(e.target.value, 10);
          onChange(options[idx].value);
        }}
        className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-blue-600"
      />
      <div className="flex justify-between text-xs text-gray-400">
        <span>{options[0]?.label}</span>
        <span>{options[options.length - 1]?.label}</span>
      </div>
    </div>
  );
}

// Policy selector with chip buttons
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
    <div className="flex flex-wrap items-center gap-2">
      {options.map((opt) => {
        const isSelected = displayValue === opt.value;
        const isInheritedDefault = isUsingDefault && opt.value === defaultValue;
        return (
          <button
            key={opt.label}
            type="button"
            onClick={() => onChange(opt.value)}
            className={`px-3 py-1.5 rounded-full text-sm font-medium border transition-all ${
              isSelected
                ? isInheritedDefault
                  ? 'bg-gray-50 text-gray-500 border-gray-300 border-dashed'
                  : `${opt.color} ring-2 ring-offset-1 ring-blue-500`
                : 'bg-white text-gray-600 border-gray-200 hover:border-gray-400'
            }`}
          >
            {opt.label}
          </button>
        );
      })}
      {allowClear && !isUsingDefault && (
        <button
          type="button"
          onClick={() => onChange(undefined)}
          className="text-xs text-gray-400 hover:text-gray-600 ml-1"
        >
          Reset
        </button>
      )}
    </div>
  );
}

// Used when the account's enabled regions cannot be fetched. The commercial
// partition as of writing; the picker groups anything it does not know.
const FALLBACK_REGIONS = [
  'us-east-1', 'us-east-2', 'us-west-1', 'us-west-2',
  'ca-central-1', 'ca-west-1', 'mx-central-1', 'sa-east-1',
  'eu-central-1', 'eu-central-2', 'eu-west-1', 'eu-west-2', 'eu-west-3',
  'eu-north-1', 'eu-south-1', 'eu-south-2',
  'ap-east-1', 'ap-south-1', 'ap-south-2',
  'ap-northeast-1', 'ap-northeast-2', 'ap-northeast-3',
  'ap-southeast-1', 'ap-southeast-2', 'ap-southeast-3', 'ap-southeast-4',
  'me-central-1', 'me-south-1', 'af-south-1', 'il-central-1',
];

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

export default function EnvironmentConfigPanel({ environment, onClose }: Props) {
  const {
    environmentConfigs, setEnvironmentConfig, debugMode, setDebugMode,
    selectedRegions, setSelectedRegions,
  } = useStore();
  const [availableRegions, setAvailableRegions] = useState<string[]>([]);
  const [regionNote, setRegionNote] = useState<string | undefined>();
  const config = environmentConfigs[environment];
  const modalRef = useRef<HTMLDivElement>(null);

  // Close on Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  // The account's own enabled regions, so the picker offers what this account
  // can actually use. Falls back to the static catalogue if that call fails -
  // an unreachable AWS must not leave the picker empty.
  useEffect(() => {
    let cancelled = false;
    let profile = '';
    listAwsProfiles()
      .then((profiles) => {
        // The profile the Account Explorer last used, not an arbitrary one:
        // the first profile alphabetically often has no usable credentials.
        profile = preferredProfile(profiles);
        return listRegions(profile);
      })
      .then((regions) => { if (!cancelled) setAvailableRegions(regions); })
      .catch(() => {
        if (cancelled) return;
        setAvailableRegions(FALLBACK_REGIONS);
        setRegionNote(
          `Could not list enabled regions${profile ? ` using profile "${profile}"` : ''}; `
          + 'showing the standard set. Scan an account in the Explorer first to pick it up.',
        );
      });
    return () => { cancelled = true; };
  }, []);

  // Close on backdrop click
  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  const updateConfig = (path: string, value: any) => {
    const newConfig = JSON.parse(JSON.stringify(config)) as EnvironmentConfig;
    const keys = path.split('.');
    let obj: any = newConfig;
    for (let i = 0; i < keys.length - 1; i++) {
      obj = obj[keys[i]];
    }
    obj[keys[keys.length - 1]] = value;
    setEnvironmentConfig(environment, newConfig);
  };

  const envColors: Record<string, string> = {
    dev: 'bg-green-100 text-green-800 border-green-200',
    staging: 'bg-yellow-100 text-yellow-800 border-yellow-200',
    prod: 'bg-red-100 text-red-800 border-red-200',
  };

  return (
    <div
      className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50"
      onClick={handleBackdropClick}
    >
      <div
        ref={modalRef}
        className="bg-white rounded-lg shadow-xl w-[700px] max-h-[85vh] overflow-hidden flex flex-col"
      >
        {/* Header */}
        <div className="p-4 border-b border-gray-200 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Settings size={20} className="text-gray-600" />
            <h2 className="text-lg font-semibold">Environment Configuration</h2>
            <span className={`px-2 py-1 rounded text-sm font-medium border ${envColors[environment] || 'bg-gray-100 text-gray-800 border-gray-200'}`}>
              {config.name}
            </span>
          </div>
          <button
            onClick={onClose}
            className="p-2 hover:bg-gray-100 rounded-full transition-colors"
            title="Close (Esc)"
          >
            <X size={20} className="text-gray-500" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6 space-y-8">
          {/* Removal Policies */}
          <section>
            <div className="flex items-center gap-2 mb-4">
              <Trash2 size={18} className="text-red-500" />
              <h3 className="font-semibold text-gray-800">Removal Policies</h3>
            </div>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Default Policy</label>
                <PolicySelector
                  value={config.removalPolicies.default}
                  onChange={(v) => updateConfig('removalPolicies.default', v || 'destroy')}
                  allowSnapshot={true}
                />
              </div>
              <div className="grid grid-cols-3 gap-4 pt-2 border-t border-gray-100">
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-2">S3 Buckets</label>
                  <PolicySelector
                    value={config.removalPolicies.s3}
                    onChange={(v) => updateConfig('removalPolicies.s3', v)}
                    allowSnapshot={false}
                    allowClear={true}
                    defaultValue={config.removalPolicies.default}
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-2">DynamoDB Tables</label>
                  <PolicySelector
                    value={config.removalPolicies.dynamodb}
                    onChange={(v) => updateConfig('removalPolicies.dynamodb', v)}
                    allowSnapshot={true}
                    allowClear={true}
                    defaultValue={config.removalPolicies.default}
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-2">Log Groups</label>
                  <PolicySelector
                    value={config.removalPolicies.logGroup}
                    onChange={(v) => updateConfig('removalPolicies.logGroup', v)}
                    allowSnapshot={false}
                    allowClear={true}
                    defaultValue={config.removalPolicies.default}
                  />
                </div>
              </div>
            </div>
          </section>

          {/* Logging */}
          <section>
            <div className="flex items-center gap-2 mb-4">
              <FileText size={18} className="text-emerald-500" />
              <h3 className="font-semibold text-gray-800">Logging</h3>
            </div>
            <div className="grid grid-cols-2 gap-6">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-3">Default Log Retention</label>
                <SteppedSlider
                  value={config.logging.defaultRetentionDays}
                  onChange={(v) => updateConfig('logging.defaultRetentionDays', v)}
                  options={RETENTION_OPTIONS}
                />
              </div>
              <div className="flex items-center">
                <Toggle
                  checked={config.logging.enableXRay}
                  onChange={(v) => updateConfig('logging.enableXRay', v)}
                  label="Enable X-Ray Tracing"
                />
              </div>
            </div>
          </section>

          {/* Resource Defaults */}
          <section>
            <div className="flex items-center gap-2 mb-4">
              <Database size={18} className="text-purple-500" />
              <h3 className="font-semibold text-gray-800">Lambda Defaults</h3>
            </div>
            <div className="grid grid-cols-2 gap-6">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-3">Memory</label>
                <SteppedSlider
                  value={config.defaults.lambdaMemory}
                  onChange={(v) => updateConfig('defaults.lambdaMemory', v)}
                  options={MEMORY_OPTIONS}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-3">Timeout</label>
                <SteppedSlider
                  value={config.defaults.lambdaTimeout}
                  onChange={(v) => updateConfig('defaults.lambdaTimeout', v)}
                  options={TIMEOUT_OPTIONS}
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4 mt-6 pt-4 border-t border-gray-100">
              <div className="flex items-center">
                <Toggle
                  checked={config.defaults.s3Versioning}
                  onChange={(v) => updateConfig('defaults.s3Versioning', v)}
                  label="S3 Versioning"
                />
              </div>
              <div className="flex items-center">
                <Toggle
                  checked={config.defaults.dynamoDbBackup}
                  onChange={(v) => updateConfig('defaults.dynamoDbBackup', v)}
                  label="DynamoDB Backup"
                />
              </div>
            </div>
          </section>

          {/* Regions - app-level, drives every region-aware surface */}
          <section className="border-t border-gray-200 pt-6">
            <div className="flex items-center gap-2 mb-1">
              <Globe size={18} className="text-sky-500" />
              <h3 className="font-semibold text-gray-800">Regions of interest</h3>
              <span className="text-[10px] uppercase tracking-wide font-semibold text-gray-400 border border-gray-200 rounded px-1.5 py-0.5">
                This machine only
              </span>
            </div>
            <p className="text-xs text-gray-500 mb-4">
              Checked regions are the ones offered elsewhere in the app - the Account
              Explorer scans these rather than all {availableRegions.length || 30}.
              Currently {summariseRegions(selectedRegions)}.
            </p>
            <RegionPicker
              available={availableRegions}
              selected={selectedRegions}
              onChange={setSelectedRegions}
              note={regionNote}
            />
          </section>

          {/* Developer - app-level, not part of the environment's config */}
          <section className="border-t border-gray-200 pt-6">
            <div className="flex items-center gap-2 mb-1">
              <Bug size={18} className="text-amber-500" />
              <h3 className="font-semibold text-gray-800">Developer</h3>
              <span className="text-[10px] uppercase tracking-wide font-semibold text-gray-400 border border-gray-200 rounded px-1.5 py-0.5">
                This machine only
              </span>
            </div>
            <p className="text-xs text-gray-500 mb-4">
              Applies to every environment and is never written to warpcore.yaml.
            </p>
            <Toggle
              checked={debugMode}
              onChange={setDebugMode}
              label="Debug mode"
              description="Runs the CLI with --dev: verbose logging, AWS API call tracing, and a captured session you can inspect with `warpcore debug session`. Deployments are slower and much noisier."
            />
            {debugMode && (
              <div className="mt-4 rounded-lg bg-amber-50 border border-amber-200 p-3">
                <p className="text-xs text-amber-800">
                  Debug mode is on. Deploy and destroy will run as
                  {' '}<code className="font-mono bg-amber-100 px-1 rounded">warpcore --dev</code>,
                  and the execution log will include DEBUG entries.
                </p>
              </div>
            )}
          </section>
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-gray-200 bg-gray-50 flex items-center justify-between">
          <p className="text-xs text-gray-500">
            These settings apply as defaults for the <strong>{config.name}</strong> environment.
          </p>
          <button
            onClick={onClose}
            className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
