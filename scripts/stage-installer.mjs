import { createReadStream } from 'node:fs';
import { mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { getPath7za } from '../node_modules/app-builder-lib/out/toolsets/7zip.js';

const { version } = JSON.parse(await readFile('package.json', 'utf8'));
const filename = `Inhouse-Link-Setup-${version}.exe`;
const source = path.resolve('artifacts', filename);
const handle = await open(source, 'r');
const header = Buffer.alloc(64);
await handle.read(header, 0, header.length, 0);
if (header.toString('ascii', 0, 2) !== 'MZ') throw new Error('El instalador no es un ejecutable Windows.');
const pe = Buffer.alloc(6);
await handle.read(pe, 0, pe.length, header.readUInt32LE(60));
await handle.close();
if (pe.toString('ascii', 0, 4) !== 'PE\0\0') throw new Error('Cabecera PE del instalador inválida.');

// The NSIS installer stub is PE32; its embedded application must be x64.
const application = await open(path.resolve('artifacts/win-unpacked/InhouseLink.exe'), 'r');
const appHeader = Buffer.alloc(64);
await application.read(appHeader, 0, appHeader.length, 0);
const appPe = Buffer.alloc(6);
await application.read(appPe, 0, appPe.length, appHeader.readUInt32LE(60));
await application.close();
if (appHeader.toString('ascii', 0, 2) !== 'MZ' || appPe.toString('ascii', 0, 4) !== 'PE\0\0' || appPe.readUInt16LE(4) !== 0x8664) {
  throw new Error('La aplicación incluida en el instalador no es Windows x64.');
}

const hash = createHash('sha256');
const nsisSignature = Buffer.from('efbeadde4e756c6c736f6674496e7374', 'hex');
let nsisFound = false;
let tail = Buffer.alloc(0);
for await (const chunk of createReadStream(source)) {
  hash.update(chunk);
  const bytes = Buffer.concat([tail, chunk]);
  if (bytes.includes(nsisSignature)) nsisFound = true;
  tail = bytes.subarray(-nsisSignature.length + 1);
}
if (!nsisFound) throw new Error('El archivo no contiene la firma de un instalador NSIS.');
const sevenZip = await getPath7za();
const run = promisify(execFile);
const { stdout: listing } = await run(sevenZip, ['l', '-slt', source], { encoding: 'utf8' });
const entries = listing.split(/\r?\n/)
  .filter(line => line.startsWith('Path = '))
  .map(line => line.slice(7).replaceAll('\\', '/'));
const archivePath = entries.find(value => /^\$PLUGINSDIR\/app-64\.7z$/.test(value));
if (!archivePath) throw new Error('El instalador está incompleto: falta el paquete de la aplicación x64.');
const uninstallerPath = entries.find(value => /^\$R0\/Uninstall [^/]+\.exe$/.test(value));
if (!uninstallerPath) throw new Error('El instalador está incompleto: falta el desinstalador de Windows.');
await run(sevenZip, ['t', source]);

const temporary = await mkdtemp(path.join(os.tmpdir(), 'inhouse-installer-check-'));
try {
  await run(sevenZip, ['x', '-y', `-o${temporary}`, source, archivePath, uninstallerPath]);
  const uninstall = await readFile(path.join(temporary, ...uninstallerPath.split('/')));
  if (uninstall.length < 64 || uninstall.toString('ascii', 0, 2) !== 'MZ' ||
      uninstall.toString('ascii', uninstall.readUInt32LE(60), uninstall.readUInt32LE(60) + 4) !== 'PE\0\0' ||
      !uninstall.includes(nsisSignature)) {
    throw new Error('El desinstalador incluido no es un ejecutable NSIS válido.');
  }
  const archive = path.join(temporary, ...archivePath.split('/'));
  await run(sevenZip, ['t', archive]);
  for (const filename of [
    'InhouseLink.exe',
    'resources/app.asar',
    'resources/app.asar.unpacked/desktop/native/input.ps1',
  ]) {
    const expectedHash = createHash('sha256');
    for await (const chunk of createReadStream(path.join('artifacts/win-unpacked', filename))) expectedHash.update(chunk);
    const embeddedHash = createHash('sha256');
    const child = spawn(sevenZip, ['x', '-so', archive, filename], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', bytes => { stderr = (stderr + bytes.toString()).slice(-4096); });
    const finished = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', code => code === 0 ? resolve() : reject(new Error(`No se pudo verificar el contenido del instalador: ${stderr}`)));
    });
    for await (const chunk of child.stdout) embeddedHash.update(chunk);
    await finished;
    if (embeddedHash.digest('hex') !== expectedHash.digest('hex')) throw new Error(`El instalador no contiene la aplicación compilada: ${filename}.`);
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}
await writeFile(`${source}.sha256`, `${hash.digest('hex')}  ${filename}\n`);
console.log(`Instalador NSIS con aplicación x64 preparado en artifacts/${filename}; paquete, contenido y SHA-256 verificados.`);
