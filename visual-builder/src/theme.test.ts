// The theme holds together: every colour class the app uses has a token,
// and no component or stylesheet paints a literal colour the theme cannot
// reach. A new hue or step shows up here before it shows up as a light
// patch on a dark screen.

import { describe, expect, it } from 'vitest';
import { THEME_TOKENS } from './themeTokens';

// Every source file as text, through Vite. CSS comes through a raw query
// too; the test environment would otherwise hand back an empty module.
const code = import.meta.glob(['./**/*.ts', './**/*.tsx', '!./**/*.test.ts'], { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const css = import.meta.glob(['./**/*.css', '!./theme.css'], { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

const ROLE = [...THEME_TOKENS].filter((t) => !/-[0-9]+$/.test(t)).join('|');
const CLASS = new RegExp(`(?:^|[\\s:'"\`(])(?:bg|text|border|ring|from|to|via|divide|outline|fill|stroke|shadow|placeholder|decoration|accent|caret)-(${ROLE}|[a-z]+-[0-9]{2,3})(?:/[0-9]+)?(?=[\\s'"\`)]|$)`, 'g');

describe('theme tokens', () => {
  it('define every colour class the app uses', () => {
    const used = new Set<string>();
    for (const text of Object.values(code)) for (const m of text.matchAll(CLASS)) used.add(m[1]);
    expect([...used].filter((t) => !THEME_TOKENS.has(t))).toEqual([]);
    expect(used.size).toBeGreaterThan(100);
  });

  it('leave no literal colour the theme cannot reach', () => {
    const offenders: string[] = [];
    for (const [f, text] of Object.entries({ ...code, ...css })) {
      if (/themeTokens\.ts|thumbnail\.ts/.test(f)) continue;
      const hits = [...text.matchAll(/#[0-9a-fA-F]{6}\b|(?<![-\w])(?:white|black)(?=\s*[;!])/g)].map((m) => m[0]);
      if (hits.length) offenders.push(`${f}: ${[...new Set(hits)].join(', ')}`);
    }
    expect(offenders).toEqual([]);
  });
});
