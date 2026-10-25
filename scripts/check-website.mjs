import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { githubAnnotation } from './github-command.mjs';

const site = new URL(process.env.PUBLIC_SITE_URL || 'https://miguelcoxcaballero.github.io/inhouse-games/');
if (site.protocol !== 'https:' || site.username || site.password || site.search || site.hash) throw new Error('Invalid public website.');
if (!site.pathname.endsWith('/')) site.pathname += '/';
let expected = null;
try { expected = JSON.parse(await readFile('public/release.json', 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
let last = '';
for (let attempt = 0; attempt < 18; attempt++) {
  try {
    const response = await fetch(new URL(`?verify=${Date.now()}`, site), { cache: 'no-store', signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`Website HTTP ${response.status}.`);
    const html = await response.text();
    if (!/inhouse/i.test(html)) throw new Error('The public entry point is not the application.');
    for (const match of html.matchAll(/(?:src|href)="([^"\s]+\.(?:js|css)(?:\?[^"\s]*)?)"/g)) {
      const asset = new URL(match[1], site);
      if (asset.origin !== site.origin || !asset.pathname.startsWith(site.pathname)) throw new Error('A built asset escapes the website base path.');
      if (!(await fetch(asset, { signal: AbortSignal.timeout(10000) })).ok) throw new Error('A built website asset is missing.');
    }
    if (expected) {
      const response = await fetch(new URL(`release.json?verify=${Date.now()}`, site), { cache: 'no-store', signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error(`Public download manifest HTTP ${response.status}.`);
      const actual = await response.json();
      if (actual.version !== expected.version || actual.tag !== expected.tag || actual.publishedAt !== expected.publishedAt) throw new Error('The public site still serves another download catalog.');
      for (const [kind, item] of Object.entries(expected.downloads)) {
        if (['url', 'sha256', 'size'].some(key => actual.downloads?.[kind]?.[key] !== item[key])) throw new Error(`The public ${kind} download changed.`);
        const url = new URL(item.url);
        if (url.origin === site.origin) {
          const file = await fetch(url, { signal: AbortSignal.timeout(20000) });
          if (!file.ok) throw new Error(`The public ${kind} archive returned ${file.status}.`);
          const bytes = Buffer.from(await file.arrayBuffer());
          if (bytes.length !== item.size || createHash('sha256').update(bytes).digest('hex') !== item.sha256) throw new Error(`The public ${kind} archive has incorrect bytes.`);
        }
      }
    }
    console.log(`Public product, client entry point, assets and available downloads verified: ${site.href}`);
    process.exit(0);
  } catch (error) { last = error.message; if (attempt < 17) await new Promise(resolve => setTimeout(resolve, 10000)); }
}
githubAnnotation(`${last} If Pages is not configured, select Settings → Pages → Deploy from a branch → gh-pages / (root).`);
process.exitCode = 1;
