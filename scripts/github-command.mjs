import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function sanitizeGithubError(value, env = process.env) {
  let text = String(value ?? '').replace(/\u001b\[[0-9;]*m/g, '');
  for (const key of ['GH_TOKEN', 'GITHUB_TOKEN']) {
    if (env[key]) text = text.split(env[key]).join('[redacted]');
  }
  return text.replace(/github_pat_[A-Za-z0-9_]+|gh[pousr]_[A-Za-z0-9_]{10,}/g, '[redacted]')
    .replace(/authorization\s*[:=][^\r\n]*/gi, 'Authorization: [redacted]')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, 4000);
}

export function githubAnnotation(message, level = 'error') {
  const safe = sanitizeGithubError(message).replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
  console.error(`::${level} title=GitHub publication::${safe || 'The GitHub operation failed.'}`);
}

export function command(program, args, { allowFailure = false } = {}) {
  const result = spawnSync(program, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, env: process.env });
  if (result.error || result.status !== 0) {
    const detail = sanitizeGithubError(result.error?.message || result.stderr || `${program} exited ${result.status}`);
    if (allowFailure) return { ok: false, output: result.stdout || '', error: detail, status: result.status ?? 1 };
    githubAnnotation(`${program} ${args.slice(0, 2).join(' ')} failed: ${detail}`);
    const error = new Error(detail || `${program} failed.`);
    error.exitCode = result.status || 1;
    throw error;
  }
  return { ok: true, output: result.stdout || '', error: '', status: 0 };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  githubAnnotation(readFileSync(process.argv[2], 'utf8'));
}
