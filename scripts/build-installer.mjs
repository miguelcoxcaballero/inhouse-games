import path from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { build, Platform, Arch } from 'electron-builder';
import { WineVmManager } from '../node_modules/app-builder-lib/out/vm/WineVm.js';
import { UninstallerReader } from '../node_modules/app-builder-lib/out/targets/nsis/nsisUtil.js';

const { version } = JSON.parse(await readFile('package.json', 'utf8'));
const installer = path.resolve('artifacts', `Inhouse-Link-Setup-${version}.exe`);
const executeWine = WineVmManager.prototype.exec;

if (process.platform === 'linux') {
  // electron-builder 26.18 already ships this parser for macOS builds. Use the
  // same parser for the generated intermediate NSIS uninstaller on Linux; no
  // Windows program or graphical Wine session needs to run during packaging.
  WineVmManager.prototype.exec = async function (file, args, ...options) {
    if (path.resolve(file) !== installer) return executeWine.call(this, file, args, ...options);
    if (args.length !== 0 || (await stat(file)).size > 2 * 1024 * 1024) {
      throw new Error('Solo se puede extraer el desinstalador NSIS intermedio generado por esta compilación.');
    }
    const output = path.join(path.dirname(file), `${path.basename(file, 'exe')}__uninstaller.exe`);
    await UninstallerReader.exec(file, output);
    console.log('Desinstalador generado por NSIS extraído mediante el parser oficial de electron-builder.');
  };
}

try {
  await build({ targets: Platform.WINDOWS.createTarget(['nsis'], Arch.x64), publish: 'never' });
} finally {
  WineVmManager.prototype.exec = executeWine;
}
