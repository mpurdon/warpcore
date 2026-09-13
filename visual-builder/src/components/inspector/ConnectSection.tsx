// The Connect section of an instance: the checks that decide whether you can
// reach it from this machine, the command that would, and two ways to use
// it. Read on request; every read is a handful of API calls plus a lookup
// of this machine's address.

import { useState } from 'react';
import { Check, Copy, HelpCircle, Terminal, X } from 'lucide-react';
import { Node } from 'reactflow';
import { useStore } from '../../store/useStore';
import { projectProfile } from '../../utils/accountExplorer';
import { ConnectPlan, fetchConnectPlan, METHOD_LABEL, openConnectSession } from '../../utils/connect';
import { Section } from './InspectorHeader';

export default function ConnectSection({ node }: { node: Node }) {
  const { environmentExtras, currentEnvironment } = useStore();
  const profile = projectProfile(environmentExtras, currentEnvironment);
  const arn = node.data?.arn as string | undefined;
  const [plan, setPlan] = useState<ConnectPlan | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [opened, setOpened] = useState<string | null>(null);

  if (!arn || node.type !== 'ec2-instance') return null;

  const read = async () => {
    if (!profile) return;
    setLoading(true);
    setError(null);
    try {
      setPlan(await fetchConnectPlan(profile, arn));
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  const copy = async () => {
    if (!plan?.command) return;
    try {
      await navigator.clipboard.writeText(plan.command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      setError('Could not write to the clipboard.');
    }
  };

  const open = async () => {
    if (!profile) return;
    setOpened(null);
    try {
      setOpened(await openConnectSession(profile, arn));
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <Section title="Connect" hint={plan ? METHOD_LABEL[plan.method] : undefined}>
      {!profile ? (
        <p className="text-xs text-gray-500">No AWS profile is recorded for this environment.</p>
      ) : !plan && !loading ? (
        <div className="flex items-center gap-2">
          <button onClick={read} className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-gray-900 text-white text-xs hover:bg-gray-800">
            <Terminal size={12} /> How do I reach this?
          </button>
          <span className="text-[11px] text-gray-500">checks the port, the key, Session Manager and a jump host</span>
        </div>
      ) : loading ? (
        <p className="text-xs text-gray-500">Checking the instance, its groups, this machine's address and keys…</p>
      ) : plan ? (
        <>
          <ul className="space-y-1 mb-2">
            {plan.checks.map((c) => (
              <li key={c.id} className="flex items-start gap-1.5 text-xs">
                {c.ok === true ? <Check size={13} className="text-emerald-600 shrink-0 mt-0.5" />
                  : c.ok === false ? <X size={13} className="text-red-600 shrink-0 mt-0.5" />
                  : <HelpCircle size={13} className="text-amber-500 shrink-0 mt-0.5" />}
                <span>
                  <span className="text-gray-800">{c.label}</span>
                  {c.detail && <span className="text-gray-500"> · {c.detail}</span>}
                </span>
              </li>
            ))}
          </ul>
          {plan.command ? (
            <>
              <pre className="text-[11px] font-mono bg-gray-900 text-gray-100 rounded p-2 whitespace-pre-wrap break-all">{plan.command}</pre>
              <div className="flex items-center gap-2 mt-2">
                <button onClick={copy} className="inline-flex items-center gap-1 px-2 py-1 rounded border border-gray-300 text-xs hover:bg-gray-50">
                  <Copy size={11} /> {copied ? 'Copied' : 'Copy'}
                </button>
                <button onClick={open} className="inline-flex items-center gap-1 px-2 py-1 rounded bg-gray-900 text-white text-xs hover:bg-gray-800">
                  <Terminal size={11} /> Open in Terminal
                </button>
                <button onClick={read} className="text-[11px] text-gray-500 hover:text-gray-800 ml-auto">Check again</button>
              </div>
              {opened && <p className="text-[11px] text-emerald-700 mt-1">Opened in a terminal window.</p>}
            </>
          ) : (
            <p className="text-xs text-gray-600">{METHOD_LABEL.none}. Fix the checks marked ✗, then check again.</p>
          )}
          {plan.notes.map((n) => <p key={n} className="text-[11px] text-gray-500 mt-1">{n}</p>)}
        </>
      ) : null}
      {error && <pre className="mt-2 text-[11px] text-red-700 whitespace-pre-wrap">{error}</pre>}
    </Section>
  );
}
