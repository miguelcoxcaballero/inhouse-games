import http from 'node:http';
import { randomInt, randomUUID, randomBytes, createHmac, createHash, createPublicKey, verify, timingSafeEqual } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isIP } from 'node:net';
import { WebSocketServer, WebSocket } from 'ws';
import { createGoogleTokenVerifier, DEFAULT_GOOGLE_CLIENT_ID, GoogleAuthError, validGoogleAccessToken } from './google-auth.mjs';
import { AccountSessionStore, validAppToken } from './account-sessions.mjs';

const VERSION = '0.3.0';
const SIGNAL_PROTOCOL = 'inhouse-link-v1';
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json',
  '.exe': 'application/vnd.microsoft.portable-executable', '.zip': 'application/zip',
};

function splitUrls(value) {
  return typeof value === 'string' ? value.split(/[\s,]+/).filter(Boolean) : [];
}

function validIceUrls(value, schemes) {
  return splitUrls(value).filter((url) => {
    const separator = url.indexOf(':');
    return separator > 0 && schemes.includes(url.slice(0, separator)) && url.length <= 1024 && !/[\s<>"']/.test(url);
  });
}

/** The shared TURN secret stays server-side. Browser credentials are short-lived. */
export function buildIceConfig(env = process.env, now = Date.now()) {
  const iceServers = [];
  let iceExpiresAt = null;
  const stun = validIceUrls(env.STUN_URLS, ['stun', 'stuns']);
  const turn = validIceUrls(env.TURN_URLS, ['turn', 'turns']);
  if (stun.length) iceServers.push({ urls: stun });
  if (turn.length && env.TURN_SECRET) {
    const lifetime = Math.floor(Math.max(60, Math.min(86400, Number(env.TURN_TTL_SECONDS) || 3600)));
    const username = `${Math.floor(now / 1000) + lifetime}:inhouse-${randomUUID()}`;
    iceExpiresAt = (Math.floor(now / 1000) + lifetime) * 1000;
    const credential = createHmac('sha1', env.TURN_SECRET).update(username).digest('base64');
    iceServers.push({ urls: turn, username, credential });
  } else if (turn.length && env.TURN_USERNAME && env.TURN_CREDENTIAL) {
    iceServers.push({ urls: turn, username: env.TURN_USERNAME, credential: env.TURN_CREDENTIAL });
  }
  return { iceServers, version: VERSION, iceExpiresAt };
}

function plain(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function safeEqual(actual, expected) {
  if (typeof actual !== 'string') return false;
  const provided = Buffer.from(actual, 'utf8');
  const wanted = Buffer.from(expected, 'utf8');
  return provided.length === wanted.length && timingSafeEqual(provided, wanted);
}

function cleanName(value, fallback) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 64) || fallback : fallback;
}

function normalizeCode(value) {
  if (typeof value !== 'string') return null;
  const code = value.toUpperCase().replace(/[\s-]/g, '');
  return code.length === 8 && [...code].every((char) => ALPHABET.includes(char)) ? code : null;
}

function verifiedDeviceId(identity, nonce) {
  if (!plain(identity) || !plain(identity.publicKey) || typeof identity.signature !== 'string') return null;
  const jwk = identity.publicKey;
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256'
    || typeof jwk.x !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(jwk.x)
    || typeof jwk.y !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(jwk.y)
    || !/^[A-Za-z0-9_-]{86}$/.test(identity.signature)) return null;
  const publicJwk = { crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y };
  try {
    const key = createPublicKey({ key: publicJwk, format: 'jwk' });
    const valid = verify('sha256', Buffer.from(nonce, 'utf8'), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(identity.signature, 'base64url'));
    return valid ? createHash('sha256').update(JSON.stringify(publicJwk)).digest('hex').slice(0, 32) : null;
  } catch { return null; }
}

function validTrust(trust) {
  return plain(trust) && typeof trust.id === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(trust.id)
    && typeof trust.proof === 'string' && /^[A-Za-z0-9_-]{43}$/.test(trust.proof);
}

function validSignal(signal) {
  if (!plain(signal)) return false;
  const { description, candidate } = signal;
  if (description !== undefined && candidate !== undefined) return false;
  if (description !== undefined) {
    return plain(description) && ['offer', 'answer'].includes(description.type)
      && typeof description.sdp === 'string' && description.sdp.length > 0 && description.sdp.length <= 96 * 1024;
  }
  if (candidate !== undefined) {
    return plain(candidate) && typeof candidate.candidate === 'string' && candidate.candidate.length <= 16 * 1024
      && (candidate.sdpMid == null || (typeof candidate.sdpMid === 'string' && candidate.sdpMid.length <= 256))
      && (candidate.sdpMLineIndex == null || (Number.isInteger(candidate.sdpMLineIndex) && candidate.sdpMLineIndex >= 0 && candidate.sdpMLineIndex < 256))
      && (candidate.usernameFragment == null || (typeof candidate.usernameFragment === 'string' && candidate.usernameFragment.length <= 256));
  }
  return false;
}

function send(client, message) {
  if (client?.ws.readyState !== WebSocket.OPEN) return;
  if (client.ws.bufferedAmount > 4 * 1024 * 1024) {
    client.ws.close(1008, 'Slow connection');
    return;
  }
  client.ws.send(JSON.stringify(message));
}

/**
 * Local signaling and static web server. Verified account owners can reach
 * their own online hosts; invitations from other accounts require approval.
 */
export function createSignalingServer(options = {}) {
  const env = options.env ?? process.env;
  const googleRequired = options.googleAuth !== false;
  const serviceToken = typeof env.SERVICE_TOKEN === 'string' ? env.SERVICE_TOKEN : '';
  if (!googleRequired && splitUrls(env.TURN_URLS).length && !serviceToken) {
    throw new Error('Configura SERVICE_TOKEN antes de habilitar TURN_URLS para proteger el acceso al relay.');
  }
  const authProtocol = serviceToken ? `auth.${Buffer.from(serviceToken, 'utf8').toString('base64url')}` : null;
  const host = options.host ?? env.HOST ?? '127.0.0.1';
  if (!googleRequired && !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host)) {
    throw new Error('googleAuth:false solo está permitido en fixtures enlazados a localhost.');
  }
  const port = options.port ?? Number(env.PORT ?? 8080);
  const staticDir = path.resolve(options.staticDir ?? path.join(process.cwd(), 'dist'));
  const now = options.now ?? Date.now;
  const roomTtlMs = options.roomTtlMs ?? 15 * 60 * 1000;
  const pendingTtlMs = options.pendingTtlMs ?? 60 * 1000;
  const cleanupIntervalMs = options.cleanupIntervalMs ?? 10_000;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 25_000;
  const production = env.NODE_ENV === 'production';
  const allowedOrigins = new Set(splitUrls(env.ALLOWED_ORIGINS));
  const allowedEmails = new Set(splitUrls(env.GOOGLE_ALLOWED_EMAILS).map((email) => email.toLowerCase()));
  const googleClientId = env.GOOGLE_CLIENT_ID || DEFAULT_GOOGLE_CLIENT_ID;
  const googleVerifier = options.googleVerifier ?? createGoogleTokenVerifier({ clientId: googleClientId, now });
  const googleTimeoutMs = options.googleTimeoutMs ?? 10000;
  const accountSessions = googleRequired ? new AccountSessionStore({
    file: options.sessionStorePath === null ? null : options.sessionStorePath ?? (env.INHOUSE_SESSION_FILE || path.resolve('data/account-sessions.json')),
    now, ttlMs: options.sessionTtlMs, maxSessions: options.sessionMaxCount, maxPerAccount: options.sessionMaxPerAccount,
  }) : null;
  const clients = new Set();
  const rooms = new Map();
  const roomsByDevice = new Map();
  const activeConnections = new Map();
  const perIp = new Map();
  const upgrading = new Map();
  const upgradingSockets = new Set();
  const requests = new Map();
  let closing = false;

  function publicAccount(account) {
    return account ? { id: account.id, name: account.name, email: account.email } : null;
  }

  function sessionProfile(account) {
    return { ...publicAccount(account), photo: typeof account?.photo === 'string' ? account.photo : '' };
  }

  function accountName(account, fallback) {
    return account ? `${account.email} · ${cleanName(account.name, account.email)}` : fallback;
  }

  async function accountForToken(token) {
    if (!validGoogleAccessToken(token)) throw new GoogleAuthError();
    if (token.startsWith('ihl_')) {
      const saved = validAppToken(token) ? accountSessions?.lookup(token) : null;
      if (!saved) throw new GoogleAuthError('La sesión de Inhouse ha caducado o se ha cerrado. Vuelve a entrar con Google.');
      if (allowedEmails.size && !allowedEmails.has(saved.profile.email.toLowerCase())) {
        throw new GoogleAuthError('Esta cuenta de Google no tiene acceso a este servicio.', 403);
      }
      return Object.freeze({ ...saved.profile, expiresAt: saved.expiresAt, sessionHash: saved.hash });
    }
    let timer;
    try {
      const account = await Promise.race([
        Promise.resolve().then(() => googleVerifier(token)),
        new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new GoogleAuthError('Google no responde a la verificación de cuenta.', 503)), googleTimeoutMs); }),
      ]);
      if (!account || typeof account.id !== 'string' || !account.id || account.id.length > 256
        || typeof account.name !== 'string' || typeof account.email !== 'string'
        || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(account.email)
        || typeof account.expiresAt !== 'number' || !Number.isFinite(account.expiresAt) || account.expiresAt <= now()) throw new GoogleAuthError();
      if (allowedEmails.size && !allowedEmails.has(account.email.toLowerCase())) {
        throw new GoogleAuthError('Esta cuenta de Google no tiene acceso a este servicio.', 403);
      }
      return Object.freeze({ ...publicAccount(account), photo: typeof account.photo === 'string' && account.photo.startsWith('https://') ? account.photo.slice(0, 2048) : '', expiresAt: account.expiresAt });
    } catch (error) {
      if (error instanceof GoogleAuthError) throw error;
      throw new GoogleAuthError('No se pudo verificar la cuenta con Google. Inténtalo de nuevo.', 503);
    } finally { clearTimeout(timer); }
  }

  async function authenticateHttp(req) {
    if (serviceToken && !safeEqual(req.headers['x-inhouse-service-key'], serviceToken)) {
      throw new GoogleAuthError('Se necesita una clave de servicio válida.');
    }
    if (!googleRequired) return null;
    const match = typeof req.headers.authorization === 'string' ? /^Bearer (\S+)$/i.exec(req.headers.authorization) : null;
    return accountForToken(match?.[1]);
  }

  async function authenticateSocket(req) {
    const protocols = splitUrls(req.headers['sec-websocket-protocol']);
    if ((googleRequired || serviceToken) && !protocols.includes(SIGNAL_PROTOCOL)) throw new GoogleAuthError();
    if (serviceToken && !protocols.some((value) => safeEqual(value, authProtocol))) {
      throw new GoogleAuthError('Se necesita una clave de servicio válida.');
    }
    if (!googleRequired) return null;
    const credentials = protocols.filter((value) => value.startsWith('google.'));
    if (credentials.length !== 1) throw new GoogleAuthError();
    const encoded = credentials[0].slice('google.'.length);
    if (!/^[A-Za-z0-9_-]+$/.test(encoded) || encoded.length > 11000) throw new GoogleAuthError();
    const token = Buffer.from(encoded, 'base64url').toString('utf8');
    if (Buffer.from(token, 'utf8').toString('base64url') !== encoded) throw new GoogleAuthError();
    return accountForToken(token);
  }

  function requestIp(req) {
    const ip = req.socket.remoteAddress ?? 'unknown';
    // Only a local reverse proxy may provide a forwarding address. The final
    // X-Forwarded-For entry is the direct client seen by that proxy.
    if (env.TRUST_PROXY === '1' && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip)) {
      const forwarded = req.headers['x-forwarded-for'];
      const last = typeof forwarded === 'string' ? forwarded.split(',').at(-1)?.trim() : null;
      if (last && isIP(last)) return last;
    }
    return ip;
  }

  function originAllowed(req) {
    const origin = req.headers.origin;
    // Native clients cannot be trusted by Origin anyway. Pairing still requires
    // a fresh invitation and explicit host consent for every client.
    if (!origin) return true;
    if (typeof origin !== 'string' || origin === 'null') return false;
    if (allowedOrigins.has(origin)) return true;
    let url;
    try { url = new URL(origin); } catch { return false; }
    if (!['http:', 'https:'].includes(url.protocol)) return false;
    if (url.host === req.headers.host) return true;
    // The desktop app serves its isolated renderer from an ephemeral loopback
    // port. This grants config access, not session authorization or control.
    if (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return true;
    return !production && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && url.port === '5173';
  }

  function permitRequest(ip, kind, count, interval) {
    const key = `${ip}:${kind}`;
    const time = now();
    let bucket = requests.get(key);
    if (!bucket || time - bucket.start >= interval) {
      bucket = { start: time, count: 0, until: time + interval };
      requests.set(key, bucket);
    }
    bucket.count += 1;
    return bucket.count <= count;
  }

  function headers(res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), display-capture=(self)');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' https://accounts.google.com; style-src 'self' 'unsafe-inline' https://accounts.google.com; img-src 'self' data: blob: https://*.googleusercontent.com; frame-src https://accounts.google.com; worker-src 'self' blob:; media-src 'self' blob:; connect-src 'self' https: wss: http://127.0.0.1:* http://localhost:* ws://127.0.0.1:* ws://localhost:*; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  }

  function json(res, status, value) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(value));
  }

  const httpServer = http.createServer(async (req, res) => {
    if (options.handleDesktopAuth) {
      try { if (await options.handleDesktopAuth(req, res)) return; }
      catch {
        if (res.headersSent) res.destroy();
        else { headers(res); json(res, 500, { error: 'No se pudo completar la autenticación de escritorio.' }); }
        return;
      }
    }
    headers(res);
    const rawPath = (req.url ?? '/').split('?')[0];
    let pathname;
    try { pathname = decodeURIComponent(rawPath); } catch { return json(res, 400, { error: 'Invalid path' }); }
    if (pathname.includes('\0') || pathname.includes('\\') || pathname.split('/').includes('..')) {
      return json(res, 403, { error: 'Forbidden' });
    }
    const accountConnection = /^\/api\/account\/connection\/([a-f0-9-]{36})$/i.exec(pathname);
    if (pathname === '/api/config' || pathname === '/api/auth/session' || accountConnection) {
      const methods = pathname === '/api/auth/session' ? ['GET', 'HEAD', 'POST', 'DELETE'] : ['GET', 'HEAD'];
      if (!originAllowed(req)) return json(res, 403, { error: 'Origin not allowed' });
      const origin = req.headers.origin;
      if (origin) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
      }
      if (req.method === 'OPTIONS') {
        const requestedMethod = req.headers['access-control-request-method'];
        const requestedHeaders = splitUrls(req.headers['access-control-request-headers']).map((value) => value.toLowerCase());
        if ((requestedMethod && !methods.includes(requestedMethod)) || requestedHeaders.some((value) => !['authorization', 'x-inhouse-service-key'].includes(value))) {
          return json(res, 403, { error: 'Preflight not allowed' });
        }
        res.writeHead(204, {
          'Access-Control-Allow-Methods': methods.join(', '),
          'Access-Control-Allow-Headers': 'Authorization, X-Inhouse-Service-Key',
          'Access-Control-Max-Age': '600',
          'Cache-Control': 'no-store',
        });
        return res.end();
      }
      if (!methods.includes(req.method)) return json(res, 405, { error: 'Method not allowed' });
      const ip = requestIp(req);
      if (!permitRequest(ip, 'config', 120, 60_000)) return json(res, 429, { error: 'Too many requests' });
      let account;
      try { account = await authenticateHttp(req); }
      catch (error) {
        res.setHeader('WWW-Authenticate', 'Bearer realm="Google Inhouse"');
        return json(res, error.status ?? 401, { error: error.message });
      }
      if (accountConnection) {
        const connection = activeConnections.get(accountConnection[1]);
        const connectionHost = connection?.host;
        const viewer = connection?.viewer;
        if (!account || !connection?.accountAuthorized || !connectionHost?.deviceId || !viewer
          || account.id !== connectionHost.account?.id
          || (connectionHost.account.sessionHash && account.sessionHash !== connectionHost.account.sessionHash)
          || connectionHost.peer !== viewer || viewer.peer !== connectionHost
          || connectionHost.ws.readyState !== WebSocket.OPEN || viewer.ws.readyState !== WebSocket.OPEN
          || !connectionHost.room || !sameAccount(viewer, connectionHost.room)) {
          return json(res, 404, { error: 'La conexión de este equipo no está disponible.' });
        }
        const expiresAt = Math.min(now() + 60_000, connectionHost.account.expiresAt, viewer.account.expiresAt);
        if (expiresAt <= now()) return json(res, 404, { error: 'La conexión de este equipo no está disponible.' });
        return json(res, 200, {
          connectionId: accountConnection[1], hostId: connectionHost.deviceId,
          ownerAccountId: connectionHost.account.id, viewerAccountId: viewer.account.id, expiresAt, active: true,
        });
      }
      if (pathname === '/api/auth/session') {
        if (req.method === 'POST') {
          if (!account || !accountSessions) return json(res, 401, { error: 'Entra con Google antes de guardar una sesión de Inhouse.' });
          if (account.sessionHash) {
            const token = /^Bearer (\S+)$/i.exec(req.headers.authorization)?.[1];
            return json(res, 200, { accessToken: token, expiresAt: account.expiresAt, profile: sessionProfile(account) });
          }
          if (!permitRequest(ip, 'session-create', 10, 60_000)) return json(res, 429, { error: 'Demasiadas sesiones nuevas. Espera un minuto.' });
          try { return json(res, 201, await accountSessions.create(sessionProfile(account))); }
          catch (error) { return json(res, error.status ?? 503, { error: error.message }); }
        }
        if (req.method === 'DELETE') {
          if (!account?.sessionHash || !accountSessions) return json(res, 400, { error: 'La credencial actual no es una sesión guardada de Inhouse.' });
          try { await accountSessions.revoke(account.sessionHash); }
          catch (error) { return json(res, error.status ?? 503, { error: error.message }); }
          for (const client of clients) if (client.account?.sessionHash === account.sessionHash) client.ws.close(1008, 'Account session revoked');
          res.writeHead(204, { 'Cache-Control': 'no-store' });
          return res.end();
        }
        return json(res, 200, { account: publicAccount(account), profile: account ? sessionProfile(account) : null, expiresAt: account?.expiresAt ?? null });
      }
      return json(res, 200, { ...buildIceConfig(env, now()), account: publicAccount(account) });
    }
    if (!['GET', 'HEAD'].includes(req.method)) return json(res, 405, { error: 'Method not allowed' });
    if (pathname === '/health') return json(res, 200, { ok: true, version: VERSION });
    if (pathname.startsWith('/api/') || pathname === '/signal') return json(res, 404, { error: 'Not found' });
    let file = path.resolve(staticDir, `.${pathname}`);
    if (!file.startsWith(staticDir + path.sep) && file !== staticDir) return json(res, 403, { error: 'Forbidden' });
    try {
      let info;
      try { info = await stat(file); } catch {
        if (path.extname(pathname)) return json(res, 404, { error: 'Not found' });
        file = path.join(staticDir, 'index.html');
        info = await stat(file);
      }
      if (info.isDirectory()) file = path.join(file, 'index.html');
      const [rootReal, fileReal] = await Promise.all([realpath(staticDir), realpath(file)]);
      if (!fileReal.startsWith(rootReal + path.sep)) return json(res, 403, { error: 'Forbidden' });
      const fileInfo = await stat(fileReal);
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(fileReal)] ?? 'application/octet-stream',
        'Content-Length': fileInfo.size,
        'Cache-Control': pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
      });
      if (req.method === 'HEAD') res.end();
      else {
        const stream = createReadStream(fileReal);
        stream.on('error', () => res.destroy());
        res.on('close', () => stream.destroy());
        stream.pipe(res);
      }
    } catch {
      json(res, 404, { error: 'Web app not built. Run npm run build first, or npm run dev for development.' });
    }
  });

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 128 * 1024,
    perMessageDeflate: false,
    // The authentication protocol is an input credential, never a negotiated
    // response value. Only the public, versioned protocol is reflected.
    handleProtocols: (protocols) => protocols.has(SIGNAL_PROTOCOL) ? SIGNAL_PROTOCOL : false,
  });

  function error(client, message) { send(client, { type: 'error', message }); }

  function accountSessionActive(client) {
    return Boolean(client.account?.id) && (!client.account.sessionHash || client.account.expiresAt > now());
  }

  function sameAccount(client, room) {
    return accountSessionActive(client) && accountSessionActive(room.host) && client.account.id === room.owner?.id;
  }

  function onlineDevices(accountId) {
    return [...roomsByDevice.values()]
      .filter((room) => room.owner?.id === accountId && accountSessionActive(room.host) && room.host.ws.readyState === WebSocket.OPEN)
      .map((room) => ({ deviceId: room.host.deviceId, name: room.host.deviceName, online: true, busy: Boolean(room.host.peer) }))
      .sort((a, b) => a.name.localeCompare(b.name) || a.deviceId.localeCompare(b.deviceId));
  }

  function sendDevices(client) {
    if (accountSessionActive(client)) send(client, { type: 'devices', devices: onlineDevices(client.account.id) });
  }

  function broadcastDevices(accountId) {
    if (!accountId) return;
    for (const client of clients) {
      if (client.deviceSubscription && client.account?.id === accountId) sendDevices(client);
    }
  }

  function pair(room, viewer, accountAuthorized = false) {
    const host = room.host;
    const connectionId = randomUUID();
    host.peer = viewer;
    viewer.peer = host;
    host.connectionId = connectionId;
    viewer.connectionId = connectionId;
    viewer.role = 'viewer';
    viewer.room = room;
    viewer.pendingId = null;
    room.lastActivity = now();
    const identity = host.deviceId ? { deviceId: host.deviceId } : {};
    const authorization = accountAuthorized ? { accountAuthorized: true } : {};
    activeConnections.set(connectionId, { host, viewer, accountAuthorized });
    if (accountAuthorized) send(viewer, { type: 'approved', ...authorization, ...identity, name: host.name, deviceName: host.deviceName, account: publicAccount(host.account) });
    send(host, { type: 'paired', peerId: viewer.id, name: viewer.name, account: publicAccount(viewer.account), initiator: true, deviceName: host.deviceName, connectionId, ...identity, ...authorization });
    send(viewer, { type: 'paired', peerId: host.id, name: host.name, account: publicAccount(host.account), initiator: false, deviceName: host.deviceName, connectionId, ...identity, ...authorization });
    for (const other of room.pending.values()) {
      other.client.pendingId = null;
      other.client.role = null;
      other.client.room = null;
      send(other.client, { type: 'rejected', message: 'El anfitrión ha aceptado otra conexión.' });
    }
    room.pending.clear();
    broadcastDevices(room.owner?.id);
  }

  function cancelPending(client, reason) {
    if (!client.pendingId || !client.room) return;
    const room = client.room;
    if (room.pending.delete(client.pendingId)) {
      // This additive event lets the host remove canceled/expired prompts.
      send(room.host, { type: 'request-cancelled', id: client.pendingId });
    }
    client.pendingId = null;
    client.room = null;
    client.role = null;
    if (reason) error(client, reason);
  }

  function disconnectPeer(host) {
    const viewer = host.peer;
    if (!viewer) return;
    if (host.connectionId) activeConnections.delete(host.connectionId);
    host.connectionId = null;
    host.peer = null;
    viewer.connectionId = null;
    viewer.peer = null;
    viewer.pendingId = null;
    viewer.role = null;
    viewer.room = null;
    host.room.lastActivity = now();
    send(viewer, { type: 'peer-left' });
    send(host, { type: 'peer-left' });
    broadcastDevices(host.room.owner?.id);
  }

  function leave(client) {
    cancelPending(client);
    const room = client.room;
    if (client.connectionId) activeConnections.delete(client.connectionId);
    client.connectionId = null;
    if (client.peer) {
      const peer = client.peer;
      client.peer = null;
      peer.peer = null;
      peer.connectionId = null;
      send(peer, { type: 'peer-left' });
      if (peer.role === 'viewer') {
        peer.role = null;
        peer.room = null;
      }
    }
    if (client.role === 'host' && room) {
      for (const pending of room.pending.values()) {
        pending.client.pendingId = null;
        pending.client.room = null;
        pending.client.role = null;
        error(pending.client, 'El anfitrión ha dejado de compartir.');
      }
      room.pending.clear();
      rooms.delete(room.code);
      if (room.host.deviceId) roomsByDevice.delete(room.host.deviceId);
    } else if (room?.host) {
      room.lastActivity = now();
    }
    client.role = null;
    client.room = null;
    broadcastDevices(room?.owner?.id);
  }

  httpServer.on('upgrade', async (req, socket, head) => {
    const pathname = (req.url ?? '').split('?')[0];
    const ip = requestIp(req);
    if (closing || pathname !== '/signal' || !originAllowed(req) || (perIp.get(ip) ?? 0) + (upgrading.get(ip) ?? 0) >= 32) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    if (googleRequired || serviceToken) {
      if (!permitRequest(ip, 'auth-upgrade', 120, 60_000)) {
        socket.write('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
    }
    upgrading.set(ip, (upgrading.get(ip) ?? 0) + 1);
    upgradingSockets.add(socket);
    socket.on('error', () => { /* Do not log authentication headers. */ });
    try {
      req.inhouseAccount = await authenticateSocket(req);
      if (!closing && !socket.destroyed) wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
      else socket.destroy();
    } catch (error) {
      if (!socket.destroyed) {
        const status = [401, 403, 503].includes(error.status) ? error.status : 503;
        const label = status === 401 ? 'Unauthorized' : status === 403 ? 'Forbidden' : 'Service Unavailable';
        socket.write(`HTTP/1.1 ${status} ${label}\r\nConnection: close\r\n\r\n`);
        socket.destroy();
      }
    } finally {
      upgradingSockets.delete(socket);
      const count = (upgrading.get(ip) ?? 1) - 1;
      if (count > 0) upgrading.set(ip, count); else upgrading.delete(ip);
    }
  });

  wss.on('connection', (ws, req) => {
    const ip = requestIp(req);
    const client = { id: randomUUID(), ws, ip, account: req.inhouseAccount, nonce: randomBytes(32).toString('base64url'), deviceId: null, name: 'Equipo', deviceName: 'PC Inhouse', deviceSubscription: false, connectionId: null, role: null, room: null, peer: null, pendingId: null, alive: true, bucketStart: now(), count: 0 };
    clients.add(client);
    perIp.set(ip, (perIp.get(ip) ?? 0) + 1);
    send(client, { type: 'hello', nonce: client.nonce, account: publicAccount(client.account) });
    ws.on('pong', () => { client.alive = true; });
    ws.on('error', () => { /* socket close owns cleanup; never log raw signaling */ });
    ws.on('message', (data, isBinary) => {
      if (client.account?.sessionHash && !accountSessionActive(client)) { ws.close(1008, 'Account session expired'); return; }
      if (isBinary) return error(client, 'Solo se admiten mensajes JSON.');
      const time = now();
      if (time - client.bucketStart > 1000) { client.bucketStart = time; client.count = 0; }
      if (++client.count > 180) { ws.close(1008, 'Message rate limit'); return; }
      let message;
      try { message = JSON.parse(data.toString()); } catch { return error(client, 'Mensaje JSON inválido.'); }
      if (!plain(message) || typeof message.type !== 'string') return error(client, 'Mensaje inválido.');
      switch (message.type) {
        case 'ping': send(client, { type: 'pong' }); break;
        case 'devices': {
          if (!accountSessionActive(client)) return error(client, 'Entra con Google para ver tus equipos.');
          client.deviceSubscription = message.subscribe !== false;
          sendDevices(client);
          break;
        }
        case 'host': {
          if (client.role || client.pendingId) return error(client, 'Ya hay una sesión activa.');
          if (!permitRequest(ip, 'host', 30, 60_000)) return error(client, 'Demasiados intentos. Espera un minuto.');
          const deviceId = message.identity === undefined ? null : verifiedDeviceId(message.identity, client.nonce);
          if (message.identity !== undefined && !deviceId) return error(client, 'La identidad del equipo no es válida.');
          if (deviceId && roomsByDevice.has(deviceId)) return error(client, 'Este equipo ya está compartiendo en otra sesión.');
          let code;
          do { code = Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]).join(''); } while (rooms.has(code));
          const room = { code, host: client, owner: publicAccount(client.account), pending: new Map(), lastActivity: time };
          client.role = 'host';
          client.name = accountName(client.account, cleanName(message.name, 'PC anfitrión'));
          client.deviceName = cleanName(message.name, 'PC Inhouse');
          client.deviceId = deviceId;
          client.room = room;
          rooms.set(code, room);
          if (deviceId) roomsByDevice.set(deviceId, room);
          send(client, { type: 'hosted', code: `${code.slice(0, 4)}-${code.slice(4)}`, account: publicAccount(client.account), ...(deviceId ? { deviceId } : {}) });
          broadcastDevices(room.owner?.id);
          break;
        }
        case 'join': {
          if (client.role || client.pendingId) return error(client, 'Ya hay una sesión activa.');
          if (!permitRequest(ip, 'join', 20, 60_000)) return error(client, 'Demasiados intentos. Espera un minuto.');
          const stableId = typeof message.code === 'string' && /^[a-fA-F0-9]{32}$/.test(message.code.trim()) ? message.code.trim().toLowerCase() : null;
          const code = normalizeCode(message.code);
          const room = stableId ? roomsByDevice.get(stableId) : code && rooms.get(code);
          if (!room || room.host.ws.readyState !== WebSocket.OPEN) return error(client, stableId ? 'Este equipo no está disponible para esta cuenta.' : 'Código no válido o caducado.');
          const ownerConnection = sameAccount(client, room);
          const trustedOnly = Boolean(stableId && !ownerConnection);
          if (trustedOnly && !validTrust(message.trust)) return error(client, 'Este equipo no está disponible para esta cuenta.');
          if (message.trust !== undefined && !validTrust(message.trust)) return error(client, 'La prueba de confianza no es válida.');
          if (room.host.peer) return error(client, 'Este PC ya tiene una conexión activa.');
          client.name = accountName(client.account, cleanName(message.name, 'Portátil'));
          if (ownerConnection) { pair(room, client, true); break; }
          if (room.pending.size >= 5) return error(client, 'Hay demasiadas solicitudes pendientes.');
          const id = randomUUID();
          client.role = 'viewer';
          client.room = room;
          client.pendingId = id;
          room.pending.set(id, { client, createdAt: time, trustedOnly });
          room.lastActivity = time;
          send(client, { type: 'pending' });
          send(room.host, { type: 'join-request', id, name: client.name, account: publicAccount(client.account), ...(trustedOnly ? { trustedOnly: true } : {}),
            ...(message.trust ? { trust: { id: message.trust.id, proof: message.trust.proof, nonce: client.nonce } } : {}) });
          break;
        }
        case 'approve': {
          if (client.role !== 'host' || !client.room || typeof message.id !== 'string' || typeof message.allow !== 'boolean') {
            return error(client, 'No puedes autorizar esta solicitud.');
          }
          const room = client.room;
          const pending = room.pending.get(message.id);
          if (!pending) return error(client, 'La solicitud ya no está disponible.');
          const viewer = pending.client;
          room.pending.delete(message.id);
          viewer.pendingId = null;
          if (time - pending.createdAt >= pendingTtlMs) {
            viewer.role = null;
            viewer.room = null;
            error(viewer, 'La solicitud de conexión ha caducado.');
            return error(client, 'La solicitud de conexión ha caducado.');
          }
          if (!message.allow || client.peer) {
            viewer.role = null;
            viewer.room = null;
            send(viewer, { type: 'rejected', message: 'El anfitrión ha rechazado la conexión.' });
            return;
          }
          pair(room, viewer);
          break;
        }
        case 'signal': {
          if (!client.peer || client.pendingId) return error(client, 'La conexión necesita aprobación del anfitrión.');
          if (!validSignal(message.signal)) return error(client, 'Señal WebRTC inválida.');
          if (client.room) client.room.lastActivity = time;
          send(client.peer, { type: 'signal', signal: message.signal });
          break;
        }
        case 'disconnect-peer': {
          if (client.role !== 'host' || !client.room) return error(client, 'Solo el anfitrión puede finalizar la conexión de este equipo.');
          disconnectPeer(client);
          break;
        }
        case 'leave': leave(client); break;
        default: error(client, 'Tipo de mensaje desconocido.');
      }
    });
    ws.on('close', () => {
      leave(client);
      clients.delete(client);
      const count = (perIp.get(ip) ?? 1) - 1;
      if (count > 0) perIp.set(ip, count); else perIp.delete(ip);
    });
  });

  const cleanup = setInterval(() => {
    const time = now();
    for (const room of rooms.values()) {
      for (const pending of [...room.pending.values()]) {
        if (time - pending.createdAt >= pendingTtlMs) cancelPending(pending.client, 'La solicitud de conexión ha caducado.');
      }
      if (!room.host.deviceId && !room.host.peer && time - room.lastActivity >= roomTtlMs) {
        error(room.host, 'El código ha caducado. Vuelve a compartir para generar otro.');
        leave(room.host);
      }
    }
    for (const client of clients) if (client.account?.sessionHash && client.account.expiresAt <= time) client.ws.close(1008, 'Account session expired');
    void accountSessions?.pruneExpired().catch(() => { /* A later mutation retries persistence; expired tokens still fail closed. */ });
    for (const [key, bucket] of requests) if (time > bucket.until + 60_000) requests.delete(key);
  }, cleanupIntervalMs);
  cleanup.unref();
  const heartbeat = setInterval(() => {
    for (const client of clients) {
      if (!client.alive) { client.ws.terminate(); continue; }
      client.alive = false;
      client.ws.ping();
    }
  }, heartbeatIntervalMs);
  heartbeat.unref();

  return {
    httpServer, wss,
    get address() { return httpServer.address(); },
    async listen() {
      await accountSessions?.load();
      return new Promise((resolve, reject) => {
        const onError = (error) => reject(error);
        httpServer.once('error', onError);
        httpServer.listen(port, host, () => {
          httpServer.off('error', onError);
          resolve(httpServer.address());
        });
      });
    },
    async close() {
      if (closing) return;
      closing = true;
      clearInterval(cleanup);
      clearInterval(heartbeat);
      for (const socket of upgradingSockets) socket.destroy();
      for (const client of clients) client.ws.terminate();
      await new Promise((resolve) => wss.close(resolve));
      if (httpServer.listening) {
        await new Promise((resolve) => {
          httpServer.close(resolve);
          httpServer.closeIdleConnections?.();
        });
      }
      await accountSessions?.flush();
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = createSignalingServer();
  server.listen().then((address) => {
    console.log(`Inhouse Link ${VERSION} — ${typeof address === 'object' ? `${address.address}:${address.port}` : address}`);
  }).catch((error) => {
    console.error(`No se pudo iniciar el servidor: ${error.code ?? error.message}`);
    process.exitCode = 1;
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => void server.close().then(() => process.exit(0)));
}
