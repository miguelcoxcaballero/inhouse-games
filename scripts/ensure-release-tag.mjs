import { appendFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { command, githubAnnotation } from './github-command.mjs';

export function tagCommit(output, tag) {
  const refs = new Map(output.trim().split(/\r?\n/).filter(Boolean).map(line => {
    const [sha, ref] = line.split(/\s+/); return [ref, sha];
  }));
  const value = refs.get(`refs/tags/${tag}^{}`) || refs.get(`refs/tags/${tag}`) || null;
  return typeof value === 'string' && /^[a-f0-9]{40}$/.test(value) ? value : null;
}

export function remoteTag(repository, tag) {
  return tagCommit(command('git', ['ls-remote', `https://github.com/${repository}.git`, `refs/tags/${tag}`, `refs/tags/${tag}^{}`]).output, tag);
}

/** Existing tags are immutable; a stale untagged workflow never publishes. */
export function ensureReleaseTag({ repository, sha, version }) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || !/^[a-f0-9]{40}$/.test(sha)
    || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(version)) throw new Error('Invalid release identity.');
  const tag = `v${version}-${sha.slice(0, 7)}`;
  let actual = remoteTag(repository, tag);
  if (!actual) {
    const main = command('git', ['ls-remote', `https://github.com/${repository}.git`, 'refs/heads/main']).output.trim().split(/\s+/)[0];
    if (main !== sha) {
      console.log(`Skipping the stale, untagged build ${sha.slice(0, 7)}; main has advanced.`);
      return { ready: false, tag };
    }
    // Use the normal gh credential helper; no credentials enter URLs or output.
    command('gh', ['auth', 'setup-git', '--hostname', 'github.com']);
    const local = command('git', ['rev-parse', '--verify', `refs/tags/${tag}`], { allowFailure: true });
    if (local.ok && local.output.trim() !== sha) throw new Error('A different local tag already exists.');
    if (!local.ok) command('git', ['tag', tag, sha]);
    const pushed = command('git', ['push', `https://github.com/${repository}.git`, `refs/tags/${tag}`], { allowFailure: true });
    actual = remoteTag(repository, tag);
    if (!pushed.ok && actual !== sha) {
      const current = command('git', ['ls-remote', `https://github.com/${repository}.git`, 'refs/heads/main']).output.trim().split(/\s+/)[0];
      if (current !== sha && !actual) {
        console.log('Main advanced before tag creation; the current workflow will publish instead.');
        return { ready: false, tag };
      }
      githubAnnotation(pushed.error);
      throw new Error('GitHub rejected creation of the immutable release tag.');
    }
  }
  if (actual !== sha) throw new Error(`Tag ${tag} points to a different commit; it will not be changed.`);
  console.log(`Verified immutable release tag ${tag} at ${sha}.`);
  return { ready: true, tag };
}

async function main() {
  const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
  const result = ensureReleaseTag({ repository: process.env.GITHUB_REPOSITORY || '', sha: process.env.GITHUB_SHA || '', version });
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `ready=${result.ready}\ntag=${result.tag}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { githubAnnotation(error.message); process.exitCode = error.exitCode || 1; });
}
