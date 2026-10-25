'use strict';

const { createHash, randomUUID } = require('node:crypto');
const { readFile, stat, mkdir, writeFile, rename, unlink } = require('node:fs/promises');
const path = require('node:path');

const MAX_SESSION = 30 * 24 * 60 * 60 * 1000;
const tokenHash = (value) => createHash('sha256').update(value).digest('hex');
const validId = (value) => typeof value === 'string' && value.length > 0 && value.length <= 256;

/** Voluntary teardown releases native state synchronously, but must not enqueue
 * a renderer revocation event that could arrive after the next pair starts. */
function createPeerRevocationHandler(release, notify) {
  return (reason) => {
    release();
    if (typeof reason === 'string' && reason.length > 0) notify(reason);
  };
}

function normalizeIssuer(value) {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('La dirección del servicio no es válida.');
  const url = new URL(value);
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/'
    || (url.protocol !== 'https:' && !(local && url.protocol === 'http:'))) throw new Error('El servicio debe usar HTTPS o una dirección local.');
  return url.origin;
}

/** Native authority for account-owned capture and input. Renderer claims are not
 * identities: Google establishes the owner, the service verifies the session,
 * and an introspected live connection grant establishes each remote peer. */
function createAccountHostingAuthority(options = {}) {
  const fetcher = options.fetcher ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const file = options.file ?? null;
  const timeoutMs = options.timeoutMs ?? 8000;
  const refreshMs = options.refreshMs ?? 30000;
  let document = { version: 1, currentOwnerId: null, owners: [], bindings: [] };
  let loaded = false;
  let queue = Promise.resolve();
  let generation = 0;
  let peerGeneration = 0;
  let active = null;
  let lease = null;
  let leaseTimer = null;
  let ownerTimer = null;
  let loginPending = false;
  let ownerEpoch = 0;
  const requests = new Set();

  async function load() {
    if (loaded) return;
    if (file) {
      try {
        const info = await stat(file);
        if (!info.isFile() || info.size > 128 * 1024) throw new Error('Invalid native account store.');
        const contents = await readFile(file, 'utf8');
        if (Buffer.byteLength(contents) > 128 * 1024) throw new Error('Invalid native account store.');
        const stored = JSON.parse(contents);
        if (stored?.version !== 1 || !Array.isArray(stored.owners) || !Array.isArray(stored.bindings)
          || stored.owners.length > 20 || stored.bindings.length > 60) throw new Error('Invalid native account store.');
        document.currentOwnerId = validId(stored.currentOwnerId) ? stored.currentOwnerId : null;
        document.owners = stored.owners.filter((owner) => validId(owner.id) && Number.isFinite(owner.googleValidUntil));
        document.bindings = stored.bindings.filter((binding) => validId(binding.accountId) && /^[a-f0-9]{32}$/.test(binding.hostId ?? '')
          && /^[a-f0-9]{64}$/.test(binding.tokenHash ?? '') && Number.isFinite(binding.expiresAt)
          && binding.expiresAt > now() && normalizeIssuer(binding.issuer) === binding.issuer);
      } catch (error) {
        if (error.code !== 'ENOENT') throw new Error('No se pudo verificar el registro local de esta cuenta. Vuelve a entrar con Google.');
      }
    }
    loaded = true;
  }

  function persist() {
    const snapshot = JSON.stringify(document);
    const operation = queue.catch(() => {}).then(async () => {
      if (!file) return;
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
        await writeFile(temporary, snapshot, { flag: 'wx', mode: 0o600 });
        await rename(temporary, file);
      } catch {
        await unlink(temporary).catch(() => {});
        throw new Error('No se pudo guardar la autorización local de esta cuenta.');
      }
    });
    queue = operation;
    return operation;
  }

  async function recordGoogleOwner(account) {
    const run = ownerEpoch;
    if (!validId(account?.id) || !Number.isFinite(account.expiresAt) || account.expiresAt <= now()) {
      throw new Error('Google no ha verificado una cuenta válida para este equipo.');
    }
    await load();
    if (run !== ownerEpoch) return false;
    document.currentOwnerId = account.id;
    document.owners = [...document.owners.filter((owner) => owner.id !== account.id), {
      id: account.id, googleValidUntil: Math.min(account.expiresAt, now() + 24 * 60 * 60 * 1000),
    }].slice(-20);
    await persist();
    if (run !== ownerEpoch) return false;
    loginPending = false;
    return true;
  }

  function endPeer(reason = '') {
    peerGeneration++;
    clearTimeout(leaseTimer); leaseTimer = null;
    const previous = lease;
    lease = null;
    if (previous) options.onPeerRevoked?.(reason);
  }

  function disable(reason = '') {
    generation++;
    for (const request of requests) request.abort();
    requests.clear();
    clearTimeout(ownerTimer); ownerTimer = null;
    endPeer(reason);
    const previous = active;
    active = null;
    if (previous && reason) options.onHostingRevoked?.(reason);
  }

  async function readJson(issuer, pathname, credential) {
    const controller = new AbortController();
    requests.add(controller);
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    try {
      const response = await fetcher(new URL(pathname, issuer), {
        method: 'GET', credentials: 'omit', redirect: 'error', signal: controller.signal,
        headers: { Authorization: `Bearer ${credential.accessToken}`, ...(credential.serviceKey ? { 'X-Inhouse-Service-Key': credential.serviceKey } : {}) },
      });
      if (!response.ok) throw new Error('El servicio no ha confirmado la autorización de esta cuenta.');
      const chunks = [];
      let size = 0;
      for await (const chunk of response.body ?? []) {
        size += chunk.byteLength;
        if (size > 64 * 1024) throw new Error('La respuesta del servicio no es válida.');
        chunks.push(Buffer.from(chunk));
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new Error('No se pudo verificar la autorización con el servicio de conexión.');
    } finally {
      clearTimeout(timer);
      requests.delete(controller);
    }
  }

  function armOwnerExpiry() {
    clearTimeout(ownerTimer);
    if (!active) return;
    const remaining = active.expiresAt - now();
    if (remaining <= 0) { disable('La sesión de tu cuenta ha caducado. Vuelve a entrar con Google.'); return; }
    ownerTimer = setTimeout(armOwnerExpiry, Math.min(remaining, 2_000_000_000));
    ownerTimer.unref?.();
  }

  async function enable(input) {
    disable();
    const run = generation;
    if (loginPending) throw new Error('Completa primero el acceso con Google en esta aplicación.');
    if (!input || typeof input !== 'object' || !/^[a-f0-9]{32}$/.test(input.hostId ?? '')
      || typeof input.accessToken !== 'string' || !/^[A-Za-z0-9._~+/-]+={0,2}$/.test(input.accessToken)
      || input.accessToken.length > 8192 || (input.serviceKey !== undefined && (typeof input.serviceKey !== 'string'
        || input.serviceKey.length > 4096 || /[^\x20-\x7e]/.test(input.serviceKey)))) throw new Error('La sesión del equipo no es válida.');
    const issuer = normalizeIssuer(input.issuer);
    await load();
    if (run !== generation) return false;
    const verified = await readJson(issuer, '/api/auth/session', input);
    if (run !== generation) return false;
    const account = verified.profile ?? verified.account;
    if (!validId(account?.id) || !Number.isFinite(verified.expiresAt) || verified.expiresAt <= now() + 10000) {
      throw new Error('El servicio no ha verificado tu cuenta de Google.');
    }
    if (document.currentOwnerId !== account.id) throw new Error('La sesión no pertenece a la cuenta que ha entrado en esta aplicación.');
    const hash = tokenHash(input.accessToken);
    const bound = document.bindings.find((binding) => binding.issuer === issuer && binding.tokenHash === hash
      && binding.accountId === account.id && binding.hostId === input.hostId && binding.expiresAt > now());
    const recentGoogle = document.owners.some((owner) => owner.id === account.id && owner.googleValidUntil > now());
    if (!bound && !recentGoogle) throw new Error('Vuelve a entrar con Google en esta aplicación para habilitar el acceso a tus equipos.');
    const expiresAt = Math.min(verified.expiresAt, bound?.expiresAt ?? now() + MAX_SESSION);
    if (!bound) {
      const binding = { issuer, tokenHash: hash, accountId: account.id, hostId: input.hostId, expiresAt };
      document.bindings = [...document.bindings.filter((entry) => entry.expiresAt > now()), binding].slice(-60);
      await persist();
      if (run !== generation) return false;
    }
    active = { issuer, accessToken: input.accessToken, serviceKey: input.serviceKey ?? '', hostId: input.hostId, accountId: account.id, expiresAt };
    armOwnerExpiry();
    return true;
  }

  async function verifyPeer(connectionId, owner) {
    const response = await readJson(owner.issuer, `/api/account/connection/${encodeURIComponent(connectionId)}`, owner);
    if (response.active !== true || response.connectionId !== connectionId || response.hostId !== owner.hostId
      || response.ownerAccountId !== owner.accountId || response.viewerAccountId !== owner.accountId
      || !Number.isFinite(response.expiresAt) || response.expiresAt <= now()
      || response.expiresAt > now() + 65000) throw new Error('La conexión no pertenece a esta cuenta de Google.');
    return { connectionId, expiresAt: Math.min(response.expiresAt, owner.expiresAt) };
  }

  function armPeerRefresh(owner, run, peerRun) {
    clearTimeout(leaseTimer);
    if (!lease || !active || run !== generation || peerRun !== peerGeneration) return;
    const delay = Math.max(10, Math.min(refreshMs, Math.max(1000, lease.expiresAt - now() - 1000)));
    leaseTimer = setTimeout(async () => {
      try {
        const renewed = await verifyPeer(lease.connectionId, owner);
        if (run !== generation || peerRun !== peerGeneration || active !== owner) return;
        lease = renewed;
        armPeerRefresh(owner, run, peerRun);
      } catch {
        if (run === generation && peerRun === peerGeneration) endPeer('El servicio ya no confirma el acceso de este equipo.');
      }
    }, delay);
    leaseTimer.unref?.();
  }

  async function authorizePeer(connectionId) {
    endPeer();
    const owner = active;
    const run = generation;
    const peerRun = peerGeneration;
    if (!owner || owner.expiresAt <= now() || typeof connectionId !== 'string'
      || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(connectionId)) return false;
    try {
      const verified = await verifyPeer(connectionId, owner);
      if (run !== generation || peerRun !== peerGeneration || active !== owner) return false;
      lease = verified;
      armPeerRefresh(owner, run, peerRun);
      return true;
    } catch { return false; }
  }

  function canCapture() {
    if (active && active.expiresAt <= now()) disable('La sesión de tu cuenta ha caducado. Vuelve a entrar con Google.');
    return active !== null;
  }

  function canControl() {
    if (!canCapture()) return false;
    if (lease && lease.expiresAt <= now()) endPeer('Ha caducado la autorización de esta conexión.');
    return lease !== null;
  }

  function pauseForLogin() { ownerEpoch++; loginPending = true; disable(); }

  async function signOut() {
    pauseForLogin();
    const run = ownerEpoch;
    await load();
    if (run !== ownerEpoch) return;
    document.currentOwnerId = null;
    await persist();
  }

  return { recordGoogleOwner, enable, authorizePeer, endPeer, disable, pauseForLogin, signOut, canCapture, canControl, flush: () => queue };
}

module.exports = { createAccountHostingAuthority, createPeerRevocationHandler, normalizeIssuer };
