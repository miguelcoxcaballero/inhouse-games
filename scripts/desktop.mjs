import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';

const require = createRequire(import.meta.url);
let executable;
try { executable = require('electron'); }
catch {
  // Electron 45 makes installation of its platform binary an explicit step.
  // Its installer verifies the vendor's checksums; never skip that verification.
  const installer = require.resolve('electron/install.js');
  const child = spawn(process.execPath, [installer], { stdio: 'inherit', env: process.env });
  const code = await new Promise(resolve => child.once('exit', resolve));
  if (code !== 0) throw new Error('No se pudo instalar el runtime oficial de Electron.');
  executable = require('electron');
}
const child = spawn(executable, ['.', ...process.argv.slice(2)], { stdio: 'inherit', env: process.env });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.once('exit', code => { process.exitCode = code ?? 1; });
