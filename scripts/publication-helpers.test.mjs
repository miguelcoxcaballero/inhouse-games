import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { tagCommit } from './ensure-release-tag.mjs';
import { manifestIdentity, verifyStaticManifest } from './prepare-website-manifest.mjs';
import { sanitizeGithubError } from './github-command.mjs';

const repository = 'miguelcoxcaballero/inhouse-games';
const content = Buffer.from('actual packaged source bytes');
const checksum = createHash('sha256').update(content).digest('hex');
function partial() {
  return { version: '0.2.0', tag: 'v0.2.0-ffeb9df', publishedAt: '2026-10-25T18:00:00.000Z', downloads: {
    source: { url: 'https://miguelcoxcaballero.github.io/inhouse-games/downloads/Inhouse-Link-Source.zip', sha256: checksum, size: content.length },
  } };
}

test('an annotated tag is bound to its peeled commit rather than its tag object', () => {
  const tag = 'v0.2.0-1234567';
  const refs = `${'a'.repeat(40)}\trefs/tags/${tag}\n${'b'.repeat(40)}\trefs/tags/${tag}^{}\n`;
  assert.equal(tagCommit(refs, tag), 'b'.repeat(40));
  assert.equal(tagCommit(`${'c'.repeat(40)}\trefs/tags/${tag}\n`, tag), 'c'.repeat(40));
  assert.equal(tagCommit('', tag), null);
});

test('a partial catalog accepts only real-shaped static archives on this site or exact repository releases', () => {
  assert.deepEqual(manifestIdentity(partial(), repository), { version: '0.2.0', tag: 'v0.2.0-ffeb9df' });
  const foreign = partial(); foreign.downloads.source.url = 'https://evil.example/source.zip';
  assert.equal(manifestIdentity(foreign, repository), null);
  const executable = partial(); executable.downloads.windows = { ...executable.downloads.source, url: 'https://miguelcoxcaballero.github.io/inhouse-games/downloads/Inhouse-Link-Windows.exe' };
  assert.deepEqual(manifestIdentity(executable, repository), { version: '0.2.0', tag: 'v0.2.0-ffeb9df' });
  executable.downloads.windows.size = 100 * 1024 * 1024 + 1;
  assert.equal(manifestIdentity(executable, repository), null);
  const empty = partial(); empty.downloads = {};
  assert.equal(manifestIdentity(empty, repository), null);
});

test('retaining static downloads verifies their actual bytes and writes matching checksum files', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'inhouse-static-'));
  try {
    const manifest = partial();
    manifest.downloads.windows = { ...manifest.downloads.source, url: 'https://miguelcoxcaballero.github.io/inhouse-games/downloads/Inhouse-Link-Windows.exe' };
    await verifyStaticManifest(manifest, repository, { readAsset: async name => {
      assert.ok(['Inhouse-Link-Source.zip', 'Inhouse-Link-Windows.exe'].includes(name)); return content;
    }, outputDirectory: directory });
    assert.deepEqual(await readFile(path.join(directory, 'Inhouse-Link-Source.zip')), content);
    assert.equal(await readFile(path.join(directory, 'Inhouse-Link-Source.zip.sha256'), 'utf8'), `${checksum}  Inhouse-Link-Source.zip\n`);
    assert.deepEqual(await readFile(path.join(directory, 'Inhouse-Link-Windows.exe')), content);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a corrupted published archive cannot create a retained download or checksum', async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'inhouse-corrupt-static-'));
  const directory = path.join(parent, 'downloads');
  try {
    await assert.rejects(verifyStaticManifest(partial(), repository, { readAsset: async () => Buffer.from('corrupted'), outputDirectory: directory }), /does not match/);
    await assert.rejects(stat(directory), { code: 'ENOENT' });
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test('GitHub error annotations redact provided credentials, standard tokens and authorization headers', () => {
  const message = sanitizeGithubError('provided-secret\nAuthorization: Bearer hidden\nghp_abcdefghijklm', { GH_TOKEN: 'provided-secret' });
  assert.equal(message.includes('provided-secret'), false);
  assert.equal(message.includes('hidden'), false);
  assert.equal(message.includes('ghp_'), false);
});
