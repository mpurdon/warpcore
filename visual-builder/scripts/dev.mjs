// `npm run tauri:dev`: a dev server on a port nobody else is using.
//
// Tauri's devUrl and Vite's port have to agree, and both used to be 1430,
// so a second Tauri app on this machine (or a second warpcore) fought over
// it and one of them loaded nothing. Here the port is chosen free at
// launch, handed to Vite through the environment and to Tauri through
// `--config`, which merges over tauri.conf.json for this run only.
//
// A port can be pinned with `npm run tauri:dev -- --port 1430`, or
// WARPCORE_DEV_PORT, when something outside this process has to know it.

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';

/** A port the OS says is free right now. */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.unref();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

const args = process.argv.slice(2);
const flag = args.indexOf('--port');
const asked = flag >= 0 ? Number(args[flag + 1]) : Number(process.env.WARPCORE_DEV_PORT);
const rest = flag >= 0 ? [...args.slice(0, flag), ...args.slice(flag + 2)] : args;
const port = Number.isInteger(asked) && asked > 0 ? asked : await freePort();

console.log(`warpcore dev server on http://localhost:${port}`);

const child = spawn(
  'npx',
  ['tauri', 'dev', '--config', JSON.stringify({ build: { devUrl: `http://localhost:${port}` } }), ...rest],
  { stdio: 'inherit', env: { ...process.env, WARPCORE_DEV_PORT: String(port) } },
);
child.on('exit', (code, signal) => process.exit(signal ? 1 : code ?? 0));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
