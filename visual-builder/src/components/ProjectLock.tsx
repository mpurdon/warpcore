// The project lock. A project opens locked: the canvas is view-only, and
// Deploy and Destroy are off. Unlocking means typing the project's name,
// the way a destructive confirmation works on GitHub, so nobody edits or
// deploys the wrong project by reflex. Switching environments locks again,
// because the deploy scope just changed.

import { useEffect, useRef, useState } from 'react';
import { Lock, Unlock, X } from 'lucide-react';
import { useCurrentEnvName, useStore } from '../store/useStore';

export function UnlockDialog({ onClose }: { onClose: () => void }) {
  const { projectName, configPath, unlock } = useStore();
  const envName = useCurrentEnvName();
  const [typed, setTyped] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const expected = (projectName || '').trim();
  const matches = expected.length > 0 && typed.trim() === expected;

  useEffect(() => { inputRef.current?.focus(); }, []);

  const confirm = () => {
    if (!matches) return;
    unlock();
    onClose();
  };

  return (
    <div className="fixed inset-0 z-[70] bg-black/50 flex items-center justify-center" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="bg-white text-gray-900 rounded-lg shadow-2xl w-[460px] overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-200 flex items-start gap-3">
          <div className="mt-0.5 p-2 rounded-full bg-amber-100 text-amber-700"><Lock size={18} /></div>
          <div className="flex-1">
            <h2 className="text-base font-semibold">Unlock {expected || 'this project'}?</h2>
            <p className="text-xs text-gray-600 mt-1">
              Locked, you can still move things around. Unlocking lets you change, connect and delete resources and run <strong>Deploy</strong> and <strong>Destroy</strong> against
              the <strong>{envName}</strong> environment{configPath ? '' : ' once the project is saved'}. It locks again when you
              switch environments or open another project.
            </p>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-gray-100 text-gray-400" title="Cancel (Esc)"><X size={16} /></button>
        </div>
        <div className="px-5 py-4">
          <label className="block text-xs font-medium text-gray-700">
            Type <span className="font-mono bg-gray-100 px-1 rounded select-all">{expected || '(unnamed)'}</span> to confirm
          </label>
          <input
            ref={inputRef}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') confirm(); if (e.key === 'Escape') { e.stopPropagation(); onClose(); } }}
            placeholder={expected}
            autoComplete="off"
            spellCheck={false}
            className="mt-1 w-full text-sm font-mono border border-gray-300 rounded px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-amber-500"
          />
          {!expected && (
            <p className="text-xs text-red-600 mt-2">This project has no name yet, so it cannot be unlocked by name. Save it first.</p>
          )}
        </div>
        <div className="px-5 py-3 bg-gray-50 border-t border-gray-200 flex justify-end gap-2">
          <button onClick={onClose} className="text-sm px-3 py-1.5 rounded border border-gray-300 hover:bg-white">Keep locked</button>
          <button
            onClick={confirm}
            disabled={!matches}
            className="inline-flex items-center gap-1.5 text-sm px-3 py-1.5 rounded bg-amber-600 text-white hover:bg-amber-700 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Unlock size={14} /> Unlock
          </button>
        </div>
      </div>
    </div>
  );
}

/** The toolbar control: the lock's state, and the way to change it. */
export function LockControl() {
  const { locked, lock, configPath, projectName } = useStore();
  const envName = useCurrentEnvName();
  const [asking, setAsking] = useState(false);

  if (!configPath) return null;

  return (
    <>
      {locked ? (
        <button
          onClick={() => setAsking(true)}
          className="flex items-center gap-2 px-3 py-1.5 rounded bg-amber-500 text-gray-900 hover:bg-amber-400 text-sm font-semibold border border-amber-300"
          title={`${projectName || 'Project'} is locked: view only. Click to unlock by typing its name.`}
        >
          <Lock size={16} />
          Locked
        </button>
      ) : (
        <button
          onClick={lock}
          className="flex items-center gap-2 px-3 py-1.5 rounded bg-gray-800 hover:bg-gray-700 text-emerald-300 text-sm border border-emerald-800"
          title={`Unlocked for ${envName}. Click to lock again.`}
        >
          <Unlock size={16} />
          Unlocked · {envName}
        </button>
      )}
      {asking && <UnlockDialog onClose={() => setAsking(false)} />}
    </>
  );
}

/** A band across the top of the canvas while locked, so the state is never a surprise. */
export function LockBanner() {
  const { locked, configPath, projectName } = useStore();
  const envName = useCurrentEnvName();
  const [asking, setAsking] = useState(false);
  if (!locked || !configPath) return null;
  return (
    <>
      <div className="absolute top-3 left-1/2 -translate-x-1/2 z-20 flex items-center gap-3 px-4 py-2 rounded-full bg-amber-50 border border-amber-300 shadow text-sm text-amber-900">
        <Lock size={16} className="text-amber-700" />
        <span>
          <strong>{projectName || 'Project'}</strong> is locked. Look, inspect and rearrange freely; changing, connecting, deleting, Deploy and Destroy for <strong>{envName}</strong> are off.
        </span>
        <button onClick={() => setAsking(true)} className="text-xs font-semibold px-2 py-1 rounded bg-amber-600 text-white hover:bg-amber-700">
          Unlock…
        </button>
      </div>
      {asking && <UnlockDialog onClose={() => setAsking(false)} />}
    </>
  );
}
