import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const CACHE_KEY = 'inhouse.link.service-config.v1';
const OFFICIAL_CONFIG = 'https://miguelcoxcaballero.github.io/inhouse-games/service.json';
const SERVICE = 'https://link.example.test';
const originals = Object.fromEntries(['window', 'location', 'localStorage', 'fetch'].map(key => [key, globalThis[key]]));
let sequence = 0;
let memory;

function browser(href = 'https://web.example.test/inhouse-games/#/client', desktop = false) {
  globalThis.location = new URL(href);
  globalThis.window = Object.assign(new EventTarget(), { location: globalThis.location });
  if (desktop) window.inhouseDesktop = {};
}

function response(document, status = 200) {
  return new Response(JSON.stringify(document), { status, headers: { 'Content-Type': 'application/json' } });
}

function cached(signalingUrl = SERVICE) {
  localStorage.setItem(CACHE_KEY, JSON.stringify({ schema: 1, signalingUrl }));
}

async function fresh() {
  return import(`../src/lib/service-config.ts?unit=${++sequence}`);
}

beforeEach(() => {
  memory = new Map();
  globalThis.localStorage = {
    getItem: key => memory.get(key) ?? null,
    setItem: (key, value) => memory.set(key, String(value)),
    removeItem: key => memory.delete(key),
  };
  browser();
  globalThis.fetch = async () => response({ schema: 1, signalingUrl: null });
});

afterEach(() => {
  for (const [key, value] of Object.entries(originals)) {
    if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
  }
});

test('web bootstrap loads its public base file without credentials and stores only a normalized default', async () => {
  const calls = [];
  globalThis.fetch = async (url, request) => {
    calls.push({ url: String(url), request });
    return response({ schema: 1, signalingUrl: SERVICE + '/' });
  };
  const config = await fresh();
  assert.equal(config.getDefaultServiceOrigin(), null);
  await config.bootstrapServiceConfig();
  assert.equal(calls.length, 1);
  // Plain Node has no Vite BASE_URL; the supported fallback is '/'.
  assert.equal(calls[0].url, 'https://web.example.test/service.json');
  assert.equal(calls[0].request.credentials, 'omit');
  assert.equal(calls[0].request.redirect, 'error');
  assert.equal(calls[0].request.cache, 'no-store');
  assert.ok(calls[0].request.signal instanceof AbortSignal);
  assert.equal(config.getDefaultServiceOrigin(), SERVICE);
  assert.equal(localStorage.getItem('inhouse.signalingUrl'), null);
  assert.equal(JSON.parse(localStorage.getItem(CACHE_KEY)).signalingUrl, SERVICE);
});

test('Windows uses the official HTTPS bootstrap rather than its loopback renderer', async () => {
  browser('http://127.0.0.1:48715/#/client', true);
  const urls = [];
  globalThis.fetch = async url => { urls.push(String(url)); return response({ schema: 1, signalingUrl: SERVICE }); };
  const config = await fresh();
  await config.bootstrapServiceConfig();
  assert.deepEqual(urls, [OFFICIAL_CONFIG]);
  assert.equal(config.getDefaultServiceOrigin(), SERVICE);
});

test('the public default never overwrites or adopts the explicit user service setting', async () => {
  const explicit = 'https://owner-selected.example.test';
  localStorage.setItem('inhouse.signalingUrl', explicit);
  globalThis.fetch = async () => response({ schema: 1, signalingUrl: SERVICE });
  const config = await fresh();
  await config.bootstrapServiceConfig();
  assert.equal(config.getDefaultServiceOrigin(), SERVICE);
  assert.equal(localStorage.getItem('inhouse.signalingUrl'), explicit);
  assert.notEqual(localStorage.getItem(CACHE_KEY), localStorage.getItem('inhouse.signalingUrl'));
});

test('public configuration rejects unsupported schemas, credentials and non-origin URLs', async () => {
  const invalid = [
    null, {}, { schema: 2, signalingUrl: SERVICE }, { schema: '1', signalingUrl: SERVICE },
    { schema: 1 }, { schema: 1, signalingUrl: 42 },
    ...[
      'http://link.example.test', 'http://127.0.0.1:48715',
      'https://user:password@link.example.test', 'https://link.example.test/api',
      'https://link.example.test/?token=private', 'https://link.example.test/#fragment',
      'file:///service.json', 'javascript:alert(1)', '//link.example.test', '',
    ].map(signalingUrl => ({ schema: 1, signalingUrl })),
  ];
  for (const document of invalid) {
    memory.clear();
    globalThis.fetch = async () => response(document);
    const config = await fresh();
    await config.bootstrapServiceConfig();
    assert.equal(config.getDefaultServiceOrigin(), null, JSON.stringify(document));
    assert.equal(localStorage.getItem('inhouse.signalingUrl'), null);
  }
});

test('network failure restores the last validated cached service instead of requiring a manual override', async () => {
  cached();
  globalThis.fetch = async () => { throw new TypeError('offline fixture'); };
  const config = await fresh();
  await config.bootstrapServiceConfig();
  assert.equal(config.getDefaultServiceOrigin(), SERVICE);
  assert.equal(localStorage.getItem('inhouse.signalingUrl'), null);
  assert.equal(JSON.parse(localStorage.getItem(CACHE_KEY)).signalingUrl, SERVICE);
});

test('invalid, unsuccessful or malformed responses retain a valid cached configuration', async () => {
  const failures = [
    () => response({ schema: 1, signalingUrl: 'https://untrusted.example.test/path' }),
    () => response({ schema: 1, signalingUrl: 'https://new.example.test' }, 503),
    () => new Response('{invalid JSON', { status: 200 }),
  ];
  for (const failure of failures) {
    memory.clear(); cached();
    globalThis.fetch = async () => failure();
    const config = await fresh();
    await config.bootstrapServiceConfig();
    assert.equal(config.getDefaultServiceOrigin(), SERVICE);
    assert.equal(JSON.parse(localStorage.getItem(CACHE_KEY)).signalingUrl, SERVICE);
  }
});

test('an explicit null published by the owner clears an obsolete public default but preserves the user override', async () => {
  cached();
  const explicit = 'https://owner-selected.example.test';
  localStorage.setItem('inhouse.signalingUrl', explicit);
  const config = await fresh();
  await config.bootstrapServiceConfig();
  assert.equal(config.getDefaultServiceOrigin(), null);
  const saved = localStorage.getItem(CACHE_KEY);
  assert.ok(saved === null || JSON.parse(saved).signalingUrl === null);
  assert.equal(localStorage.getItem('inhouse.signalingUrl'), explicit);
});

test('invalid persisted cache never becomes a fallback during an outage', async () => {
  const invalidCaches = [
    '{invalid JSON',
    JSON.stringify({ schema: 2, signalingUrl: SERVICE }),
    JSON.stringify({ schema: 1, signalingUrl: 'http://127.0.0.1:48715' }),
    JSON.stringify({ schema: 1, signalingUrl: 'https://user:secret@link.example.test' }),
    JSON.stringify({ schema: 1, signalingUrl: SERVICE + '/path' }),
  ];
  globalThis.fetch = async () => { throw new TypeError('offline fixture'); };
  for (const invalid of invalidCaches) {
    memory.clear(); memory.set(CACHE_KEY, invalid);
    const config = await fresh();
    await config.bootstrapServiceConfig();
    assert.equal(config.getDefaultServiceOrigin(), null);
  }
});

test('concurrent callers share one bootstrap and later callers reuse its completed result', async () => {
  let resolve;
  let calls = 0;
  globalThis.fetch = () => { calls++; return new Promise(result => { resolve = result; }); };
  const config = await fresh();
  const first = config.bootstrapServiceConfig();
  const second = config.bootstrapServiceConfig();
  await Promise.resolve();
  assert.equal(calls, 1);
  resolve(response({ schema: 1, signalingUrl: SERVICE }));
  await Promise.all([first, second]);
  await config.bootstrapServiceConfig();
  assert.equal(calls, 1);
  assert.equal(config.getDefaultServiceOrigin(), SERVICE);
});

test('the five-second deadline aborts a stalled request, ignores its late response and permits retry', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  cached();
  let finishRequest;
  let signal;
  globalThis.fetch = (_url, request) => {
    signal = request.signal;
    // Intentionally ignore cancellation to verify the bootstrap's own deadline.
    return new Promise(resolve => { finishRequest = resolve; });
  };
  try {
    const config = await fresh();
    const loading = config.bootstrapServiceConfig();
    let settled = false;
    void loading.then(() => { settled = true; });
    context.mock.timers.tick(4999);
    await Promise.resolve();
    assert.equal(settled, false);
    assert.equal(signal.aborted, false);
    context.mock.timers.tick(1);
    await loading;
    assert.equal(signal.aborted, true);
    assert.equal(config.getDefaultServiceOrigin(), SERVICE);
    finishRequest(response({ schema: 1, signalingUrl: 'https://late.example.test' }));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(config.getDefaultServiceOrigin(), SERVICE);
    assert.equal(JSON.parse(localStorage.getItem(CACHE_KEY)).signalingUrl, SERVICE);
    globalThis.fetch = async () => response({ schema: 1, signalingUrl: 'https://retried.example.test' });
    await config.bootstrapServiceConfig();
    assert.equal(config.getDefaultServiceOrigin(), 'https://retried.example.test');
  } finally {
    context.mock.timers.reset();
  }
});

test('missing browser context is safe and does not make a network request', async () => {
  delete globalThis.window;
  delete globalThis.location;
  delete globalThis.localStorage;
  globalThis.fetch = async () => { assert.fail('Node without a browser must not request a public service'); };
  const config = await fresh();
  assert.equal(config.getDefaultServiceOrigin(), null);
  await config.bootstrapServiceConfig();
  assert.equal(config.getDefaultServiceOrigin(), null);
});

test('unavailable localStorage does not prevent a validated in-memory default', async () => {
  globalThis.localStorage = {
    getItem() { throw new Error('storage denied'); },
    setItem() { throw new Error('storage denied'); },
    removeItem() { throw new Error('storage denied'); },
  };
  globalThis.fetch = async () => response({ schema: 1, signalingUrl: SERVICE });
  const config = await fresh();
  await config.bootstrapServiceConfig();
  assert.equal(config.getDefaultServiceOrigin(), SERVICE);
});

test('Pages and Windows select private cloud transport when no shared Node service is configured', async () => {
  browser('https://miguelcoxcaballero.github.io/inhouse-games/#/client');
  const pages = await fresh();
  assert.equal(pages.useCloudAccountTransport(), true);
  await pages.bootstrapServiceConfig();
  assert.equal(pages.getDefaultServiceOrigin(), null);
  assert.equal(pages.useCloudAccountTransport(), true);
  memory.clear();
  browser('http://127.0.0.1:48715/#/client', true);
  assert.equal((await fresh()).useCloudAccountTransport(), true);
  // The native bridge remains authoritative while its renderer URL is not yet available.
  delete window.location;
  delete globalThis.location;
  assert.equal((await fresh()).useCloudAccountTransport(), true);
});

test('developer and self-hosted web origins retain Node transport, and Node imports need no browser globals', async () => {
  for (const href of [
    'http://localhost:5173/#/client', 'http://127.0.0.1:8080/#/client',
    'https://self-hosted.example.test/#/client',
  ]) {
    browser(href);
    assert.equal((await fresh()).useCloudAccountTransport(), false, href);
  }
  delete globalThis.window;
  delete globalThis.location;
  assert.equal((await fresh()).useCloudAccountTransport(), false);
});

test('explicit service choices and a validated public backend take precedence over private cloud transport', async () => {
  for (const desktop of [false, true]) {
    browser('https://miguelcoxcaballero.github.io/inhouse-games/#/client', desktop);
    for (const explicit of ['https://owner-selected.example.test', 'not a valid URL']) {
      localStorage.setItem('inhouse.signalingUrl', explicit);
      assert.equal((await fresh()).useCloudAccountTransport(), false, 'An invalid explicit choice must not silently switch transport');
    }
  }
  localStorage.removeItem('inhouse.signalingUrl');
  browser('https://miguelcoxcaballero.github.io/inhouse-games/#/client');
  globalThis.fetch = async () => response({ schema: 1, signalingUrl: SERVICE });
  const config = await fresh();
  assert.equal(config.useCloudAccountTransport(), true);
  await config.bootstrapServiceConfig();
  assert.equal(config.getDefaultServiceOrigin(), SERVICE);
  assert.equal(config.useCloudAccountTransport(), false);
});

test('Google account restoration awaits the new public default and never sends the previous issuer credential', async () => {
  browser('https://miguelcoxcaballero.github.io/inhouse-games/#/client');
  window.google = { accounts: { oauth2: { initTokenClient: () => ({ requestAccessToken() {} }) } } };
  const previous = 'https://previous-service.example.test';
  const next = 'https://next-service.example.test';
  cached(previous);
  // This is the first plain import; earlier config tests isolate module state with query strings.
  const auth = await import('../src/lib/google-account.ts');
  assert.equal(auth.getConfiguredServiceOrigin(), previous);
  localStorage.setItem('inhouse.signalingUrl', 'https://user-selected.example.test');
  assert.equal(auth.getConfiguredServiceOrigin(), 'https://user-selected.example.test');
  localStorage.removeItem('inhouse.signalingUrl');
  assert.equal(auth.getConfiguredServiceOrigin(), previous);
  localStorage.setItem(auth.GOOGLE_SESSION_KEY, JSON.stringify({
    accessToken: 'ihl_' + 'a'.repeat(43),
    expiresAt: Date.now() + 30 * 86400_000,
    issuer: previous,
    profile: { id: 'fixture-drive-permission-id', name: 'Fixture', email: 'fixture@example.test', photo: '' },
  }));
  assert.equal(auth.getGoogleSession().issuer, previous);
  const requests = [];
  globalThis.fetch = async (url, request) => {
    requests.push(String(url));
    assert.equal(new URL(url).origin, 'https://miguelcoxcaballero.github.io');
    assert.ok(new URL(url).pathname.endsWith('/service.json'), 'The obsolete credential must not reach Drive or any account endpoint');
    assert.equal(request.headers.Authorization, undefined);
    return response({ schema: 1, signalingUrl: next });
  };
  const account = new auth.GoogleAccount(() => {});
  try {
    await account.initialize();
    assert.equal(requests.length, 1);
    assert.equal(auth.getConfiguredServiceOrigin(), next);
    assert.equal(account.state.status, 'signed-out');
    assert.equal(account.state.profile, null);
    assert.equal(auth.getGoogleSession(), null);
    assert.equal(localStorage.getItem(auth.GOOGLE_SESSION_KEY), null);
  } finally {
    account.destroy();
  }
});
