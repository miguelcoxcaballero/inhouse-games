'use strict';

const { randomBytes, generateKeyPairSync, createPublicKey, diffieHellman, hkdfSync, createDecipheriv, timingSafeEqual } = require('node:crypto');

const CALLBACK_ORIGIN = 'http://127.0.0.1:48715';
const CALLBACK_PATH = '/auth/google/callback';
const PUBLIC_APP_URL = 'https://miguelcoxcaballero.github.io/inhouse-games/';
const HANDOFF_INFO = 'inhouse-link:google-desktop:v1';
const MAX_BODY = 32 * 1024;
const CODE = /^[A-Za-z0-9_-]{43}$/;

function publicKeyOnly(value) {
  if (!value || typeof value !== 'object' || value.kty !== 'EC' || value.crv !== 'P-256'
    || !CODE.test(value.x ?? '') || !CODE.test(value.y ?? '') || 'd' in value) throw new Error('Invalid handoff key.');
  return { kty: 'EC', crv: 'P-256', x: value.x, y: value.y };
}

function approvedBrokerUrl(value = PUBLIC_APP_URL) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.hostname !== 'miguelcoxcaballero.github.io'
    || url.port || url.username || url.password || url.pathname.replace(/\/$/, '') !== '/inhouse-games' || url.search) {
    throw new Error('El acceso de Google debe usar la página pública HTTPS de Inhouse Link.');
  }
  url.pathname = '/inhouse-games/';
  url.hash = '';
  return url;
}

function decryptHandoff(privateKey, state, envelope, now = Date.now()) {
  if (!envelope || typeof envelope !== 'object' || envelope.v !== 1
    || typeof envelope.iv !== 'string' || !/^[A-Za-z0-9_-]{16}$/.test(envelope.iv)
    || typeof envelope.ciphertext !== 'string' || !/^[A-Za-z0-9_-]{22,24000}$/.test(envelope.ciphertext)) {
    throw new Error('Invalid encrypted handoff.');
  }
  const key = createPublicKey({ key: publicKeyOnly(envelope.key), format: 'jwk' });
  const shared = diffieHellman({ privateKey, publicKey: key });
  const derived = Buffer.from(hkdfSync('sha256', shared, Buffer.from(state, 'base64url'), Buffer.from(HANDOFF_INFO), 32));
  shared.fill(0);
  const encrypted = Buffer.from(envelope.ciphertext, 'base64url');
  const decipher = createDecipheriv('aes-256-gcm', derived, Buffer.from(envelope.iv, 'base64url'));
  derived.fill(0);
  decipher.setAAD(Buffer.from(state));
  decipher.setAuthTag(encrypted.subarray(-16));
  const cleartext = Buffer.concat([decipher.update(encrypted.subarray(0, -16)), decipher.final()]);
  let payload;
  try { payload = JSON.parse(cleartext.toString('utf8')); } finally { cleartext.fill(0); }
  if (!payload || typeof payload.accessToken !== 'string'
    || !/^[A-Za-z0-9\-._~+/]+=*$/.test(payload.accessToken) || payload.accessToken.length < 20 || payload.accessToken.length > 8192
    || typeof payload.expiresAt !== 'number' || !Number.isFinite(payload.expiresAt)
    || payload.expiresAt <= now + 10_000 || payload.expiresAt > now + 24 * 60 * 60 * 1000) {
    throw new Error('Invalid Google session handoff.');
  }
  return { accessToken: payload.accessToken, expiresAt: payload.expiresAt };
}

function createDesktopGoogleAuth(options = {}) {
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? 5 * 60 * 1000;
  let pending = null;

  function cancel(message = 'Se ha cancelado el acceso con Google.') {
    const previous = pending;
    pending = null;
    if (previous) { clearTimeout(previous.timer); previous.reject(new Error(message)); }
  }

  function begin() {
    cancel('Se ha iniciado otra solicitud de acceso con Google.');
    const broker = approvedBrokerUrl(options.publicAppUrl);
    const state = randomBytes(32).toString('base64url');
    const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const key = publicKeyOnly(pair.publicKey.export({ format: 'jwk' }));
    let resolve;
    let reject;
    const promise = new Promise((done, failed) => { resolve = done; reject = failed; });
    const attempt = { state, privateKey: pair.privateKey, expires: now() + timeoutMs, resolve, reject, timer: null };
    attempt.timer = setTimeout(() => {
      if (pending === attempt) cancel('El acceso con Google ha caducado. Vuelve a intentarlo desde la aplicación.');
    }, timeoutMs);
    attempt.timer.unref?.();
    pending = attempt;
    const params = new URLSearchParams({ state, key: Buffer.from(JSON.stringify(key)).toString('base64url'), callback: CALLBACK_ORIGIN + CALLBACK_PATH });
    broker.hash = `/desktop-auth?${params}`;
    return { url: broker.href, promise, cancel: () => { if (pending === attempt) cancel(); } };
  }

  function complete(state, envelope) {
    const attempt = pending;
    if (!attempt || typeof state !== 'string' || !CODE.test(state)
      || !timingSafeEqual(Buffer.from(state), Buffer.from(attempt.state))) throw new Error('No hay una solicitud válida para esta respuesta.');
    if (now() >= attempt.expires) {
      cancel('El acceso con Google ha caducado.');
      throw new Error('La solicitud ha caducado.');
    }
    const payload = decryptHandoff(attempt.privateKey, state, envelope, now());
    // Consume only after successful authenticated decryption. A retry, replay or
    // response from an earlier browser tab cannot resolve a different attempt.
    pending = null;
    clearTimeout(attempt.timer);
    attempt.resolve(payload);
    return true;
  }

  function headers(res, type) {
    res.setHeader('Content-Type', type);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), display-capture=()');
  }

  function json(res, status, body) {
    headers(res, 'application/json; charset=utf-8');
    res.writeHead(status);
    res.end(JSON.stringify(body));
  }

  async function handleRequest(req, res) {
    const pathname = (req.url ?? '').split('?')[0];
    if (![CALLBACK_PATH, CALLBACK_PATH + '.js', CALLBACK_PATH + '.css', '/auth/google/complete'].includes(pathname)) return false;
    if (req.headers.host !== '127.0.0.1:48715') { json(res, 403, { error: 'Origen de respuesta no permitido.' }); return true; }
    if (pathname === '/auth/google/complete') {
      if (req.method !== 'POST' || req.headers.origin !== CALLBACK_ORIGIN
        || String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase() !== 'application/json') {
        json(res, 403, { error: 'Respuesta no permitida.' }); return true;
      }
      let body = '';
      let tooLarge = false;
      try {
        for await (const chunk of req) {
          body += chunk.toString('utf8');
          if (Buffer.byteLength(body) > MAX_BODY) { tooLarge = true; break; }
        }
        if (tooLarge) { json(res, 413, { error: 'Respuesta demasiado grande.' }); return true; }
        const data = JSON.parse(body);
        if (typeof data.payload !== 'string' || !/^[A-Za-z0-9_-]{1,30000}$/.test(data.payload)) throw new Error('Invalid response.');
        const envelope = JSON.parse(Buffer.from(data.payload, 'base64url').toString('utf8'));
        complete(data.state, envelope);
        json(res, 200, { ok: true });
      } catch { json(res, 400, { error: 'Esta respuesta no es válida o ya ha caducado. Vuelve a iniciar el acceso desde Inhouse Link.' }); }
      return true;
    }
    if (req.method !== 'GET') { json(res, 405, { error: 'Método no permitido.' }); return true; }
    if (pathname === CALLBACK_PATH + '.js') {
      headers(res, 'text/javascript; charset=utf-8');
      res.end(CALLBACK_SCRIPT); return true;
    }
    if (pathname === CALLBACK_PATH + '.css') {
      headers(res, 'text/css; charset=utf-8');
      res.end(CALLBACK_CSS); return true;
    }
    headers(res, 'text/html; charset=utf-8');
    res.end(CALLBACK_HTML);
    return true;
  }

  return { begin, complete, cancel, handleRequest };
}

const CALLBACK_HTML = '<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Acceso · Inhouse Link</title><link rel="stylesheet" href="/auth/google/callback.css"><script src="/auth/google/callback.js" defer></script></head><body><main><span class="brand">inhouse link</span><h1 id="title">Terminando el acceso…</h1><p id="message" role="status">Estamos devolviendo la sesión a la aplicación de Windows.</p><p class="note">Puedes cerrar esta pestaña cuando termine.</p></main></body></html>';
const CALLBACK_CSS = 'html{color-scheme:dark}body{margin:0;background:#151515;color:#f2f0e8;font:17px system-ui,sans-serif;display:grid;min-height:100vh;place-items:center}main{width:min(560px,calc(100vw - 80px));padding:40px;border:1px solid #303030;border-radius:28px;background:#1c1c1c}.brand{color:#E07A3C;font-size:21px;letter-spacing:.02em}h1{font-size:34px;line-height:1.2}p{color:#c9c7bd;line-height:1.6}.note{font-size:13px;color:#96948c}';
const CALLBACK_SCRIPT = `(() => {
  const params = new URLSearchParams(location.hash.slice(1));
  const state = params.get('state');
  const payload = params.get('payload');
  history.replaceState(null, '', location.pathname);
  const title = document.getElementById('title');
  const message = document.getElementById('message');
  if (!state || !payload) {
    title.textContent = 'Esta respuesta está incompleta.';
    message.textContent = 'Vuelve a pulsar Entrar con Google en la aplicación de Inhouse Link.';
    return;
  }
  fetch('/auth/google/complete', {
    method: 'POST', credentials: 'omit', cache: 'no-store', redirect: 'error',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ state, payload })
  }).then(async (response) => {
    if (!response.ok) throw new Error('expired');
    title.textContent = 'Ya puedes volver a Inhouse Link.';
    message.textContent = 'El acceso se ha entregado a la aplicación de Windows. Puedes cerrar esta pestaña.';
  }).catch(() => {
    title.textContent = 'No se ha podido completar el acceso.';
    message.textContent = 'La solicitud puede haber caducado. Vuelve a iniciarla desde la aplicación de Inhouse Link.';
  });
})();`;

module.exports = { createDesktopGoogleAuth, decryptHandoff, approvedBrokerUrl, CALLBACK_ORIGIN, CALLBACK_PATH, HANDOFF_INFO, PUBLIC_APP_URL };
