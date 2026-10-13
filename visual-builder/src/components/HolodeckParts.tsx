// The small pieces the Holodeck shows in more than one place: the family
// tag, a thumbnail, an entry's notes and source, and the Save a copy button
// that owns its dialog.

import { useState } from 'react';
import { Copy, Flame, Route } from 'lucide-react';
import { difficultyLabel, familyInfo, HolodeckEntry, HolodeckFamily, HolodeckMeta } from '../utils/holodeck';
import { isUnhappy } from '../utils/scenarios';
import SaveCopyDialog from './SaveCopyDialog';

const TAG_CLASS: Record<HolodeckFamily, string> = {
  reference: 'bg-emerald-50 text-emerald-800 border-emerald-200',
  inspired: 'bg-violet-50 text-violet-800 border-violet-200',
  classic: 'bg-sky-50 text-sky-800 border-sky-200',
  starter: 'bg-gray-100 text-gray-700 border-gray-200',
  designed: 'bg-amber-50 text-amber-800 border-amber-200',
};

export function FamilyTag({ family }: { family: HolodeckFamily }) {
  const f = familyInfo(family);
  return <span className={`text-[10px] font-medium border rounded-full px-1.5 py-px whitespace-nowrap ${TAG_CLASS[family]}`} title={f.description}>{f.tag}</span>;
}

export function Difficulty({ d }: { d: 1 | 2 | 3 }) {
  return (
    <span className="inline-flex items-center gap-0.5" title={`Size: ${difficultyLabel(d)}`}>
      {[1, 2, 3].map((i) => <span key={i} className={`w-1.5 h-1.5 rounded-full ${i <= d ? 'bg-gray-500' : 'bg-gray-200'}`} />)}
    </span>
  );
}

/** The laid-out canvas as a picture; `src` is the data URL the loader made. */
export function Thumbnail({ src }: { src: string }) {
  return <img src={src} alt="" className="w-full aspect-[3/2] object-contain bg-gray-50 rounded-lg border border-gray-100" draggable={false} />;
}

/** The look-at notes and, for an inspired entry, the source with the disclaimer. */
export function HolodeckNotes({ meta, heading = true }: { meta: HolodeckMeta; heading?: boolean }) {
  const f = familyInfo(meta.family);
  return (
    <>
      {meta.lookAt.length > 0 && (
        <div>
          {heading && <div className="text-[10px] font-semibold uppercase tracking-wide text-gray-400 mb-1">Look at</div>}
          <ul className="space-y-1.5">
            {meta.lookAt.map((l, i) => <li key={i} className="text-xs text-gray-700 flex gap-2"><span className="text-gray-300">▸</span><span>{l}</span></li>)}
          </ul>
        </div>
      )}
      {meta.source && (
        <div className="text-[11px] text-gray-600">
          <span className="font-medium text-gray-800">{f.tag}</span> {meta.source.title}
          {meta.source.by ? `, ${meta.source.by}` : ''}{meta.source.year ? ` (${meta.source.year})` : ''}.
          {meta.source.url && <div className="font-mono text-[10px] text-gray-400 break-all mt-0.5">{meta.source.url}</div>}
          <div className="text-gray-400 mt-1">A rendering of a public description on AWS services, not the real system. No branding.</div>
        </div>
      )}
    </>
  );
}

/** One line per scenario, with the flame for an unhappy path. */
export function ScenarioList({ entry }: { entry: HolodeckEntry }) {
  return (
    <ul className="space-y-1">
      {entry.scenarios.map((s) => (
        <li key={s.id} className="text-xs text-gray-800 flex items-center gap-2">
          {isUnhappy(s) ? <Flame size={11} className="text-red-600 shrink-0" /> : <Route size={11} className="text-blue-600 shrink-0" />}
          <span className="flex-1 truncate">{s.name}</span>
          <span className="text-[10px] text-gray-400 shrink-0">{s.steps.length} steps{s.trigger.event ? ` · ${s.trigger.event}` : ''}</span>
        </li>
      ))}
    </ul>
  );
}

export const BUTTON = 'inline-flex items-center gap-1 text-xs px-2 py-1 rounded border';
export const PRIMARY = `${BUTTON} border-blue-600 bg-blue-600 text-white hover:bg-blue-700`;
export const QUIET = `${BUTTON} border-gray-200 text-gray-800 hover:bg-gray-50`;

/** "Save a copy…", with the dialog it opens. */
export function SaveCopyButton({ entry, className = QUIET, stop = false }: { entry: HolodeckEntry; className?: string; stop?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        onClick={(e) => { if (stop) e.stopPropagation(); setOpen(true); }}
        className={className}
        title="Write it as a project of your own and open it"
      >
        <Copy size={12} /> Save a copy…
      </button>
      {open && <SaveCopyDialog entry={entry} onClose={() => setOpen(false)} />}
    </>
  );
}
