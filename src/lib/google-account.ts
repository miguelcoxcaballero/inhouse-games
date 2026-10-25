/** Google Identity Services, using the public web client shared by Notes/Read.
 * Only the Google account flow is shared; Link keeps its own token namespace.
 */
import { bootstrapServiceConfig, getDefaultServiceOrigin, useCloudAccountTransport } from './service-config.ts';
import {
  CLOUD_ACCOUNT_KEY, clearCloudAccount, createCloudAccountFromRealm, getCloudAccount,
  prepareCloudAccount, rememberCloudAccount, type CloudAccount,
} from './cloud-account.ts';

export const GOOGLE_CLIENT_ID = '435784295430-cmug30o42f1vu4ijgor9sjb0ro4oo37o.apps.googleusercontent.com';
export const GOOGLE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
export const GOOGLE_SESSION_KEY = 'inhouse.link.google-session.v1';
const SDK_URL = 'https://accounts.google.com/gsi/client';
const PROFILE_URL = 'https://www.googleapis.com/drive/v3/about?fields=user(displayName,emailAddress,photoLink,permissionId)';
const EXPIRY_MARGIN = 60_000;

export type GoogleProfile = { id: string; name: string; email: string; photo: string };
export type AccountState = {
  status: 'loading' | 'signed-out' | 'signed-in' | 'error';
  profile: GoogleProfile | null;
  error: string | null;
};
export type GoogleSession = { accessToken: string; expiresAt: number; profile: GoogleProfile; issuer?: string; kind?: 'cloud' };
export type GoogleAccountOptions = { googleOnly?: boolean; exchangeServiceSession?: boolean };
type OAuthResponse = { access_token?: string; expires_in?: number | string; scope?: string; error?: string; error_description?: string };
type TokenClient = { requestAccessToken(options: { prompt: string; login_hint?: string }): void };
type GoogleOAuth = {
  initTokenClient(options: {
    client_id: string; scope: string; include_granted_scopes: boolean;
    callback: (response: OAuthResponse) => void;
    error_callback: (error: { type?: string }) => void;
  }): TokenClient;
};
type AccountWindow = Window & {
  google?: { accounts?: { oauth2?: GoogleOAuth } };
  inhouseDesktop?: {
    googleSignIn?: (options?: { cloudMode?: boolean }) => Promise<{
      accessToken: string; expiresAt: number; cloudRealm?: CloudRealm; profile?: GoogleProfile; cloudSessionExpiresAt?: number;
    }>;
    googleSignOut?: () => void | Promise<void>;
    cloudAccountRestore?: () => Promise<{ realm: CloudRealm; profile: GoogleProfile; expiresAt: number } | null>;
    cloudAccountForget?: () => void | Promise<void>;
  };
};
type CloudRealm = { fileId: string; accountId: string; secret: string; id?: string };

function accountWindow(): AccountWindow | null {
  return typeof window === 'undefined' ? null : window as unknown as AccountWindow;
}

function googleApi() { return accountWindow()?.google?.accounts?.oauth2; }

function serviceHeaders(accessToken: string): Record<string, string> {
  let key = '';
  try { key = localStorage.getItem('inhouse.serviceToken')?.trim() || ''; } catch { /* No optional service key. */ }
  return { Authorization: `Bearer ${accessToken}`, ...(key ? { 'X-Inhouse-Service-Key': key } : {}) };
}

function normalizedServiceOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.username || url.password || (url.protocol !== 'https:' && !(url.protocol === 'http:' && local))) return null;
    return url.origin;
  } catch { return null; }
}

/** A Node service is optional for Pages/Windows using the private account realm. */
export function getConfiguredServiceOrigin(): string | null {
  let configured = '';
  try { configured = localStorage.getItem('inhouse.signalingUrl')?.trim() || ''; } catch { /* Optional persisted setting. */ }
  if (!configured) configured = import.meta.env?.VITE_SIGNALING_URL?.trim() || '';
  if (configured) return normalizedServiceOrigin(configured);
  const defaultService = getDefaultServiceOrigin();
  if (defaultService) return defaultService;
  if (useCloudAccountTransport()) return null;
  const current = accountWindow()?.location ?? (typeof location !== 'undefined' ? location : null);
  if (!current || current.hostname.endsWith('.github.io') || current.hostname === 'github.io') return null;
  return normalizedServiceOrigin(current.origin);
}

function validProfile(value: unknown): value is GoogleProfile {
  if (!value || typeof value !== 'object') return false;
  const profile = value as Record<string, unknown>;
  return typeof profile.id === 'string' && profile.id.length > 0 && profile.id.length <= 256
    && typeof profile.name === 'string' && profile.name.length <= 256
    && typeof profile.email === 'string' && profile.email.length > 0 && profile.email.length <= 320
    && typeof profile.photo === 'string' && profile.photo.length <= 2048;
}

/** A remembered avatar alone never establishes authentication. */
export function getGoogleSession(): GoogleSession | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    const value = JSON.parse(localStorage.getItem(GOOGLE_SESSION_KEY) || 'null') as Partial<GoogleSession> | null;
    if (!value || typeof value.accessToken !== 'string' || !value.accessToken || value.accessToken.length > 8192
      || typeof value.expiresAt !== 'number' || !Number.isFinite(value.expiresAt)
      || value.expiresAt <= Date.now() + EXPIRY_MARGIN || !validProfile(value.profile)) return null;
    if (value.kind === 'cloud' || value.accessToken.startsWith('ild_')) {
      if (value.kind !== 'cloud' || value.issuer !== undefined || !useCloudAccountTransport()) return null;
      const cloud = getCloudAccount();
      if (!cloud || cloud.clientToken !== value.accessToken || cloud.expiresAt !== value.expiresAt
        || cloud.profile.id !== value.profile.id || cloud.profile.name !== value.profile.name
        || cloud.profile.email !== value.profile.email || cloud.profile.photo !== value.profile.photo) return null;
      return { kind: 'cloud', accessToken: cloud.clientToken, expiresAt: cloud.expiresAt, profile: { ...cloud.profile } };
    }
    if (value.kind !== undefined) return null;
    if (value.accessToken.startsWith('ihl_') || value.issuer) {
      if (!/^ihl_[A-Za-z0-9_-]{43}$/.test(value.accessToken) || typeof value.issuer !== 'string'
        || normalizedServiceOrigin(value.issuer) !== value.issuer || getConfiguredServiceOrigin() !== value.issuer) return null;
      return { accessToken: value.accessToken, expiresAt: value.expiresAt, profile: { ...value.profile }, issuer: value.issuer };
    }
    return { accessToken: value.accessToken, expiresAt: value.expiresAt, profile: { ...value.profile } };
  } catch { return null; }
}

let sessionRevision = 0;
let exchange: { origin: string; accessToken: string; revision: number; promise: Promise<GoogleSession> } | null = null;

function normalizedServerProfile(value: unknown, expected: GoogleProfile): GoogleProfile {
  if (!validProfile(value) || value.id !== expected.id || value.email.toLowerCase() !== expected.email.toLowerCase()) {
    throw new Error('La cuenta devuelta por el servicio no coincide con tu cuenta de Google.');
  }
  return { ...value, photo: value.photo || expected.photo };
}

/** Exchanges a verified Google grant for a server-issued, revocable session.
 * Its lifetime comes from the server; the client never extends it locally.
 */
export function ensureServiceAccountSession(base: URL): Promise<GoogleSession> {
  const origin = normalizedServiceOrigin(base.origin);
  if (!origin || origin !== getConfiguredServiceOrigin()) return Promise.reject(new Error('El servicio de conexión ha cambiado. Vuelve a iniciar sesión.'));
  const session = getGoogleSession();
  if (!session) return Promise.reject(new Error('Inicia sesión con Google para conectar este equipo.'));
  if (session.kind === 'cloud') return Promise.reject(new Error('Vuelve a iniciar sesión con Google para autorizar un servidor propio.'));
  if (session.issuer) return Promise.resolve(session);
  if (exchange?.origin === origin && exchange.accessToken === session.accessToken && exchange.revision === sessionRevision) return exchange.promise;
  const revision = sessionRevision;
  const promise = (async () => {
    const response = await fetch(new URL('/api/auth/session', origin), {
      method: 'POST', credentials: 'omit', signal: AbortSignal.timeout(20000),
      headers: serviceHeaders(session.accessToken),
    });
    if (!response.ok) throw new Error(`El servicio no pudo crear la sesión de cuenta (${response.status}).`);
    const result = await response.json() as Partial<GoogleSession>;
    if (typeof result.accessToken !== 'string' || !/^ihl_[A-Za-z0-9_-]{43}$/.test(result.accessToken)
      || typeof result.expiresAt !== 'number' || !Number.isFinite(result.expiresAt) || result.expiresAt <= Date.now() + EXPIRY_MARGIN) {
      throw new Error('El servicio no devolvió una sesión de cuenta válida.');
    }
    const profile = normalizedServerProfile(result.profile, session.profile);
    const current = getGoogleSession();
    if (sessionRevision !== revision || current?.accessToken !== session.accessToken || current.profile.id !== profile.id
      || origin !== getConfiguredServiceOrigin()) throw new Error('La conexión de la cuenta ha cambiado. Vuelve a iniciar sesión.');
    const upgraded: GoogleSession = { accessToken: result.accessToken, expiresAt: result.expiresAt, profile, issuer: origin };
    localStorage.setItem(GOOGLE_SESSION_KEY, JSON.stringify(upgraded));
    accountWindow()?.dispatchEvent(new CustomEvent('inhouse-service-session-updated', {
      detail: { accountId: profile.id, issuer: origin, expiresAt: upgraded.expiresAt },
    }));
    emit('refreshed', profile);
    return upgraded;
  })();
  exchange = { origin, accessToken: session.accessToken, revision, promise };
  void promise.finally(() => { if (exchange?.promise === promise) exchange = null; }).catch(() => {});
  return promise;
}

let sdkPromise: Promise<void> | null = null;

/** Load once, keep popups attached to the original click, and allow retries. */
export function loadGoogleSdk(): Promise<void> {
  if (googleApi()?.initTokenClient) return Promise.resolve();
  if (sdkPromise) return sdkPromise;
  if (typeof document === 'undefined') return Promise.reject(new Error('Google no está disponible en este entorno.'));
  sdkPromise = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${SDK_URL}"]`);
    const script = existing ?? document.createElement('script');
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      script.removeEventListener('load', loaded);
      script.removeEventListener('error', failed);
      if (error) { if (!existing) script.remove(); reject(error); }
      else resolve();
    };
    const loaded = () => finish(googleApi()?.initTokenClient ? undefined : new Error('Google no pudo inicializar el acceso. Reintenta.'));
    const failed = () => finish(new Error('No se pudo cargar Google. Comprueba la conexión y reintenta.'));
    const timer = setTimeout(() => finish(new Error('Google tardó demasiado en cargar. Reintenta.')), 12000);
    script.addEventListener('load', loaded);
    script.addEventListener('error', failed);
    if (!existing) {
      script.src = SDK_URL;
      script.async = true;
      script.referrerPolicy = 'strict-origin-when-cross-origin';
      document.head.append(script);
    }
  }).catch((error: unknown) => { sdkPromise = null; throw error; });
  return sdkPromise;
}

function emit(reason: 'signed-in' | 'refreshed' | 'signed-out' | 'expired', profile: GoogleProfile | null) {
  accountWindow()?.dispatchEvent(new CustomEvent('inhouse-account-changed', {
    detail: { reason, profile, accountId: profile?.id ?? null },
  }));
}

function failure(error: unknown) {
  return error instanceof Error ? error.message : 'No se pudo conectar la cuenta de Google.';
}

function temporaryServiceFailure() {
  return Object.assign(new Error('No se pudo acceder al servicio de cuenta. Comprueba la conexión y reintenta.'), { retryableService: true });
}

export class GoogleAccount {
  private current: AccountState = { status: 'loading', profile: null, error: null };
  private onChange: (state: AccountState) => void;
  private generation = 0;
  private destroyed = false;
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;
  private profileController: AbortController | null = null;
  private pendingReject: ((error: Error) => void) | null = null;
  private silent = false;
  private googleOnly = false;
  private oauthSession: GoogleSession | null = null;

  constructor(onChange: (state: AccountState) => void, options: GoogleAccountOptions = {}) {
    this.onChange = onChange;
    this.googleOnly = options.googleOnly === true || options.exchangeServiceSession === false;
    accountWindow()?.addEventListener('storage', this.storageChanged);
    accountWindow()?.addEventListener('inhouse-service-changed', this.serviceChanged);
    accountWindow()?.addEventListener('inhouse-service-session-updated', this.serviceSessionChanged);
  }

  get state() { return this.current; }

  /** The desktop broker may hand off only a fresh Google grant, never ihl_. */
  getOAuthSession(): GoogleSession | null {
    const session = this.oauthSession;
    return session && !session.kind && !session.issuer && !session.accessToken.startsWith('ihl_') && session.expiresAt > Date.now() + EXPIRY_MARGIN
      ? { ...session, profile: { ...session.profile } } : null;
  }

  private change(state: AccountState) {
    this.current = state;
    if (!this.destroyed) this.onChange(state);
  }

  private storageChanged = (event: Event) => {
    if (this.googleOnly) return;
    const changed = event as StorageEvent;
    if (changed.key === GOOGLE_SESSION_KEY || changed.key === CLOUD_ACCOUNT_KEY || changed.key === 'inhouse.signalingUrl' || changed.key === null) {
      const next = getGoogleSession();
      if (!next || next.profile.id !== this.current.profile?.id) emit('signed-out', null);
      void this.initialize();
    }
  };

  private serviceChanged = () => { if (!this.googleOnly) void this.initialize(); };

  private serviceSessionChanged = () => {
    if (this.googleOnly || this.destroyed) return;
    const session = getGoogleSession();
    if (!session?.issuer) return;
    this.change({ status: 'signed-in', profile: session.profile, error: null });
    this.scheduleExpiry(session.expiresAt, this.generation);
  };

  private cancel() {
    this.generation++;
    if (!this.googleOnly) sessionRevision++;
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
    this.profileController?.abort();
    this.profileController = null;
    this.pendingReject?.(new Error('La conexión de Google se ha cancelado.'));
    this.pendingReject = null;
  }

  async initialize(): Promise<void> {
    if (this.destroyed) return;
    this.cancel();
    const run = this.generation;
    this.change({ status: 'loading', profile: null, error: null });
    if (!this.googleOnly) await bootstrapServiceConfig();
    if (run !== this.generation || this.destroyed) return;
    const desktop = accountWindow()?.inhouseDesktop;
    if (!this.googleOnly && useCloudAccountTransport() && desktop) {
      try {
        // A renderer cache cannot recreate the native authorization anchor.
        const restored = await desktop.cloudAccountRestore?.();
        if (run !== this.generation || this.destroyed) return;
        if (restored) {
          this.activateCloud(createCloudAccountFromRealm(restored.profile, restored.realm, restored.expiresAt), run, 'refreshed');
          return;
        }
        this.clearStored();
        this.change({ status: 'signed-out', profile: null, error: null });
        emit('signed-out', null);
      } catch (error) { if (run === this.generation) this.rejectSession(error); }
      return;
    }
    const saved = getGoogleSession();
    const session = this.googleOnly && (saved?.issuer || saved?.kind === 'cloud') ? null : saved;
    if (session) {
      // SDK loading is independent from a restored token's Google validation.
      if (!desktop) void loadGoogleSdk().catch(() => {});
      try {
        if (session.kind === 'cloud') {
          this.change({ status: 'signed-in', profile: session.profile, error: null });
          emit('refreshed', session.profile);
          this.scheduleExpiry(session.expiresAt, run);
        } else if (session.issuer) await this.acceptService(session, run);
        else await this.accept(session.accessToken, session.expiresAt, run, 'refreshed');
      }
      catch (error) {
        if (run === this.generation) {
          if (session.issuer && (error as { retryableService?: boolean })?.retryableService) {
            // A temporary outage is not evidence that a durable token was revoked.
            this.change({ status: 'error', profile: null, error: failure(error) });
            emit('signed-out', null);
          } else this.rejectSession(error);
        }
      }
      return;
    }
    if (!this.googleOnly) {
      this.clearStored();
      emit('signed-out', null);
    }
    try {
      if (!desktop) await loadGoogleSdk();
      if (run === this.generation) this.change({ status: 'signed-out', profile: null, error: null });
    } catch (error) {
      if (run === this.generation) this.change({ status: 'error', profile: null, error: failure(error) });
    }
  }

  private async acceptService(session: GoogleSession, run: number) {
    let response: Response;
    try {
      response = await fetch(new URL('/api/auth/session', session.issuer), {
        credentials: 'omit', signal: AbortSignal.timeout(20000), headers: serviceHeaders(session.accessToken),
      });
    } catch { throw temporaryServiceFailure(); }
    if (response.status >= 500 || response.status === 429) throw temporaryServiceFailure();
    if (!response.ok) throw new Error('La sesión del servicio ha caducado o ha sido revocada. Vuelve a iniciar sesión con Google.');
    const result = await response.json() as Partial<GoogleSession>;
    if (run !== this.generation || this.destroyed || session.issuer !== getConfiguredServiceOrigin()) throw new Error('La conexión de la cuenta ha cambiado.');
    if (typeof result.expiresAt !== 'number' || !Number.isFinite(result.expiresAt) || result.expiresAt <= Date.now() + EXPIRY_MARGIN) throw new Error('La sesión del servicio ha caducado.');
    const profile = normalizedServerProfile(result.profile, session.profile);
    const validated: GoogleSession = { ...session, profile, expiresAt: result.expiresAt };
    localStorage.setItem(GOOGLE_SESSION_KEY, JSON.stringify(validated));
    this.change({ status: 'signed-in', profile, error: null });
    emit('refreshed', profile);
    this.scheduleExpiry(validated.expiresAt, run);
  }

  /** Call directly from the login click; there is no await before GIS opens. */
  signIn(): Promise<void> {
    if (this.destroyed) return Promise.reject(new Error('La cuenta ya está cerrada.'));
    if (!this.googleOnly && this.current.status === 'error' && getGoogleSession()?.issuer) return this.initialize();
    this.cancel();
    const run = this.generation;
    const desktop = accountWindow()?.inhouseDesktop;
    this.change({ status: 'loading', profile: null, error: null });
    if (desktop) {
      if (!desktop.googleSignIn) {
        const error = new Error('Esta versión de Windows no puede abrir el acceso externo de Google. Actualiza la aplicación.');
        this.change({ status: 'error', profile: null, error: error.message });
        return Promise.reject(error);
      }
      const cloudMode = !this.googleOnly && useCloudAccountTransport();
      return desktop.googleSignIn({ cloudMode }).then(async (result) => {
        if (run !== this.generation) throw new Error('La conexión de Google se ha cancelado.');
        if (cloudMode && (!result.cloudRealm || !result.profile || typeof result.cloudSessionExpiresAt !== 'number')) {
          throw new Error('Actualiza la aplicación de Windows para conectar mediante tu cuenta de Google.');
        }
        await this.accept(result.accessToken, result.expiresAt, run, 'signed-in', cloudMode ? {
          realm: result.cloudRealm!, profile: result.profile!, expiresAt: result.cloudSessionExpiresAt!,
        } : undefined);
      }).catch((error: unknown) => {
        if (run === this.generation) this.rejectSession(error);
        throw error;
      });
    }
    const api = googleApi();
    if (!api?.initTokenClient) {
      const error = new Error('Google está cargando. Pulsa Iniciar sesión otra vez.');
      this.change({ status: 'error', profile: null, error: error.message });
      void loadGoogleSdk().catch(() => {});
      return Promise.reject(error);
    }
    return this.requestWeb(api, run, false);
  }

  private requestWeb(api: GoogleOAuth, run: number, silent: boolean): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let received = false;
      const complete = (error?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (this.pendingReject === cancel) this.pendingReject = null;
        if (error) reject(error); else resolve();
      };
      const cancel = (error: Error) => complete(error);
      this.pendingReject = cancel;
      const timeout = setTimeout(() => {
        if (run === this.generation) this.rejectSession(new Error('Google tardó demasiado. Vuelve a iniciar sesión.'));
        complete(new Error('Google tardó demasiado. Vuelve a iniciar sesión.'));
      }, silent ? 9000 : 60000);
      try {
        const client = api.initTokenClient({
          client_id: GOOGLE_CLIENT_ID,
          scope: GOOGLE_SCOPE,
          include_granted_scopes: true,
          callback: (response) => {
            if (settled || run !== this.generation) { complete(new Error('La conexión de Google se ha cancelado.')); return; }
            if (received) return;
            received = true;
            if (response.error) { const error = new Error(response.error_description || 'Google no autorizó la conexión.'); this.rejectSession(error); complete(error); return; }
            const granted = response.scope?.split(/\s+/) ?? [];
            // Notes may already have granted full Drive to this shared client.
            // That existing grant covers drive.file; Link still requests only file.
            if (response.scope && !granted.includes(GOOGLE_SCOPE) && !granted.includes('https://www.googleapis.com/auth/drive')) {
              const error = new Error('Google no concedió el permiso de cuenta solicitado.'); this.rejectSession(error); complete(error); return;
            }
            const seconds = Number(response.expires_in);
            const expiresAt = Date.now() + seconds * 1000;
            void this.accept(response.access_token ?? '', expiresAt, run, silent ? 'refreshed' : 'signed-in')
              .then(() => complete(), (error: unknown) => { if (run === this.generation) this.rejectSession(error); complete(error); });
          },
          error_callback: (result) => {
            if (settled || received || run !== this.generation) return;
            const error = new Error(result.type === 'popup_closed'
              ? 'Se cerró la ventana de Google. Puedes reintentar.'
              : result.type === 'popup_failed_to_open'
                ? 'El navegador bloqueó la ventana de Google. Permite las ventanas emergentes y reintenta.'
                : 'No se pudo abrir Google. Reintenta.');
            this.rejectSession(error); complete(error);
          },
        });
        // Keep this synchronous: awaiting SDK/network here loses the user gesture.
        const hint = this.current.profile?.email ?? getGoogleSession()?.profile.email;
        client.requestAccessToken({ prompt: silent ? 'none' : 'select_account', ...(silent && hint ? { login_hint: hint } : {}) });
      } catch (error) { if (run === this.generation) this.rejectSession(error); complete(error); }
    });
  }

  private async accept(accessToken: string, expiresAt: number, run: number, reason: 'signed-in' | 'refreshed', nativeCloud?: { realm: CloudRealm; profile: GoogleProfile; expiresAt: number }) {
    if (typeof accessToken !== 'string' || !accessToken || accessToken.length > 8192
      || typeof expiresAt !== 'number' || !Number.isFinite(expiresAt) || expiresAt <= Date.now() + EXPIRY_MARGIN) {
      throw new Error('Google no devolvió una sesión válida. Vuelve a iniciar sesión.');
    }
    this.profileController?.abort();
    const controller = new AbortController();
    this.profileController = controller;
    const timeout = setTimeout(() => controller.abort(), 20000);
    let user: Record<string, unknown>;
    try {
      const response = await fetch(PROFILE_URL, { headers: { Authorization: `Bearer ${accessToken}` }, credentials: 'omit', signal: controller.signal });
      if (!response.ok) throw new Error(response.status === 401 || response.status === 403
        ? 'La sesión de Google ha caducado o no tiene permiso. Vuelve a iniciar sesión.'
        : 'No se pudo verificar la cuenta de Google. Reintenta.');
      const data = await response.json() as { user?: Record<string, unknown> };
      user = data.user ?? {};
    } finally {
      clearTimeout(timeout);
      if (this.profileController === controller) this.profileController = null;
    }
    if (run !== this.generation || this.destroyed) throw new Error('La conexión de Google se ha cancelado.');
    const profile: GoogleProfile = {
      id: typeof user.permissionId === 'string' ? user.permissionId : '',
      name: typeof user.displayName === 'string' ? user.displayName.slice(0, 256) : 'Cuenta de Google',
      email: typeof user.emailAddress === 'string' ? user.emailAddress.slice(0, 320) : '',
      photo: typeof user.photoLink === 'string' && /^https:\/\//i.test(user.photoLink) ? user.photoLink.slice(0, 2048) : '',
    };
    if (!validProfile(profile) || expiresAt <= Date.now() + EXPIRY_MARGIN) throw new Error('Google no devolvió los datos de una cuenta válida.');
    const verified: GoogleSession = { accessToken, expiresAt, profile };
    this.oauthSession = verified;
    if (this.googleOnly) {
      this.change({ status: 'signed-in', profile, error: null });
      this.scheduleExpiry(expiresAt, run);
      return;
    }
    if (useCloudAccountTransport()) {
      if (nativeCloud) normalizedServerProfile(nativeCloud.profile, profile);
      const cloud = nativeCloud
        ? createCloudAccountFromRealm(profile, nativeCloud.realm, nativeCloud.expiresAt)
        : await prepareCloudAccount(accessToken, profile);
      if (run !== this.generation || this.destroyed || !useCloudAccountTransport()) throw new Error('La conexión de la cuenta ha cambiado.');
      this.oauthSession = null;
      this.activateCloud(cloud, run, reason);
      return;
    }
    if (nativeCloud) throw new Error('El servicio de conexión ha cambiado. Vuelve a iniciar sesión.');
    localStorage.setItem(GOOGLE_SESSION_KEY, JSON.stringify(verified));
    let active = verified;
    let serviceError: string | null = null;
    const service = getConfiguredServiceOrigin();
    if (service) {
      try { active = await ensureServiceAccountSession(new URL(service)); }
      catch (error) {
        if (run !== this.generation || this.destroyed) throw error;
        serviceError = `${failure(error)} Tu acceso de Google sigue activo hasta su caducidad.`;
      }
    }
    if (run !== this.generation || this.destroyed) throw new Error('La conexión de Google se ha cancelado.');
    this.change({ status: 'signed-in', profile: active.profile, error: serviceError });
    emit(reason, active.profile);
    this.scheduleExpiry(active.expiresAt, run);
  }

  private activateCloud(cloud: CloudAccount, run: number, reason: 'signed-in' | 'refreshed') {
    if (run !== this.generation || this.destroyed || !useCloudAccountTransport()) throw new Error('La conexión de la cuenta ha cambiado.');
    this.oauthSession = null;
    rememberCloudAccount(cloud);
    const session: GoogleSession = { kind: 'cloud', accessToken: cloud.clientToken, expiresAt: cloud.expiresAt, profile: cloud.profile };
    try { localStorage.setItem(GOOGLE_SESSION_KEY, JSON.stringify(session)); }
    catch (error) { clearCloudAccount(); throw error; }
    this.change({ status: 'signed-in', profile: cloud.profile, error: null });
    emit(reason, cloud.profile);
    this.scheduleExpiry(cloud.expiresAt, run);
  }

  private scheduleExpiry(expiresAt: number, run: number) {
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    const session = !this.googleOnly ? getGoogleSession() : null;
    const durableSession = !!session && (!!session.issuer || session.kind === 'cloud');
    const delay = Math.max(0, Math.min(2_000_000_000, expiresAt - Date.now() - EXPIRY_MARGIN));
    this.expiryTimer = setTimeout(() => {
      this.expiryTimer = null;
      if (run !== this.generation || this.destroyed) return;
      if (expiresAt > Date.now() + EXPIRY_MARGIN) {
        this.scheduleExpiry(expiresAt, run);
        return;
      }
      const api = googleApi();
      if (!durableSession && !accountWindow()?.inhouseDesktop && api?.initTokenClient && !this.silent) {
        this.silent = true;
        void this.requestWeb(api, run, true).catch(() => {}).finally(() => { this.silent = false; });
      } else {
        this.cancel();
        this.oauthSession = null;
        if (!this.googleOnly) this.clearStored();
        this.change({ status: 'signed-out', profile: null, error: 'La sesión de tu cuenta ha caducado. Vuelve a iniciar sesión con Google.' });
        if (!this.googleOnly) emit('expired', null);
      }
    }, delay);
  }

  private clearStored() {
    clearCloudAccount();
    try { localStorage.removeItem(GOOGLE_SESSION_KEY); } catch { /* No persisted session. */ }
  }

  private rejectSession(error: unknown) {
    this.oauthSession = null;
    if (!this.googleOnly) this.clearStored();
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
    this.change({ status: 'error', profile: null, error: failure(error) });
    if (!this.googleOnly) emit('signed-out', null);
  }

  signOut() {
    const current = this.googleOnly ? null : getGoogleSession();
    this.cancel();
    this.oauthSession = null;
    if (!this.googleOnly) this.clearStored();
    this.change({ status: 'signed-out', profile: null, error: null });
    if (!this.googleOnly) emit('signed-out', null);
    if (current?.issuer) {
      void fetch(new URL('/api/auth/session', current.issuer), {
        method: 'DELETE', credentials: 'omit', keepalive: true, signal: AbortSignal.timeout(10000),
        headers: serviceHeaders(current.accessToken),
      }).catch(() => {});
    }
    // Match Read: sign out of this app, without revoking the shared Notes grant.
    try {
      if (!this.googleOnly) {
        void Promise.resolve(accountWindow()?.inhouseDesktop?.cloudAccountForget?.()).catch(() => {});
        void Promise.resolve(accountWindow()?.inhouseDesktop?.googleSignOut?.()).catch(() => {});
      }
    }
    catch { /* Local state has already been cleared. */ }
  }

  destroy() {
    this.cancel();
    this.oauthSession = null;
    this.destroyed = true;
    accountWindow()?.removeEventListener('storage', this.storageChanged);
    accountWindow()?.removeEventListener('inhouse-service-changed', this.serviceChanged);
    accountWindow()?.removeEventListener('inhouse-service-session-updated', this.serviceSessionChanged);
  }
}
