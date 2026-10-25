import { createHash } from 'node:crypto';

export const DEFAULT_GOOGLE_CLIENT_ID = '435784295430-cmug30o42f1vu4ijgor9sjb0ro4oo37o.apps.googleusercontent.com';
const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const TOKEN_INFO_URL = 'https://oauth2.googleapis.com/tokeninfo';
const DRIVE_USER_URL = 'https://www.googleapis.com/drive/v3/about?fields=user(displayName,emailAddress,photoLink,permissionId)';

export class GoogleAuthError extends Error {
  constructor(message = 'La sesión de Google no es válida o ha caducado.', status = 401) {
    super(message);
    this.name = 'GoogleAuthError';
    this.status = status;
  }
}

/** Validate syntax before forwarding a bearer credential to Google. */
export function validGoogleAccessToken(token) {
  return typeof token === 'string' && token.length > 0 && token.length <= 8192
    && /^[A-Za-z0-9._~+/-]+={0,2}$/.test(token);
}

/**
 * The real provider verifier. Tokens are never put in URLs or logs. Google's
 * official Node auth client also POSTs tokeninfo with Authorization: Bearer:
 * https://github.com/googleapis/google-auth-library-nodejs/blob/main/src/auth/oauth2client.ts
 * Only /drive/v3/about is read: no Drive files are read, created or changed.
 */
export function createGoogleTokenVerifier(options = {}) {
  const clientId = options.clientId ?? DEFAULT_GOOGLE_CLIENT_ID;
  const fetcher = options.fetcher ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? 8000;
  const cacheTtlMs = options.cacheTtlMs ?? 5 * 60 * 1000;
  const maxCacheEntries = options.maxCacheEntries ?? 1000;
  const maxPending = options.maxPending ?? 32;
  const cache = new Map();
  const pending = new Map();

  async function requestJson(url, init) {
    let response;
    try { response = await fetcher(url, { ...init, redirect: 'error' }); }
    catch { throw new GoogleAuthError('No se pudo verificar la cuenta con Google. Inténtalo de nuevo.', 503); }
    if (!response.ok) {
      if ([400, 401, 403].includes(response.status)) throw new GoogleAuthError();
      throw new GoogleAuthError('Google no está disponible para verificar la cuenta.', 503);
    }
    try { return await response.json(); }
    catch { throw new GoogleAuthError('Google devolvió una respuesta no válida.', 503); }
  }

  async function fetchAccount(token) {
    const checkedAt = now();
    const signal = AbortSignal.timeout(timeoutMs);
    const authorization = `Bearer ${token}`;
    const info = await requestJson(TOKEN_INFO_URL, {
      method: 'POST',
      headers: { authorization, 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      signal,
    });
    if (!info || typeof info !== 'object' || info.aud !== clientId) {
      throw new GoogleAuthError('La sesión de Google no pertenece al cliente OAuth de Inhouse.');
    }
    const seconds = Number(info.expires_in);
    if (!Number.isFinite(seconds) || seconds <= 0) throw new GoogleAuthError();
    const scopes = typeof info.scope === 'string' ? info.scope.split(/\s+/) : [];
    if (!scopes.includes(DRIVE_FILE_SCOPE)) {
      throw new GoogleAuthError('La sesión de Google no incluye el permiso drive.file utilizado por Inhouse.');
    }
    const about = await requestJson(DRIVE_USER_URL, { method: 'GET', headers: { authorization }, signal });
    const user = about?.user;
    if (!user || typeof user.permissionId !== 'string' || !user.permissionId || user.permissionId.length > 256
      || typeof user.emailAddress !== 'string' || user.emailAddress.length > 254
      || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(user.emailAddress)) {
      throw new GoogleAuthError('Google no ha devuelto una identidad de cuenta válida.');
    }
    return Object.freeze({
      id: user.permissionId,
      name: typeof user.displayName === 'string' && user.displayName.trim() ? user.displayName.trim().slice(0, 120) : user.emailAddress,
      email: user.emailAddress,
      photo: typeof user.photoLink === 'string' && user.photoLink.startsWith('https://') ? user.photoLink.slice(0, 2048) : '',
      expiresAt: checkedAt + Math.floor(seconds * 1000),
    });
  }

  return async function verifyGoogleToken(token) {
    if (!validGoogleAccessToken(token)) throw new GoogleAuthError();
    const hash = createHash('sha256').update(token).digest('hex');
    const cached = cache.get(hash);
    if (cached && cached.until > now()) return cached.account;
    if (cached) cache.delete(hash);
    if (pending.has(hash)) return pending.get(hash);
    if (pending.size >= maxPending) throw new GoogleAuthError('Hay demasiadas verificaciones de Google en curso. Inténtalo de nuevo.', 503);
    const operation = fetchAccount(token).then((account) => {
      const until = Math.min(now() + cacheTtlMs, account.expiresAt - 1000);
      if (until > now() && maxCacheEntries > 0) {
        while (cache.size >= maxCacheEntries) cache.delete(cache.keys().next().value);
        cache.set(hash, { account, until });
      }
      return account;
    }).finally(() => { pending.delete(hash); });
    pending.set(hash, operation);
    return operation;
  };
}
