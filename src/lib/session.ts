import { collectSessionStats, EMPTY_STATS, type SessionStats, type StatsSample } from './stats';
import { ensureServiceAccountSession, getConfiguredServiceOrigin, getGoogleSession } from './google-account.ts';
import { getCloudAccount } from './cloud-account';
import { useCloudAccountTransport } from './service-config';
import { getCloudHub, type CloudSocket } from './cloud-signal';
import {
  base64url, clearTrustedDevices, createCredential, forgetTrustedHost, getTrustedDevices, getTrustedHosts, getTrustRevision,
  identityForNonce, prove, saveDevice, saveHost, storedDevices, storedHosts, verifyProof,
  type StoredDevice, type StoredHost,
} from './trust';

export type { SessionStats } from './stats';
export { clearTrustedDevices, forgetTrustedHost, getTrustedDevices, getTrustedHosts } from './trust';

export type LinkSettings = {
  resolution: 'native' | '1080p' | '1440p' | '4k';
  fps: 30 | 60 | 120;
  bitrate: number;
  codec: 'auto' | 'h264' | 'vp9' | 'av1';
  audio: boolean;
  adaptive: boolean;
};

export type LinkState = {
  status: 'idle' | 'connecting' | 'hosting' | 'pending' | 'negotiating' | 'connected' | 'disconnected' | 'error';
  role: 'host' | 'viewer' | null;
  code: string;
  deviceId: string;
  error: string | null;
  peerName: string;
  requests: { id: string; name: string }[];
  stats: SessionStats;
  remoteStream: MediaStream | null;
  localStream: MediaStream | null;
  controlEnabled: boolean;
  accountHosting?: boolean;
};

export type DesktopBridge = {
  platform: string;
  version: string;
  setControlEnabled(enabled: boolean): Promise<boolean>;
  injectInput(event: Record<string, unknown>): void;
  releaseInputs(): void;
  captureEnded?(): void;
  enableAccountHosting?(options: { issuer: string; accessToken: string; serviceKey?: string; hostId: string }): Promise<boolean>;
  getAccountCaptureSource?(): Promise<{ sourceId: string } | null>;
  authorizeAccountPeer?(connectionId: string): Promise<boolean>;
  endAccountPeer?(): void;
  disableAccountHosting?(): void;
  getComputerName?(): Promise<string>;
  onAccountHostingRevoked?(callback: (reason: string) => void): () => void;
  onAccountPeerRevoked?(callback: (reason: string) => void): () => void;
  enableCloudAccountHosting?(options: { accountId: string; hostId: string }): Promise<{ challenge: string } | null>;
  authorizeCloudPeer?(proof: unknown): Promise<boolean>;
  renewCloudPeer?(proof: unknown): Promise<boolean>;
};

declare global {
  interface Window {
    inhouseDesktop?: DesktopBridge;
  }
}

export const DEFAULT_SETTINGS: LinkSettings = {
  resolution: '1080p', fps: 60, bitrate: 25, codec: 'auto', audio: true, adaptive: true,
};

const INITIAL_STATE: LinkState = {
  status: 'idle', role: null, code: '', deviceId: '', error: null, peerName: '', requests: [],
  stats: { ...EMPTY_STATS }, remoteStream: null, localStream: null, controlEnabled: false, accountHosting: false,
};
const RESOLUTIONS = { '1080p': [1920, 1080], '1440p': [2560, 1440], '4k': [3840, 2160] } as const;

function validSettings(value: unknown): LinkSettings | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (!['native', '1080p', '1440p', '4k'].includes(String(v.resolution))
    || typeof v.fps !== 'number' || ![30, 60, 120].includes(v.fps)
    || !['auto', 'h264', 'vp9', 'av1'].includes(String(v.codec))
    || typeof v.audio !== 'boolean' || typeof v.adaptive !== 'boolean'
    || typeof v.bitrate !== 'number' || !Number.isFinite(v.bitrate) || v.bitrate < 2 || v.bitrate > 150) return null;
  return { resolution: v.resolution, fps: v.fps, bitrate: v.bitrate, codec: v.codec, audio: v.audio, adaptive: v.adaptive } as LinkSettings;
}

function message(error: unknown) {
  if (error instanceof DOMException && error.name === 'NotAllowedError') return 'No se ha autorizado compartir la pantalla.';
  if (error instanceof Error) return error.message;
  return 'No se pudo establecer la conexión.';
}

function endpoint() {
  const origin = getConfiguredServiceOrigin();
  if (!origin) throw new Error('El servicio remoto no está configurado. Actívalo para que tus equipos compartan la misma lista; GitHub Pages aloja la web del cliente.');
  const base = new URL(origin);
  if (base.username || base.password || !['https:', 'http:'].includes(base.protocol)) {
    throw new Error('La dirección del servidor debe ser una URL HTTPS sin credenciales.');
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname);
  if (base.protocol !== 'https:' && !loopback) throw new Error('El servidor remoto debe usar HTTPS. HTTP solo se admite en localhost.');
  return base;
}

export function isValidInput(event: unknown): event is Record<string, unknown> {
  if (!event || typeof event !== 'object') return false;
  const e = event as Record<string, unknown>;
  switch (e.kind) {
    case 'pointer': return typeof e.x === 'number' && Number.isFinite(e.x) && e.x >= 0 && e.x <= 1
      && typeof e.y === 'number' && Number.isFinite(e.y) && e.y >= 0 && e.y <= 1;
    case 'relative': return typeof e.dx === 'number' && Number.isFinite(e.dx) && Math.abs(e.dx) <= 2048
      && typeof e.dy === 'number' && Number.isFinite(e.dy) && Math.abs(e.dy) <= 2048;
    case 'button': return typeof e.button === 'number' && [0, 1, 2].includes(e.button) && typeof e.down === 'boolean';
    case 'wheel': return typeof e.dx === 'number' && Number.isFinite(e.dx) && Math.abs(e.dx) <= 1200
      && typeof e.dy === 'number' && Number.isFinite(e.dy) && Math.abs(e.dy) <= 1200;
    case 'key': return typeof e.code === 'string' && /^[A-Za-z][A-Za-z0-9]{0,29}$/.test(e.code) && typeof e.down === 'boolean';
    case 'release': return true;
    default: return false;
  }
}

/** One approved host/viewer pair. Media and input travel over encrypted WebRTC. */
export class LinkSession {
  private current: LinkState = { ...INITIAL_STATE, stats: { ...EMPTY_STATS } };
  private settings: LinkSettings = { ...DEFAULT_SETTINGS };
  private socket: WebSocket | CloudSocket | null = null;
  private peer: RTCPeerConnection | null = null;
  private control: RTCDataChannel | null = null;
  private pointer: RTCDataChannel | null = null;
  private iceServers: RTCIceServer[] = [];
  private candidates: RTCIceCandidateInit[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private recoveryTimer: ReturnType<typeof setTimeout> | null = null;
  private previousStats: StatsSample | null = null;
  private generation = 0;
  private processing = Promise.resolve();
  private viewerInputEnabled = true;
  private adaptiveBitrate = DEFAULT_SETTINGS.bitrate;
  private statsPending = false;
  private destroyed = false;
  private connectionNonce = '';
  private hostControlEnabled = false;
  private trustToCreate: StoredDevice | null = null;
  private activeTrustedDevice: (StoredDevice & { nonce: string }) | null = null;
  private expectedTrustedHost: StoredHost | null = null;
  private trustedHostVerified = false;
  private remotePermission = false;
  private authTimer: ReturnType<typeof setTimeout> | null = null;
  private iceRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private serverBase: URL | null = null;
  private enrollmentRevision = 0;
  private releaseQueued = false;
  private approvalInFlight = false;
  private hostReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private hostReconnectAttempt = 0;
  private reconnectingHost = false;
  private hostReconnectPending = false;
  private accountId = '';
  private accountHosting = false;
  private hostName = 'PC Inhouse';
  private cloudMode = false;
  private nativeCloudChallenge = '';
  private activeConnectionId = '';
  private removeHostingRevoked: (() => void) | undefined;
  private removePeerRevoked: (() => void) | undefined;
  private accountChanged = () => {
    const account = getGoogleSession();
    if (this.current.role && (!account || account.profile.id !== this.accountId)) this.disconnect();
  };

  constructor(private onChange: (state: LinkState) => void) {
    window.addEventListener('inhouse-account-changed', this.accountChanged);
    this.removeHostingRevoked = window.inhouseDesktop?.onAccountHostingRevoked?.(reason => {
      if (this.accountHosting) this.fail(reason || 'Vuelve a iniciar sesión para dejar este PC disponible.');
    });
    this.removePeerRevoked = window.inhouseDesktop?.onAccountPeerRevoked?.(reason => {
      if (this.accountHosting) this.disconnectPeer(reason || 'La sesión de control ha terminado.');
    });
  }

  get state() { return this.current; }

  private change(patch: Partial<LinkState>) {
    this.current = { ...this.current, ...patch };
    if (!this.destroyed) this.onChange(this.current);
  }

  async host(settings: LinkSettings, options: { accountHosting?: boolean; name?: string } = {}): Promise<void> {
    this.disconnect();
    const account = getGoogleSession();
    if (!account) { this.fail('Inicia sesión con tu cuenta de Google para compartir este PC.'); return; }
    this.accountId = account.profile.id;
    this.accountHosting = options.accountHosting === true;
    this.hostName = options.name?.trim().slice(0, 64) || 'PC Inhouse';
    const run = this.generation;
    this.settings = validSettings(settings) ?? { ...DEFAULT_SETTINGS };
    this.adaptiveBitrate = this.settings.bitrate;
    this.change({ ...INITIAL_STATE, role: 'host', status: 'connecting', accountHosting: this.accountHosting, stats: { ...EMPTY_STATS } });
    try {
      if (!navigator.mediaDevices?.getDisplayMedia) throw new Error('Este entorno no permite capturar pantalla. Usa la aplicación de Windows.');
      let stream: MediaStream;
      if (this.accountHosting) {
        const native = window.inhouseDesktop;
        if (!native?.getAccountCaptureSource) throw new Error('Actualiza la app de Windows para disponer de acceso con tu cuenta.');
        await this.connect(run);
        const identity = await identityForNonce(this.connectionNonce);
        if (run !== this.generation) return;
        const session = getGoogleSession();
        if (!session || session.profile.id !== this.accountId) throw new Error('Vuelve a iniciar sesión con Google.');
        let allowed = false;
        if (this.cloudMode) {
          const grant = await native.enableCloudAccountHosting?.({ accountId: this.accountId, hostId: identity.deviceId });
          allowed = !!grant?.challenge;
          this.nativeCloudChallenge = grant?.challenge || '';
        } else if (this.serverBase && native.enableAccountHosting) {
          allowed = await native.enableAccountHosting({ issuer: this.serverBase.origin, accessToken: session.accessToken,
            serviceKey: localStorage.getItem('inhouse.serviceToken')?.trim() || '', hostId: identity.deviceId });
        }
        if (run !== this.generation) return;
        if (!allowed) throw new Error('No se ha podido verificar la cuenta propietaria de este PC.');
        const source = await native.getAccountCaptureSource();
        if (!source || run !== this.generation) throw new Error('No se ha podido preparar la pantalla de este PC.');
        const constraints = {
          video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: source.sourceId,
            maxFrameRate: this.settings.fps } },
          audio: this.settings.audio ? { mandatory: { chromeMediaSource: 'desktop' } } : false,
        } as unknown as MediaStreamConstraints;
        try { stream = await navigator.mediaDevices.getUserMedia(constraints); }
        catch (error) {
          if (!this.settings.audio) throw error;
          stream = await navigator.mediaDevices.getUserMedia({ ...constraints, audio: false });
        }
      } else {
        // Manual/browser capture preserves the initiating user gesture.
        stream = await navigator.mediaDevices.getDisplayMedia({
          video: { frameRate: { ideal: this.settings.fps, max: this.settings.fps } }, audio: this.settings.audio,
        });
      }
      if (run !== this.generation) { stream.getTracks().forEach((track) => track.stop()); return; }
      const capturedVideo = stream.getVideoTracks()[0];
      if (capturedVideo) capturedVideo.contentHint = 'motion';
      this.change({ localStream: stream });
      stream.getVideoTracks()[0]?.addEventListener('ended', () => {
        if (this.current.localStream === stream) this.disconnect();
      }, { once: true });
      // This local, native consent remains valid only while this capture stays active.
      if (!this.accountHosting) {
        await this.setControlEnabled(true);
        await this.connect(run);
      }
      if (run === this.generation) await this.registerHost(run);
    } catch (error) { if (run === this.generation) this.fail(message(error)); }
  }

  async join(code: string, settings: LinkSettings, name = 'Portátil Inhouse'): Promise<void> {
    this.disconnect();
    const account = getGoogleSession();
    if (!account) { this.fail('Inicia sesión con tu cuenta de Google para conectar.'); return; }
    this.accountId = account.profile.id;
    const run = this.generation;
    this.settings = validSettings(settings) ?? { ...DEFAULT_SETTINGS };
    const cleanCode = code.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
    if (!/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/.test(cleanCode) && !/^[A-F0-9]{32}$/.test(cleanCode)) {
      this.fail('Introduce un código de conexión válido de ocho caracteres o elige un equipo de tu cuenta.'); return;
    }
    this.expectedTrustedHost = storedHosts().find((host) => host.deviceId === cleanCode.toLowerCase()) ?? null;
    this.change({ ...INITIAL_STATE, role: 'viewer', status: 'connecting', code: cleanCode, stats: { ...EMPTY_STATS } });
    try {
      await this.connect(run);
      if (run === this.generation) {
        const trust = this.expectedTrustedHost ? {
          id: this.expectedTrustedHost.id,
          proof: await prove(this.expectedTrustedHost.token, `${this.connectionNonce}:${this.expectedTrustedHost.deviceId}`),
        } : undefined;
        if (run === this.generation) this.sendSignal({ type: 'join', code: cleanCode, name: name.slice(0, 60), ...(trust ? { trust } : {}) });
      }
    } catch (error) { if (run === this.generation) this.fail(message(error)); }
  }

  private async connect(run: number): Promise<void> {
    this.cloudMode = useCloudAccountTransport();
    let socket: WebSocket | CloudSocket;
    if (this.cloudMode) {
      const cloud = getCloudAccount();
      if (!cloud || cloud.profile.id !== this.accountId) throw new Error('Vuelve a iniciar sesión con Google para conectar con tus equipos.');
      this.serverBase = null;
      this.iceServers = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
      socket = await getCloudHub(cloud).createSocket();
      if (run !== this.generation) { socket.close(); return; }
    } else {
      const base = endpoint();
      this.serverBase = base;
      const serviceToken = localStorage.getItem('inhouse.serviceToken')?.trim();
      const account = await ensureServiceAccountSession(base);
      if (!account || account.profile.id !== this.accountId) throw new Error('La sesión de Google ha caducado o ha cambiado. Vuelve a iniciar sesión.');
      if (run !== this.generation) return;
      const response = await fetch(new URL('/api/config', base), {
        credentials: 'omit', signal: AbortSignal.timeout(12000),
        headers: { Authorization: `Bearer ${account.accessToken}`, ...(serviceToken ? { 'X-Inhouse-Service-Key': serviceToken } : {}) },
      });
      if (!response.ok) throw new Error(`El servidor de conexión respondió ${response.status}.`);
      const config = await response.json() as { iceServers?: RTCIceServer[]; iceExpiresAt?: number | null };
      if (run !== this.generation) return;
      this.iceServers = Array.isArray(config.iceServers) ? config.iceServers : [];
      this.scheduleIceRefresh(config.iceExpiresAt, run);
      const url = new URL('/signal', base);
      url.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
      const protocols = ['inhouse-link-v1', `google.${base64url(new TextEncoder().encode(account.accessToken))}`];
      if (serviceToken) protocols.push(`auth.${base64url(new TextEncoder().encode(serviceToken))}`);
      socket = new WebSocket(url, protocols);
    }
    await new Promise<void>((resolve, reject) => {
      this.socket = socket;
      let opened = false;
      let greeted = false;
      const timeout = setTimeout(() => { socket.close(); reject(new Error('El servidor de conexión no responde.')); }, 12000);
      socket.onopen = () => { opened = true; };
      socket.onerror = () => { clearTimeout(timeout); if (!greeted) reject(new Error('No se pudo acceder al servidor de conexión. Comprueba su dirección y certificado HTTPS.')); };
      socket.onclose = () => {
        clearTimeout(timeout);
        if (!greeted) reject(new Error('Se cerró la conexión con el servidor.'));
        else if (run === this.generation && this.current.status !== 'disconnected') {
          if (this.current.role === 'host' && this.current.localStream?.active) this.scheduleHostReconnect(run);
          else this.fail('Se ha perdido la conexión con el servidor.');
        }
      };
      socket.onmessage = (event: { data: unknown }) => {
        if (typeof event.data !== 'string' || event.data.length > 256000) return;
        let parsed: Record<string, unknown>;
        try { parsed = JSON.parse(event.data) as Record<string, unknown>; } catch { return; }
        if (parsed.type === 'hello' && typeof parsed.nonce === 'string' && /^[A-Za-z0-9_-]{32,100}$/.test(parsed.nonce)) {
          if (!greeted && opened && run === this.generation) { greeted = true; this.connectionNonce = parsed.nonce; clearTimeout(timeout); resolve(); }
          return;
        }
        this.processing = this.processing.then(async () => {
          if (run !== this.generation) return;
          await this.onSignal(parsed, run);
        }).catch((error: unknown) => { if (run === this.generation) this.fail(message(error)); });
      };
    });
  }

  private sendSignal(data: Record<string, unknown>) {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(data));
  }

  private async registerHost(run: number) {
    const identity = await identityForNonce(this.connectionNonce);
    if (run !== this.generation) return;
    if (this.socket?.readyState !== WebSocket.OPEN) throw new Error('El servicio se desconectó antes de registrar este PC.');
    this.change({ deviceId: identity.deviceId });
    this.sendSignal({ type: 'host', name: this.hostName, identity: identity.identity,
      ...(this.nativeCloudChallenge ? { nativeChallenge: this.nativeCloudChallenge } : {}) });
  }

  /** A signaling outage never silently ends an already approved local capture. */
  private scheduleHostReconnect(run: number) {
    if (run !== this.generation || this.destroyed || this.current.role !== 'host' || !this.current.localStream?.active) return;
    if (this.reconnectingHost) { this.hostReconnectPending = true; return; }
    if (this.hostReconnectTimer) return;
    const nextRun = ++this.generation; // Invalidate all old offers, approvals and ICE callbacks.
    this.closePeer(false);
    if (this.socket) { this.socket.onclose = null; this.socket.close(); this.socket = null; }
    if (this.iceRefreshTimer) clearTimeout(this.iceRefreshTimer);
    this.iceRefreshTimer = null;
    this.activeTrustedDevice = null;
    this.trustToCreate = null;
    this.approvalInFlight = false;
    this.processing = Promise.resolve();
    this.change({ status: 'connecting', code: '', remoteStream: null, peerName: '', requests: [], controlEnabled: this.hostControlEnabled,
      stats: { ...EMPTY_STATS }, error: 'Se ha perdido el servicio de conexión. Reintentando automáticamente…' });
    const backoff = 1000 * 2 ** Math.min(this.hostReconnectAttempt++, 5);
    const delay = Math.max(1000, Math.min(30000, backoff * (0.8 + Math.random() * 0.4)));
    this.hostReconnectTimer = setTimeout(() => {
      this.hostReconnectTimer = null;
      if (nextRun !== this.generation || !this.current.localStream?.active) return;
      this.reconnectingHost = true;
      this.hostReconnectPending = false;
      void (async () => {
        try {
          await this.connect(nextRun);
          if (nextRun === this.generation) await this.registerHost(nextRun);
        } catch { if (nextRun === this.generation) this.hostReconnectPending = true; }
        finally {
          if (nextRun !== this.generation) return;
          this.reconnectingHost = false;
          if (this.hostReconnectPending || this.socket?.readyState !== WebSocket.OPEN) this.scheduleHostReconnect(nextRun);
        }
      })();
    }, delay);
  }

  private scheduleIceRefresh(expiresAt: number | null | undefined, run: number) {
    if (this.iceRefreshTimer) clearTimeout(this.iceRefreshTimer);
    this.iceRefreshTimer = null;
    if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) return;
    const delay = Math.max(10000, Math.min(2_000_000_000, (expiresAt - Date.now()) * 0.8));
    this.iceRefreshTimer = setTimeout(() => { void this.refreshIce(run); }, delay);
  }

  /** Refresh short-lived TURN credentials before an allocation can expire. */
  private async refreshIce(run: number) {
    if (run !== this.generation || !this.serverBase) return;
    try {
      const token = localStorage.getItem('inhouse.serviceToken')?.trim();
      const account = getGoogleSession();
      if (!account || account.profile.id !== this.accountId) throw new Error('Vuelve a iniciar sesión con Google.');
      const response = await fetch(new URL('/api/config', this.serverBase), {
        credentials: 'omit', signal: AbortSignal.timeout(12000),
        headers: { Authorization: `Bearer ${account.accessToken}`, ...(token ? { 'X-Inhouse-Service-Key': token } : {}) },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const config = await response.json() as { iceServers?: RTCIceServer[]; iceExpiresAt?: number | null };
      if (run !== this.generation) return;
      if (this.current.error?.startsWith('No se han podido renovar las credenciales')) this.change({ error: null });
      if (Array.isArray(config.iceServers)) {
        this.iceServers = config.iceServers;
        const peer = this.peer;
        if (peer) {
          peer.setConfiguration({ ...peer.getConfiguration(), iceServers: this.iceServers });
          if (this.current.role === 'host' && peer.signalingState === 'stable') {
            await peer.setLocalDescription(await peer.createOffer({ iceRestart: true }));
            if (run === this.generation && peer === this.peer) this.sendSignal({ type: 'signal', signal: { description: peer.localDescription } });
          }
        }
      }
      this.scheduleIceRefresh(config.iceExpiresAt, run);
    } catch {
      if (run !== this.generation) return;
      this.change({ error: 'No se han podido renovar las credenciales del relay. Reintentando la conexión con el servicio…' });
      this.iceRefreshTimer = setTimeout(() => { void this.refreshIce(run); }, 15000);
    }
  }

  private async onSignal(data: Record<string, unknown>, run: number) {
    switch (data.type) {
      case 'hosted':
        this.hostReconnectAttempt = 0;
        this.change({ status: 'hosting', code: String(data.code), deviceId: typeof data.deviceId === 'string' ? data.deviceId : this.current.deviceId, error: null });
        break;
      case 'pending':
        this.change({ status: 'pending' });
        break;
      case 'join-request': {
        if (this.approvalInFlight) break;
        const trust = data.trust as { id?: string; proof?: string; nonce?: string } | undefined;
        const trusted = trust && typeof trust.id === 'string' ? storedDevices().find((device) => device.id === trust.id) : null;
        const trustRevision = getTrustRevision();
        const verified = !!trusted && typeof trust?.proof === 'string' && typeof trust.nonce === 'string'
          && await verifyProof(trusted.token, `${trust.nonce}:${this.current.deviceId}`, trust.proof);
        if (run !== this.generation) return;
        if (verified && trusted && trust?.nonce && trustRevision === getTrustRevision()) {
          this.approvalInFlight = true;
          this.activeTrustedDevice = { ...trusted, nonce: trust.nonce };
          this.sendSignal({ type: 'approve', id: String(data.id), allow: true });
        } else if (data.trustedOnly === true) this.sendSignal({ type: 'approve', id: String(data.id), allow: false });
        else this.change({ requests: [...this.current.requests.filter((r) => r.id !== data.id), { id: String(data.id), name: String(data.name || 'Portátil') }] });
        break;
      }
      case 'request-expired':
      case 'request-cancelled':
        this.change({ requests: this.current.requests.filter((r) => r.id !== data.id) });
        break;
      case 'paired': {
        this.approvalInFlight = false;
        const remoteAccount = data.account as { id?: unknown } | undefined;
        const ownAccount = data.accountAuthorized === true && remoteAccount?.id === this.accountId;
        if (data.accountAuthorized === true && !ownAccount) throw new Error('La cuenta del equipo remoto no coincide con tu sesión.');
        if (ownAccount) {
          this.expectedTrustedHost = null; this.activeTrustedDevice = null; this.trustToCreate = null;
          this.trustedHostVerified = false;
        }
        if (this.expectedTrustedHost && data.deviceId !== this.expectedTrustedHost.deviceId) throw new Error('La identidad del PC remoto no coincide con el equipo emparejado.');
        this.change({ status: 'negotiating', deviceId: typeof data.deviceId === 'string' ? data.deviceId : this.current.deviceId,
          peerName: String(data.deviceName || data.name || 'Equipo remoto'), requests: [], error: null });
        const peer = this.createPeer(run);
        this.activeConnectionId = typeof data.connectionId === 'string' ? data.connectionId : '';
        if (this.current.role === 'host' && ownAccount && this.cloudMode) {
          const allowed = await window.inhouseDesktop?.authorizeCloudPeer?.(data.accountProof) ?? false;
          if (run !== this.generation || peer !== this.peer) return;
          if (!allowed) { this.disconnectPeer('No se ha podido verificar el acceso de tu cuenta a este PC.'); return; }
          await this.setControlEnabled(true);
        } else if (this.current.role === 'host' && ownAccount && window.inhouseDesktop?.authorizeAccountPeer) {
          const allowed = !!this.activeConnectionId && await window.inhouseDesktop.authorizeAccountPeer(this.activeConnectionId);
          if (run !== this.generation || peer !== this.peer) return;
          if (!allowed) { this.disconnectPeer('No se ha podido verificar el permiso de esta conexión.'); return; }
          await this.setControlEnabled(true);
        } else if (this.current.role === 'host' && this.accountHosting) {
          if (ownAccount) throw new Error('Esta versión de Windows no puede verificar el acceso con tu cuenta.');
        }
        if (data.initiator) {
          this.bindChannel(peer.createDataChannel('control', { ordered: true }));
          this.bindChannel(peer.createDataChannel('pointer', { ordered: false, maxRetransmits: 0 }));
          this.current.localStream?.getTracks().forEach((track) => peer.addTransceiver(track, {
            direction: 'sendonly', streams: [this.current.localStream!],
            ...(track.kind === 'video' ? { sendEncodings: [this.videoEncoding(track)] } : {}),
          }));
          this.applyCodecPreference();
          await peer.setLocalDescription(await peer.createOffer());
          if (run === this.generation && peer === this.peer) this.sendSignal({ type: 'signal', signal: { description: peer.localDescription } });
        }
        break;
      }
      case 'account-keepalive': {
        const proof = data.proof as { connectionId?: unknown } | undefined;
        if (this.cloudMode && this.current.role === 'host' && this.accountHosting && proof?.connectionId === this.activeConnectionId) {
          const connectionId = this.activeConnectionId;
          const allowed = await window.inhouseDesktop?.renewCloudPeer?.(data.proof) ?? false;
          if (!allowed && run === this.generation && connectionId === this.activeConnectionId) this.disconnectPeer('La conexión de tu cuenta ha terminado.');
        }
        break;
      }
      case 'signal': {
        const signal = data.signal as { description?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit } | undefined;
        if (!signal) return;
        if (signal.description) {
          const peer = this.peer;
          if (!peer) return;
          await peer.setRemoteDescription(signal.description);
          if (run !== this.generation || peer !== this.peer) return;
          for (const candidate of this.candidates.splice(0)) await peer.addIceCandidate(candidate);
          if (signal.description.type === 'offer') {
            this.applyCodecPreference();
            await peer.setLocalDescription(await peer.createAnswer());
            if (run === this.generation && peer === this.peer) this.sendSignal({ type: 'signal', signal: { description: peer.localDescription } });
          } else if (signal.description.type === 'answer') await this.applySenderSettings();
        }
        if (signal.candidate) {
          if (this.peer?.remoteDescription) await this.peer.addIceCandidate(signal.candidate);
          else this.candidates.push(signal.candidate);
        }
        break;
      }
      case 'peer-left':
        this.approvalInFlight = false;
        this.closePeer(false);
        if (this.accountHosting) { window.inhouseDesktop?.endAccountPeer?.(); this.hostControlEnabled = false; }
        this.activeTrustedDevice = null;
        this.trustToCreate = null;
        this.change({ status: this.current.role === 'host' && this.current.localStream ? 'hosting' : 'disconnected', remoteStream: null, controlEnabled: this.current.role === 'host' && this.hostControlEnabled, peerName: '', stats: { ...EMPTY_STATS } });
        break;
      case 'error':
        if (this.current.role === 'host' && this.current.localStream?.active && this.hostReconnectAttempt > 0) {
          this.scheduleHostReconnect(run);
          break;
        }
        this.fail(typeof data.message === 'string' ? data.message : 'El servidor no pudo establecer la conexión.');
        break;
      case 'rejected':
        this.fail(typeof data.message === 'string' ? data.message : 'El equipo remoto rechazó la conexión.');
        break;
    }
  }

  /** End one viewer without taking the signed-in PC out of the account list. */
  disconnectPeer(reason: string | null = null) {
    if (this.current.role !== 'host' || !this.current.localStream?.active) { this.disconnect(); return; }
    this.sendSignal({ type: 'disconnect-peer' });
    this.closePeer(false);
    if (this.accountHosting) { window.inhouseDesktop?.endAccountPeer?.(); this.hostControlEnabled = false; }
    this.activeTrustedDevice = null; this.trustToCreate = null;
    this.change({ status: 'hosting', peerName: '', requests: [], remoteStream: null, controlEnabled: this.hostControlEnabled,
      stats: { ...EMPTY_STATS }, error: reason });
  }

  approve(id: string, allow: boolean, remember = false) {
    if (this.approvalInFlight || this.current.role !== 'host' || !this.current.requests.some((request) => request.id === id)) return;
    const request = this.current.requests.find((entry) => entry.id === id)!;
    this.change({ requests: allow ? [] : this.current.requests.filter((request) => request.id !== id) });
    if (allow) {
      this.approvalInFlight = true;
      this.trustToCreate = remember ? createCredential(request.name) : null;
      this.enrollmentRevision = getTrustRevision();
      const run = this.generation;
      void this.setControlEnabled(true).then(() => { if (run === this.generation) this.sendSignal({ type: 'approve', id, allow: true }); });
    } else this.sendSignal({ type: 'approve', id, allow: false });
  }

  async setControlEnabled(enabled: boolean): Promise<boolean> {
    if (this.current.role !== 'host' || !this.current.localStream?.active) return false;
    const run = this.generation;
    let allowed = false;
    try { allowed = await window.inhouseDesktop?.setControlEnabled(enabled) ?? false; } catch { allowed = false; }
    if (run !== this.generation) return false;
    if (!allowed) window.inhouseDesktop?.releaseInputs();
    this.hostControlEnabled = enabled && allowed;
    this.change({ controlEnabled: enabled && allowed });
    this.sendControl({ type: 'permission', enabled: this.current.controlEnabled });
    return this.current.controlEnabled;
  }

  setViewerInputEnabled(enabled: boolean) {
    if (!enabled) this.sendInput({ kind: 'release' });
    this.viewerInputEnabled = enabled;
  }

  getTrustedHosts() { return getTrustedHosts(); }
  getTrustedDevices() { return getTrustedDevices(); }
  forgetTrustedHost(deviceId: string) { forgetTrustedHost(deviceId); }
  clearTrustedDevices() {
    clearTrustedDevices();
    this.trustToCreate = null;
    this.activeTrustedDevice = null;
    // Revocation also cancels a pending native-consent or cryptographic approval.
    if (this.current.role === 'host') this.disconnect();
  }

  private createPeer(run: number) {
    this.closePeer(false);
    const peer = new RTCPeerConnection({ iceServers: this.iceServers, bundlePolicy: 'max-bundle' });
    this.peer = peer;
    this.candidates = [];
    peer.onicecandidate = (event) => {
      if (event.candidate && run === this.generation) this.sendSignal({ type: 'signal', signal: { candidate: event.candidate.toJSON() } });
    };
    peer.ondatachannel = (event) => this.bindChannel(event.channel);
    peer.ontrack = (event) => {
      if (run !== this.generation) return;
      // This is a preference, not a promise of zero network or playout latency.
      try {
        const receiver = event.receiver as RTCRtpReceiver & { jitterBufferTarget?: number };
        if ('jitterBufferTarget' in receiver) receiver.jitterBufferTarget = 0;
      } catch { /* Older engines may not expose or accept a jitter target. */ }
      const stream = this.current.remoteStream ?? new MediaStream();
      if (!stream.getTracks().some((track) => track.id === event.track.id)) stream.addTrack(event.track);
      this.change({ remoteStream: stream });
    };
    peer.onconnectionstatechange = () => {
      if (run !== this.generation || peer !== this.peer) return;
      if (this.recoveryTimer) { clearTimeout(this.recoveryTimer); this.recoveryTimer = null; }
      if (peer.connectionState === 'connected') {
        this.change({ status: 'connected', error: null });
        if (!this.timer) this.timer = setInterval(() => { void this.sampleStats(peer, run); }, 1000);
        void this.sampleStats(peer, run);
      } else if (peer.connectionState === 'failed') this.fail('No se encontró una ruta entre los equipos. Revisa STUN/TURN y el cortafuegos del servidor.');
      else if (peer.connectionState === 'disconnected') {
        window.inhouseDesktop?.releaseInputs();
        this.change({ status: 'negotiating', error: 'La conexión se ha interrumpido. Intentando recuperar la ruta…' });
        this.recoveryTimer = setTimeout(() => { if (peer === this.peer) this.fail('Se perdió la conexión con el equipo remoto.'); }, 12000);
      }
    };
    return peer;
  }

  private bindChannel(channel: RTCDataChannel) {
    if (channel.label === 'control') this.control = channel;
    else if (channel.label === 'pointer') this.pointer = channel;
    else { channel.close(); return; }
    if (channel.label === 'control') {
      channel.bufferedAmountLowThreshold = 16000;
      channel.onbufferedamountlow = () => { this.releaseQueued = false; };
    }
    channel.onopen = async () => {
      if (channel.label !== 'control') return;
      if (this.current.role === 'host') {
        if (this.activeTrustedDevice) {
          const proof = await prove(this.activeTrustedDevice.token, `host:${this.activeTrustedDevice.nonce}:${this.current.deviceId}`);
          if (channel !== this.control || channel.readyState !== 'open') return;
          this.sendControl({ type: 'host-auth', proof });
        }
        if (this.trustToCreate && this.enrollmentRevision === getTrustRevision()) {
          saveDevice(this.trustToCreate);
          this.sendControl({ type: 'trusted-device', deviceId: this.current.deviceId, id: this.trustToCreate.id, token: this.trustToCreate.token, name: 'PC Inhouse' });
          this.trustToCreate = null;
        }
        this.sendControl({ type: 'permission', enabled: this.hostControlEnabled });
      } else {
        this.sendControl({ type: 'settings', settings: this.settings });
        if (this.expectedTrustedHost) this.authTimer = setTimeout(() => {
          if (!this.trustedHostVerified && channel === this.control) this.fail('El PC remoto no ha demostrado su identidad. Vuelve a emparejarlo localmente.');
        }, 10000);
      }
    };
    channel.onclose = () => {
      if (channel.label === 'control') {
        window.inhouseDesktop?.releaseInputs();
        this.change({ controlEnabled: false });
      }
    };
    channel.onmessage = async (event) => {
      if (typeof event.data !== 'string' || event.data.length > 4096) return;
      let data: Record<string, unknown>;
      try { data = JSON.parse(event.data) as Record<string, unknown>; } catch { return; }
      if (channel !== this.control && data.type !== 'input') return;
      if (channel !== this.control && data.type === 'input') {
        const input = data.event as { kind?: string } | undefined;
        if (input?.kind !== 'pointer' && input?.kind !== 'relative') return;
      }
      if (data.type === 'input' && this.current.role === 'host' && this.current.controlEnabled && isValidInput(data.event)) {
        window.inhouseDesktop?.injectInput(data.event);
      } else if (data.type === 'settings' && this.current.role === 'host') {
        const settings = validSettings(data.settings);
        if (settings) void this.updateSettings(settings);
      } else if (data.type === 'permission' && this.current.role === 'viewer' && typeof data.enabled === 'boolean') {
        this.remotePermission = data.enabled;
        this.change({ controlEnabled: data.enabled && (!this.expectedTrustedHost || this.trustedHostVerified) });
      } else if (data.type === 'host-auth' && this.current.role === 'viewer' && this.expectedTrustedHost && typeof data.proof === 'string') {
        const valid = await verifyProof(this.expectedTrustedHost.token, `host:${this.connectionNonce}:${this.expectedTrustedHost.deviceId}`, data.proof);
        if (channel !== this.control) return;
        if (!valid) { this.fail('La identidad del PC remoto no coincide con el emparejamiento guardado.'); return; }
        this.trustedHostVerified = true;
        if (this.authTimer) { clearTimeout(this.authTimer); this.authTimer = null; }
        saveHost({ ...this.expectedTrustedHost, lastSeen: Date.now() });
        this.change({ controlEnabled: this.remotePermission });
      } else if (data.type === 'trusted-device' && this.current.role === 'viewer'
        && channel === this.control && (!this.expectedTrustedHost || this.trustedHostVerified)
        && typeof data.deviceId === 'string' && data.deviceId === this.current.deviceId
        && typeof data.id === 'string' && /^[a-f0-9]{32}$/.test(data.id)
        && typeof data.token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(data.token)) {
        saveHost({ deviceId: data.deviceId, id: data.id, token: data.token, name: String(data.name || this.current.peerName).slice(0, 60), lastSeen: Date.now() });
        this.change({});
      } else if (data.type === 'settings-applied' && typeof data.message === 'string') this.change({ error: data.message || null });
    };
  }

  private sendControl(data: Record<string, unknown>) {
    if (this.control?.readyState === 'open' && this.control.bufferedAmount < 128000) this.control.send(JSON.stringify(data));
  }

  sendInput(event: Record<string, unknown>) {
    if (this.current.role !== 'viewer' || this.current.status !== 'connected' || !this.current.controlEnabled
      || (!this.viewerInputEnabled && event.kind !== 'release') || !isValidInput(event)) return;
    const channel = (event.kind === 'pointer' || event.kind === 'relative') && this.pointer?.readyState === 'open' ? this.pointer : this.control;
    if (channel?.readyState !== 'open') return;
    if (channel === this.pointer) {
      if (channel.bufferedAmount < 64000) channel.send(JSON.stringify({ type: 'input', event }));
      return;
    }
    if (this.releaseQueued) return;
    if (channel.bufferedAmount >= 64000) {
      // Queue exactly one reliable release after existing input, then pause input
      // until the queue drains. Key-up must never disappear due to backpressure.
      this.releaseQueued = true;
      try { channel.send(JSON.stringify({ type: 'input', event: { kind: 'release' } })); }
      catch { channel.close(); }
      return;
    }
    channel.send(JSON.stringify({ type: 'input', event }));
  }

  async updateSettings(settings: LinkSettings): Promise<void> {
    const validated = validSettings(settings);
    if (!validated) { this.change({ error: 'Los ajustes seleccionados no son válidos.' }); return; }
    const previousCodec = this.settings.codec;
    this.settings = validated;
    this.adaptiveBitrate = validated.bitrate;
    if (this.current.role === 'viewer') { this.sendControl({ type: 'settings', settings: validated }); return; }
    if (this.current.role !== 'host') return;
    try {
      const stream = this.current.localStream;
      stream?.getAudioTracks().forEach((track) => { track.enabled = validated.audio; });
      const video = stream?.getVideoTracks()[0];
      if (video) await video.applyConstraints({ frameRate: { ideal: validated.fps, max: validated.fps } });
      await this.applySenderSettings();
      if (previousCodec !== validated.codec && this.peer?.signalingState === 'stable') {
        this.applyCodecPreference();
        await this.peer.setLocalDescription(await this.peer.createOffer());
        this.sendSignal({ type: 'signal', signal: { description: this.peer.localDescription } });
      }
      const warning = validated.audio && !stream?.getAudioTracks().length
        ? 'La captura actual no incluye audio del sistema. Vuelve a compartir la pantalla con audio para enviarlo.' : null;
      this.change({ error: warning });
      this.sendControl({ type: 'settings-applied', message: warning ?? '' });
    } catch (error) {
      const warning = `No se han podido aplicar todos los ajustes: ${message(error)}`;
      this.change({ error: warning });
      this.sendControl({ type: 'settings-applied', message: warning });
    }
  }

  private applyCodecPreference() {
    if (!this.peer) return;
    // H.264 is the most broadly hardware-accelerated baseline across Windows
    // hosts and browser clients. AV1/VP9 remain explicit preferences, not claims
    // that the selected machine has a hardware encoder for those formats.
    const preferred = this.settings.codec === 'auto' ? 'h264' : this.settings.codec;
    const mime = `video/${preferred === 'h264' ? 'H264' : preferred.toUpperCase()}`;
    const capabilities = RTCRtpSender.getCapabilities?.('video');
    const selected = capabilities?.codecs.filter((codec) => codec.mimeType.toLowerCase() === mime.toLowerCase()) ?? [];
    if (!selected.length) {
      if (this.settings.codec !== 'auto') this.change({ error: `Este equipo no ofrece ${this.settings.codec.toUpperCase()}; se negociará otro códec compatible.` });
      return;
    }
    const others = capabilities!.codecs.filter((codec) => codec.mimeType.toLowerCase() !== mime.toLowerCase());
    for (const transceiver of this.peer.getTransceivers()) {
      if ((transceiver.sender.track?.kind ?? transceiver.receiver.track?.kind) === 'video' && transceiver.setCodecPreferences) {
        transceiver.setCodecPreferences([...selected, ...others]);
      }
    }
  }

  private videoEncoding(track: MediaStreamTrack): RTCRtpEncodingParameters {
    const source = track.getSettings();
    const target = this.settings.resolution === 'native' ? null : RESOLUTIONS[this.settings.resolution];
    const scale = target ? Math.max(1, (source.width || target[0]) / target[0], (source.height || target[1]) / target[1]) : 1;
    return { maxBitrate: Math.round(this.adaptiveBitrate * 1_000_000), maxFramerate: this.settings.fps, scaleResolutionDownBy: scale };
  }

  private async applySenderSettings() {
    if (!this.peer || this.current.role !== 'host') return;
    for (const sender of this.peer.getSenders()) {
      if (sender.track?.kind !== 'video') continue;
      const parameters = sender.getParameters();
      if (!parameters.encodings?.length) continue;
      for (const encoding of parameters.encodings) {
        Object.assign(encoding, this.videoEncoding(sender.track));
      }
      parameters.degradationPreference = this.settings.adaptive ? 'maintain-framerate' : 'maintain-resolution';
      await sender.setParameters(parameters);
    }
  }

  private async sampleStats(peer: RTCPeerConnection, run: number) {
    if (this.statsPending || run !== this.generation || peer !== this.peer) return;
    this.statsPending = true;
    try {
      const { stats, sample } = await collectSessionStats(peer, this.previousStats);
      if (run !== this.generation || peer !== this.peer) return;
      this.previousStats = sample;
      this.change({ stats });
      if (this.current.role === 'host' && this.settings.adaptive) {
        const congested = (stats.rttMs ?? 0) > 160 || (stats.packetLoss ?? 0) > 3;
        const healthy = stats.rttMs !== null && stats.rttMs < 80 && (stats.packetLoss ?? 0) < 1;
        const next = congested ? Math.max(2, this.adaptiveBitrate * 0.85)
          : healthy ? Math.min(this.settings.bitrate, this.adaptiveBitrate * 1.05) : this.adaptiveBitrate;
        if (Math.abs(next - this.adaptiveBitrate) > 0.1) { this.adaptiveBitrate = next; await this.applySenderSettings(); }
      }
    } catch { /* Stats can disappear during renegotiation; a later report will replace them. */ }
    finally { this.statsPending = false; }
  }

  private closePeer(revoke = true) {
    this.activeConnectionId = '';
    if (this.timer) clearInterval(this.timer);
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
    if (this.authTimer) clearTimeout(this.authTimer);
    this.timer = null; this.recoveryTimer = null;
    this.authTimer = null;
    this.previousStats = null;
    this.statsPending = false;
    window.inhouseDesktop?.releaseInputs();
    if (revoke) { this.hostControlEnabled = false; void window.inhouseDesktop?.setControlEnabled(false); }
    for (const channel of [this.control, this.pointer]) {
      if (channel) { channel.onopen = null; channel.onmessage = null; channel.onclose = null; channel.onbufferedamountlow = null; channel.close(); }
    }
    this.control = null; this.pointer = null;
    const peer = this.peer;
    this.peer = null;
    if (peer) { peer.onconnectionstatechange = null; peer.ontrack = null; peer.onicecandidate = null; peer.ondatachannel = null; peer.close(); }
    this.current.remoteStream?.getTracks().forEach((track) => track.stop());
    this.candidates = [];
    this.releaseQueued = false;
  }

  disconnect() {
    this.sendInput({ kind: 'release' });
    this.generation++;
    if (this.hostReconnectTimer) clearTimeout(this.hostReconnectTimer);
    this.hostReconnectTimer = null;
    this.hostReconnectAttempt = 0;
    this.hostReconnectPending = false;
    this.reconnectingHost = false;
    this.sendSignal({ type: 'leave' });
    if (this.socket) { this.socket.onclose = null; this.socket.close(); this.socket = null; }
    if (this.iceRefreshTimer) clearTimeout(this.iceRefreshTimer);
    this.iceRefreshTimer = null;
    this.serverBase = null;
    this.closePeer();
    this.current.localStream?.getTracks().forEach((track) => track.stop());
    window.inhouseDesktop?.captureEnded?.();
    if (this.accountHosting) window.inhouseDesktop?.disableAccountHosting?.();
    this.accountHosting = false;
    this.cloudMode = false;
    this.nativeCloudChallenge = '';
    this.processing = Promise.resolve();
    this.viewerInputEnabled = true;
    this.connectionNonce = '';
    this.trustToCreate = null;
    this.activeTrustedDevice = null;
    this.expectedTrustedHost = null;
    this.trustedHostVerified = false;
    this.remotePermission = false;
    this.approvalInFlight = false;
    this.change({ ...INITIAL_STATE, status: 'disconnected', stats: { ...EMPTY_STATS } });
  }

  private fail(error: string) {
    const role = this.current.role;
    this.disconnect();
    this.change({ status: 'error', role, error });
  }

  destroy() {
    window.removeEventListener('inhouse-account-changed', this.accountChanged);
    this.removeHostingRevoked?.(); this.removePeerRevoked?.();
    this.destroyed = true;
    this.disconnect();
  }
}
