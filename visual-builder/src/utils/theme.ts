// The theme: one attribute on <html>, read by every token in theme.css.
// "system" follows the OS and changes with it; light and dark are fixed.
// Colours reach the DOM as CSS (`var(--c-…)` in classes and style props);
// the few places CSS cannot reach (SVG presentation attributes behind a
// library callback, three.js) read the resolved value with rc() or
// cssColorHex(), which re-read when the theme changes.

import { useSyncExternalStore } from 'react';
import type { Appearance } from './preferences';

type Theme = 'light' | 'dark';

const media = () => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null);

/** What an appearance preference means right now. */
export function resolveTheme(appearance: Appearance, systemDark = Boolean(media()?.matches)): Theme {
  if (appearance === 'system') return systemDark ? 'dark' : 'light';
  return appearance;
}

let stop: (() => void) | null = null;

/** Apply the preference to the document and keep following the system while it says so. */
export function applyAppearance(appearance: Appearance): void {
  stop?.();
  stop = null;
  const set = () => {
    const next = resolveTheme(appearance);
    if (document.documentElement.dataset.theme !== next) document.documentElement.dataset.theme = next;
  };
  set();
  if (appearance === 'system') {
    const m = media();
    if (m) {
      m.addEventListener('change', set);
      stop = () => m.removeEventListener('change', set);
    }
  }
}

// ------------------------------------------------- following the attribute
//
// One observer on <html>; the resolved-colour cache and every subscriber
// hear about a change from it, in that order, so no render can read a
// stale colour with a fresh version.

const listeners = new Set<() => void>();
const resolved = new Map<string, string>();
let version = 0;
let observing = false;

function observe(): void {
  if (observing || typeof document === 'undefined') return;
  observing = true;
  new MutationObserver(() => {
    resolved.clear();
    version += 1;
    for (const fn of listeners) fn();
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
}

function subscribe(fn: () => void): () => void {
  observe();
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** Bumps when the theme attribute changes, so a canvas or a library callback can repaint. */
export function useThemeVersion(): number {
  return useSyncExternalStore(subscribe, () => version, () => 0);
}

function raw(token: string): string {
  observe();
  let hit = resolved.get(token);
  if (hit === undefined) {
    hit = getComputedStyle(document.documentElement).getPropertyValue(`--c-${token}`).trim();
    resolved.set(token, hit);
  }
  return hit;
}

/** `var(--c-x)` as `rgb(var(--c-x) / a)`, for a tint of a token in a style prop. */
export function withAlpha(value: string, alpha: number): string {
  return value.replace(/^var\((--c-[a-z0-9-]+)\)$/, `rgb(var($1) / ${alpha})`);
}

/**
 * A colour for an SVG presentation attribute behind a library callback,
 * where `var()` does not resolve: "var(--c-blue-500)" and
 * "rgb(var(--c-gray-100) / 0.7)" come back as plain rgb(); anything else
 * passes through. Cached per theme.
 */
export function rc(value: string): string {
  if (!value.includes('var(--c-') || typeof document === 'undefined') return value;
  return value
    .replace(/rgb\(var\(--c-([a-z0-9-]+)\)\s*\/\s*([0-9.]+)\)/g, (_m, t, a) => `rgb(${raw(t)} / ${a})`)
    .replace(/var\(--c-([a-z0-9-]+)\)/g, (_m, t) => `rgb(${raw(t)})`);
}

/** A token as a number, for three.js. Cached per theme. */
export function cssColorHex(token: string): number {
  const [r, g, b] = raw(token).split(/\s+/).map(Number);
  return (r << 16) | (g << 8) | b;
}
