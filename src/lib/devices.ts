import { ensureServiceAccountSession, getConfiguredServiceOrigin, getGoogleSession } from './google-account';
import { base64url } from './trust';
import { getCloudAccount } from './cloud-account';
import { useCloudAccountTransport } from './service-config';
import { getCloudHub } from './cloud-signal';

export type AccountDevice = { deviceId: string; name: string; online: true; busy: boolean };
export type DevicesState = {
  status: 'loading' | 'online' | 'offline' | 'unconfigured';
  devices: AccountDevice[];
  error: string | null;
  localOnly: boolean;
};
export const EMPTY_DEVICES: DevicesState = { status: 'loading', devices: [], error: null, localOnly: false };

/** Presence uses an independent authenticated socket, so joining a PC never
 * destroys the account's live directory. The server owns the account filter. */
export class AccountDevices {
  private socket: WebSocket | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private timeout: ReturnType<typeof setTimeout> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private generation = 0;
  private attempt = 0;
  private active = false;
  private unsubscribeCloud: (() => void) | null = null;
  private accountId = '';
  private state: DevicesState = { ...EMPTY_DEVICES };

  constructor(private onChange: (state: DevicesState) => void) {}

  private change(patch: Partial<DevicesState>) {
    this.state = { ...this.state, ...patch };
    if (this.active) this.onChange(this.state);
  }

  start() {
    this.stop();
    this.active = true;
    this.accountId = getGoogleSession()?.profile.id ?? '';
    this.attempt = 0;
    void this.open(++this.generation);
  }

  private async open(run: number) {
    if (useCloudAccountTransport()) {
      const account = getCloudAccount();
      if (!account || account.profile.id !== this.accountId) {
        this.change({ status: 'offline', devices: [], localOnly: false, error: 'Vuelve a iniciar sesión con Google para sincronizar tus equipos.' });
        return;
      }
      this.unsubscribeCloud = getCloudHub(account).subscribeDevices(state => {
        if (!this.active || run !== this.generation) return;
        this.change({ status: state.status === 'connected' ? 'online' : state.status === 'connecting' ? 'loading' : 'offline',
          devices: state.devices.filter(device => device.online).map(device => ({ deviceId: device.deviceId, name: device.name,
            online: true, busy: device.busy })), error: state.error, localOnly: false });
      });
      return;
    }
    const origin = getConfiguredServiceOrigin();
    if (!origin) {
      this.change({ status: 'unconfigured', devices: [], localOnly: false,
        error: 'El servicio de conexión entre equipos todavía no está configurado.' });
      return;
    }
    const localOnly = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(origin).hostname);
    this.change({ status: 'loading', devices: [], error: null, localOnly });
    try {
      const session = await ensureServiceAccountSession(new URL(origin));
      if (!this.active || run !== this.generation) return;
      if (!this.accountId || session.profile.id !== this.accountId) throw new Error('La cuenta de Google ha cambiado. Vuelve a iniciar sesión.');
      const protocols = ['inhouse-link-v1', `google.${base64url(new TextEncoder().encode(session.accessToken))}`];
      const key = localStorage.getItem('inhouse.serviceToken')?.trim();
      if (key) protocols.push(`auth.${base64url(new TextEncoder().encode(key))}`);
      const url = new URL('/signal', origin);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      const socket = new WebSocket(url, protocols);
      this.socket = socket;
      let greeted = false;
      this.timeout = setTimeout(() => socket.close(), 12000);
      socket.onmessage = event => {
        if (!this.active || run !== this.generation || typeof event.data !== 'string' || event.data.length > 256000) return;
        let data: Record<string, unknown>;
        try { data = JSON.parse(event.data); } catch { return; }
        if (data.type === 'hello') {
          const account = data.account as { id?: unknown } | undefined;
          if (account?.id !== this.accountId) { socket.close(); return; }
          greeted = true;
          if (this.timeout) clearTimeout(this.timeout);
          this.timeout = null;
          socket.send(JSON.stringify({ type: 'devices' }));
          // This is ordinary presence traffic while the signed-in client is open.
          this.heartbeat = setInterval(() => {
            if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'ping' }));
          }, 25000);
        } else if (greeted && data.type === 'devices' && Array.isArray(data.devices)) {
          const devices = data.devices.slice(0, 200).flatMap(value => {
            if (!value || typeof value !== 'object') return [];
            const device = value as Partial<AccountDevice>;
            if (typeof device.deviceId !== 'string' || !/^[a-f0-9]{32}$/.test(device.deviceId)
              || typeof device.name !== 'string' || device.online !== true || typeof device.busy !== 'boolean') return [];
            return [{ deviceId: device.deviceId, name: device.name.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 64) || 'PC Windows', online: true as const, busy: device.busy }];
          });
          this.attempt = 0;
          this.change({ status: 'online', devices, error: null });
        } else if (data.type === 'error') {
          this.change({ status: 'offline', devices: [], error: typeof data.message === 'string' ? data.message : 'No se puede consultar la lista de equipos.' });
        }
      };
      socket.onerror = () => { /* Close handles one retry and clears stale presence. */ };
      socket.onclose = () => {
        if (this.timeout) clearTimeout(this.timeout);
        if (this.heartbeat) clearInterval(this.heartbeat);
        this.timeout = null; this.heartbeat = null;
        if (!this.active || run !== this.generation) return;
        this.change({ status: 'offline', devices: [], error: 'No se puede acceder al servicio de equipos. Reintentando…' });
        this.retry(run);
      };
    } catch (error) {
      if (!this.active || run !== this.generation) return;
      this.change({ status: 'offline', devices: [], error: error instanceof Error ? error.message : 'No se puede consultar tu cuenta.' });
      this.retry(run);
    }
  }

  private retry(run: number) {
    if (!this.active || run !== this.generation || getGoogleSession()?.profile.id !== this.accountId) return;
    this.timer = setTimeout(() => { this.timer = null; void this.open(run); }, Math.min(30000, 1000 * 2 ** this.attempt++));
  }

  stop() {
    this.active = false;
    this.generation++;
    this.unsubscribeCloud?.(); this.unsubscribeCloud = null;
    if (this.timer) clearTimeout(this.timer);
    if (this.timeout) clearTimeout(this.timeout);
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.timer = null; this.timeout = null; this.heartbeat = null;
    if (this.socket) { this.socket.onclose = null; this.socket.close(); this.socket = null; }
    this.state = { ...EMPTY_DEVICES, devices: [] };
  }
}
