import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { command, githubAnnotation } from './github-command.mjs';
import { createReleaseManifest } from './release-manifest.mjs';
import { remoteTag } from './ensure-release-tag.mjs';

export function manifestIdentity(value, repository) {
  if (!value || typeof value !== 'object' || typeof value.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(value.version)
    || typeof value.tag !== 'string' || !value.tag.startsWith(`v${value.version}-`) || !/^[A-Za-z0-9.-]+-[a-f0-9]{7}$/.test(value.tag)
    || typeof value.publishedAt !== 'string' || !Number.isFinite(Date.parse(value.publishedAt))
    || !value.downloads || typeof value.downloads !== 'object' || Array.isArray(value.downloads)
    || Object.keys(value.downloads).some(kind => !['windows', 'web', 'source'].includes(kind))) return null;
  const names = { windows: 'Inhouse-Link-Windows.exe', web: 'Inhouse-Link-Web.zip', source: 'Inhouse-Link-Source.zip' };
  let count = 0;
  for (const [kind, name] of Object.entries(names)) {
    const item = value.downloads?.[kind];
    if (!item) continue;
    const releaseUrl = `https://github.com/${repository}/releases/download/${encodeURIComponent(value.tag)}/${name}`;
    const [owner, repo] = repository.split('/');
    const staticUrl = `https://${owner.toLowerCase()}.github.io/${repo}/downloads/${name}`;
    if ((item.url !== releaseUrl && item.url !== staticUrl)
      || (item.url === staticUrl && item.size > 100 * 1024 * 1024)
      || !/^[a-f0-9]{64}$/.test(item.sha256) || !Number.isSafeInteger(item.size) || item.size <= 0) return null;
    count++;
  }
  return count ? { version: value.version, tag: value.tag } : null;
}

export async function verifyStaticManifest(manifest, repository, { readAsset, outputDirectory = 'public/downloads' }) {
  if (!manifestIdentity(manifest, repository)) throw new Error('Invalid static download manifest.');
  const [owner, repo] = repository.split('/');
  const records = [];
  for (const [kind, item] of Object.entries(manifest.downloads)) {
    const name = { windows: 'Inhouse-Link-Windows.exe', web: 'Inhouse-Link-Web.zip', source: 'Inhouse-Link-Source.zip' }[kind];
    if (!name || item.url !== `https://${owner.toLowerCase()}.github.io/${repo}/downloads/${name}`) throw new Error('Not a static archive manifest.');
    const bytes = await readAsset(name);
    if (!Buffer.isBuffer(bytes) || bytes.length !== item.size || createHash('sha256').update(bytes).digest('hex') !== item.sha256) {
      throw new Error(`The published static archive does not match its manifest: ${name}`);
    }
    records.push({ name, bytes, sha256: item.sha256 });
  }
  await mkdir(outputDirectory, { recursive: true });
  for (const { name, bytes, sha256 } of records) {
    await writeFile(path.join(outputDirectory, name), bytes);
    await writeFile(path.join(outputDirectory, `${name}.sha256`), `${sha256}  ${name}\n`);
  }
  return manifest;
}

/** A website deployment never fabricates or requires an unreleased download. */
async function main() {
  const repository = process.env.GITHUB_REPOSITORY || '';
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error('Invalid repository.');
  const version = JSON.parse(await readFile('package.json', 'utf8')).version;
  const sha = command('git', ['rev-parse', 'HEAD']).output.trim();
  const candidates = [`v${version}-${sha.slice(0, 7)}`];
  let staticManifest = null;
  const branch = command('gh', ['api', `repos/${repository}/git/ref/heads/gh-pages`, '--jq', '.object.sha'], { allowFailure: true });
  const siteRef = branch.ok && /^[a-f0-9]{40}$/.test(branch.output.trim()) ? branch.output.trim() : 'gh-pages';
  const previous = command('gh', ['api', `repos/${repository}/contents/release.json?ref=${siteRef}`, '--jq', '.content'], { allowFailure: true });
  if (previous.ok) {
    try {
      const existing = JSON.parse(Buffer.from(previous.output.replace(/\s+/g, ''), 'base64').toString('utf8'));
      const identity = manifestIdentity(existing, repository);
      if (identity) {
        candidates.push(identity.tag);
        const [owner, repo] = repository.split('/');
        if (Object.values(existing.downloads).every(item => item.url.startsWith(`https://${owner.toLowerCase()}.github.io/${repo}/downloads/`))) {
          try {
            const commit = remoteTag(repository, identity.tag);
            if (!commit || !commit.startsWith(identity.tag.slice(-7))) throw new Error('The existing static download catalog has no matching source tag.');
            staticManifest = await verifyStaticManifest(existing, repository, { readAsset: async name => {
              if (!/^[a-f0-9]{40}$/.test(siteRef)) throw new Error('A commit-pinned website is required.');
              const file = await fetch(`https://raw.githubusercontent.com/${repository}/${siteRef}/downloads/${name}`, { signal: AbortSignal.timeout(120000) });
              if (!file.ok) throw new Error(`The published download returned HTTP ${file.status}.`);
              const size = Number(file.headers.get('content-length'));
              if (size > 100 * 1024 * 1024) throw new Error('The published download exceeds the static file limit.');
              return Buffer.from(await file.arrayBuffer());
            } });
          } catch (error) { githubAnnotation(error.message, 'warning'); }
        }
      }
    } catch { githubAnnotation('The existing website manifest was invalid and will not be reused.', 'warning'); }
  }
  const recent = command('gh', ['release', 'list', '--repo', repository, '--limit', '10', '--json', 'tagName,isDraft'], { allowFailure: true });
  if (recent.ok) {
    try { for (const release of JSON.parse(recent.output)) if (!release.isDraft) candidates.push(release.tagName); }
    catch { /* A missing catalog must not block the public website. */ }
  }
  await rm('public/release.json', { force: true });
  for (const tag of [...new Set(candidates)]) {
    const matched = /^v(\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?)-([a-f0-9]{7})$/.exec(tag);
    if (!matched) continue;
    const view = command('gh', ['release', 'view', tag, '--repo', repository, '--json', 'isDraft,publishedAt'], { allowFailure: true });
    if (!view.ok) continue;
    const metadata = JSON.parse(view.output);
    if (metadata.isDraft || !Number.isFinite(Date.parse(metadata.publishedAt))) continue;
    const commit = remoteTag(repository, tag);
    if (!commit || !commit.startsWith(matched[2])) continue;
    const directory = await mkdtemp(path.join(os.tmpdir(), 'inhouse-public-downloads-'));
    try {
      const downloaded = command('gh', ['release', 'download', tag, '--repo', repository,
        '--pattern', 'Inhouse-Link-Windows.exe*', '--pattern', 'Inhouse-Link-Web.zip*',
        '--pattern', 'Inhouse-Link-Source.zip*', '--dir', directory], { allowFailure: true });
      if (!downloaded.ok) continue;
      const manifest = await createReleaseManifest({ version: matched[1], tag, publishedAt: metadata.publishedAt,
        repository, assetsDirectory: directory });
      await writeFile('public/release.json', JSON.stringify(manifest, null, 2) + '\n');
      console.log(`The website will offer the verified public release ${tag}.`);
      return;
    } catch (error) { githubAnnotation(`Release ${tag} cannot be offered: ${error.message}`, 'warning'); }
    finally { await rm(directory, { recursive: true, force: true }); }
  }
  if (staticManifest) {
    await writeFile('public/release.json', JSON.stringify(staticManifest, null, 2) + '\n');
    console.log('Preserved the existing static downloads after checking their actual bytes and SHA-256.');
    return;
  }
  githubAnnotation('No verified public download release exists yet. Product, Google login and web client will still be deployed; download links will appear after a successful release.', 'warning');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { githubAnnotation(error.message); process.exitCode = 1; });
}
