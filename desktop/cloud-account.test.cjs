'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes, randomUUID, createCipheriv, createDecipheriv } = require('node:crypto');
const { mkdtemp, readFile, writeFile, stat, access, rm } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createCloudAccountAuthority } = require('./cloud-account.cjs');
const { createPeerRevocationHandler } = require('./account-hosting.cjs');
const helpers = import('../server/drive-realm.mjs');

function fixture(options = {}) {
  let clock = Date.now();
  const profile = { id: 'google-drive-owner', name: 'Owner', email: 'owner@example.test', photo: '' };
  const realm = { id: 'private-drive-file', fileId: 'private-drive-file', accountId: profile.id, secret: randomBytes(32).toString('base64url') };
  const config = { now: () => clock, ...options };
  const authority = createCloudAccountAuthority(config);
  const hostId = 'a'.repeat(32);
  const viewerId = 'b'.repeat(32);
  return {
    profile, realm, config, authority, hostId, viewerId,
    time: () => clock,
    advance: (ms) => { clock += ms; },
    async ready() {
      await authority.recordSession(realm, profile);
      return authority.enable({ accountId: profile.id, hostId });
    },
    async proof(challenge, patch = {}, secret = realm.secret) {
      const { createAccountPeerProof } = await helpers;
      return createAccountPeerProof(secret, { accountId: profile.id, hostId, viewerId, connectionId: randomUUID(), challenge,
        purpose: 'connect', issuedAt: clock, counter: 0, ...patch });
    },
  };
}

/** A real authenticated cipher substitutes only the OS protected-storage API.
 * These tests do not claim that Windows DPAPI ran on this Linux test machine. */
function protectedStorage(key = randomBytes(32)) {
  return {
    protect(value) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      return Buffer.concat([iv, cipher.update(value, 'utf8'), cipher.final(), cipher.getAuthTag()]);
    },
    unprotect(bytes) {
      const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(-16));
      return Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]).toString('utf8');
    },
  };
}

test('cloud capture uses the main-owned Google realm and ignores a renderer-supplied secret', async () => {
  const f = fixture();
  try {
    assert.equal(await f.authority.enable({ accountId: f.profile.id, hostId: f.hostId, secret: f.realm.secret }), null);
    await f.authority.recordSession(f.realm, f.profile);
    assert.equal(await f.authority.enable({ accountId: 'another-owner', hostId: f.hostId }), null);
    const enabled = await f.authority.enable({ accountId: f.profile.id, hostId: f.hostId, secret: randomBytes(32).toString('base64url') });
    assert.match(enabled.challenge, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(f.authority.canCapture(), true);
    assert.equal(f.authority.canControl(), false);
    assert.equal(await f.authority.authorizePeer(await f.proof(enabled.challenge, {}, randomBytes(32).toString('base64url'))), false);
    assert.equal(await f.authority.authorizePeer(await f.proof(enabled.challenge)), true);
    assert.equal(f.authority.canControl(), true);
  } finally { f.authority.disable(); }
});

test('cloud peer authorization rejects wrong owner, host, challenge, stale and future proofs', async () => {
  const f = fixture();
  try {
    const { challenge } = await f.ready();
    for (const patch of [
      { accountId: 'another-owner' }, { hostId: 'another-host' }, { challenge: randomBytes(32).toString('base64url') },
      { issuedAt: f.time() - 60001 }, { issuedAt: f.time() + 5001 }, { purpose: 'keepalive', counter: 1 },
    ]) {
      assert.equal(await f.authority.authorizePeer(await f.proof(challenge, patch)), false);
      assert.equal(f.authority.canControl(), false);
    }
    assert.equal(await f.authority.authorizePeer(await f.proof(challenge)), true);
  } finally { f.authority.disable(); }
});

test('consumed connection IDs cannot be replayed after disconnect and a new challenge rejects old proofs', async () => {
  let releases = 0;
  const notices = [];
  const f = fixture({ onPeerRevoked: createPeerRevocationHandler(() => releases++, (reason) => notices.push(reason)) });
  try {
    const { challenge } = await f.ready();
    const initial = await f.proof(challenge);
    assert.equal(await f.authority.authorizePeer(initial), true);
    f.authority.endPeer();
    assert.equal(releases, 1);
    assert.deepEqual(notices, []);
    assert.equal(f.authority.canCapture(), true);
    assert.equal(await f.authority.authorizePeer(initial), false);
    assert.equal(await f.authority.authorizePeer(await f.proof(challenge, { connectionId: initial.connectionId })), false);
    const replacement = await f.authority.enable({ accountId: f.profile.id, hostId: f.hostId });
    assert.notEqual(replacement.challenge, challenge);
    assert.equal(await f.authority.authorizePeer(await f.proof(challenge)), false);
    assert.equal(await f.authority.authorizePeer(await f.proof(replacement.challenge)), true);
  } finally { f.authority.disable(); }
});

test('keepalive requires the current viewer, connection, purpose and a strictly increasing counter', async () => {
  const f = fixture();
  try {
    const { challenge } = await f.ready();
    const initial = await f.proof(challenge);
    assert.equal(await f.authority.authorizePeer(initial), true);
    f.advance(30000);
    const next = await f.proof(challenge, { connectionId: initial.connectionId, purpose: 'keepalive', counter: 1 });
    assert.equal(await f.authority.renewPeer(next), true);
    assert.equal(await f.authority.renewPeer(next), false);
    for (const patch of [{ viewerId: 'another-viewer' }, { connectionId: randomUUID() }, { purpose: 'connect' }, { issuedAt: f.time() - 60001 }]) {
      assert.equal(await f.authority.renewPeer(await f.proof(challenge, { ...next, counter: 2, ...patch })), false);
    }
    f.advance(20000);
    assert.equal(f.authority.canControl(), true, 'a valid keepalive renewed the original 45-second lease');
    f.advance(25001);
    assert.equal(f.authority.canControl(), false);
    assert.equal(f.authority.canCapture(), true);
    assert.equal(await f.authority.renewPeer(await f.proof(challenge, { connectionId: initial.connectionId, purpose: 'keepalive', counter: 3 })), false);
  } finally { f.authority.disable(); }
});

test('concurrent duplicate connects and stale asynchronous crypto cannot reactivate a disabled host', async () => {
  const f = fixture();
  try {
    const { challenge } = await f.ready();
    const initial = await f.proof(challenge);
    const decisions = await Promise.all([f.authority.authorizePeer(initial), f.authority.authorizePeer(initial)]);
    assert.equal(decisions.filter(Boolean).length, 1);
    f.authority.endPeer();
    const pending = f.authority.authorizePeer(await f.proof(challenge));
    f.authority.disable();
    assert.equal(await pending, false);
    assert.equal(f.authority.canCapture(), false);
    assert.equal(f.authority.canControl(), false);
  } finally { f.authority.disable(); }
});

test('protected storage restores the same realm after Google expiry without exposing it on disk', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'inhouse-protected-cloud-'));
  const file = path.join(directory, 'realm.bin');
  const storage = protectedStorage();
  const f = fixture({ file, ...storage });
  try {
    const saved = await f.authority.recordSession(f.realm, f.profile);
    const bytes = await readFile(file);
    assert.equal(bytes.includes(Buffer.from(f.realm.secret)), false);
    assert.equal(bytes.includes(Buffer.from(f.profile.email)), false);
    if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600);
    f.advance(2 * 3600000);
    const restored = createCloudAccountAuthority(f.config);
    assert.deepEqual(await restored.restore(), saved);
    assert.equal((await restored.restore()).expiresAt, saved.expiresAt, 'restoration never extends expiry');
    const enabled = await restored.enable({ accountId: f.profile.id, hostId: f.hostId });
    assert.equal(await restored.authorizePeer(await f.proof(enabled.challenge)), true);
    restored.disable();
    const wrongUser = createCloudAccountAuthority({ file, ...protectedStorage(), now: f.config.now });
    assert.equal(await wrongUser.restore(), null);
    const corrupted = Buffer.from(bytes); corrupted[15] ^= 1;
    await writeFile(file, corrupted);
    assert.equal(await createCloudAccountAuthority(f.config).restore(), null);
  } finally { f.authority.disable(); await rm(directory, { recursive: true, force: true }); }
});

test('unavailable protected storage keeps the realm only in memory and removes an older account cache', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'inhouse-memory-cloud-'));
  const file = path.join(directory, 'realm.bin');
  await writeFile(file, 'an older protected cache');
  let protectionCalls = 0;
  const f = fixture({ file, isProtectionAvailable: () => false,
    protect: () => { protectionCalls++; throw new Error('not available'); }, unprotect: () => { throw new Error('not available'); } });
  try {
    const saved = await f.authority.recordSession(f.realm, f.profile);
    assert.deepEqual(await f.authority.restore(), saved);
    assert.equal(protectionCalls, 0);
    await assert.rejects(access(file), { code: 'ENOENT' });
    assert.equal(await createCloudAccountAuthority(f.config).restore(), null);
  } finally { f.authority.disable(); await rm(directory, { recursive: true, force: true }); }
});

test('logout removes protected state, and a concurrent login write cannot resurrect it', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'inhouse-cloud-logout-'));
  const file = path.join(directory, 'realm.bin');
  const f = fixture({ file, ...protectedStorage() });
  try {
    const recording = f.authority.recordSession(f.realm, f.profile);
    const forgetting = f.authority.forget();
    assert.equal(await recording, null);
    await forgetting;
    await assert.rejects(access(file), { code: 'ENOENT' });
    assert.equal(await f.authority.restore(), null);
    assert.equal(f.authority.canControl(), false);
    assert.equal(await createCloudAccountAuthority(f.config).restore(), null);
  } finally { f.authority.disable(); await rm(directory, { recursive: true, force: true }); }
});

test('the local cloud session expires after 30 days and cannot be extended by renderer claims', async () => {
  const reasons = [];
  const f = fixture({ onHostingRevoked: (reason) => reasons.push(reason) });
  try {
    const { challenge } = await f.ready();
    await f.authority.authorizePeer(await f.proof(challenge));
    f.advance(30 * 24 * 3600000 + 1);
    assert.equal(f.authority.canCapture(), false);
    assert.equal(f.authority.canControl(), false);
    assert.equal(await f.authority.restore(), null);
    assert.equal(await f.authority.enable({ accountId: f.profile.id, hostId: f.hostId, realm: f.realm, expiresAt: f.time() + 30 * 24 * 3600000 }), null);
    assert.equal(reasons.length, 1);
  } finally { f.authority.disable(); }
});
