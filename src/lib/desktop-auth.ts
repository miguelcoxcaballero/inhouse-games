/** Browser side of a single-use, encrypted handoff to the local Windows app. */
const CALLBACK_URL = 'http://127.0.0.1:48715/auth/google/callback';
const INFO = new TextEncoder().encode('inhouse-link:google-desktop:v1');
const CODE = /^[A-Za-z0-9_-]{43}$/;

export type DesktopAuthRequest = { state: string; key: JsonWebKey; callback: string };

function decode(value: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length > 32000) throw new Error('La solicitud de acceso no es válida.');
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/');
  return Uint8Array.from(atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')), (character) => character.charCodeAt(0));
}

function encode(value: Uint8Array | ArrayBuffer) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join('')).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

export function readDesktopAuthRequest(hash = location.hash): DesktopAuthRequest {
  if (!hash.startsWith('#/desktop-auth?')) throw new Error('Inicia el acceso desde la aplicación de Windows.');
  const params = new URLSearchParams(hash.slice(hash.indexOf('?') + 1));
  const state = params.get('state') ?? '';
  const callback = params.get('callback') ?? '';
  const encodedKey = params.get('key') ?? '';
  if (!CODE.test(state) || callback !== CALLBACK_URL || encodedKey.length > 1500) throw new Error('La solicitud de la aplicación no es válida. Vuelve a iniciarla desde Windows.');
  let key: JsonWebKey;
  try { key = JSON.parse(new TextDecoder().decode(decode(encodedKey))) as JsonWebKey; }
  catch { throw new Error('La solicitud de la aplicación está incompleta.'); }
  if (key.kty !== 'EC' || key.crv !== 'P-256' || !CODE.test(key.x ?? '') || !CODE.test(key.y ?? '') || key.d) {
    throw new Error('La clave de la solicitud no es válida.');
  }
  return { state, callback, key: { kty: 'EC', crv: 'P-256', x: key.x, y: key.y } };
}

export async function createDesktopCallbackUrl(request: DesktopAuthRequest, session: { accessToken: string; expiresAt: number }): Promise<string> {
  if (request.callback !== CALLBACK_URL || !CODE.test(request.state)
    || typeof session.accessToken !== 'string' || session.accessToken.length < 20 || session.accessToken.length > 8192
    || !Number.isFinite(session.expiresAt) || session.expiresAt <= Date.now() + 10000) {
    throw new Error('La sesión de Google ha caducado. Vuelve a entrar.');
  }
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const recipient = await crypto.subtle.importKey('jwk', request.key, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: recipient }, pair.privateKey, 256);
  const material = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  new Uint8Array(shared).fill(0);
  const key = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: decode(request.state), info: INFO }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify({ accessToken: session.accessToken, expiresAt: session.expiresAt }));
  let ciphertext: ArrayBuffer;
  try {
    ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(request.state) }, key, plaintext);
  } finally { plaintext.fill(0); }
  const ephemeralKey = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const envelope = { v: 1, key: { kty: ephemeralKey.kty, crv: ephemeralKey.crv, x: ephemeralKey.x, y: ephemeralKey.y }, iv: encode(iv), ciphertext: encode(ciphertext) };
  const callback = new URL(CALLBACK_URL);
  callback.hash = new URLSearchParams({ state: request.state, payload: encode(new TextEncoder().encode(JSON.stringify(envelope))) }).toString();
  return callback.href;
}
