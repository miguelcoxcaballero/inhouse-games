import type { GoogleProfile } from './google-account.ts';
import { obtainDriveRealm, type DriveRealm } from '../../server/drive-realm.mjs';

export const CLOUD_ACCOUNT_KEY = 'inhouse.link.cloud-account.v1';
const LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
const CLOCK_MARGIN_MS = 60_000;

export type CloudAccount = {
  profile: GoogleProfile;
  secret: string;
  expiresAt: number;
  fileId: string;
  clientToken: string;
};
type RealmInput = Pick<DriveRealm, 'fileId' | 'accountId' | 'secret'> & { id?: string };
type StoredCloudAccount = CloudAccount & { schema: 1; accountId: string; issuedAt: number };

function encode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function canonicalSecret(value: unknown): value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) return false;
  try {
    const decoded = atob(value.replaceAll('-', '+').replaceAll('_', '/') + '=');
    const bytes = Uint8Array.from(decoded, character => character.charCodeAt(0));
    return bytes.length === 32 && encode(bytes) === value;
  } catch { return false; }
}

function validProfile(value: unknown): value is GoogleProfile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const profile = value as Record<string, unknown>;
  if (typeof profile.id !== 'string' || !/^[A-Za-z0-9._:-]{1,256}$/.test(profile.id)
    || typeof profile.name !== 'string' || profile.name.length > 256
    || typeof profile.email !== 'string' || profile.email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(profile.email)
    || typeof profile.photo !== 'string' || profile.photo.length > 2048) return false;
  if (!profile.photo) return true;
  try {
    const url = new URL(profile.photo);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch { return false; }
}

function validFileId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(value);
}

function validStored(value: unknown, now: number): value is StoredCloudAccount {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const stored = value as Record<string, unknown>;
  return stored.schema === 1 && validProfile(stored.profile)
    && stored.accountId === stored.profile.id && canonicalSecret(stored.secret)
    && validFileId(stored.fileId) && typeof stored.clientToken === 'string'
    && stored.clientToken.startsWith('ild_') && canonicalSecret(stored.clientToken.slice(4))
    && typeof stored.issuedAt === 'number' && Number.isFinite(stored.issuedAt)
    && stored.issuedAt >= 0 && stored.issuedAt <= now + CLOCK_MARGIN_MS
    && typeof stored.expiresAt === 'number' && Number.isFinite(stored.expiresAt)
    && stored.expiresAt > now + CLOCK_MARGIN_MS && stored.expiresAt > stored.issuedAt
    && stored.expiresAt - stored.issuedAt <= LIFETIME_MS;
}

function clone(account: CloudAccount): CloudAccount {
  return {
    profile: { id: account.profile.id, name: account.profile.name, email: account.profile.email, photo: account.profile.photo },
    secret: account.secret, fileId: account.fileId, clientToken: account.clientToken, expiresAt: account.expiresAt,
  };
}

/** A private local capability is separate from a Google OAuth access token. */
export function getCloudAccount(): CloudAccount | null {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(CLOUD_ACCOUNT_KEY) || 'null');
    return validStored(value, Date.now()) ? clone(value) : null;
  } catch { return null; }
}

/** Prepare without storing: the caller must reject canceled account changes first. */
export async function prepareCloudAccount(accessToken: string, profile: GoogleProfile): Promise<CloudAccount> {
  if (!validProfile(profile)) throw new Error('La cuenta de Google no contiene un perfil válido.');
  const verifiedProfile = { id: profile.id, name: profile.name, email: profile.email, photo: profile.photo };
  const realm = await obtainDriveRealm(accessToken, verifiedProfile);
  return createCloudAccountFromRealm(verifiedProfile, realm, Date.now() + LIFETIME_MS);
}

export function createCloudAccountFromRealm(profile: GoogleProfile, realm: RealmInput, expiresAt: number): CloudAccount {
  if (!validProfile(profile) || !realm || realm.accountId !== profile.id
    || !validFileId(realm.fileId) || (realm.id !== undefined && realm.id !== realm.fileId)
    || !canonicalSecret(realm.secret)) throw new Error('El archivo privado de conexión no corresponde a una cuenta válida.');
  const now = Date.now();
  if (!Number.isFinite(expiresAt) || expiresAt <= now + CLOCK_MARGIN_MS || expiresAt > now + LIFETIME_MS + CLOCK_MARGIN_MS) {
    throw new Error('La sesión privada de conexión no tiene una duración válida.');
  }
  const expiry = Math.min(expiresAt, now + LIFETIME_MS);
  const existing = getCloudAccount();
  const reusable = existing && existing.secret === realm.secret && existing.fileId === realm.fileId
    && existing.expiresAt === expiry && existing.profile.id === profile.id && existing.profile.name === profile.name
    && existing.profile.email === profile.email && existing.profile.photo === profile.photo;
  if (!reusable && !globalThis.crypto?.getRandomValues) throw new Error('Este entorno necesita WebCrypto para conectar tu cuenta.');
  return clone({
    profile, secret: realm.secret, fileId: realm.fileId, expiresAt: expiry,
    clientToken: reusable ? existing.clientToken : `ild_${encode(crypto.getRandomValues(new Uint8Array(32)))}`,
  });
}

/** Persist only the private capability, never the Google grant used to retrieve it. */
export function rememberCloudAccount(account: CloudAccount): void {
  const now = Date.now();
  const stored: StoredCloudAccount = { ...clone(account), schema: 1, accountId: account.profile.id, issuedAt: now };
  if (!validStored(stored, now)) throw new Error('La sesión privada de conexión no es válida.');
  try { localStorage.setItem(CLOUD_ACCOUNT_KEY, JSON.stringify(stored)); }
  catch { throw new Error('No se pudo guardar tu sesión privada. Permite el almacenamiento local y vuelve a entrar con Google.'); }
}

/** Signing out removes this device's capability without changing any Drive file. */
export function clearCloudAccount(): void {
  try { localStorage.removeItem(CLOUD_ACCOUNT_KEY); } catch { /* An unavailable store cannot authenticate a local session. */ }
}
