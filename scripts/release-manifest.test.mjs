import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createReleaseManifest, RELEASE_ASSETS } from './release-manifest.mjs';

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'inhouse-release-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const name of Object.values(RELEASE_ASSETS)) {
    const content = Buffer.from(`Verified test artifact: ${name}\n`);
    await writeFile(path.join(directory, name), content);
    await writeFile(path.join(directory, `${name}.sha256`), `${createHash('sha256').update(content).digest('hex')}  ${name}\n`);
  }
  return {
    version: '0.2.0', tag: 'v0.2.0-1234abc', publishedAt: '2026-10-25T17:00:00Z',
    repository: 'miguelcoxcaballero/inhouse-games', assetsDirectory: directory,
  };
}

test('release manifest describes only exact versioned artifacts with verified hashes and actual sizes', async t => {
  const options = await fixture(t);
  const result = await createReleaseManifest({ ...options, expectedDirectory: options.assetsDirectory });
  assert.equal(result.version, options.version);
  assert.equal(result.publishedAt, '2026-10-25T17:00:00.000Z');
  for (const [key, filename] of Object.entries(RELEASE_ASSETS)) {
    assert.equal(result.downloads[key].url, `https://github.com/${options.repository}/releases/download/${options.tag}/${filename}`);
    assert.equal(result.downloads[key].size, (await readFile(path.join(options.assetsDirectory, filename))).length);
    assert.match(result.downloads[key].sha256, /^[a-f0-9]{64}$/);
  }
});

test('corrupted or renamed release files cannot produce a manifest', async t => {
  const options = await fixture(t);
  await writeFile(path.join(options.assetsDirectory, RELEASE_ASSETS.windows), 'Changed after publication');
  await assert.rejects(createReleaseManifest(options), /checksum verification failed/);
});

test('a downloaded asset must also match the artifact built by this run', async t => {
  const options = await fixture(t);
  const expected = await fixture(t);
  await writeFile(path.join(expected.assetsDirectory, RELEASE_ASSETS.web), 'Different build');
  await assert.rejects(createReleaseManifest({ ...options, expectedDirectory: expected.assetsDirectory }), /differs from the built artifact/);
});

test('release metadata cannot inject a different repository, path or missing publication time', async t => {
  const options = await fixture(t);
  await assert.rejects(createReleaseManifest({ ...options, repository: 'owner/repo/../../other' }), /Invalid GitHub repository/);
  await assert.rejects(createReleaseManifest({ ...options, tag: 'v0.2.0-../../latest' }), /Invalid versioned release tag/);
  await assert.rejects(createReleaseManifest({ ...options, publishedAt: '' }), /publication time/);
});
