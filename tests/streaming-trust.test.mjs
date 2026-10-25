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
