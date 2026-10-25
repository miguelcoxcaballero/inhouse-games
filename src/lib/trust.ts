import { getGoogleSession } from './google-account.ts';

/** Pairing material stays on the participating devices, never in signaling logs. */
export type TrustedHost = { deviceId: string; name: string; lastSeen: number };
export type TrustedDevice = { id: string; name: string; createdAt: number };
export type StoredHost = TrustedHost & { id: string; token: string };
export type StoredDevice = TrustedDevice & { token: string };

const HOSTS_KEY = 'inhouse.trustedHosts.v1';
const DEVICES_KEY = 'inhouse.trustedDevices.v1';
const IDENTITY_KEY = 'inhouse.hostIdentity.v1';
const encoder = new TextEncoder();
let revision = 0;
type Identity = { publicKey: JsonWebKey; privateKey: JsonWebKey };
type ReadyIdentity = { identity: Identity; privateKey: CryptoKey };
const pendingIdentities = new Map<string, { revision: number; promise: Promise<ReadyIdentity> }>();

function accountKey(key: string): string {
  const account = getGoogleSession()?.profile.id;
  // Existing unscoped test/legacy data is never adopted into a Google account.
  return account ? `${key}:${encodeURIComponent(account)}` : key;
}
if (typeof window !== 'undefined') window.addEventListener('inhouse-account-changed', () => { revision++; });

export function getTrustRevision() { return revision; }

export function base64url(bytes: ArrayBuffer | Uint8Array) {
  const array = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return btoa(Array.from(array, (byte) => String.fromCharCode(byte)).join('')).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function bytes(value: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length > 256) throw new Error('Prueba de dispositivo inválida.');
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/');
  return Uint8Array.from(atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')), (char) => char.charCodeAt(0));
}

function load<T>(key: string): T[] {
  try { const list: unknown = JSON.parse(localStorage.getItem(accountKey(key)) ?? '[]'); return Array.isArray(list) ? list as T[] : []; }
  catch { return []; }
}

function isCredential(value: unknown): value is { id: string; token: string; name: string } {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === 'string' && /^[a-f0-9]{32}$/.test(record.id)
    && typeof record.token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(record.token)
    && typeof record.name === 'string';
}

export function storedHosts(): StoredHost[] {
  return load<StoredHost>(HOSTS_KEY).filter((host) => isCredential(host) && typeof host.deviceId === 'string' && /^[a-f0-9]{32}$/.test(host.deviceId));
}

export function storedDevices(): StoredDevice[] { return load<StoredDevice>(DEVICES_KEY).filter(isCredential); }

export function getTrustedHosts(): TrustedHost[] {
  return storedHosts().map(({ deviceId, name, lastSeen }) => ({ deviceId, name, lastSeen }));
}

export function getTrustedDevices(): TrustedDevice[] {
  return storedDevices().map(({ id, name, createdAt }) => ({ id, name, createdAt }));
}

export function saveHost(host: StoredHost) {
  localStorage.setItem(accountKey(HOSTS_KEY), JSON.stringify([...storedHosts().filter((entry) => entry.deviceId !== host.deviceId), host]));
}

export function saveDevice(device: StoredDevice) {
  localStorage.setItem(accountKey(DEVICES_KEY), JSON.stringify([...storedDevices().filter((entry) => entry.id !== device.id), device]));
}

export function clearTrustedDevices() { revision++; localStorage.removeItem(accountKey(DEVICES_KEY)); }
export function forgetTrustedHost(deviceId: string) {
  localStorage.setItem(accountKey(HOSTS_KEY), JSON.stringify(storedHosts().filter((entry) => entry.deviceId !== deviceId)));
}

export function createCredential(name: string): StoredDevice {
  const random = crypto.getRandomValues(new Uint8Array(16));
  return { id: Array.from(random, (byte) => byte.toString(16).padStart(2, '0')).join(''), token: base64url(crypto.getRandomValues(new Uint8Array(32))), name: name.slice(0, 60), createdAt: Date.now() };
}

export async function prove(token: string, text: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', bytes(token), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return base64url(await crypto.subtle.sign('HMAC', key, encoder.encode(text)));
}

export async function verifyProof(token: string, text: string, proof: string): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey('raw', bytes(token), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    return await crypto.subtle.verify('HMAC', key, bytes(proof), encoder.encode(text));
  } catch { return false; }
}

export async function identityForNonce(nonce: string) {
  const storageKey = accountKey(IDENTITY_KEY);
  const startedRevision = revision;
  const assertCurrentAccount = () => {
    if (revision !== startedRevision || accountKey(IDENTITY_KEY) !== storageKey) throw new Error('La cuenta de Google ha cambiado.');
  };
  let pending = pendingIdentities.get(storageKey);
  if (!pending || pending.revision !== startedRevision) {
    const promise = (async (): Promise<ReadyIdentity> => {
      let identity: Identity | null = null;
      try { identity = JSON.parse(localStorage.getItem(storageKey) ?? 'null') as Identity | null; } catch { /* Generate a fresh local identity. */ }
      let privateKey: CryptoKey | null = null;
      if (identity?.privateKey && identity.publicKey) {
        try { privateKey = await crypto.subtle.importKey('jwk', identity.privateKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']); }
        catch { identity = null; }
        assertCurrentAccount();
      }
      if (!privateKey || !identity) {
        const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
        assertCurrentAccount();
        const publicKey = await crypto.subtle.exportKey('jwk', pair.publicKey);
        assertCurrentAccount();
        const exportedPrivateKey = await crypto.subtle.exportKey('jwk', pair.privateKey);
        assertCurrentAccount();
        identity = { publicKey, privateKey: exportedPrivateKey };
        localStorage.setItem(storageKey, JSON.stringify(identity));
        privateKey = pair.privateKey;
      }
      return { identity, privateKey };
    })();
    const entry = { revision: startedRevision, promise };
    pendingIdentities.set(storageKey, entry);
    const clearPending = () => { if (pendingIdentities.get(storageKey) === entry) pendingIdentities.delete(storageKey); };
    void promise.then(clearPending, clearPending);
    pending = entry;
  }
  const { identity, privateKey } = await pending.promise;
  assertCurrentAccount();
  const publicKey = { ...identity.publicKey };
  const { crv, kty, x, y } = publicKey;
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(JSON.stringify({ crv, kty, x, y })));
  assertCurrentAccount();
  const deviceId = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('').slice(0, 32);
  const signature = base64url(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, encoder.encode(nonce)));
  assertCurrentAccount();
  return { deviceId, identity: { publicKey, signature } };
}
