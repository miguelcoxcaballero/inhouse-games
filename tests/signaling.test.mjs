import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, generateKeyPairSync, createHash, sign } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, stat, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { buildIceConfig, createSignalingServer } from '../server/index.mjs';

async function fixture(t, options = {}) {
  const service = createSignalingServer({ host: '127.0.0.1', port: 0, env: {}, googleAuth: false, sessionStorePath: null, ...options });
  const address = await service.listen();
  t.after(() => service.close());
  const base = `http://127.0.0.1:${address.port}`;
  return { service, base, async client(origin, protocols = []) {
    const ws = new WebSocket(base.replace('http:', 'ws:') + '/signal', protocols, origin ? { origin } : undefined);
    const messages = [];
    const waiters = [];
    ws.on('message', (data) => {
      const message = JSON.parse(data.toString());
      const index = waiters.findIndex((waiter) => waiter.type === message.type);
      if (index === -1) messages.push(message);
      else { const [waiter] = waiters.splice(index, 1); clearTimeout(waiter.timer); waiter.resolve(message); }
    });
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    return { ws, send(message) { ws.send(JSON.stringify(message)); }, next(type, timeout = 2000) {
      const index = messages.findIndex((message) => message.type === type);
      if (index !== -1) return Promise.resolve(messages.splice(index, 1)[0]);
      return new Promise((resolve, reject) => {
        const waiter = { type, resolve, timer: null };
        waiter.timer = setTimeout(() => { waiters.splice(waiters.indexOf(waiter), 1); reject(new Error(`Timed out waiting for ${type}`)); }, timeout);
        waiters.push(waiter);
      });
    } };
  } };
}

async function paired(f) {
  const host = await f.client();
  const viewer = await f.client();
  host.send({ type: 'host', name: 'Murcia' });
  const { code } = await host.next('hosted');
  assert.match(code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  viewer.send({ type: 'join', code: code.toLowerCase(), name: 'Valencia' });
  assert.equal((await viewer.next('pending')).type, 'pending');
  const request = await host.next('join-request');
  assert.equal(request.name, 'Valencia');
  host.send({ type: 'approve', id: request.id, allow: true });
  const [hostPair, viewerPair] = await Promise.all([host.next('paired'), viewer.next('paired')]);
  assert.equal(hostPair.initiator, true);
  assert.equal(viewerPair.initiator, false);
  assert.equal(hostPair.name, 'Valencia');
  assert.equal(viewerPair.name, 'Murcia');
  return { host, viewer, code };
}

test('host approval routes offer, answer and candidates only to its paired viewer', async (t) => {
  const f = await fixture(t);
  const { host, viewer } = await paired(f);
  const offer = { description: { type: 'offer', sdp: 'v=0\r\no=host' } };
  host.send({ type: 'signal', target: 'untrusted-target-is-ignored', signal: offer });
  assert.deepEqual((await viewer.next('signal')).signal, offer);
  const answer = { description: { type: 'answer', sdp: 'v=0\r\no=viewer' } };
  viewer.send({ type: 'signal', signal: answer });
  assert.deepEqual((await host.next('signal')).signal, answer);
  const candidate = { candidate: { candidate: 'candidate:1 1 udp 123 127.0.0.1 5000 typ host', sdpMid: '0', sdpMLineIndex: 0 } };
  host.send({ type: 'signal', signal: candidate });
  assert.deepEqual((await viewer.next('signal')).signal, candidate);
  const other = await f.client();
  other.send({ type: 'signal', signal: offer });
  assert.match((await other.next('error')).message, /aprobación/);
});

test('signaling is blocked before approval; rejection releases viewer for another attempt', async (t) => {
  const f = await fixture(t);
  const host = await f.client();
  const viewer = await f.client();
  host.send({ type: 'host' });
  const { code } = await host.next('hosted');
  viewer.send({ type: 'join', code });
  const request = await host.next('join-request');
  viewer.send({ type: 'signal', signal: { description: { type: 'offer', sdp: 'blocked' } } });
  assert.match((await viewer.next('error')).message, /aprobación/);
  viewer.send({ type: 'approve', id: request.id, allow: true });
  assert.match((await viewer.next('error')).message, /autorizar/);
  host.send({ type: 'approve', id: request.id, allow: false });
  assert.equal((await viewer.next('rejected')).type, 'rejected');
  viewer.send({ type: 'join', code });
  const second = await host.next('join-request');
  assert.notEqual(second.id, request.id);
});

test('an active host accepts only one viewer and does not route malformed signal', async (t) => {
  const f = await fixture(t);
  const { host, code } = await paired(f);
  const third = await f.client();
  third.send({ type: 'join', code });
  assert.match((await third.next('error')).message, /activa/);
  host.send({ type: 'signal', signal: { description: { type: 'offer', sdp: 'v=0' }, candidate: { candidate: '' } } });
  assert.match((await host.next('error')).message, /inválida/);
  host.send({ type: 'signal', signal: { candidate: { candidate: 'x', sdpMLineIndex: -1 } } });
  assert.match((await host.next('error')).message, /inválida/);
});

test('viewer leave notifies host, room can reconnect, host close destroys invitation', async (t) => {
  const f = await fixture(t);
  const { host, viewer, code } = await paired(f);
  viewer.send({ type: 'leave' });
  await host.next('peer-left');
  viewer.send({ type: 'join', code });
  await host.next('join-request');
  host.ws.close();
  assert.match((await viewer.next('error')).message, /dejado/);
  viewer.send({ type: 'join', code });
  assert.match((await viewer.next('error')).message, /caducado/);
});

test('disconnecting pending viewer removes the approval request', async (t) => {
  const f = await fixture(t);
  const host = await f.client();
  const viewer = await f.client();
  host.send({ type: 'host' });
  const { code } = await host.next('hosted');
  viewer.send({ type: 'join', code });
  const request = await host.next('join-request');
  viewer.ws.close();
  assert.equal((await host.next('request-cancelled')).id, request.id);
});

test('pending and idle room expiration remove stale authorization', async (t) => {
  let clock = 1000;
  const f = await fixture(t, { now: () => clock, pendingTtlMs: 50, roomTtlMs: 100, cleanupIntervalMs: 10 });
  const host = await f.client();
  const viewer = await f.client();
  host.send({ type: 'host' });
  const { code } = await host.next('hosted');
  viewer.send({ type: 'join', code });
  await host.next('join-request');
  clock += 60;
  assert.match((await viewer.next('error')).message, /caducado/);
  await host.next('request-cancelled');
  clock += 60;
  assert.match((await host.next('error')).message, /caducado/);
  viewer.send({ type: 'join', code });
  assert.match((await viewer.next('error')).message, /caducado/);
});

test('malformed messages do not crash the service, ping remains available', async (t) => {
  const f = await fixture(t);
  const c = await f.client();
  c.ws.send('{broken');
  assert.match((await c.next('error')).message, /JSON/);
  c.send(null);
  assert.match((await c.next('error')).message, /inválido/);
  c.send({ type: 'unknown' });
  assert.match((await c.next('error')).message, /desconocido/);
  c.send({ type: 'join', code: '<bad>' });
  assert.match((await c.next('error')).message, /válido/);
  c.send({ type: 'ping' });
  assert.equal((await c.next('pong')).type, 'pong');
});

test('production origin policy rejects unrelated sites but accepts configured web client', async (t) => {
  const f = await fixture(t, { env: { NODE_ENV: 'production', ALLOWED_ORIGINS: 'https://link.example.test' } });
  const rejected = new WebSocket(f.base.replace('http:', 'ws:') + '/signal', { origin: 'https://evil.example.test' });
  await assert.rejects(new Promise((resolve, reject) => { rejected.once('open', resolve); rejected.once('error', reject); }), /403/);
  const accepted = await f.client('https://link.example.test');
  accepted.send({ type: 'ping' });
  await accepted.next('pong');
  const response = await fetch(f.base + '/api/config', { headers: { Origin: 'https://evil.example.test' } });
  assert.equal(response.status, 403);
  const loopback = await fetch(f.base + '/api/config', { headers: { Origin: 'http://127.0.0.1:34567' } });
  assert.equal(loopback.status, 200);
  assert.equal(loopback.headers.get('access-control-allow-origin'), 'http://127.0.0.1:34567');
  const superstring = await fetch(f.base + '/api/config', { headers: { Origin: 'http://localhost.evil.example.test:34567' } });
  assert.equal(superstring.status, 403);
});

test('TURN credentials use coturn HMAC, expire, and never expose the shared secret', async (t) => {
  const secret = 'unit-test-secret';
  const env = { SERVICE_TOKEN: 'test-service-access-key', STUN_URLS: 'stun:stun.example.test:3478', TURN_URLS: 'turn:relay.example.test:3478?transport=udp,turns:relay.example.test:5349', TURN_SECRET: secret, TURN_TTL_SECONDS: '600' };
  const f = await fixture(t, { env, now: () => 1_700_000_000_000 });
  const response = await fetch(f.base + '/api/config', { headers: { 'X-Inhouse-Service-Key': env.SERVICE_TOKEN } });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(body.iceServers.length, 2);
  assert.equal(body.iceExpiresAt, 1_700_000_600_000);
  const turn = body.iceServers[1];
  assert.match(turn.username, /^1700000600:inhouse-/);
  assert.equal(turn.credential, createHmac('sha1', secret).update(turn.username).digest('base64'));
  assert.ok(!JSON.stringify(body).includes(secret));
  assert.ok(!JSON.stringify(body).includes(env.SERVICE_TOKEN));
  assert.deepEqual(buildIceConfig({ TURN_URLS: 'turn:example.test' }).iceServers, []);
  assert.equal(buildIceConfig({}).iceExpiresAt, null);
});

test('static web app supports SPA routes and blocks traversal and escaped symlinks', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'inhouse-server-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const staticDir = path.join(directory, 'dist');
  await mkdir(staticDir);
  await writeFile(path.join(staticDir, 'index.html'), '<h1>Inhouse Link</h1>');
  await writeFile(path.join(directory, 'private.txt'), 'private-data');
  await symlink(path.join(directory, 'private.txt'), path.join(staticDir, 'escape.txt'));
  const f = await fixture(t, { staticDir });
  const page = await fetch(f.base + '/session/example');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Inhouse Link/);
  assert.equal((await fetch(f.base + '/escape.txt')).status, 403);
  const traversal = await new Promise((resolve, reject) => {
    import('node:http').then(({ get }) => get(f.base + '/%2e%2e%2fprivate.txt', (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject));
  });
  assert.equal(traversal, 403);
  assert.equal((await fetch(f.base + '/missing.js')).status, 404);
  assert.equal((await fetch(f.base + '/api/missing')).status, 404);
  assert.equal((await fetch(f.base + '/health')).status, 200);
  const head = await fetch(f.base + '/index.html', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), String(Buffer.byteLength('<h1>Inhouse Link</h1>')));
  assert.equal(await head.text(), '');
});

function makeIdentity() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const canonical = { crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y };
  return {
    deviceId: createHash('sha256').update(JSON.stringify(canonical)).digest('hex').slice(0, 32),
    response(nonce) {
      return { publicKey: jwk, signature: sign('sha256', Buffer.from(nonce), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url') };
    },
  };
}

test('authenticated host identity has a stable address and forwards nonce-bound trust without auto-approval', async (t) => {
  const f = await fixture(t);
  const identity = makeIdentity();
  const host = await f.client();
  const viewer = await f.client();
  const hostHello = await host.next('hello');
  const viewerHello = await viewer.next('hello');
  assert.notEqual(hostHello.nonce, viewerHello.nonce);
  assert.match(hostHello.nonce, /^[A-Za-z0-9_-]{43}$/);
  host.send({ type: 'host', name: 'Murcia', identity: identity.response(hostHello.nonce) });
  const hosted = await host.next('hosted');
  assert.equal(hosted.deviceId, identity.deviceId);
  const proof = createHmac('sha256', 'test-paired-device-token').update(viewerHello.nonce).digest('base64url');
  viewer.send({ type: 'join', code: identity.deviceId, trust: { id: 'trusted-viewer-123', proof, nonce: 'attacker-controlled-nonce' } });
  await viewer.next('pending');
  const request = await host.next('join-request');
  assert.deepEqual(request.trust, { id: 'trusted-viewer-123', proof, nonce: viewerHello.nonce });
  viewer.send({ type: 'signal', signal: { description: { type: 'offer', sdp: 'not-approved' } } });
  assert.match((await viewer.next('error')).message, /aprobación/);
  host.send({ type: 'approve', id: request.id, allow: true });
  const [a, b] = await Promise.all([host.next('paired'), viewer.next('paired')]);
  assert.equal(a.deviceId, identity.deviceId);
  assert.equal(b.deviceId, identity.deviceId);
});

test('host identity cannot be claimed with another connection signature or replace an online alias', async (t) => {
  const f = await fixture(t);
  const identity = makeIdentity();
  const host = await f.client();
  const attacker = await f.client();
  const aHello = await host.next('hello');
  const bHello = await attacker.next('hello');
  const aSignature = identity.response(aHello.nonce);
  attacker.send({ type: 'host', identity: aSignature });
  assert.match((await attacker.next('error')).message, /identidad/);
  host.send({ type: 'host', identity: aSignature });
  await host.next('hosted');
  attacker.send({ type: 'host', identity: identity.response(bHello.nonce) });
  assert.match((await attacker.next('error')).message, /otra sesión/);
  host.send({ type: 'leave' });
  host.send({ type: 'ping' });
  await host.next('pong');
  attacker.send({ type: 'host', identity: identity.response(bHello.nonce) });
  assert.equal((await attacker.next('hosted')).deviceId, identity.deviceId);
});

test('stable authenticated hosts remain discoverable after anonymous invitation expiry', async (t) => {
  let clock = 1000;
  const f = await fixture(t, { now: () => clock, roomTtlMs: 20, cleanupIntervalMs: 5 });
  const host = await f.client();
  const identity = makeIdentity();
  const hello = await host.next('hello');
  host.send({ type: 'host', identity: identity.response(hello.nonce) });
  await host.next('hosted');
  clock += 100;
  await new Promise((resolve) => setTimeout(resolve, 20));
  const viewer = await f.client();
  viewer.send({ type: 'join', code: identity.deviceId });
  assert.equal((await viewer.next('pending')).type, 'pending');
  host.send({ type: 'leave' });
  await viewer.next('error');
  viewer.send({ type: 'join', code: identity.deviceId });
  assert.match((await viewer.next('error')).message, /caducado/);
});

test('a configured service key protects ICE config and signaling without reflecting its credential', async (t) => {
  const token = 'service-test-private-key-123';
  const f = await fixture(t, { env: { SERVICE_TOKEN: token } });
  const authProtocol = `auth.${Buffer.from(token).toString('base64url')}`;
  const absent = await fetch(f.base + '/api/config');
  assert.equal(absent.status, 401);
  assert.match(absent.headers.get('www-authenticate'), /^Bearer/);
  const incorrect = await fetch(f.base + '/api/config', { headers: { 'X-Inhouse-Service-Key': 'wrong' } });
  assert.equal(incorrect.status, 401);
  const granted = await fetch(f.base + '/api/config', { headers: { 'X-Inhouse-Service-Key': token } });
  assert.equal(granted.status, 200);
  assert.ok(!(await granted.text()).includes(token));
  await assert.rejects(f.client(), /401/);
  await assert.rejects(f.client(undefined, ['inhouse-link-v1', 'auth.wrong']), /401/);
  await assert.rejects(f.client(undefined, [authProtocol]), /401/);
  const client = await f.client(undefined, ['inhouse-link-v1', authProtocol]);
  assert.equal(client.ws.protocol, 'inhouse-link-v1');
  assert.notEqual(client.ws.protocol, authProtocol);
  assert.match((await client.next('hello')).nonce, /^[A-Za-z0-9_-]{43}$/);
  client.send({ type: 'ping' });
  await client.next('pong');
});

test('config Authorization preflight accepts a permitted origin without requiring credentials on OPTIONS', async (t) => {
  const origin = 'http://127.0.0.1:45678';
  const f = await fixture(t, { env: { SERVICE_TOKEN: 'preflight-test-key', NODE_ENV: 'production' } });
  const headers = { Origin: origin, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization' };
  const allowed = await fetch(f.base + '/api/config', { method: 'OPTIONS', headers });
  assert.equal(allowed.status, 204);
  assert.equal(allowed.headers.get('access-control-allow-origin'), origin);
  assert.equal(allowed.headers.get('access-control-allow-headers'), 'Authorization, X-Inhouse-Service-Key');
  assert.match(allowed.headers.get('access-control-allow-methods'), /GET/);
  assert.equal(allowed.headers.get('access-control-allow-credentials'), null);
  const unlisted = await fetch(f.base + '/api/config', { method: 'OPTIONS', headers: { ...headers, Origin: 'https://evil.example.test' } });
  assert.equal(unlisted.status, 403);
  const unexpected = await fetch(f.base + '/api/config', { method: 'OPTIONS', headers: { ...headers, 'Access-Control-Request-Headers': 'authorization, x-extra' } });
  assert.equal(unexpected.status, 403);
  const stillProtected = await fetch(f.base + '/api/config', { headers: { Origin: origin } });
  assert.equal(stillProtected.status, 401);
  assert.equal(stillProtected.headers.get('access-control-allow-origin'), origin);
});

test('a Google-disabled test relay refuses to start without an owner-managed service key', () => {
  assert.throws(() => createSignalingServer({ env: { TURN_URLS: 'turn:relay.example.test' }, googleAuth: false }), /SERVICE_TOKEN/);
  assert.deepEqual(buildIceConfig({ TURN_URLS: 'turn:relay.example.test' }).iceServers, []);
});

const TEST_ACCOUNTS = {
  'test-google-host-token': { id: 'drive-owner-123', name: 'Nombre Google anfitrión', email: 'owner@example.test' },
  'test-google-viewer-token': { id: 'drive-viewer-456', name: 'Nombre Google cliente', email: 'viewer@example.test' },
};

async function testGoogleVerifier(token) {
  const account = TEST_ACCOUNTS[token];
  if (!account) {
    const error = new Error('Rejected fake token');
    error.status = 401;
    throw error;
  }
  return { ...account, expiresAt: Date.now() + 60_000 };
}

function googleProtocols(token) { return ['inhouse-link-v1', `google.${Buffer.from(token).toString('base64url')}`]; }

test('Google authentication is required by default for config and signaling', async (t) => {
  const f = await fixture(t, { googleAuth: true, googleVerifier: testGoogleVerifier });
  assert.equal((await fetch(f.base + '/health')).status, 200);
  assert.equal((await fetch(f.base + '/api/config')).status, 401);
  await assert.rejects(f.client(), /401/);
  await assert.rejects(f.client(undefined, ['inhouse-link-v1']), /401/);
  const response = await fetch(f.base + '/api/config', { headers: { Authorization: 'Bearer test-google-host-token' } });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).account, TEST_ACCOUNTS['test-google-host-token']);
  const connection = await f.client(undefined, googleProtocols('test-google-host-token'));
  assert.equal(connection.ws.protocol, 'inhouse-link-v1');
  assert.deepEqual((await connection.next('hello')).account, TEST_ACCOUNTS['test-google-host-token']);
});

test('verified Google profile replaces claimed names but never replaces host approval', async (t) => {
  const f = await fixture(t, { googleAuth: true, googleVerifier: testGoogleVerifier });
  const host = await f.client(undefined, googleProtocols('test-google-host-token'));
  const viewer = await f.client(undefined, googleProtocols('test-google-viewer-token'));
  host.send({ type: 'host', name: 'spoofed-host@example.test' });
  const hosted = await host.next('hosted');
  assert.equal(hosted.account.email, 'owner@example.test');
  viewer.send({ type: 'join', code: hosted.code, name: 'spoofed-owner@example.test' });
  await viewer.next('pending');
  const request = await host.next('join-request');
  assert.equal(request.account.email, 'viewer@example.test');
  assert.match(request.name, /^viewer@example\.test/);
  assert.ok(!request.name.includes('spoofed'));
  viewer.send({ type: 'signal', signal: { description: { type: 'offer', sdp: 'not-approved' } } });
  assert.match((await viewer.next('error')).message, /aprobación/);
  host.send({ type: 'approve', id: request.id, allow: true });
  const [a, b] = await Promise.all([host.next('paired'), viewer.next('paired')]);
  assert.equal(a.account.email, 'viewer@example.test');
  assert.equal(b.account.email, 'owner@example.test');
});

test('Google token and optional owner service key are independent credentials', async (t) => {
  const serviceKey = 'owner-extra-service-key';
  const f = await fixture(t, { googleAuth: true, googleVerifier: testGoogleVerifier, env: { SERVICE_TOKEN: serviceKey } });
  const googleHeaders = { Authorization: 'Bearer test-google-host-token' };
  assert.equal((await fetch(f.base + '/api/config', { headers: googleHeaders })).status, 401);
  assert.equal((await fetch(f.base + '/api/config', { headers: { 'X-Inhouse-Service-Key': serviceKey } })).status, 401);
  const granted = await fetch(f.base + '/api/config', { headers: { ...googleHeaders, 'X-Inhouse-Service-Key': serviceKey } });
  assert.equal(granted.status, 200);
  await assert.rejects(f.client(undefined, googleProtocols('test-google-host-token')), /401/);
  const connection = await f.client(undefined, [...googleProtocols('test-google-host-token'), `auth.${Buffer.from(serviceKey).toString('base64url')}`]);
  assert.equal(connection.ws.protocol, 'inhouse-link-v1');
  const preflight = await fetch(f.base + '/api/config', { method: 'OPTIONS', headers: {
    Origin: 'http://127.0.0.1:12345', 'Access-Control-Request-Method': 'GET',
    'Access-Control-Request-Headers': 'authorization, x-inhouse-service-key',
  } });
  assert.equal(preflight.status, 204);
});

test('an administrator email allowlist restricts verified Google accounts', async (t) => {
  const f = await fixture(t, { googleAuth: true, googleVerifier: testGoogleVerifier, env: { GOOGLE_ALLOWED_EMAILS: 'OWNER@example.test' } });
  const allowed = await fetch(f.base + '/api/auth/session', { headers: { Authorization: 'Bearer test-google-host-token' } });
  assert.equal(allowed.status, 200);
  assert.equal((await allowed.json()).account.email, 'owner@example.test');
  const denied = await fetch(f.base + '/api/config', { headers: { Authorization: 'Bearer test-google-viewer-token' } });
  assert.equal(denied.status, 403);
  await assert.rejects(f.client(undefined, googleProtocols('test-google-viewer-token')), /403/);
});

test('provider verification has a bounded timeout and never returns provider error text', async (t) => {
  const f = await fixture(t, { googleAuth: true, googleVerifier: () => new Promise(() => {}), googleTimeoutMs: 20 });
  const response = await fetch(f.base + '/api/config', { headers: { Authorization: 'Bearer test-google-host-token' } });
  assert.equal(response.status, 503);
  const body = await response.text();
  assert.ok(!body.includes('test-google-host-token'));
  await assert.rejects(f.client(undefined, googleProtocols('test-google-host-token')), /503/);
});

test('desktop auth hook runs before defaults and supports a locally validated POST handler', async (t) => {
  const f = await fixture(t, { googleAuth: true, googleVerifier: testGoogleVerifier, handleDesktopAuth: async (req, res) => {
    if (req.url !== '/auth/google/complete') return false;
    res.writeHead(201, { 'Content-Type': 'application/json', 'X-Desktop-Handler': 'handled' });
    res.end('{"ok":true}');
    return true;
  } });
  const response = await fetch(f.base + '/auth/google/complete', { method: 'POST' });
  assert.equal(response.status, 201);
  assert.equal(response.headers.get('x-desktop-handler'), 'handled');
  assert.equal(response.headers.get('cross-origin-opener-policy'), null);
  assert.equal((await fetch(f.base + '/api/config')).status, 401);
});

async function durableSession(f, token = 'test-google-host-token', extraHeaders = {}) {
  const response = await fetch(f.base + '/api/auth/session', { method: 'POST', headers: { Authorization: `Bearer ${token}`, ...extraHeaders } });
  assert.equal(response.status, 201);
  const session = await response.json();
  assert.match(session.accessToken, /^ihl_[A-Za-z0-9_-]{43}$/);
  return session;
}

test('Google upgrades to an opaque account session usable without repeated provider checks', async (t) => {
  let providerChecks = 0;
  const f = await fixture(t, { googleAuth: true, googleVerifier: async (token) => { providerChecks++; return testGoogleVerifier(token); } });
  const session = await durableSession(f);
  assert.deepEqual(session.profile, { ...TEST_ACCOUNTS['test-google-host-token'], photo: '' });
  assert.ok(session.expiresAt > Date.now() + 29 * 24 * 60 * 60 * 1000);
  const headers = { Authorization: `Bearer ${session.accessToken}` };
  const config = await fetch(f.base + '/api/config', { headers });
  assert.equal(config.status, 200);
  assert.equal((await config.json()).account.id, TEST_ACCOUNTS['test-google-host-token'].id);
  const profile = await fetch(f.base + '/api/auth/session', { headers });
  assert.equal((await profile.json()).profile.email, 'owner@example.test');
  const connection = await f.client(undefined, googleProtocols(session.accessToken));
  assert.equal((await connection.next('hello')).account.email, 'owner@example.test');
  const again = await fetch(f.base + '/api/auth/session', { method: 'POST', headers });
  const unchanged = await again.json();
  assert.equal(again.status, 200);
  assert.equal(unchanged.accessToken, session.accessToken);
  assert.equal(unchanged.expiresAt, session.expiresAt);
  assert.equal(providerChecks, 1);
});

test('account sessions survive restart with only private-file token hashes and account metadata persisted', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'inhouse-account-session-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sessionStorePath = path.join(directory, 'sessions.json');
  const first = await fixture(t, { googleAuth: true, googleVerifier: testGoogleVerifier, sessionStorePath });
  const session = await durableSession(first);
  await first.service.close();
  const contents = await readFile(sessionStorePath, 'utf8');
  assert.ok(!contents.includes(session.accessToken));
  assert.ok(!contents.includes('test-google-host-token'));
  const saved = JSON.parse(contents);
  assert.match(saved.sessions[0].hash, /^[a-f0-9]{64}$/);
  assert.equal(saved.sessions[0].profile.email, 'owner@example.test');
  assert.equal((await stat(sessionStorePath)).mode & 0o777, 0o600);
  const second = await fixture(t, { googleAuth: true, googleVerifier: () => { throw new Error('Provider must not be called for an app session'); }, sessionStorePath });
  const restored = await fetch(second.base + '/api/auth/session', { headers: { Authorization: `Bearer ${session.accessToken}` } });
  assert.equal(restored.status, 200);
  assert.equal((await restored.json()).profile.id, session.profile.id);
});

test('logout revokes only that account session and closes its signaling sockets', async (t) => {
  const f = await fixture(t, { googleAuth: true, googleVerifier: testGoogleVerifier });
  const owner = await durableSession(f);
  const other = await durableSession(f, 'test-google-viewer-token');
  const connection = await f.client(undefined, googleProtocols(owner.accessToken));
  const closed = new Promise((resolve) => connection.ws.once('close', (code) => resolve(code)));
  const revoked = await fetch(f.base + '/api/auth/session', { method: 'DELETE', headers: { Authorization: `Bearer ${owner.accessToken}` } });
  assert.equal(revoked.status, 204);
  assert.equal(await closed, 1008);
  assert.equal((await fetch(f.base + '/api/config', { headers: { Authorization: `Bearer ${owner.accessToken}` } })).status, 401);
  await assert.rejects(f.client(undefined, googleProtocols(owner.accessToken)), /401/);
  const retained = await fetch(f.base + '/api/auth/session', { headers: { Authorization: `Bearer ${other.accessToken}` } });
  assert.equal(retained.status, 200);
  assert.equal((await retained.json()).profile.email, 'viewer@example.test');
});

test('expired account sessions fail closed and are not extended by POST reuse', async (t) => {
  let clock = Date.now();
  const f = await fixture(t, { googleAuth: true, googleVerifier: testGoogleVerifier, now: () => clock, sessionTtlMs: 1000 });
  const session = await durableSession(f);
  clock += 1001;
  const response = await fetch(f.base + '/api/auth/session', { headers: { Authorization: `Bearer ${session.accessToken}` } });
  assert.equal(response.status, 401);
  const reuse = await fetch(f.base + '/api/auth/session', { method: 'POST', headers: { Authorization: `Bearer ${session.accessToken}` } });
  assert.equal(reuse.status, 401);
});

test('minted profile cannot be changed by a claimed account in the POST body', async (t) => {
  const f = await fixture(t, { googleAuth: true, googleVerifier: testGoogleVerifier });
  const response = await fetch(f.base + '/api/auth/session', {
    method: 'POST', headers: { Authorization: 'Bearer test-google-host-token', 'Content-Type': 'application/json' },
    body: JSON.stringify({ profile: TEST_ACCOUNTS['test-google-viewer-token'] }),
  });
  assert.equal(response.status, 201);
  const session = await response.json();
  assert.equal(session.profile.id, TEST_ACCOUNTS['test-google-host-token'].id);
  const headers = { Authorization: `Bearer ${session.accessToken}` };
  const config = await fetch(f.base + '/api/config', { headers });
  assert.equal((await config.json()).account.email, 'owner@example.test');
});

test('account session caps constrain durable authorization', async (t) => {
  const limited = await fixture(t, { googleAuth: true, googleVerifier: testGoogleVerifier, sessionMaxPerAccount: 1 });
  await durableSession(limited);
  const second = await fetch(limited.base + '/api/auth/session', { method: 'POST', headers: { Authorization: 'Bearer test-google-host-token' } });
  assert.equal(second.status, 429);
  assert.throws(() => createSignalingServer({ googleAuth: false, host: '0.0.0.0', env: {} }), /localhost/);
});

test('persisted app sessions respect a changed administrator account allowlist', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'inhouse-session-allowlist-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sessionStorePath = path.join(directory, 'sessions.json');
  const first = await fixture(t, { googleAuth: true, googleVerifier: testGoogleVerifier, sessionStorePath });
  const session = await durableSession(first);
  await first.service.close();
  const second = await fixture(t, { googleAuth: true, googleVerifier: testGoogleVerifier, sessionStorePath, env: { GOOGLE_ALLOWED_EMAILS: 'viewer@example.test' } });
  const rejected = await fetch(second.base + '/api/config', { headers: { Authorization: `Bearer ${session.accessToken}` } });
  assert.equal(rejected.status, 403);
  await assert.rejects(second.client(undefined, googleProtocols(session.accessToken)), /403/);
});
