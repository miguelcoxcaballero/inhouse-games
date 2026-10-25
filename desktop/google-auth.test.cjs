'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { randomBytes } = require('node:crypto');
const { createDesktopGoogleAuth, approvedBrokerUrl, CALLBACK_ORIGIN } = require('./google-auth.cjs');

const browserCrypto = import('../src/lib/desktop-auth.ts');
const testSession = () => ({ accessToken: 'synthetic-google-session-for-handoff-tests-only', expiresAt: Date.now() + 60 * 60 * 1000 });

async function encrypt(attempt, session = testSession()) {
  const { readDesktopAuthRequest, createDesktopCallbackUrl } = await browserCrypto;
  const request = readDesktopAuthRequest(new URL(attempt.url).hash);
  const callback = new URL(await createDesktopCallbackUrl(request, session));
  const params = new URLSearchParams(callback.hash.slice(1));
  return { request, callback, state: params.get('state'), payload: params.get('payload'), envelope: JSON.parse(Buffer.from(params.get('payload'), 'base64url').toString('utf8')), session };
}

test('browser WebCrypto handoff decrypts once and never places plaintext credentials in URLs', async () => {
  const auth = createDesktopGoogleAuth();
  const attempt = auth.begin();
  const encrypted = await encrypt(attempt);
  assert.equal(new URL(attempt.url).origin, 'https://miguelcoxcaballero.github.io');
  assert.equal(encrypted.callback.origin, CALLBACK_ORIGIN);
  assert.equal(encrypted.callback.pathname, '/auth/google/callback');
  assert.equal(encrypted.callback.search, '');
  assert.equal(encrypted.callback.href.includes(encrypted.session.accessToken), false);
  assert.equal(attempt.url.includes(encrypted.session.accessToken), false);
  assert.equal('d' in encrypted.request.key, false);
  assert.equal('d' in encrypted.envelope.key, false);
  assert.equal(auth.complete(encrypted.state, encrypted.envelope), true);
  assert.deepEqual(await attempt.promise, encrypted.session);
  assert.throws(() => auth.complete(encrypted.state, encrypted.envelope), /solicitud válida/);
});

test('tampered ciphertext and a wrong state cannot consume a pending login', async () => {
  const auth = createDesktopGoogleAuth();
  const attempt = auth.begin();
  const encrypted = await encrypt(attempt);
  const corrupted = structuredClone(encrypted.envelope);
  const bytes = Buffer.from(corrupted.ciphertext, 'base64url');
  bytes[0] ^= 1;
  corrupted.ciphertext = bytes.toString('base64url');
  assert.throws(() => auth.complete(encrypted.state, corrupted));
  assert.throws(() => auth.complete(randomBytes(32).toString('base64url'), encrypted.envelope), /solicitud válida/);
  auth.complete(encrypted.state, encrypted.envelope);
  assert.deepEqual(await attempt.promise, encrypted.session);
});

test('an expired browser response is rejected even when its Google token is still valid', async () => {
  let clock = Date.now();
  const auth = createDesktopGoogleAuth({ now: () => clock, timeoutMs: 300000 });
  const attempt = auth.begin();
  const encrypted = await encrypt(attempt);
  const rejected = assert.rejects(attempt.promise, /caducado/);
  clock += 300001;
  assert.throws(() => auth.complete(encrypted.state, encrypted.envelope), /caducado/);
  await rejected;
});

test('canceling an older attempt cannot cancel or resolve its replacement', async () => {
  const auth = createDesktopGoogleAuth();
  const old = auth.begin();
  const oldEncrypted = await encrypt(old);
  const oldRejected = assert.rejects(old.promise, /otra solicitud/);
  const replacement = auth.begin();
  await oldRejected;
  old.cancel();
  assert.throws(() => auth.complete(oldEncrypted.state, oldEncrypted.envelope), /solicitud válida/);
  const current = await encrypt(replacement);
  auth.complete(current.state, current.envelope);
  assert.deepEqual(await replacement.promise, current.session);
});

test('explicit cancellation invalidates the pending browser tab without leaving a login promise', async () => {
  const auth = createDesktopGoogleAuth();
  const attempt = auth.begin();
  const encrypted = await encrypt(attempt);
  const rejected = assert.rejects(attempt.promise, /cancelado/);
  auth.cancel();
  await rejected;
  assert.throws(() => auth.complete(encrypted.state, encrypted.envelope), /solicitud válida/);
});

test('the real timeout rejects an abandoned login and permits a fresh attempt', async () => {
  const keepAlive = setInterval(() => {}, 1000);
  try {
    const auth = createDesktopGoogleAuth({ timeoutMs: 25 });
    const abandoned = auth.begin();
    await assert.rejects(abandoned.promise, /caducado/);
    const fresh = auth.begin();
    const rejected = assert.rejects(fresh.promise, /cancelado/);
    auth.cancel();
    await rejected;
  } finally { clearInterval(keepAlive); }
});

test('browser broker rejects arbitrary callbacks, private keys and unapproved public origins', async () => {
  const { readDesktopAuthRequest } = await browserCrypto;
  const auth = createDesktopGoogleAuth();
  const attempt = auth.begin();
  const rejected = assert.rejects(attempt.promise, /cancelado/);
  const hash = new URL(attempt.url).hash;
  const params = new URLSearchParams(hash.slice(hash.indexOf('?') + 1));
  params.set('callback', 'https://example.invalid/collect');
  assert.throws(() => readDesktopAuthRequest(`#/desktop-auth?${params}`), /no es válida/);
  for (const url of ['http://miguelcoxcaballero.github.io/inhouse-games/', 'https://example.invalid/inhouse-games/', 'https://miguelcoxcaballero.github.io/another-app/', 'https://user@miguelcoxcaballero.github.io/inhouse-games/']) {
    assert.throws(() => approvedBrokerUrl(url));
  }
  auth.cancel();
  await rejected;
});

test('loopback callback requires its fixed Host, same-origin POST and one-use encrypted payload', async () => {
  const auth = createDesktopGoogleAuth();
  const attempt = auth.begin();
  const encrypted = await encrypt(attempt);
  const server = http.createServer(async (req, res) => {
    if (!await auth.handleRequest(req, res)) { res.writeHead(404); res.end(); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const request = (method, pathname, body, extra = {}) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, method, path: pathname, headers: {
      Host: '127.0.0.1:48715', Origin: CALLBACK_ORIGIN, 'Content-Type': 'application/json', ...extra,
    } }, (response) => {
      let text = '';
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, text }));
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
  try {
    const page = await request('GET', '/auth/google/callback');
    assert.equal(page.status, 200);
    assert.match(page.headers['content-security-policy'], /script-src 'self'/);
    assert.equal(page.headers['cache-control'], 'no-store');
    assert.equal(page.headers['cross-origin-resource-policy'], 'same-origin');
    assert.match(page.text, /callback\.js/);
    assert.equal(page.text.includes(encrypted.session.accessToken), false);
    const wrongHost = await request('GET', '/auth/google/callback', null, { Host: 'example.invalid:48715' });
    assert.equal(wrongHost.status, 403);
    const body = { state: encrypted.state, payload: encrypted.payload };
    assert.equal((await request('POST', '/auth/google/complete', body, { Origin: 'https://example.invalid' })).status, 403);
    assert.equal((await request('POST', '/auth/google/complete', body)).status, 200);
    assert.deepEqual(await attempt.promise, encrypted.session);
    assert.equal((await request('POST', '/auth/google/complete', body)).status, 400);
  } finally {
    auth.cancel();
    await new Promise((resolve) => server.close(resolve));
  }
});
