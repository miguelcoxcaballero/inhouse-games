import { mkdtemp, readFile, writeFile, appendFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ensureReleaseTag, remoteTag } from './ensure-release-tag.mjs';
import { command, githubAnnotation } from './github-command.mjs';
import { createReleaseManifest, RELEASE_ASSETS } from './release-manifest.mjs';

async function main() {
  const repository = process.env.GITHUB_REPOSITORY || '';
  const sha = process.env.GITHUB_SHA || '';
  const version = JSON.parse(await readFile('package.json', 'utf8')).version;
  const { ready, tag } = ensureReleaseTag({ repository, sha, version });
  if (!ready) {
    if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, 'published=false\n');
    return;
  }
  const directory = await mkdtemp(path.join(os.tmpdir(), 'inhouse-release-verified-'));
  try {
    const existing = command('gh', ['release', 'view', tag, '--repo', repository, '--json', 'isDraft'], { allowFailure: true });
    let created = false;
    if (existing.ok) {
      if (JSON.parse(existing.output).isDraft) throw new Error('An incomplete draft release exists; it will not be overwritten.');
      console.log('Reusing the original release without replacing its assets.');
    } else {
      if (!/404|not found|no release/i.test(existing.error)) throw new Error(`Release lookup failed: ${existing.error}`);
      const notes = path.join(directory, 'release-notes.md');
      await writeFile(notes, 'Google login and shared downloads.\n');
      const assets = Object.values(RELEASE_ASSETS).flatMap(name => [`artifacts/${name}`, `artifacts/${name}.sha256`]);
      command('gh', ['release', 'create', tag, ...assets, '--repo', repository, '--verify-tag',
        '--title', `inhouse link ${version}`, '--notes-file', notes, '--prerelease', '--latest=false']);
      created = true;
    }
    command('gh', ['release', 'download', tag, '--repo', repository, '--pattern', 'Inhouse-Link-Windows.exe*',
      '--pattern', 'Inhouse-Link-Web.zip*', '--pattern', 'Inhouse-Link-Source.zip*', '--dir', directory]);
    const metadata = JSON.parse(command('gh', ['release', 'view', tag, '--repo', repository, '--json', 'publishedAt,isDraft,assets']).output);
    if (metadata.isDraft || remoteTag(repository, tag) !== sha) throw new Error('The public release is not bound to this immutable commit tag.');
    const manifest = await createReleaseManifest({ version, tag, publishedAt: metadata.publishedAt, repository,
      assetsDirectory: directory, expectedDirectory: created ? 'artifacts' : undefined });
    const contents = JSON.stringify(manifest, null, 2) + '\n';
    await writeFile('public/release.json', contents);
    if (metadata.assets.some(asset => asset.name === 'release.json')) {
      const old = path.join(directory, 'old-manifest');
      command('gh', ['release', 'download', tag, '--repo', repository, '--pattern', 'release.json', '--dir', old]);
      if (await readFile(path.join(old, 'release.json'), 'utf8') !== contents) throw new Error('A different immutable release manifest already exists.');
    } else command('gh', ['release', 'upload', tag, 'public/release.json', '--repo', repository]);
    if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `published=true\ntag=${tag}\n`);
    console.log(`Public release ${tag}, its exact downloaded assets and its manifest have been verified.`);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

main().catch(error => { githubAnnotation(error.message); process.exitCode = error.exitCode || 1; });
