import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const RELEASE_ASSETS = Object.freeze({
  windows: 'Inhouse-Link-Windows.exe',
  web: 'Inhouse-Link-Web.zip',
  source: 'Inhouse-Link-Source.zip',
});

async function digest(filename) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

/** Only generate a download manifest from the exact, verified release files. */
export async function createReleaseManifest({ version, tag, publishedAt, repository, assetsDirectory, expectedDirectory }) {
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(version)) throw new Error('Invalid app version.');
  if (typeof tag !== 'string' || !tag.startsWith(`v${version}-`) || !/^[A-Za-z0-9.-]+$/.test(tag) || !/[a-f0-9]{7,40}$/.test(tag)) throw new Error('Invalid versioned release tag.');
  if (typeof repository !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error('Invalid GitHub repository.');
  if (typeof publishedAt !== 'string' || !Number.isFinite(Date.parse(publishedAt))) throw new Error('A real release publication time is required.');
  const downloads = {};
  for (const [key, name] of Object.entries(RELEASE_ASSETS)) {
    const filename = path.join(assetsDirectory, name);
    const info = await stat(filename);
    if (!info.isFile() || info.size === 0) throw new Error(`Missing or empty release asset: ${name}`);
    const checksum = (await readFile(`${filename}.sha256`, 'utf8')).trim();
    const match = /^([a-fA-F0-9]{64})\s+\*?([^\r\n]+)$/.exec(checksum);
    if (!match || match[2].trim() !== name) throw new Error(`Invalid checksum record: ${name}`);
    const actual = await digest(filename);
    if (actual !== match[1].toLowerCase()) throw new Error(`Release checksum verification failed: ${name}`);
    if (expectedDirectory && actual !== await digest(path.join(expectedDirectory, name))) throw new Error(`Downloaded release differs from the built artifact: ${name}`);
    downloads[key] = {
      url: `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${name}`,
      sha256: actual,
      size: info.size,
    };
  }
  return { version, tag, publishedAt: new Date(publishedAt).toISOString(), downloads };
}

async function main() {
  const flags = new Map();
  const allowed = new Set(['--version', '--tag', '--published-at', '--repository', '--assets-directory', '--expected-directory', '--output']);
  for (let index = 2; index < process.argv.length; index += 2) {
    const flag = process.argv[index];
    const value = process.argv[index + 1];
    if (!allowed.has(flag) || !value || value.startsWith('--')) throw new Error('Invalid release manifest arguments.');
    flags.set(flag, value);
  }
  const manifest = await createReleaseManifest({
    version: flags.get('--version'), tag: flags.get('--tag'), publishedAt: flags.get('--published-at'),
    repository: flags.get('--repository'), assetsDirectory: flags.get('--assets-directory') ?? 'artifacts',
    expectedDirectory: flags.get('--expected-directory'),
  });
  const destination = path.resolve(flags.get('--output') ?? 'public/release.json');
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(manifest, null, 2) + '\n');
  await rename(temporary, destination);
  console.log(`Verified download manifest written for ${manifest.tag}.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
