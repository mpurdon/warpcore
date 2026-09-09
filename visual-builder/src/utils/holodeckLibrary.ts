// The bundled entries: every YAML file in visual-builder/holodeck/, parsed
// once at startup. Kept apart from holodeck.ts so the parser stays a pure
// function of a string.

import { FAMILIES, HolodeckEntry, HolodeckFamily, parseHolodeckEntry } from './holodeck';

const files = import.meta.glob('../../holodeck/*.yaml', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

const familyRank = new Map(FAMILIES.map((f, i) => [f.id, i]));

export const HOLODECK_ENTRIES: HolodeckEntry[] = Object.entries(files)
  .map(([path, text]) => parseHolodeckEntry(text, path.split('/').pop()!.replace(/\.ya?ml$/, '')))
  .sort((a, b) => (familyRank.get(a.meta.family)! - familyRank.get(b.meta.family)!) || a.meta.difficulty - b.meta.difficulty || a.meta.name.localeCompare(b.meta.name));

const BY_ID = new Map(HOLODECK_ENTRIES.map((e) => [e.meta.id, e]));

export function findEntry(id: string): HolodeckEntry | undefined {
  return BY_ID.get(id);
}

/** Entries per family, for the drawer's rail. */
export const ENTRY_COUNTS: Record<HolodeckFamily, number> = Object.fromEntries(
  FAMILIES.map((f) => [f.id, HOLODECK_ENTRIES.filter((e) => e.meta.family === f.id).length]),
) as Record<HolodeckFamily, number>;
