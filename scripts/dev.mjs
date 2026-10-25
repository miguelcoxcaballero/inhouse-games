import { spawn } from 'node:child_process';
import { createSignalingServer } from '../server/index.mjs';

const server = createSignalingServer({ port: 8080, host: '127.0.0.1' });
await server.listen();
const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1'], {
  stdio: 'inherit', env: process.env,
});
let closing = false;
async function stop(code = 0) {
  if (closing) return;
  closing = true;
  vite.kill('SIGTERM');
  await server.close();
  process.exit(code);
}
vite.on('exit', code => { void stop(code ?? 1); });
process.once('SIGINT', () => { void stop(); });
process.once('SIGTERM', () => { void stop(); });
