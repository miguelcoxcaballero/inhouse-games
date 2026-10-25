const encoder = new TextEncoder();
const MARKER = 'inhouse.link.realm';
const DRIVE_FILES = 'https://www.googleapis.com/drive/v3/files';
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const METADATA_FIELDS = 'id,createdTime,ownedByMe,shared,size,appProperties';
const FILE_QUERY = "trashed = false and 'me' in owners and appProperties has { key='inhouse.link.realm' and value='1' }";

function webCrypto(options = {}) {
  const crypto = options.crypto ?? globalThis.crypto;
  if (!crypto?.subtle || !crypto.getRandomValues) throw new Error('Este entorno necesita WebCrypto para conectar tu cuenta.');
  return crypto;
}

function encode64(value) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  let text = '';
  for (let index = 0; index < bytes.length; index += 8192) text += String.fromCharCode(...bytes.subarray(index, index + 8192));
  return btoa(text).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function decode64(value, maxBytes, exactBytes) {
  if (typeof value !== 'string' || !value || value.length > Math.ceil(maxBytes * 4 / 3)
    || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Dato cifrado no válido.');
  const base64 = value.replaceAll('-', '+').replaceAll('_', '/');
  let decoded;
  try { decoded = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')); } catch { throw new Error('Dato cifrado no válido.'); }
  const bytes = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  if (bytes.length > maxBytes || (exactBytes !== undefined && bytes.length !== exactBytes) || encode64(bytes) !== value) throw new Error('Dato cifrado no válido.');
  return bytes;
}

function secretBytes(secret) { return decode64(secret, 32, 32); }
function plain(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function nowValue(options) { return typeof options.now === 'function' ? options.now() : options.now ?? Date.now(); }

async function realmKey(secret, purpose, options = {}) {
  const crypto = webCrypto(options);
  const input = await crypto.subtle.importKey('raw', secretBytes(secret), 'HKDF', false, ['deriveKey']);
  const encryption = purpose === 'packet';
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: encoder.encode('inhouse-link/drive-realm/v1'), info: encoder.encode(purpose) }, input,
    encryption ? { name: 'AES-GCM', length: 256 } : { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false, encryption ? ['encrypt', 'decrypt'] : ['sign', 'verify']);
}

/** The broker learns an opaque topic, not the Google account or Drive file ID. */
export async function deriveRealmTopic(secret, options = {}) {
  const crypto = webCrypto(options);
  const digest = new Uint8Array(await crypto.subtle.sign('HMAC', await realmKey(secret, 'topic', options), encoder.encode('inhouse-link/realm-topic/v1')));
  return `inhouse/link/v1/${Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

function channelAad(channel) {
  if (typeof channel !== 'string' || !channel || encoder.encode(channel).length > 1024) throw new Error('Canal de conexión no válido.');
  return encoder.encode(JSON.stringify(['inhouse-link/realm-packet', 1, channel]));
}

export async function encryptRealmPacket(secret, channel, payload, options = {}) {
  const crypto = webCrypto(options);
  const serialized = JSON.stringify(payload);
  if (serialized === undefined) throw new Error('El paquete de conexión no contiene datos JSON.');
  const plaintext = encoder.encode(serialized);
  const maxBytes = options.maxPacketBytes ?? 64 * 1024;
  if (plaintext.length > maxBytes) throw new Error('El paquete de conexión supera el tamaño permitido.');
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: channelAad(channel), tagLength: 128 }, await realmKey(secret, 'packet', options), plaintext);
  return { v: 1, nonce: encode64(nonce), ciphertext: encode64(ciphertext) };
}

/** Throws on malformed/tampered input. Receivers discard the packet silently. */
export async function decryptRealmPacket(secret, channel, packet, options = {}) {
  if (!plain(packet) || packet.v !== 1) throw new Error('Formato de paquete de conexión no válido.');
  const maxBytes = options.maxPacketBytes ?? 64 * 1024;
  const nonce = decode64(packet.nonce, 12, 12);
  const ciphertext = decode64(packet.ciphertext, maxBytes + 16);
  if (ciphertext.length < 16) throw new Error('Formato de paquete de conexión no válido.');
  try {
    const plaintext = await webCrypto(options).subtle.decrypt({ name: 'AES-GCM', iv: nonce, additionalData: channelAad(channel), tagLength: 128 }, await realmKey(secret, 'packet', options), ciphertext);
    if (plaintext.byteLength > maxBytes) throw new Error('Oversize');
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext));
  } catch { throw new Error('No se pudo verificar el paquete cifrado de conexión.'); }
}

function canonicalProof(fields) {
  if (!plain(fields) || !['connect', 'keepalive'].includes(fields.purpose)) throw new Error('Prueba de cuenta no válida.');
  for (const name of ['accountId', 'hostId', 'viewerId', 'connectionId']) {
    if (typeof fields[name] !== 'string' || !/^[A-Za-z0-9._:-]{1,256}$/.test(fields[name])) throw new Error('Prueba de cuenta no válida.');
  }
  decode64(fields.challenge, 32, 32);
  if (!Number.isSafeInteger(fields.issuedAt) || fields.issuedAt < 0
    || (fields.counter !== undefined && (!Number.isSafeInteger(fields.counter) || fields.counter < 0))
    || (fields.purpose === 'keepalive' && fields.counter === undefined)) throw new Error('Prueba de cuenta no válida.');
  const normalized = {
    accountId: fields.accountId, hostId: fields.hostId, viewerId: fields.viewerId,
    connectionId: fields.connectionId, challenge: fields.challenge, issuedAt: fields.issuedAt,
    ...(fields.counter !== undefined ? { counter: fields.counter } : {}), purpose: fields.purpose,
  };
  return { fields: normalized, bytes: encoder.encode(JSON.stringify(['inhouse-link/account-peer-proof', 1, normalized])) };
}

export async function createAccountPeerProof(secret, fields, options = {}) {
  const canonical = canonicalProof(fields);
  const proof = await webCrypto(options).subtle.sign('HMAC', await realmKey(secret, 'account-peer-proof', options), canonical.bytes);
  return { ...canonical.fields, proof: encode64(proof) };
}

/** Stateless verification: callers consume challenges and advance minCounter. */
export async function verifyAccountPeerProof(secret, packet, options = {}) {
  try {
    const canonical = canonicalProof(packet);
    const now = nowValue(options);
    if (!Number.isFinite(now) || (options.minCounter !== undefined && (!Number.isSafeInteger(options.minCounter) || options.minCounter < -1))) return false;
    if (packet.issuedAt > now + (options.clockSkewMs ?? 5000) || now - packet.issuedAt > (options.maxAgeMs ?? 60_000)) return false;
    for (const name of ['accountId', 'hostId', 'viewerId', 'connectionId', 'challenge', 'purpose']) {
      const optionName = `expected${name[0].toUpperCase()}${name.slice(1)}`;
      const expected = options[optionName] ?? options.expected?.[name];
      if (expected !== undefined && packet[name] !== expected) return false;
    }
    if (options.minCounter !== undefined && (packet.counter === undefined || packet.counter <= options.minCounter)) return false;
    return await webCrypto(options).subtle.verify('HMAC', await realmKey(secret, 'account-peer-proof', options), decode64(packet.proof, 32, 32), canonical.bytes);
  } catch { return false; }
}

async function boundedJson(response, maxBytes) {
  const declared = response.headers.get('content-length');
  if (declared && (!Number.isSafeInteger(Number(declared)) || Number(declared) > maxBytes)) throw new Error('Google Drive devolvió un archivo demasiado grande.');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Google Drive no devolvió contenido legible.');
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new Error('Google Drive devolvió un archivo demasiado grande.');
      chunks.push(value);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new Error('El archivo de conexión de Google Drive no contiene JSON válido.'); }
}

function privateMetadata(file) {
  if (!plain(file) || typeof file.id !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(file.id)
    || file.ownedByMe !== true || file.shared !== false || file.appProperties?.[MARKER] !== '1'
    || typeof file.createdTime !== 'string' || !Number.isFinite(Date.parse(file.createdTime))) {
    throw new Error('El archivo de conexión debe pertenecer a tu cuenta y permanecer privado.');
  }
  return file;
}

/**
 * Retrieves one private app-created file. Creation never changes sharing or
 * touches unrelated Drive files. Listing again converges concurrent creators;
 * Drive has no atomic create-if-absent, so each later call rechecks canonicality.
 */
export async function obtainDriveRealm(accessToken, profile, options = {}) {
  if (typeof accessToken !== 'string' || !accessToken || accessToken.length > 8192 || /[\s\r\n]/.test(accessToken)
    || !profile || typeof profile.id !== 'string' || !/^[A-Za-z0-9._:-]{1,256}$/.test(profile.id)) throw new Error('Entra con Google antes de conectar tus equipos.');
  const crypto = webCrypto(options);
  const fetcher = options.fetcher ?? globalThis.fetch;
  const maxBytes = options.maxBytes ?? 4096;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 12000);
  const relayAbort = () => controller.abort();
  if (options.signal?.aborted) controller.abort();
  else options.signal?.addEventListener('abort', relayAbort, { once: true });
  async function request(url, init = {}, limit = 64 * 1024) {
    let response;
    try {
      response = await fetcher(url, { ...init, headers: { ...init.headers, Authorization: `Bearer ${accessToken}` }, redirect: 'error', cache: 'no-store', signal: controller.signal });
    } catch { throw new Error('No se pudo acceder al archivo privado de conexión en Google Drive.'); }
    if (!response.ok) throw new Error([401, 403].includes(response.status)
      ? 'Google no ha autorizado el acceso al archivo privado de conexión. Vuelve a entrar con Google.'
      : 'Google Drive no pudo completar la conexión de tu cuenta.');
    return boundedJson(response, limit);
  }
  async function list() {
    const files = [];
    let pageToken;
    const seen = new Set();
    const maxPages = options.maxPages ?? 10;
    for (let page = 0; page < maxPages; page++) {
      const url = new URL(DRIVE_FILES);
      url.searchParams.set('q', FILE_QUERY);
      url.searchParams.set('fields', `nextPageToken,files(${METADATA_FIELDS})`);
      url.searchParams.set('pageSize', '100');
      url.searchParams.set('orderBy', 'createdTime');
      if (pageToken) url.searchParams.set('pageToken', pageToken);
      const result = await request(url.toString());
      if (!plain(result) || !Array.isArray(result.files)) throw new Error('Google Drive devolvió una lista de conexión no válida.');
      for (const file of result.files) files.push(privateMetadata(file));
      if (!result.nextPageToken) return files.sort((a, b) => Date.parse(a.createdTime) - Date.parse(b.createdTime) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      if (typeof result.nextPageToken !== 'string' || result.nextPageToken.length > 4096 || seen.has(result.nextPageToken)) throw new Error('No se pudo completar la lista privada de conexión.');
      seen.add(result.nextPageToken);
      pageToken = result.nextPageToken;
    }
    throw new Error('La lista privada de conexión supera el límite permitido.');
  }
  try {
    let files = await list();
    if (!files.length) {
      const contents = { schema: 1, accountId: profile.id, secret: encode64(crypto.getRandomValues(new Uint8Array(32))) };
      const metadata = { name: '.inhouse-link-realm.v1.json', mimeType: 'application/json', appProperties: { [MARKER]: '1' } };
      const boundary = `inhouse_${encode64(crypto.getRandomValues(new Uint8Array(18)))}`;
      const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(contents)}\r\n--${boundary}--\r\n`;
      const url = new URL(DRIVE_UPLOAD);
      url.searchParams.set('uploadType', 'multipart');
      url.searchParams.set('fields', METADATA_FIELDS);
      privateMetadata(await request(url.toString(), { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body }));
      const attempts = Math.max(1, Math.min(5, options.settleAttempts ?? 3));
      for (let attempt = 0; attempt < attempts; attempt++) {
        files = await list();
        if (attempt + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, options.settleDelayMs ?? 100));
      }
      if (!files.length) throw new Error('Google Drive todavía no ha publicado el archivo privado de conexión. Inténtalo de nuevo.');
    }
    const file = files[0];
    // Recheck live ownership/privacy before reading the selected file's content.
    const metadataUrl = new URL(`${DRIVE_FILES}/${encodeURIComponent(file.id)}`);
    metadataUrl.searchParams.set('fields', METADATA_FIELDS);
    const current = privateMetadata(await request(metadataUrl.toString()));
    if (current.id !== file.id) throw new Error('Google Drive devolvió un identificador de conexión no válido.');
    if (current.size !== undefined && (!Number.isSafeInteger(Number(current.size)) || Number(current.size) > maxBytes)) throw new Error('El archivo privado de conexión supera el tamaño permitido.');
    const media = await request(`${DRIVE_FILES}/${encodeURIComponent(file.id)}?alt=media`, {}, maxBytes);
    if (!plain(media) || media.schema !== 1 || media.accountId !== profile.id) throw new Error('El archivo privado de conexión no corresponde a tu cuenta de Google.');
    secretBytes(media.secret);
    return { id: file.id, fileId: file.id, accountId: media.accountId, secret: media.secret };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', relayAbort);
  }
}
