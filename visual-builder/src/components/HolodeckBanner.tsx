// The band across the top of the canvas while a Holodeck entry is
// previewed: what it is, that nothing is saved, and the two ways out. The
// same height as the lock banner, so the lens bar makes the same room.

import { LibraryBig, X } from 'lucide-react';
import { useStore } from '../store/useStore';
import { findEntry } from '../utils/holodeckLibrary';
import { closePreview } from '../utils/holodeckActions';
import { LOCK_BANNER_HEIGHT } from './ProjectLock';
import { SaveCopyButton } from './HolodeckParts';

export default function HolodeckBanner() {
  const holodeck = useStore((s) => s.holodeck);
  const preview = useStore((s) => s.holodeckPreview);
  const openDialog = useStore((s) => s.openDialog);
  if (!preview || !holodeck) return null;
  const entry = findEntry(holodeck.id);
  return (
    <div
      className="absolute top-0 left-0 right-0 z-30 flex items-center gap-3 px-4 bg-indigo-50 border-b border-indigo-200 text-sm text-indigo-900"
      style={{ height: LOCK_BANNER_HEIGHT }}
      role="status"
    >
      <LibraryBig size={14} className="text-indigo-700 shrink-0" />
      <span className="truncate min-w-0">
        Holodeck preview: <strong>{holodeck.name}</strong>, read only, nothing saved.
        <span className="hidden lg:inline"> Play its scenarios, switch lenses, open the system view.</span>
      </span>
      <span className="ml-auto shrink-0 flex items-center gap-1.5">
        <button onClick={() => openDialog('holodeck')} className="text-xs px-2.5 py-1 rounded border border-indigo-200 text-indigo-800 hover:bg-white">Library</button>
        {entry && <SaveCopyButton entry={entry} className="inline-flex items-center gap-1 text-xs font-semibold px-2.5 py-1 rounded bg-indigo-600 text-white hover:bg-indigo-700" />}
        <button onClick={closePreview} className="p-1 rounded text-indigo-700 hover:bg-white" title="Close the preview and go back to what was open">
          <X size={14} />
        </button>
      </span>
    </div>
  );
}
