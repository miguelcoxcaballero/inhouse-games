'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes, randomUUID, createHash } = require('node:crypto');
const { mkdtemp, readFile, writeFile, rm } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createAccountHostingAuthority, createPeerRevocationHandler, normalizeIssuer } = require('./account-hosting.cjs');

function fixture(options = {}) {
  let clock = Date.now();
  const hostId = 'a'.repeat(32);
  const connectionId = randomUUID();
  const accountId = 'verified-google-owner';
  const credential = { issuer: 'https://link.example.test', accessToken: `ihl_${randomBytes(32).toString('base64url')}`, serviceKey: randomBytes(24).toString('base64url'), hostId };
  let profileId = accountId;
  let grant = { active: true, connectionId, hostId, ownerAccountId: accountId, viewerAccountId: accountId };
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ path: new URL(url).pathname, headers: init.headers, redirect: init.redirect });
    const body = new URL(url).pathname === '/api/auth/session'
      ? { profile: { id: profileId, email: 'owner@example.test' }, expiresAt: clock + 30 * 24 * 3600000 }
      : { ...grant, expiresAt: clock + 60000 };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const config = { now: () => clock, fetcher, ...options };
  const authority = createAccountHostingAuthority(config);
  return {
    authority, credential, accountId, connectionId, hostId, calls, config,
    owner: () => authority.recordGoogleOwner({ id: accountId, expiresAt: clock + 3600000 }),
    advance: (ms) => { clock += ms; },
    setProfile: (id) => { profileId = id; },
    setGrant: (patch) => { grant = { ...grant, ...patch }; },
  };
}

test('native unattended hosting needs a Google owner and a verified service session, never a renderer flag', async () => {
  const f = fixture();
  await assert.rejects(f.authority.enable({ accountAuthorized: true, accountId: f.accountId, hostId: f.hostId }), /sesión/);
  await assert.rejects(f.authority.enable(f.credential), /cuenta que ha entrado/);
  assert.equal(f.authority.canCapture(), false);
  await f.owner();
  f.setProfile('another-account');
  await assert.rejects(f.authority.enable({ ...f.credential, accountAuthorized: true, accountId: f.accountId }), /cuenta que ha entrado/);
  f.setProfile(f.accountId);
  assert.equal(await f.authority.enable(f.credential), true);
  assert.equal(f.authority.canCapture(), true);
  assert.equal(f.authority.canControl(), false);
  assert.equal(f.calls.at(-1).headers.Authorization, `Bearer ${f.credential.accessToken}`);
  assert.equal(f.calls.at(-1).headers['X-Inhouse-Service-Key'], f.credential.serviceKey);
  assert.equal(f.calls.at(-1).redirect, 'error');
  f.authority.disable();
});

test('only an introspected active peer for this exact host and Google owner grants native input', async () => {
  const f = fixture();
  await f.owner(); await f.authority.enable(f.credential);
  const invalid = [
    { active: false }, { hostId: 'b'.repeat(32) }, { ownerAccountId: 'someone-else' },
    { viewerAccountId: 'someone-else' }, { connectionId: randomUUID() },
  ];
  for (const patch of invalid) {
    f.setGrant({ active: true, hostId: f.hostId, ownerAccountId: f.accountId, viewerAccountId: f.accountId, connectionId: f.connectionId, ...patch });
    assert.equal(await f.authority.authorizePeer(f.connectionId), false);
    assert.equal(f.authority.canControl(), false);
  }
  f.setGrant({ active: true, hostId: f.hostId, ownerAccountId: f.accountId, viewerAccountId: f.accountId, connectionId: f.connectionId });
  assert.equal(await f.authority.authorizePeer(f.connectionId), true);
  assert.equal(f.authority.canControl(), true);
  f.authority.endPeer();
  assert.equal(f.authority.canControl(), false);
  assert.equal(f.authority.canCapture(), true, 'viewer departure keeps the host available');
  f.authority.disable();
});

test('native metadata restores the bound 30-day session after the Google hour without saving credentials', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'inhouse-native-owner-'));
  const file = path.join(directory, 'owner.json');
  const f = fixture({ file });
  try {
    await f.owner(); await f.authority.enable(f.credential); f.authority.disable();
    const contents = await readFile(file, 'utf8');
    assert.equal(contents.includes(f.credential.accessToken), false);
    assert.equal(contents.includes(f.credential.serviceKey), false);
    assert.equal(contents.includes(createHash('sha256').update(f.credential.accessToken).digest('hex')), true);
    f.advance(2 * 3600000);
    const restored = createAccountHostingAuthority(f.config);
    assert.equal(await restored.enable(f.credential), true);
    restored.disable();
    await assert.rejects(restored.enable({ ...f.credential, accessToken: `ihl_${randomBytes(32).toString('base64url')}` }), /Vuelve a entrar con Google/);
    await assert.rejects(restored.enable({ ...f.credential, issuer: 'https://another.example.test' }), /Vuelve a entrar con Google/);
    await assert.rejects(restored.enable({ ...f.credential, hostId: 'c'.repeat(32) }), /Vuelve a entrar con Google/);
    restored.disable();
  } finally { f.authority.disable(); await rm(directory, { recursive: true, force: true }); }
});

test('sign-out and account switching release authority and prevent restoring another account binding', async () => {
  const f = fixture();
  await f.owner(); await f.authority.enable(f.credential); await f.authority.authorizePeer(f.connectionId);
  await f.authority.signOut();
  assert.equal(f.authority.canCapture(), false);
  assert.equal(f.authority.canControl(), false);
  await assert.rejects(f.authority.enable(f.credential), /Completa primero/);
  await f.authority.recordGoogleOwner({ id: 'new-owner', expiresAt: Date.now() + 3600000 });
  await assert.rejects(f.authority.enable(f.credential), /cuenta que ha entrado/);
  f.authority.disable();
});

test('lease expiry stops native input while owner expiry also revokes capture', async () => {
  const events = [];
  const f = fixture({ onPeerRevoked: (reason) => events.push(['peer', reason]), onHostingRevoked: (reason) => events.push(['host', reason]) });
  await f.owner(); await f.authority.enable(f.credential); await f.authority.authorizePeer(f.connectionId);
  f.advance(60001);
  assert.equal(f.authority.canControl(), false);
  assert.equal(f.authority.canCapture(), true);
  assert.equal(events[0][0], 'peer');
  f.advance(31 * 24 * 3600000);
  assert.equal(f.authority.canCapture(), false);
  assert.equal(events.at(-1)[0], 'host');
});

test('a failed live grant refresh releases input without making the PC unavailable', async () => {
  let revoked;
  const noticed = new Promise((resolve) => { revoked = resolve; });
  let grantCalls = 0;
  const f = fixture({ refreshMs: 10, onPeerRevoked: (reason) => revoked(reason) });
  const original = f.config.fetcher;
  f.config.fetcher = async (url, init) => {
    if (new URL(url).pathname.includes('/connection/') && ++grantCalls > 1) throw new Error('fixture outage');
    return original(url, init);
  };
  const authority = createAccountHostingAuthority(f.config);
  const keepAlive = setInterval(() => {}, 1000);
  try {
    await authority.recordGoogleOwner({ id: f.accountId, expiresAt: Date.now() + 3600000 });
    await authority.enable(f.credential);
    assert.equal(await authority.authorizePeer(f.connectionId), true);
    await noticed;
    assert.equal(authority.canControl(), false);
    assert.equal(authority.canCapture(), true);
  } finally { authority.disable(); clearInterval(keepAlive); }
});

test('voluntary teardown and an old delayed refresh cannot revoke or notify a newer pair', async () => {
  let cleanupCount = 0;
  const notices = [];
  const handler = createPeerRevocationHandler(() => cleanupCount++, (reason) => notices.push(reason));
  const f = fixture({ refreshMs: 10, onPeerRevoked: handler });
  const nextConnectionId = randomUUID();
  const original = f.config.fetcher;
  let failOldRefresh;
  let noteOldRefresh;
  const oldRefreshStarted = new Promise((resolve) => { noteOldRefresh = resolve; });
  let oldGrantCalls = 0;
  f.config.fetcher = async (url, init) => {
    const pathname = new URL(url).pathname;
    if (pathname.endsWith(nextConnectionId)) return new Response(JSON.stringify({
      active: true, connectionId: nextConnectionId, hostId: f.hostId,
      ownerAccountId: f.accountId, viewerAccountId: f.accountId, expiresAt: Date.now() + 60000,
    }));
    if (pathname.endsWith(f.connectionId) && ++oldGrantCalls > 1) {
      noteOldRefresh();
      return new Promise((_resolve, reject) => { failOldRefresh = reject; });
    }
    return original(url, init);
  };
  const authority = createAccountHostingAuthority(f.config);
  const keepAlive = setInterval(() => {}, 1000);
  try {
    await authority.recordGoogleOwner({ id: f.accountId, expiresAt: Date.now() + 3600000 });
    await authority.enable(f.credential);
    assert.equal(await authority.authorizePeer(f.connectionId), true);
    await oldRefreshStarted;
    authority.endPeer();
    assert.equal(cleanupCount, 1);
    assert.deepEqual(notices, [], 'voluntary end must not enqueue a renderer event');
    assert.equal(await authority.authorizePeer(nextConnectionId), true);
    failOldRefresh(new Error('old connection is gone'));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(authority.canControl(), true);
    assert.equal(cleanupCount, 1, 'a stale refresh must not release the new pair');
    assert.deepEqual(notices, []);
    authority.endPeer('The current permission was revoked.');
    assert.equal(cleanupCount, 2);
    assert.deepEqual(notices, ['The current permission was revoked.']);
    assert.equal(authority.canControl(), false);
    assert.equal(authority.canCapture(), true);
  } finally { authority.disable(); clearInterval(keepAlive); }
});

test('a late service response cannot reactivate capture after a concurrent disable', async () => {
  let finish;
  let started;
  const observed = new Promise((resolve) => { started = resolve; });
  const response = new Promise((resolve) => { finish = resolve; });
  const f = fixture({ fetcher: async () => { started(); return response; } });
  await f.owner();
  const enabling = f.authority.enable(f.credential);
  await observed;
  f.authority.disable();
  finish(new Response(JSON.stringify({ profile: { id: f.accountId }, expiresAt: Date.now() + 3600000 })));
  assert.equal(await enabling, false);
  assert.equal(f.authority.canCapture(), false);
});

test('a superseded Google owner verification cannot unlock hosting during a newer login', async () => {
  const f = fixture();
  const oldOwner = f.owner();
  f.authority.pauseForLogin();
  assert.equal(await oldOwner, false);
  await assert.rejects(f.authority.enable(f.credential), /Completa primero/);
  assert.equal(f.authority.canCapture(), false);
});

test('native owner storage corruption fails closed without replacing the user file', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'inhouse-native-bad-store-'));
  const file = path.join(directory, 'owner.json');
  await writeFile(file, '{invalid native metadata');
  const f = fixture({ file });
  try {
    await assert.rejects(f.authority.enable(f.credential), /registro local/);
    assert.equal(await readFile(file, 'utf8'), '{invalid native metadata');
    assert.equal(f.authority.canCapture(), false);
  } finally { f.authority.disable(); await rm(directory, { recursive: true, force: true }); }
});

test('native service verification rejects credential URLs and remote plaintext HTTP', () => {
  for (const issuer of ['http://remote.example', 'https://user:password@link.example', 'https://link.example/path', 'https://link.example/?token=something']) {
    assert.throws(() => normalizeIssuer(issuer));
  }
  assert.equal(normalizeIssuer('http://127.0.0.1:48715'), 'http://127.0.0.1:48715');
});
