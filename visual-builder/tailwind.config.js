/** @type {import('tailwindcss').Config} */
// Every colour resolves through a token in src/theme.css, so one attribute
// on <html> switches the theme. The scale names are kept because the app
// uses them by role (50 soft, 200 border, 600 solid, 800 text); the values
// behind them are designed per theme. See DESIGN_GUIDANCE.md §17.
import { HUES, ROLE_TOKENS, STEPS } from './scripts/theme-palette.mjs';

const token = (name) => `rgb(var(--c-${name}) / <alpha-value>)`;
const scale = (hue) => Object.fromEntries(STEPS.map((s) => [s, token(`${hue}-${s}`)]));

export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    colors: {
      transparent: 'transparent',
      current: 'currentColor',
      black: '#000000',
      ...Object.fromEntries(ROLE_TOKENS.map((t) => [t, token(t)])),
      gray: scale('gray'),
      ...Object.fromEntries(HUES.map((h) => [h, scale(h)])),
    },
    extend: {
      animation: {
        'pulse-glow': 'pulse-glow 1.5s ease-in-out infinite',
      },
      keyframes: {
        'pulse-glow': {
          '0%, 100%': { boxShadow: '0 0 8px 2px rgb(var(--c-blue-500) / 0.4)' },
          '50%': { boxShadow: '0 0 16px 4px rgb(var(--c-blue-500) / 0.8)' },
        },
      },
    },
  },
  plugins: [],
}
