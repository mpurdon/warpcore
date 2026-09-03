import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Tauri v2 renamed the variables the CLI injects into the frontend build:
// TAURI_PLATFORM -> TAURI_ENV_PLATFORM, TAURI_DEBUG -> TAURI_ENV_DEBUG.
// Reading the v1 names here silently produced a minified, sourcemap-less
// bundle for `tauri dev`, because the old names are simply never set.
const platform = process.env.TAURI_ENV_PLATFORM;
const isDebug = !!process.env.TAURI_ENV_DEBUG;

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1430,
    // Tauri's devUrl points at this exact port; failing loudly beats Vite
    // quietly moving to 1421 and the app window loading nothing.
    strictPort: true,
  },
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  build: {
    // The app renders in the OS webview, not Chrome: WebView2 on Windows,
    // WKWebView elsewhere.
    target: platform === 'windows' ? 'chrome105' : 'safari13',
    minify: isDebug ? false : 'esbuild',
    sourcemap: isDebug,
  },
});
