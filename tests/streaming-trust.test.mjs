import test from 'node:test';
import assert from 'node:assert/strict';
import { GOOGLE_SESSION_KEY } from '../src/lib/google-account.ts';
import {
  createCredential, getTrustedDevices, getTrustedHosts, identityForNonce, prove,
  saveDevice, saveHost, verifyProof, clearTrustedDevices, forgetTrustedHost,
} from '../src/lib/trust.ts';

const memory = new Map();
globalThis.localStorage = {
  getItem: (key) => memory.get(key) ?? null,
  setItem: (key, value) => memory.set(key, value),
  removeItem: (key) => memory.delete(key),
};

test('pairing proof is bound to both a fresh nonce and the target host', async () => {
  const credential = createCredential('Portátil de prueba');
  const proof = await prove(credential.token, 'nonce-one:host-one');
  assert.equal(await verifyProof(credential.token, 'nonce-one:host-one', proof), true);
  assert.equal(await verifyProof(credential.token, 'nonce-two:host-one', proof), false);
  assert.equal(await verifyProof(credential.token, 'nonce-one:host-two', proof), false);
  assert.equal(await verifyProof(createCredential('Otro equipo').token, 'nonce-one:host-one', proof), false);
});

test('host identity persists and proves possession of its private key', async () => {
  const one = await identityForNonce('nonce-one');
  const two = await identityForNonce('nonce-two');
  assert.equal(one.deviceId, two.deviceId);
  assert.match(one.deviceId, /^[a-f0-9]{32}$/);
  const key = await crypto.subtle.importKey('jwk', one.identity.publicKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const signature = Uint8Array.from(Buffer.from(one.identity.signature, 'base64url'));
  assert.equal(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, signature, new TextEncoder().encode('nonce-one')), true);
  assert.equal(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, signature, new TextEncoder().encode('nonce-two')), false);
  assert.equal('d' in one.identity.publicKey, false);
});

test('public device lists never expose pairing tokens and can be revoked', () => {
  const credential = createCredential('Mi portátil');
  saveDevice(credential);
  saveHost({ ...credential, deviceId: 'a'.repeat(32), lastSeen: Date.now() });
  assert.equal(getTrustedDevices().some((device) => 'token' in device), false);
  assert.equal(getTrustedHosts().some((host) => 'token' in host || 'id' in host), false);
  assert.equal(getTrustedHosts().length, 1);
  forgetTrustedHost('a'.repeat(32));
  clearTrustedDevices();
  assert.equal(getTrustedHosts().length, 0);
  assert.equal(getTrustedDevices().length, 0);
});

test('saved hosts, trusted viewers and host identity are isolated by Google account', async () => {
  const signIn = (id) => localStorage.setItem(GOOGLE_SESSION_KEY, JSON.stringify({
    accessToken: `test-access-${id}`, expiresAt: Date.now() + 3_600_000,
    profile: { id, name: id, email: `${id}@example.test`, photo: '' },
  }));
  signIn('first-account');
  const credential = createCredential('Portátil vinculado');
  saveDevice(credential);
  saveHost({ ...credential, deviceId: 'c'.repeat(32), lastSeen: Date.now() });
  const firstIdentity = await identityForNonce('first-account-nonce');
  assert.equal(getTrustedHosts().length, 1);
  assert.equal(getTrustedDevices().length, 1);
  signIn('second-account');
  assert.equal(getTrustedHosts().length, 0);
  assert.equal(getTrustedDevices().length, 0);
  const secondIdentity = await identityForNonce('second-account-nonce');
  assert.notEqual(secondIdentity.deviceId, firstIdentity.deviceId);
  signIn('first-account');
  assert.equal(getTrustedHosts().length, 1);
  assert.equal(getTrustedDevices().length, 1);
  assert.equal((await identityForNonce('returning-account')).deviceId, firstIdentity.deviceId);
  clearTrustedDevices();
  forgetTrustedHost('c'.repeat(32));
  localStorage.removeItem(GOOGLE_SESSION_KEY);
});

function signIn(id) {
  localStorage.setItem(GOOGLE_SESSION_KEY, JSON.stringify({
    accessToken: `test-access-${id}`, expiresAt: Date.now() + 3_600_000,
    profile: { id, name: id, email: `${id}@example.test`, photo: '' },
  }));
}

function accountFixture(t, id) {
  const previous = localStorage.getItem(GOOGLE_SESSION_KEY);
  t.after(() => { if (previous === null) localStorage.removeItem(GOOGLE_SESSION_KEY); else localStorage.setItem(GOOGLE_SESSION_KEY, previous); });
  signIn(id);
  return `inhouse.hostIdentity.v1:${encodeURIComponent(id)}`;
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('concurrent first identities share one device and each signature authenticates its own nonce', async (t) => {
  const storageKey = accountFixture(t, 'concurrent-first-identity');
  const nonces = Array.from({ length: 8 }, (_, index) => `parallel-challenge-${index}`);
  const identities = await Promise.all(nonces.map((nonce) => identityForNonce(nonce)));
  const first = identities[0];
  const key = await crypto.subtle.importKey('jwk', first.identity.publicKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const saved = JSON.parse(localStorage.getItem(storageKey));
  assert.deepEqual(saved.publicKey, first.identity.publicKey);
  for (const [index, identity] of identities.entries()) {
    assert.equal(identity.deviceId, first.deviceId);
    assert.deepEqual(identity.identity.publicKey, first.identity.publicKey);
    const signature = Buffer.from(identity.identity.signature, 'base64url');
    assert.equal(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, signature, new TextEncoder().encode(nonces[index])), true);
    assert.equal(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, signature, new TextEncoder().encode(nonces[(index + 1) % nonces.length])), false);
    assert.equal('d' in identity.identity.publicKey, false);
  }
});

test('a pending identity from a changed account cannot write or replace the new account identity', async (t) => {
  const oldStorageKey = accountFixture(t, 'pending-old-account');
  const started = deferred(), gate = deferred();
  const generateKey = crypto.subtle.generateKey;
  let calls = 0;
  crypto.subtle.generateKey = async function (...args) {
    const result = await generateKey.apply(this, args);
    if (++calls === 1) { started.resolve(); await gate.promise; }
    return result;
  };
  t.after(() => { gate.resolve(); crypto.subtle.generateKey = generateKey; });
  const canceled = assert.rejects(identityForNonce('old-account-challenge'), /cuenta/);
  await started.promise;
  signIn('pending-new-account');
  const fresh = await identityForNonce('new-account-challenge');
  const newStorageKey = 'inhouse.hostIdentity.v1:pending-new-account';
  const saved = localStorage.getItem(newStorageKey);
  gate.resolve();
  await canceled;
  assert.equal(localStorage.getItem(oldStorageKey), null);
  assert.equal(localStorage.getItem(newStorageKey), saved);
  assert.equal((await identityForNonce('new-account-again')).deviceId, fresh.deviceId);
});

test('revoking during first generation cancels old work without evicting a newer shared initialization', async (t) => {
  const storageKey = accountFixture(t, 'pending-revoked-generation');
  const firstStarted = deferred(), secondStarted = deferred();
  const firstGate = deferred(), secondGate = deferred();
  const generateKey = crypto.subtle.generateKey;
  let calls = 0;
  crypto.subtle.generateKey = async function (...args) {
    const index = ++calls;
    const result = await generateKey.apply(this, args);
    if (index === 1) { firstStarted.resolve(); await firstGate.promise; }
    if (index === 2) { secondStarted.resolve(); await secondGate.promise; }
    return result;
  };
  t.after(() => { firstGate.resolve(); secondGate.resolve(); crypto.subtle.generateKey = generateKey; });
  const revoked = assert.rejects(identityForNonce('before-revocation'), /cuenta/);
  await firstStarted.promise;
  clearTrustedDevices();
  const freshOne = identityForNonce('after-revocation-one');
  await secondStarted.promise;
  firstGate.resolve();
  await revoked;
  assert.equal(localStorage.getItem(storageKey), null);
  const freshTwo = identityForNonce('after-revocation-two');
  secondGate.resolve();
  const [one, two] = await Promise.all([freshOne, freshTwo]);
  assert.equal(one.deviceId, two.deviceId);
  assert.deepEqual(one.identity.publicKey, two.identity.publicKey);
  assert.deepEqual(JSON.parse(localStorage.getItem(storageKey)).publicKey, one.identity.publicKey);
});

test('an account change during signing cannot return an already stored identity from the old scope', async (t) => {
  accountFixture(t, 'pending-signature-account');
  await identityForNonce('initial-identity');
  const started = deferred(), gate = deferred();
  const sign = crypto.subtle.sign;
  crypto.subtle.sign = async function (...args) {
    const result = await sign.apply(this, args);
    started.resolve();
    await gate.promise;
    return result;
  };
  t.after(() => { gate.resolve(); crypto.subtle.sign = sign; });
  const canceled = assert.rejects(identityForNonce('signature-in-progress'), /cuenta/);
  await started.promise;
  signIn('changed-during-signature');
  gate.resolve();
  await canceled;
  assert.equal(localStorage.getItem('inhouse.hostIdentity.v1:changed-during-signature'), null);
});
