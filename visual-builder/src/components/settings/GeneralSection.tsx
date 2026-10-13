import { Bug, RotateCcw } from 'lucide-react';
import { useStore } from '../../store/useStore';
import { APPEARANCES, LogLevel, resetPreferences } from '../../utils/preferences';
import Toggle from '../ui/Toggle';
import { Field, SectionHeader, Select, SmallButton, SubHeader } from './primitives';

const LOG_LEVELS: { label: string; value: LogLevel }[] = [
  { label: 'Debug', value: 'debug' },
  { label: 'Info', value: 'info' },
  { label: 'Warning', value: 'warning' },
  { label: 'Error', value: 'error' },
];

export default function GeneralSection() {
  const { debugMode, setDebugMode, prefs, setPref } = useStore();

  const reset = () => {
    if (!confirm('Reset every application setting to its default? Regions of interest are cleared too.')) return;
    const defaults = resetPreferences();
    // Push each key through setPref so the store mirrors update as well.
    (Object.keys(defaults) as (keyof typeof defaults)[]).forEach((k) => setPref(k, defaults[k]));
  };

  return (
    <div>
      <SectionHeader
        icon={Bug}
        title="General"
        description="How this copy of the app runs the CLI. Applies to every project and environment on this machine and is never written to warpcore.yaml."
      />

      <Field
        label="Appearance"
        description="Light or dark, or whatever the system is set to. Both are designed on purpose: the canvas, the cards and the panels each have their own dark palette."
      >
        <Select value={prefs.appearance} onChange={(v) => setPref('appearance', v)} options={APPEARANCES.map((a) => ({ label: a.label, value: a.value }))} />
      </Field>

      <Field
        label="Developer mode"
        description={
          <>
            Runs the CLI with <code className="font-mono bg-gray-100 px-1 rounded">--dev</code>: verbose logging,
            AWS API call tracing, and a captured session you can inspect with
            {' '}<code className="font-mono bg-gray-100 px-1 rounded">warpcore debug session</code>.
            Deployments are slower and much noisier.
          </>
        }
      >
        <Toggle checked={debugMode} onChange={setDebugMode} label="Developer mode" />
      </Field>

      {debugMode && (
        <div className="mt-3 rounded-lg bg-amber-50 border border-amber-200 p-3">
          <p className="text-xs text-amber-800">
            Developer mode is on. Deploy and destroy will run as
            {' '}<code className="font-mono bg-amber-100 px-1 rounded">warpcore --dev</code>,
            the execution log will include DEBUG entries, and a session manifest is written under
            {' '}<code className="font-mono bg-amber-100 px-1 rounded">.warpcore/dev</code>.
          </p>
        </div>
      )}

      <Field
        label="Log level"
        description={
          debugMode
            ? 'Developer mode forces debug logging; this applies again when it is off.'
            : 'Console verbosity for every CLI run. The JSONL log file always records debug.'
        }
      >
        <Select<LogLevel>
          value={prefs.logLevel}
          onChange={(v) => setPref('logLevel', v)}
          options={LOG_LEVELS}
          disabled={debugMode}
        />
      </Field>

      <SubHeader title="Reset" />
      <Field label="Reset application settings" description="Back to the defaults on this page and every other section.">
        <SmallButton onClick={reset} danger>
          <span className="inline-flex items-center gap-1"><RotateCcw size={12} /> Reset all</span>
        </SmallButton>
      </Field>
    </div>
  );
}
