/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      animation: {
        'pulse-glow': 'pulse-glow 1.5s ease-in-out infinite',
      },
      keyframes: {
        'pulse-glow': {
          '0%, 100%': {
            boxShadow: '0 0 8px 2px rgba(59, 130, 246, 0.4)',
          },
          '50%': {
            boxShadow: '0 0 16px 4px rgba(59, 130, 246, 0.8)',
          },
        },
      },
    },
  },
  plugins: [],
}
