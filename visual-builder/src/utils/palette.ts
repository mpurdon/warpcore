// Ranking for the command palette. Deliberately small: exact and prefix
// matches beat substrings, which beat scattered subsequences, and the title
// counts for more than the subtitle or keywords. No dependency, no fuzz
// library, and simple enough to reason about when a result looks wrong.

export type PaletteKind = 'resource' | 'environment' | 'command' | 'lens' | 'layer' | 'setting';

export interface PaletteItem {
  id: string;
  kind: PaletteKind;
  /** Group heading the item appears under. */
  group: string;
  title: string;
  subtitle?: string;
  keywords?: string[];
  /** Displayed on the right, e.g. "⌘D". */
  shortcut?: string;
  /** Rendered with a small dot, for resources: their status colour. */
  tone?: 'ok' | 'warn' | 'bad' | 'info' | 'muted';
  run: () => void;
}

/** How well `query` matches `text`: 0 for no match. Higher is better. */
export function scoreText(query: string, text: string): number {
  const q = query.trim().toLowerCase();
  const t = text.toLowerCase();
  if (!q) return 1;
  if (t === q) return 100;
  if (t.startsWith(q)) return 90;
  const words = t.split(/[\s\-_/.:]+/);
  if (words.some((w) => w.startsWith(q))) return 80;
  const at = t.indexOf(q);
  if (at >= 0) return 65 - Math.min(at, 20);
  // Subsequence: every query character in order, penalised by the spread.
  let ti = 0;
  let first = -1;
  for (let qi = 0; qi < q.length; qi++) {
    const idx = t.indexOf(q[qi], ti);
    if (idx < 0) return 0;
    if (first < 0) first = idx;
    ti = idx + 1;
  }
  const spread = ti - first - q.length;
  return Math.max(1, 30 - spread);
}

export function scoreItem(query: string, item: PaletteItem): number {
  const title = scoreText(query, item.title);
  const subtitle = item.subtitle ? scoreText(query, item.subtitle) * 0.6 : 0;
  const keyword = (item.keywords || []).reduce((best, k) => Math.max(best, scoreText(query, k) * 0.7), 0);
  return Math.max(title, subtitle, keyword);
}

/**
 * Rank items for a query. With no query, items keep their given order, so
 * the caller decides what an empty palette shows first.
 */
export function rankItems(query: string, items: PaletteItem[], limit = 40): PaletteItem[] {
  if (!query.trim()) return items.slice(0, limit);
  return items
    .map((item, index) => ({ item, index, score: scoreItem(query, item) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .map((r) => r.item);
}

/** Items grouped in first-seen order of their group label. */
export function groupItems(items: PaletteItem[]): { group: string; items: PaletteItem[] }[] {
  const groups = new Map<string, PaletteItem[]>();
  for (const item of items) {
    const list = groups.get(item.group);
    if (list) list.push(item);
    else groups.set(item.group, [item]);
  }
  return [...groups.entries()].map(([group, list]) => ({ group, items: list }));
}
