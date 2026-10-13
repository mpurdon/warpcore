// Holodeck commands: walk through a library system, and leave it.

import { HOLODECK_ENTRIES, findEntry } from '../utils/holodeckLibrary';
import { previewEntry, replaceBlockedReason } from '../utils/holodeckActions';
import { define } from './registry';

define({
  id: 'holodeck.preview', title: 'Walk through a system', description: 'Put a Holodeck entry on the canvas as a read-only preview, with its scenarios ready to play. `id` is the entry id or its name. What was open comes back when the preview closes.', group: 'Actions', kind: 'view',
  params: { id: { type: 'string', description: 'The entry id or name', required: true } },
  keywords: ['holodeck', 'library', 'example', 'reference'],
  available: (s) => (s.holodeckPreview ? null : replaceBlockedReason()),
  instances: () => HOLODECK_ENTRIES.map((e) => ({ key: e.meta.id, args: { id: e.meta.id }, title: `Walk through: ${e.meta.name}`, subtitle: e.meta.summary, keywords: [e.meta.family, ...e.services] })),
  describe: (a) => `Walk through ${findEntry(a.id as string)?.meta.name ?? a.id}`,
  run: (a) => {
    const ref = String(a.id);
    const entry = findEntry(ref) ?? HOLODECK_ENTRIES.find((e) => e.meta.name.toLowerCase() === ref.toLowerCase());
    if (!entry) throw new Error(`no Holodeck entry ${ref}; have ${HOLODECK_ENTRIES.map((e) => e.meta.id).join(', ')}`);
    const reason = previewEntry(entry);
    if (reason) throw new Error(reason);
    return { id: entry.meta.id, scenarios: entry.scenarios.map((s) => s.name) };
  },
});
