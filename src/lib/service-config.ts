/** Public service discovery. This file never stores or transmits account tokens. */
const PUBLIC_CONFIG_URL = 'https://miguelcoxcaballero.github.io/inhouse-games/service.json';
const CACHE_KEY = 'inhouse.link.service-config.v1';
const BOOTSTRAP_TIMEOUT_MS = 5000;
type PublicServiceConfig = { schema: 1; signalingUrl: string | null };

let defaultOrigin: string | null = null;
let cacheLoaded = false;
let completed = false;
let pending: Promise<void> | null = null;

function validateConfig(value: unknown): PublicServiceConfig | null {
  if (!value || typeof value !== 'object') return null;
  const config = value as Record<string, unknown>;
  if (config.schema !== 1) return null;
  if (config.signalingUrl === null) return { schema: 1, signalingUrl: null };
  if (typeof config.signalingUrl !== 'string') return null;
  const raw = config.signalingUrl.trim();
  // A public default is an HTTPS origin, never a credential-bearing URL or API path.
  if (raw.length > 2048 || !/^https:\/\/[^/?#\s]+\/?$/i.test(raw)) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null;
    return { schema: 1, signalingUrl: url.origin };
  } catch { return null; }
}

function loadCachedConfig() {
  if (cacheLoaded) return;
  cacheLoaded = true;
  try {
    const cached = validateConfig(JSON.parse(localStorage.getItem(CACHE_KEY) || 'null'));
    if (cached) defaultOrigin = cached.signalingUrl;
  } catch { /* Storage is optional; an invalid cached value is never adopted. */ }
}

/** The public default is separate from the user's explicit service override. */
export function getDefaultServiceOrigin(): string | null {
  loadCachedConfig();
  return defaultOrigin;
}

/** Pages and Windows discover a private account realm when no Node service is
 * selected. A developer's localhost web app keeps using its Node fixture.
 */
export function useCloudAccountTransport(): boolean {
  let explicit = '';
  try { explicit = localStorage.getItem('inhouse.signalingUrl')?.trim() || ''; } catch { /* No explicit override. */ }
  if (explicit || import.meta.env?.VITE_SIGNALING_URL?.trim() || getDefaultServiceOrigin()) return false;
  if (typeof window !== 'undefined' && (window as unknown as { inhouseDesktop?: unknown }).inhouseDesktop) return true;
  const current = typeof window !== 'undefined' ? window.location : typeof location !== 'undefined' ? location : null;
  return !!current && (current.hostname === 'github.io' || current.hostname.endsWith('.github.io'));
}

function publicConfigUrl(): URL | null {
  const current = typeof window !== 'undefined' ? window.location : typeof location !== 'undefined' ? location : null;
  if (!current || !['http:', 'https:'].includes(current.protocol)) return null;
  if (typeof window !== 'undefined' && (window as unknown as { inhouseDesktop?: unknown }).inhouseDesktop) {
    return new URL(PUBLIC_CONFIG_URL);
  }
  try {
    const base = new URL(import.meta.env?.BASE_URL || '/', current.href);
    return new URL('service.json', base);
  } catch { return null; }
}

/** Resolve before restoring an issuer-bound account or opening signaling.
 * An outage retains the last validated default; a published null explicitly
 * removes it. Credentials and the user's override are never written here.
 */
export function bootstrapServiceConfig(): Promise<void> {
  loadCachedConfig();
  if (completed) return Promise.resolve();
  if (pending) return pending;
  const url = publicConfigUrl();
  if (!url || typeof fetch === 'undefined') return Promise.resolve();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error('Service configuration timed out.'));
    }, BOOTSTRAP_TIMEOUT_MS);
  });
  const request = async () => {
    const response = await fetch(url, {
      credentials: 'omit', redirect: 'error', cache: 'no-store', signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) throw new Error('Service configuration unavailable.');
    const text = await response.text();
    if (text.length > 16384) throw new Error('Service configuration too large.');
    const config = validateConfig(JSON.parse(text));
    if (!config) throw new Error('Invalid service configuration.');
    return config;
  };
  pending = (async () => {
    try {
      const config = await Promise.race([request(), deadline]);
      defaultOrigin = config.signalingUrl;
      completed = true;
      try { localStorage.setItem(CACHE_KEY, JSON.stringify(config)); } catch { /* The in-memory default remains usable. */ }
    } catch { /* The last validated cache is the only fallback during an outage. */ }
    finally { if (timer !== undefined) clearTimeout(timer); pending = null; }
  })();
  return pending;
}
