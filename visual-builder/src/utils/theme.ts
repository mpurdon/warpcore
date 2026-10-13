// The theme: one attribute on <html>, read by every token in theme.css.
// "system" follows the OS and changes with it; light and dark are fixed.
// Components that paint outside CSS (the minimap, the 3D view) read the
// resolved tokens with cssColor() and re-read when the theme changes.

import { useEffect, useState } from 'react';
import type { Appearance } from './preferences';

export type Theme = 'light' | 'dark';

const media = () => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null);

/** What an appearance preference means right now. */
export function resolveTheme(appearance: Appearance, systemDark = Boolean(media()?.matches)): Theme {
  if (appearance === 'system') return systemDark ? 'dark' : 'light';
  return appearance;
}

export function currentTheme(): Theme {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

let stop: (() => void) | null = null;

/** Apply the preference to the document and keep following the system while it says so. */
export function applyAppearance(appearance: Appearance): void {
  stop?.();
  stop = null;
  const set = () => { document.documentElement.dataset.theme = resolveTheme(appearance); };
  set();
  if (appearance === 'system') {
    const m = media();
    if (m) {
      m.addEventListener('change', set);
      stop = () => m.removeEventListener('change', set);
    }
  }
}

const resolved = new Map<string, string>();
let watching = false;
function watchTheme(): void {
  if (watching || typeof document === 'undefined') return;
  watching = true;
  new MutationObserver(() => resolved.clear()).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
}

/**
 * A colour for an SVG presentation attribute or an icon prop, where `var()`
 * does not resolve: "var(--c-blue-500)" and "rgb(var(--c-gray-100) / 0.7)"
 * come back as plain rgb(); anything else passes through. Cached per theme.
 */
export function rc(value: string): string {
  if (!value.includes('var(--c-')) return value;
  if (typeof document === 'undefined') return value;
  watchTheme();
  const hit = resolved.get(value);
  if (hit) return hit;
  const out = value.replace(/rgb\(var\(--c-([a-z0-9-]+)\)\s*\/\s*([0-9.]+)\)/g, (_m, t, a) => cssColor(t, Number(a)))
    .replace(/var\(--c-([a-z0-9-]+)\)/g, (_m, t) => cssColor(t));
  resolved.set(value, out);
  return out;
}

/** A token's resolved colour, e.g. cssColor('blue-600') → "rgb(37 99 235)". For canvases and WebGL. */
export function cssColor(token: string, alpha?: number): string {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(`--c-${token}`).trim();
  return alpha === undefined ? `rgb(${raw})` : `rgb(${raw} / ${alpha})`;
}

/** The same colour as a number, for three.js. */
export function cssColorHex(token: string): number {
  const [r, g, b] = getComputedStyle(document.documentElement).getPropertyValue(`--c-${token}`).trim().split(/\s+/).map(Number);
  return (r << 16) | (g << 8) | b;
}

/** Bumps when the theme attribute changes, so a canvas can repaint. */
export function useThemeVersion(): number {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const observer = new MutationObserver(() => setVersion((v) => v + 1));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);
  return version;
}

/** The theme in effect, for components that branch on it. */
export function useTheme(): Theme {
  const version = useThemeVersion();
  void version;
  return typeof document === 'undefined' ? 'light' : currentTheme();
}
