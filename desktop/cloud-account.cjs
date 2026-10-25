'use strict';

const { randomBytes, randomUUID } = require('node:crypto');
const { readFile, stat, mkdir, writeFile, rename, unlink } = require('node:fs/promises');
const path = require('node:path');

const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
const LEASE_MS = 45000;
const ID = /^[A-Za-z0-9._:-]{1,256}$/;
const cryptoHelpers = import('../server/drive-realm.mjs');

function normalizeSession(realm, profile, expiresAt, now) {
  if (!realm || !profile || !ID.test(profile.id ?? '') || realm.accountId !== profile.id
    || typeof realm.fileId !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(realm.fileId)
    || (realm.id !== undefined && realm.id !== realm.fileId)
    || typeof realm.secret !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(realm.secret)
    || Buffer.from(realm.secret, 'base64url').toString('base64url') !== realm.secret
    || typeof profile.email !== 'string' || profile.email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(profile.email)
    || !Number.isFinite(expiresAt) || expiresAt <= now || expiresAt > now + THIRTY_DAYS + 1000) {
    throw new Error('No se pudo verificar la cuenta privada de Google Drive.');
  }
  return {
    realm: { id: realm.fileId, fileId: realm.fileId, accountId: profile.id, secret: realm.secret },
    profile: { id: profile.id, email: profile.email, name: typeof profile.name === 'string' ? profile.name.slice(0, 256) : profile.email,
      photo: typeof profile.photo === 'string' && profile.photo.startsWith('https://') ? profile.photo.slice(0, 2048) : '' },
    expiresAt,
  };
}

function createCloudAccountAuthority(options = {}) {
  const now = options.now ?? Date.now;
  const file = options.file ?? null;
  const leaseMs = Math.min(LEASE_MS, Math.max(1, options.leaseMs ?? LEASE_MS));
  let session = null;
  let loaded = false;
  let loginPending = false;
  let sessionEpoch = 0;
  let generation = 0;
  let peerGeneration = 0;
  let hosting = null;
  let peer = null;
  let ownerTimer = null;
  let peerTimer = null;
  let queue = Promise.resolve();
  const consumed = new Set();

  function protectedStorageAvailable() {
    try {
      return typeof options.protect === 'function' && typeof options.unprotect === 'function'
        && (typeof options.isProtectionAvailable !== 'function' || options.isProtectionAvailable());
    } catch { return false; }
  }

  function fileOperation(action) {
    const operation = queue.catch(() => {}).then(action);
    queue = operation;
    return operation;
  }

  function snapshot() {
    return session ? { realm: { ...session.realm }, profile: { ...session.profile }, expiresAt: session.expiresAt } : null;
  }

  function endPeer(reason = '') {
    peerGeneration++;
    clearTimeout(peerTimer); peerTimer = null;
    const previous = peer;
    peer = null;
    if (previous) options.onPeerRevoked?.(reason);
  }

  function disable(reason = '') {
    generation++;
    endPeer(reason);
    const previous = hosting;
    hosting = null;
    consumed.clear();
    if (previous && reason) options.onHostingRevoked?.(reason);
  }

  function current() {
    if (session && session.expiresAt <= now()) {
      disable('La sesión de tu cuenta ha caducado. Vuelve a entrar con Google.');
      session = null;
    }
    return !loginPending && session;
  }

  function armOwnerExpiry() {
    clearTimeout(ownerTimer);
    if (!session) return;
    if (!current()) return;
    ownerTimer = setTimeout(armOwnerExpiry, Math.min(Math.max(1, session.expiresAt - now()), 2_000_000_000));
    ownerTimer.unref?.();
  }

  async function recordSession(realm, profile) {
    const value = normalizeSession(realm, profile, now() + THIRTY_DAYS, now());
    const run = ++sessionEpoch;
    loginPending = true;
    disable();
    clearTimeout(ownerTimer); ownerTimer = null;
    session = null;
    let protectedBytes = null;
    if (file && protectedStorageAvailable()) {
      try { protectedBytes = Buffer.from(options.protect(JSON.stringify({ version: 1, ...value }))); }
      catch { protectedBytes = null; }
    }
    await fileOperation(async () => {
      if (!file) return;
      if (!protectedBytes) {
        // No plaintext fallback, and no old account cache resurrected on restart.
        await unlink(file).catch((error) => { if (error.code !== 'ENOENT') throw new Error('No se pudo actualizar la cuenta privada local.'); });
        return;
      }
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
        await writeFile(temporary, protectedBytes, { flag: 'wx', mode: 0o600 });
        await rename(temporary, file);
      } catch {
        await unlink(temporary).catch(() => {});
        throw new Error('No se pudo guardar la cuenta privada local.');
      }
    });
    if (run !== sessionEpoch) return null;
    session = value;
    loaded = true;
    loginPending = false;
    armOwnerExpiry();
    return snapshot();
  }

  async function restore() {
    if (loginPending) return null;
    if (current()) return snapshot();
    if (loaded || !file || !protectedStorageAvailable()) return null;
    const run = sessionEpoch;
    await queue.catch(() => {});
    try {
      const info = await stat(file);
      if (!info.isFile() || info.size > 64 * 1024) throw new Error('Invalid protected account cache.');
      const protectedBytes = await readFile(file);
      const stored = JSON.parse(options.unprotect(protectedBytes));
      if (stored?.version !== 1) throw new Error('Unsupported protected account cache.');
      const value = normalizeSession(stored.realm, stored.profile, stored.expiresAt, now());
      if (run !== sessionEpoch || loginPending) return null;
      session = value;
      loaded = true;
      armOwnerExpiry();
      return snapshot();
    } catch {
      if (run === sessionEpoch) loaded = true;
      return null;
    }
  }

  function beginLogin() {
    sessionEpoch++;
    loginPending = true;
    disable();
    clearTimeout(ownerTimer); ownerTimer = null;
    session = null;
  }

  async function forget() {
    beginLogin();
    loaded = true;
    await fileOperation(async () => {
      if (!file) return;
      await unlink(file).catch((error) => { if (error.code !== 'ENOENT') throw new Error('No se pudo cerrar la cuenta privada local.'); });
    });
  }

  async function enable(input) {
    disable();
    const run = generation;
    const saved = await restore();
    if (run !== generation || !saved || input?.accountId !== saved.profile.id || !ID.test(input?.hostId ?? '')) return null;
    hosting = { accountId: saved.profile.id, hostId: input.hostId, challenge: randomBytes(32).toString('base64url') };
    return { challenge: hosting.challenge };
  }

  function canCapture() { return Boolean(current() && hosting); }

  function canControl() {
    if (!canCapture()) return false;
    if (peer && peer.expiresAt <= now()) endPeer('Ha caducado la autorización de esta conexión.');
    return peer !== null;
  }

  function armPeerExpiry() {
    clearTimeout(peerTimer);
    const expected = peer;
    if (!expected) return;
    const epoch = peerGeneration;
    peerTimer = setTimeout(() => {
      if (peer !== expected || epoch !== peerGeneration) return;
      if (peer.expiresAt <= now()) endPeer('Se ha perdido la confirmación del equipo conectado.');
      else armPeerExpiry();
    }, Math.max(1, peer.expiresAt - now()));
    peerTimer.unref?.();
  }

  async function authorizePeer(packet) {
    if (!canCapture()) return false;
    // Expiring an old peer may notify the renderer. Never accept a new peer in
    // that same operation and let the queued old event tear down the new one.
    if (peer) { canControl(); return false; }
    if (consumed.size >= 4096 || typeof packet?.connectionId !== 'string' || consumed.has(packet.connectionId)) return false;
    const owner = hosting;
    const saved = session;
    const run = generation;
    const peerRun = peerGeneration;
    const { verifyAccountPeerProof } = await cryptoHelpers;
    const valid = await verifyAccountPeerProof(saved.realm.secret, packet, {
      expectedAccountId: owner.accountId, expectedHostId: owner.hostId, expectedChallenge: owner.challenge,
      expectedPurpose: 'connect', maxAgeMs: 60000, now,
    });
    if (!valid || run !== generation || peerRun !== peerGeneration || owner !== hosting || saved !== session
      || !canCapture() || peer || consumed.has(packet.connectionId)) return false;
    consumed.add(packet.connectionId);
    peer = { connectionId: packet.connectionId, viewerId: packet.viewerId,
      counter: packet.counter ?? -1, expiresAt: Math.min(now() + leaseMs, session.expiresAt) };
    armPeerExpiry();
    return true;
  }

  async function renewPeer(packet) {
    if (!canControl()) return false;
    const owner = hosting;
    const saved = session;
    const expected = peer;
    const run = generation;
    const peerRun = peerGeneration;
    const { verifyAccountPeerProof } = await cryptoHelpers;
    const valid = await verifyAccountPeerProof(saved.realm.secret, packet, {
      expectedAccountId: owner.accountId, expectedHostId: owner.hostId, expectedViewerId: expected.viewerId,
      expectedConnectionId: expected.connectionId, expectedChallenge: owner.challenge, expectedPurpose: 'keepalive',
      minCounter: expected.counter, maxAgeMs: 60000, now,
    });
    if (!valid || run !== generation || peerRun !== peerGeneration || owner !== hosting || saved !== session || expected !== peer
      || !canControl() || packet.counter <= peer.counter) return false;
    peer.counter = packet.counter;
    peer.expiresAt = Math.min(now() + leaseMs, session.expiresAt);
    armPeerExpiry();
    return true;
  }

  return { recordSession, restore, beginLogin, forget, enable, authorizePeer, renewPeer, endPeer, disable, canCapture, canControl, flush: () => queue };
}

module.exports = { createCloudAccountAuthority };
