/** @type {import('tailwindcss').Config} */
// Every colour resolves through a token in src/theme.css, so one attribute
// on <html> switches the theme. The scale names are kept because the app
// uses them by role (50 soft, 200 border, 600 solid, 800 text); the values
// behind them are designed per theme. See DESIGN_GUIDANCE.md §17.
const token = (name) => `rgb(var(--c-${name}) / <alpha-value>)`;
const scale = (hue) => Object.fromEntries([50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950].map((s) => [s, token(`${hue}-${s}`)]));

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
      white: token('white'),
      gray: scale('gray'),
      red: scale('red'),
      amber: scale('amber'),
      yellow: scale('yellow'),
      orange: scale('orange'),
      green: scale('green'),
      emerald: scale('emerald'),
      blue: scale('blue'),
      sky: scale('sky'),
      indigo: scale('indigo'),
      violet: scale('violet'),
      purple: scale('purple'),
      pink: scale('pink'),
      rose: scale('rose'),
      teal: scale('teal'),
      cyan: scale('cyan'),
      strong: token('strong'),
      'strong-hover': token('strong-hover'),
      'on-strong': token('on-strong'),
      chrome: token('chrome'),
      'chrome-hover': token('chrome-hover'),
      'chrome-fg': token('chrome-fg'),
      'chrome-muted': token('chrome-muted'),
    },
    extend: {
      animation: {
        'pulse-glow': 'pulse-glow 1.5s ease-in-out infinite',
      },
      keyframes: {
        'pulse-glow': {
          '0%, 100%': {
            boxShadow: '0 0 8px 2px rgb(var(--c-blue-500) / 0.4)',
          },
          '50%': {
            boxShadow: '0 0 16px 4px rgb(var(--c-blue-500) / 0.8)',
          },
        },
      },
    },
  },
  plugins: [],
}
