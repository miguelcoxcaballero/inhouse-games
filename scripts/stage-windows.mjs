import { createReadStream } from 'node:fs';
import { copyFile, mkdir, open, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const filename = 'Inhouse-Link-Windows.exe';
const source = path.resolve('artifacts', filename);
const handle = await open(source, 'r');
const header = Buffer.alloc(64);
await handle.read(header, 0, 64, 0);
if (header.toString('ascii', 0, 2) !== 'MZ') throw new Error('El artefacto no es un ejecutable Windows.');
const pe = Buffer.alloc(6);
await handle.read(pe, 0, 6, header.readUInt32LE(60));
await handle.close();
if (pe.toString('ascii', 0, 4) !== 'PE\0\0') throw new Error('Cabecera PE inválida.');
const hash = createHash('sha256');
for await (const chunk of createReadStream(source)) hash.update(chunk);
const checksum = `${hash.digest('hex')}  ${filename}\n`;
await writeFile(path.resolve('artifacts', `${filename}.sha256`), checksum);
for (const directory of ['public/downloads', 'dist/downloads']) {
  await mkdir(directory, { recursive: true });
  await copyFile(source, path.join(directory, filename));
  await writeFile(path.join(directory, `${filename}.sha256`), checksum);
}
console.log(`Ejecutable Windows preparado en artifacts/${filename}; descarga web disponible.`);
