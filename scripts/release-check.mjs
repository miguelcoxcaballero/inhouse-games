import { readFile } from 'node:fs/promises';

const flags = new Map();
for (let index = 2; index < process.argv.length; index += 2) flags.set(process.argv[index], process.argv[index + 1]);
const site = new URL(flags.get('--site') ?? 'https://miguelcoxcaballero.github.io/inhouse-games/');
if (site.protocol !== 'https:' || site.username || site.password || site.search || site.hash) throw new Error('Use the public HTTPS site origin and base path.');
if (!site.pathname.endsWith('/')) site.pathname += '/';
const expected = JSON.parse(await readFile(flags.get('--manifest') ?? 'public/release.json', 'utf8'));
let failure = 'The Pages deployment is not available.';
for (let attempt = 0; attempt < 18; attempt++) {
  try {
    const nonce = `inhouse-check=${Date.now()}`;
    const [page, manifest] = await Promise.all([
      fetch(new URL(`?${nonce}`, site), { cache: 'no-store', signal: AbortSignal.timeout(10000) }),
      fetch(new URL(`release.json?${nonce}`, site), { cache: 'no-store', signal: AbortSignal.timeout(10000) }),
    ]);
    if (!page.ok || !manifest.ok) throw new Error(`Public site HTTP ${page.status}; release manifest HTTP ${manifest.status}.`);
    const actual = await manifest.json();
    if (actual.version !== expected.version || actual.tag !== expected.tag || actual.publishedAt !== expected.publishedAt) throw new Error('The public site still serves an older release.');
    for (const key of ['windows', 'web', 'source']) {
      for (const field of ['url', 'sha256', 'size']) {
        if (actual.downloads?.[key]?.[field] !== expected.downloads?.[key]?.[field]) throw new Error(`The public ${key} download does not match this verified release.`);
      }
    }
    const html = await page.text();
    if (!/inhouse/i.test(html)) throw new Error('The public entry point is not the Inhouse application.');
    for (const match of html.matchAll(/(?:src|href)="([^"\s]+\.(?:js|css)(?:\?[^"\s]*)?)"/g)) {
      const asset = new URL(match[1], site);
      if (asset.origin !== site.origin || !asset.pathname.startsWith(site.pathname)) throw new Error('A website asset escapes the configured Pages base path.');
      const response = await fetch(asset, { cache: 'no-store', signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error(`A published application asset returned HTTP ${response.status}.`);
    }
    console.log(`Public website and exact download manifest verified: ${site.href}`);
    process.exit(0);
  } catch (error) {
    failure = error.message;
    if (attempt < 17) await new Promise(resolve => setTimeout(resolve, 10000));
  }
}
console.error(failure);
console.error('If GitHub Pages is not enabled yet, select Settings → Pages → Deploy from a branch → gh-pages / (root), then rerun this workflow.');
process.exitCode = 1;
