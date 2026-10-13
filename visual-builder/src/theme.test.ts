// The theme holds together: every colour class the app uses has a token in
// both palettes, and no component paints a literal colour the theme cannot
// reach. A new hue or step shows up here before it shows up as a light
// patch on a dark screen.

import { describe, expect, it } from 'vitest';
import { THEME_TOKENS } from './themeTokens';

// Every source file as text, through Vite, so no file-system types are needed.
const sources = import.meta.glob(['./**/*.ts', './**/*.tsx', '!./**/*.test.ts'], { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const files = Object.keys(sources);
const readFileSync = (f: string) => sources[f];

const CLASS = /(?:^|[\s:'"`(])(?:(?:hover|focus|disabled|group-hover|active|placeholder|focus-within):)*(?:bg|text|border|ring|from|to|via|divide|outline|fill|stroke|shadow|placeholder|decoration|accent|caret)-([a-z]+(?:-[0-9]{2,3})?)(?:\/[0-9]+)?(?=[\s'"`)]|$)/g;
const PLAIN = new Set(['transparent', 'current', 'inherit', 'black', 'none', 'inset', 'sm', 'md', 'lg', 'xl', 'solid', 'dashed', 'dotted', 'double', 'left', 'right', 'top', 'bottom', 'center', 'justify', 'start', 'end', 'nowrap', 'wrap', 'ellipsis', 'clip', 'balance', 'pretty', 'offset', 'hidden', 'opacity', 'blue', 'red', 'green', 'gray']);

describe('theme tokens', () => {
  it('define every colour class the app uses, in both palettes', () => {
    const used = new Set<string>();
    for (const f of files) {
      const text = readFileSync(f);
      for (const m of text.matchAll(CLASS)) {
        const name = m[1];
        if (PLAIN.has(name) || /^(xs|sm|base|lg|[0-9]+xl|opacity.*|\[.*\])$/.test(name)) continue;
        if (/^(white|[a-z]+-[0-9]{2,3}|strong|strong-hover|on-strong|chrome|chrome-hover|chrome-fg|chrome-muted)$/.test(name)) used.add(name);
      }
    }
    const missing = [...used].filter((t) => !THEME_TOKENS.has(t));
    expect(missing).toEqual([]);
    expect(used.size).toBeGreaterThan(100);
  });

  it('leave no literal colour in a component the theme cannot reach', () => {
    const offenders: string[] = [];
    for (const f of files) {
      if (/themeTokens\.ts|thumbnail\.ts|demoAccount\.ts|holodeckLibrary\.ts/.test(f)) continue;
      const text = readFileSync(f);
      const hits = [...text.matchAll(/#[0-9a-fA-F]{6}\b/g)].map((m) => m[0]);
      if (hits.length) offenders.push(`${f}: ${[...new Set(hits)].join(', ')}`);
    }
    expect(offenders).toEqual([]);
  });

  it('has the chrome and strong tokens the components rely on', () => {
    for (const t of ['strong', 'strong-hover', 'on-strong', 'chrome', 'chrome-hover', 'chrome-fg', 'chrome-muted', 'white', 'gray-50', 'gray-900']) {
      expect(THEME_TOKENS.has(t), t).toBe(true);
    }
  });
});
