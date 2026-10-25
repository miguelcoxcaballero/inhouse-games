import mqtt, { type IClientOptions, type MqttClient } from 'mqtt';
import { getCloudAccount, type CloudAccount } from './cloud-account.ts';
import { base64url, identityForNonce } from './trust.ts';
import {
  createAccountPeerProof, decryptRealmPacket, deriveRealmTopic, encryptRealmPacket, verifyAccountPeerProof,
  type AccountPeerProof,
} from '../../server/drive-realm.mjs';

export const DEFAULT_CLOUD_BROKER = 'wss://public.cloud.shiftr.io';
export type CloudDevice = {
  id: string; deviceId: string; name: string; platform: 'win32'; online: boolean;
  busy: boolean; lastSeen: number; replySocketId: string; nativeChallenge: string;
};
export type CloudDevicesState = {
  status: 'connecting' | 'connected' | 'offline' | 'error'; devices: CloudDevice[]; error: string | null;
};
export type CloudSocketMessage = { data: string };
export type CloudSocketClose = { code: number; reason: string; wasClean: boolean };
export type CloudIdentity = Awaited<ReturnType<typeof identityForNonce>>;
export type CloudHubOptions = {
  /** Explicit injection for a real loopback MQTT broker in tests, never a persisted preference. */
  brokerFactory?: (url: string, options: IClientOptions) => MqttClient;
  brokerUrl?: string;
  identityProvider?: (nonce: string) => Promise<CloudIdentity>;
  accountProvider?: () => CloudAccount | null;
  now?: () => number;
  heartbeatMs?: number;
  presenceTtlMs?: number;
  connectTimeoutMs?: number;
};

type JsonObject = Record<string, unknown>;
type IdentityKey = { crv: string; kty: string; x: string; y: string };
type Body = {
  v: 1; id: string; sentAt: number; from: string; clientId: string; deviceId: string;
  publicKey: IdentityKey; to: string | null; kind: 'presence' | 'join' | 'paired' | 'signal' | 'leave' | 'reject' | 'pulse'; data: JsonObject;
};
type Prepared = { topic: string; payload: string; retain: boolean };
type Presence = CloudDevice & { clientId: string; expiresAt: number; sequence: number };
type Pair = {
  connectionId: string; peerSocketId: string; peerDeviceId: string; peerName: string;
  proof: AccountPeerProof; lastPulse: number; counter: number; leave: Prepared | null;
};
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const DEVICE = /^[a-f0-9]{32}$/;
const SECRET = /^[A-Za-z0-9_-]{43}$/;
const CLEAR_LIMIT = 64 * 1024;
const WIRE_LIMIT = 128 * 1024;
const MAX_DEVICES = 64;

function plain(value: unknown): value is JsonObject { return !!value && typeof value === 'object' && !Array.isArray(value); }
function name(value: unknown, fallback: string) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 64) || fallback : fallback;
}
function canonical(value: unknown, depth = 0): string {
  if (depth > 20) throw new Error('Packet nesting exceeds the limit.');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) {
    if (value.length > 1024) throw new Error('Packet array exceeds the limit.');
    return `[${value.map(item => canonical(item, depth + 1)).join(',')}]`;
  }
  if (plain(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key], depth + 1)}`).join(',')}}`;
  throw new Error('The packet contains a non-JSON value.');
}
function decodeBase64(value: string) {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/');
  return Uint8Array.from(atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')), character => character.charCodeAt(0));
}
async function digest(body: unknown) {
  const text = canonical(body);
  if (encoder.encode(text).length > CLEAR_LIMIT - 1024) throw new Error('El mensaje de conexión supera el límite.');
  return base64url(await crypto.subtle.digest('SHA-256', encoder.encode(text)));
}
function publicKey(value: unknown): IdentityKey | null {
  if (!plain(value) || value.crv !== 'P-256' || value.kty !== 'EC'
    || typeof value.x !== 'string' || !SECRET.test(value.x) || typeof value.y !== 'string' || !SECRET.test(value.y)) return null;
  return { crv: value.crv, kty: value.kty, x: value.x, y: value.y };
}
async function deviceId(key: IdentityKey) {
  const bytes = await crypto.subtle.digest('SHA-256', encoder.encode(JSON.stringify(key)));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('').slice(0, 32);
}
function validSignal(value: unknown) {
  if (!plain(value)) return false;
  if (value.description !== undefined && value.candidate !== undefined) return false;
  if (plain(value.description)) return ['offer', 'answer'].includes(String(value.description.type))
    && typeof value.description.sdp === 'string' && value.description.sdp.length > 0 && value.description.sdp.length < 48 * 1024;
  if (plain(value.candidate)) return typeof value.candidate.candidate === 'string' && value.candidate.candidate.length < 12000;
  return false;
}
function validOptions(options: CloudHubOptions) {
  if (!options.brokerUrl || options.brokerUrl === DEFAULT_CLOUD_BROKER) return;
  const url = new URL(options.brokerUrl);
  if (!['ws:', 'wss:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password) {
    throw new Error('El transporte de prueba debe usar un broker local.');
  }
}

/** A WebSocket-shaped endpoint; all network messages belong to one private realm. */
export class CloudSocket {
  readyState = 0;
  onopen: ((event: { type: string }) => unknown) | null = null;
  onmessage: ((event: CloudSocketMessage) => unknown) | null = null;
  onclose: ((event: CloudSocketClose) => unknown) | null = null;
  onerror: ((event: { type: string }) => unknown) | null = null;
  readonly id = crypto.randomUUID();
  readonly nonce = base64url(crypto.getRandomValues(new Uint8Array(32)));
  role: 'host' | 'viewer' | null = null;
  hostName = 'PC Inhouse';
  challenge = '';
  pair: Pair | null = null;
  pending: Pair | null = null;
  offline: Prepared | null = null;
  offlineSequence = 0;
  pulseTimer: ReturnType<typeof setInterval> | null = null;
  private hub: CloudHub;
  private outbound = Promise.resolve();
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(hub: CloudHub) { this.hub = hub; }
  send(serialized: string) {
    if (this.readyState !== 1) throw new Error('El canal privado no está abierto.');
    if (typeof serialized !== 'string' || serialized.length > CLEAR_LIMIT) { this.emit({ type: 'error', message: 'Mensaje de conexión inválido.' }); return; }
    let message: unknown;
    try { message = JSON.parse(serialized); } catch { this.emit({ type: 'error', message: 'Mensaje de conexión inválido.' }); return; }
    this.outbound = this.outbound.then(async () => {
      if (this.readyState === 1 && plain(message)) await this.hub.command(this, message);
    }).catch(() => { this.emit({ type: 'error', message: 'No se pudo enviar el mensaje por el enlace privado.' }); });
  }
  close(code = 1000, reason = '') { this.hub.removeSocket(this, code, reason); }
  emit(message: JsonObject) {
    if (this.readyState === 1) this.onmessage?.({ data: JSON.stringify(message) });
  }
  open(accountId: string) {
    if (this.readyState !== 0) return;
    this.readyState = 1;
    this.onopen?.({ type: 'open' });
    this.emit({ type: 'hello', nonce: this.nonce, account: { id: accountId }, accountAuthorized: true });
  }
  closed(code: number, reason: string) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    if (this.pulseTimer) clearInterval(this.pulseTimer);
    if (this.pendingTimer) clearTimeout(this.pendingTimer);
    this.pulseTimer = null;
    this.pendingTimer = null;
    this.onclose?.({ code, reason, wasClean: code === 1000 });
  }
  waitForPair(milliseconds: number) {
    if (this.pendingTimer) clearTimeout(this.pendingTimer);
    this.pendingTimer = setTimeout(() => {
      this.pendingTimer = null;
      if (!this.pending || this.readyState !== 1) return;
      this.hub.expirePending(this);
    }, milliseconds);
  }
  paired() { if (this.pendingTimer) clearTimeout(this.pendingTimer); this.pendingTimer = null; this.pending = null; }
}

/** One MQTT connection shared by this browser's device list and session endpoints. */
export class CloudHub {
  private account: CloudAccount;
  private options: CloudHubOptions;
  private client: MqttClient | null = null;
  private topic = '';
  private key: IdentityKey | null = null;
  private ownDeviceId = '';
  private readonly clientId = crypto.randomUUID();
  private sockets = new Map<string, CloudSocket>();
  private devices = new Map<string, Presence>();
  private observers = new Set<(state: CloudDevicesState) => void>();
  private seen = new Map<string, number>();
  private sequence = 0;
  private presenceSequences = new Map<string, number>();
  private incoming = Promise.resolve();
  private queued = 0;
  private status: CloudDevicesState['status'] = 'connecting';
  private error: string | null = null;
  private disposed = false;
  private subscribed = false;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;
  private readyWaiters = new Set<{ resolve: () => void; reject: (error: Error) => void }>();
  private accountChanged: () => void;

  constructor(account: CloudAccount, options: CloudHubOptions = {}) {
    validOptions(options);
    if (!account?.profile?.id || !SECRET.test(account.secret) || account.expiresAt <= Date.now()) throw new Error('La cuenta privada no está disponible.');
    const current = (options.accountProvider ?? getCloudAccount)();
    if (!current || current.profile.id !== account.profile.id || current.secret !== account.secret || current.fileId !== account.fileId) throw new Error('La cuenta privada ha cambiado.');
    this.account = { ...account, profile: { ...account.profile } };
    this.options = options;
    this.accountChanged = () => { this.checkAccount(); };
    if (typeof window !== 'undefined') window.addEventListener('inhouse-account-changed', this.accountChanged);
    this.tickTimer = setInterval(() => { void this.tick().catch(() => {}); }, Math.min(1000, this.heartbeatMs));
    this.scheduleIdle();
    void this.initialize().catch(() => { this.setStatus('error', 'No se pudo abrir el enlace privado de tu cuenta.'); this.rejectWaiters(); });
  }
  get closed() { return this.disposed; }
  get identity() { return this.ownDeviceId; }
  get snapshot(): CloudDevicesState {
    const now = this.now();
    return {
      status: this.status, error: this.error,
      devices: [...this.devices.values()].map(device => ({
        id: device.id, deviceId: device.deviceId, name: device.name, platform: device.platform,
        online: device.online && device.expiresAt > now, busy: device.busy && device.expiresAt > now,
        lastSeen: device.lastSeen, replySocketId: device.replySocketId, nativeChallenge: device.nativeChallenge,
      })).sort((a, b) => b.lastSeen - a.lastSeen),
    };
  }
  private now() { return this.options.now?.() ?? Date.now(); }
  private get heartbeatMs() { return this.options.heartbeatMs ?? 10_000; }
  private get ttlMs() { return this.options.presenceTtlMs ?? 40_000; }
  private sign(nonce: string) { return (this.options.identityProvider ?? identityForNonce)(nonce); }
  private currentAccount() { return (this.options.accountProvider ?? getCloudAccount)(); }

  subscribeDevices(callback: (state: CloudDevicesState) => void) {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.observers.add(callback);
    queueMicrotask(() => { if (this.observers.has(callback)) { try { callback(this.snapshot); } catch { /* Observers cannot affect transport ownership. */ } } });
    return () => { this.observers.delete(callback); this.scheduleIdle(); };
  }
  subscribeDevicesState(callback: (state: CloudDevicesState) => void) { return this.subscribeDevices(callback); }
  updateAccount(account: CloudAccount) {
    if (account.profile.id !== this.account.profile.id || account.secret !== this.account.secret || account.fileId !== this.account.fileId) {
      this.dispose('La cuenta privada ha cambiado.'); return;
    }
    this.account.expiresAt = account.expiresAt;
  }
  async createSocket(): Promise<CloudSocket> {
    if (this.disposed) throw new Error('El enlace de cuenta está cerrado.');
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    try { await this.waitUntilReady(); }
    catch (error) { this.scheduleIdle(); throw error; }
    if (this.disposed) throw new Error('El enlace de cuenta está cerrado.');
    const socket = new CloudSocket(this);
    this.sockets.set(socket.id, socket);
    // Promise continuations install WebSocket handlers before either event fires.
    setTimeout(() => { if (!this.disposed && this.sockets.has(socket.id)) socket.open(this.account.profile.id); }, 0);
    return socket;
  }
  private async initialize() {
    const run = this.generation;
    const identity = await this.sign('inhouse-cloud-identity-v1');
    const key = publicKey(identity.identity.publicKey);
    if (!key || await deviceId(key) !== identity.deviceId) throw new Error('Invalid device identity.');
    this.topic = await deriveRealmTopic(this.account.secret);
    if (this.disposed || run !== this.generation) return;
    this.key = key;
    this.ownDeviceId = identity.deviceId;
    const factory = this.options.brokerFactory ?? mqtt.connect;
    this.client = factory(this.options.brokerUrl ?? DEFAULT_CLOUD_BROKER, {
      clientId: `ih-${this.clientId.replaceAll('-', '').slice(0, 20)}`, clean: true, protocolVersion: 4,
      username: 'public', password: 'public', reconnectPeriod: 2000,
      connectTimeout: this.options.connectTimeoutMs ?? 12000, resubscribe: false,
      queueQoSZero: false,
    });
    this.client.on('connect', () => {
      if (this.disposed) return;
      this.client!.subscribe(`${this.topic}/#`, { qos: 1 }, error => {
        if (this.disposed) return;
        if (error) { this.setStatus('error', 'No se pudo suscribir el enlace privado.'); this.rejectWaiters(); return; }
        this.subscribed = true;
        this.setStatus('connected', null);
        for (const waiter of this.readyWaiters) waiter.resolve();
        this.readyWaiters.clear();
        for (const socket of this.sockets.values()) if (socket.role === 'host') void this.publishPresence(socket, true).catch(() => {});
      });
    });
    const offline = () => {
      this.subscribed = false;
      if (!this.disposed) this.setStatus('offline', 'El enlace privado se está reconectando…');
    };
    this.client.on('offline', offline);
    this.client.on('close', offline);
    this.client.on('error', () => { if (!this.disposed) this.setStatus('error', 'No se pudo contactar con el enlace privado.'); });
    this.client.on('message', (topic, bytes) => {
      if (this.disposed || bytes.length > WIRE_LIMIT || this.queued >= 64) return;
      this.queued++;
      this.incoming = this.incoming.then(() => this.receive(topic, bytes)).catch(() => {}).finally(() => { this.queued--; });
    });
  }
  private waitUntilReady() {
    if (this.status === 'connected' && this.subscribed) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => { this.readyWaiters.delete(waiter); reject(new Error('No se pudo conectar con el enlace privado.')); }, this.options.connectTimeoutMs ?? 15000);
      const waiter = {
        resolve: () => { clearTimeout(timeout); resolve(); },
        reject: (error: Error) => { clearTimeout(timeout); reject(error); },
      };
      this.readyWaiters.add(waiter);
    });
  }
  private rejectWaiters() {
    for (const waiter of this.readyWaiters) waiter.reject(new Error(this.error || 'El enlace privado no está disponible.'));
    this.readyWaiters.clear();
  }
  private setStatus(status: CloudDevicesState['status'], error: string | null) { this.status = status; this.error = error; this.notify(); }
  private live(socket: CloudSocket, role?: CloudSocket['role']) {
    return !this.disposed && this.sockets.get(socket.id) === socket && socket.readyState === 1 && (role === undefined || socket.role === role);
  }
  private notify() { for (const callback of this.observers) { try { callback(this.snapshot); } catch { /* One observer must not block another session. */ } } }
  private checkAccount() {
    if (this.disposed) return false;
    const account = this.currentAccount();
    if (!account || account.profile.id !== this.account.profile.id || account.secret !== this.account.secret || account.fileId !== this.account.fileId || account.expiresAt <= this.now()) {
      this.dispose('La cuenta ha cambiado o ha caducado.'); return false;
    }
    this.account.expiresAt = account.expiresAt;
    return true;
  }
  private async prepare(socket: CloudSocket, kind: Body['kind'], to: string | null, data: JsonObject, retain = false): Promise<Prepared> {
    if (!this.key || this.disposed) throw new Error('El enlace privado no está abierto.');
    const body: Body = {
      v: 1, id: crypto.randomUUID(), sentAt: this.now(), from: socket.id, clientId: this.clientId,
      deviceId: this.ownDeviceId, publicKey: this.key, to, kind, data,
    };
    const signature = await this.sign(await digest(body));
    if (signature.deviceId !== this.ownDeviceId || this.disposed) throw new Error('La identidad del equipo ha cambiado.');
    const topic = kind === 'presence' ? `${this.topic}/presence/${socket.id}` : `${this.topic}/inbox/${to}`;
    const encrypted = await encryptRealmPacket(this.account.secret, topic, { body, signature: signature.identity.signature });
    return { topic, payload: JSON.stringify(encrypted), retain };
  }
  private publish(prepared: Prepared) {
    const client = this.client;
    if (!client?.connected || !this.subscribed) return Promise.reject(new Error('El enlace privado está desconectado.'));
    return new Promise<void>((resolve, reject) => {
      client.publish(prepared.topic, prepared.payload, { qos: 1, retain: prepared.retain }, error => error ? reject(error) : resolve());
    });
  }
  private async send(socket: CloudSocket, kind: Body['kind'], to: string, data: JsonObject) {
    const packet = await this.prepare(socket, kind, to, data);
    if (!this.live(socket)) return;
    if (kind === 'join' && (socket.role !== 'viewer' || socket.pending?.connectionId !== data.connectionId)) return;
    if (['paired', 'pulse', 'signal'].includes(kind) && socket.pair?.connectionId !== data.connectionId) return;
    await this.publish(packet);
  }
  private async publishPresence(socket: CloudSocket, online: boolean) {
    if (socket.role !== 'host' || this.disposed) return;
    const sequence = ++this.sequence;
    const offlineSequence = ++this.sequence;
    const data = {
      name: socket.hostName, online, busy: !!socket.pair, platform: 'win32', nativeChallenge: socket.challenge, sequence,
    };
    const [packet, offline] = await Promise.all([
      this.prepare(socket, 'presence', null, data, true),
      this.prepare(socket, 'presence', null, { ...data, online: false, busy: false, sequence: offlineSequence }, true),
    ]);
    if (socket.role !== 'host' || this.disposed || socket.readyState !== 1) return;
    // A close may happen as soon as the online packet reaches the broker.
    // Cache its already-signed offline counterpart first, and never regress
    // that cache when concurrent heartbeats finish in a different order.
    if (offlineSequence > socket.offlineSequence) {
      socket.offline = offline;
      socket.offlineSequence = offlineSequence;
    }
    await this.publish(packet);
    this.acceptPresence({
      v: 1, id: crypto.randomUUID(), sentAt: this.now(), from: socket.id, clientId: this.clientId,
      deviceId: this.ownDeviceId, publicKey: this.key!, to: null, kind: 'presence', data,
    });
  }
  private async receive(topic: string, bytes: Uint8Array) {
    if (!topic.startsWith(`${this.topic}/`) || this.disposed || !this.checkAccount()) return;
    const suffix = topic.slice(this.topic.length + 1);
    if (!/^presence\/[a-f0-9-]{36}$/i.test(suffix) && !/^inbox\/[a-f0-9-]{36}$/i.test(suffix)) return;
    const recipient = suffix.startsWith('inbox/') ? suffix.slice(6) : null;
    if (recipient && !this.sockets.has(recipient)) return;
    let packet: unknown;
    try { packet = await decryptRealmPacket(this.account.secret, topic, JSON.parse(decoder.decode(bytes))); } catch { return; }
    if (!plain(packet) || !plain(packet.body) || typeof packet.signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(packet.signature)) return;
    const candidate = packet.body;
    const key = publicKey(candidate.publicKey);
    if (!key || candidate.v !== 1 || typeof candidate.id !== 'string' || !UUID.test(candidate.id)
      || typeof candidate.from !== 'string' || !UUID.test(candidate.from) || typeof candidate.clientId !== 'string' || !UUID.test(candidate.clientId)
      || typeof candidate.deviceId !== 'string' || !DEVICE.test(candidate.deviceId)
      || typeof candidate.sentAt !== 'number' || !Number.isSafeInteger(candidate.sentAt)
      || this.now() - candidate.sentAt > this.ttlMs || candidate.sentAt > this.now() + 5000
      || (candidate.to !== null && (typeof candidate.to !== 'string' || !UUID.test(candidate.to)))
      || !['presence', 'join', 'paired', 'signal', 'leave', 'reject', 'pulse'].includes(String(candidate.kind)) || !plain(candidate.data)) return;
    if (recipient !== candidate.to || (!recipient && (candidate.kind !== 'presence' || suffix !== `presence/${candidate.from}`))) return;
    const replayKey = `${candidate.from}:${candidate.id}`;
    if (this.seen.has(replayKey) || await deviceId(key) !== candidate.deviceId) return;
    const imported = await crypto.subtle.importKey('jwk', key, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    const verified = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, imported, decodeBase64(packet.signature), encoder.encode(await digest(candidate)));
    if (!verified || this.disposed) return;
    this.seen.set(replayKey, this.now());
    while (this.seen.size > 2048) this.seen.delete(this.seen.keys().next().value!);
    const body = candidate as unknown as Body;
    if (body.kind === 'presence') { this.acceptPresence(body); return; }
    const socket = this.sockets.get(body.to!);
    if (!socket || socket.readyState !== 1 || body.from === socket.id) return;
    if (body.kind === 'join') { await this.acceptJoin(socket, body); return; }
    if (body.kind === 'paired') { await this.acceptPair(socket, body); return; }
    if (body.kind === 'reject') {
      const pending = socket.pending;
      if (pending?.connectionId === body.data.connectionId && pending?.peerSocketId === body.from && pending?.peerDeviceId === body.deviceId) {
        socket.paired(); socket.emit({ type: 'error', message: name(body.data.message, 'El PC no está disponible.') });
      }
      return;
    }
    const pair = socket.pair;
    if (!pair || pair.peerSocketId !== body.from || pair.peerDeviceId !== body.deviceId || body.data.connectionId !== pair.connectionId) return;
    if (body.kind === 'signal' && validSignal(body.data.signal)) socket.emit({ type: 'signal', signal: body.data.signal });
    else if (body.kind === 'leave') this.clearPair(socket, true);
    else if (body.kind === 'pulse' && socket.role === 'host') {
      const proof = body.data.proof;
      if (await verifyAccountPeerProof(this.account.secret, proof, {
        expectedAccountId: this.account.profile.id, expectedHostId: this.ownDeviceId,
        expectedViewerId: pair.peerDeviceId, expectedConnectionId: pair.connectionId,
        expectedChallenge: socket.challenge, expectedPurpose: 'keepalive', minCounter: pair.counter, now: this.now(), maxAgeMs: this.ttlMs,
      })) {
        if (socket.pair !== pair) return;
        pair.counter = (proof as AccountPeerProof).counter!;
        pair.lastPulse = this.now();
        socket.emit({ type: 'account-keepalive', proof });
      }
    }
  }
  private acceptPresence(body: Body) {
    const data = body.data;
    if (typeof data.name !== 'string' || typeof data.online !== 'boolean' || typeof data.busy !== 'boolean'
      || data.platform !== 'win32' || typeof data.nativeChallenge !== 'string' || !SECRET.test(data.nativeChallenge)
      || typeof data.sequence !== 'number' || !Number.isSafeInteger(data.sequence) || data.sequence < 1) return;
    const key = `${body.deviceId}:${body.from}`;
    if ((this.presenceSequences.get(key) ?? 0) >= data.sequence) return;
    this.presenceSequences.set(key, data.sequence);
    while (this.presenceSequences.size > 512) this.presenceSequences.delete(this.presenceSequences.keys().next().value!);
    const current = this.devices.get(body.deviceId);
    if (current && current.lastSeen > body.sentAt) return;
    this.devices.set(body.deviceId, {
      id: body.deviceId, deviceId: body.deviceId, name: name(data.name, 'PC Inhouse'), online: data.online,
      busy: data.busy, platform: 'win32', nativeChallenge: data.nativeChallenge,
      lastSeen: body.sentAt, replySocketId: body.from, clientId: body.clientId, expiresAt: body.sentAt + this.ttlMs, sequence: data.sequence,
    });
    while (this.devices.size > MAX_DEVICES) {
      const oldest = [...this.devices.values()].sort((a, b) => a.lastSeen - b.lastSeen)[0];
      this.devices.delete(oldest.deviceId);
    }
    if (!data.online) for (const socket of this.sockets.values()) {
      if (socket.role === 'viewer' && socket.pair?.peerSocketId === body.from) this.clearPair(socket, true);
    }
    this.notify();
  }
  async command(socket: CloudSocket, message: JsonObject) {
    if (!this.checkAccount() || socket.readyState !== 1) return;
    switch (message.type) {
      case 'host': {
        if (socket.role || !plain(message.identity) || typeof message.identity.signature !== 'string') throw new Error('Invalid host registration.');
        if ([...this.sockets.values()].some(other => other !== socket && other.role === 'host')) throw new Error('Este PC ya está disponible en tu cuenta.');
        const key = publicKey(message.identity.publicKey);
        if (!key || await deviceId(key) !== this.ownDeviceId || !/^[A-Za-z0-9_-]{86}$/.test(message.identity.signature)
          || typeof message.nativeChallenge !== 'string' || !SECRET.test(message.nativeChallenge)) throw new Error('Invalid host identity or challenge.');
        const imported = await crypto.subtle.importKey('jwk', key, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
        if (!await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, imported, decodeBase64(message.identity.signature), encoder.encode(socket.nonce))) throw new Error('Invalid host registration signature.');
        if (!this.live(socket, null)) return;
        if ([...this.sockets.values()].some(other => other !== socket && other.role === 'host')) throw new Error('Este PC ya está disponible en tu cuenta.');
        socket.role = 'host'; socket.hostName = name(message.name, 'PC Inhouse'); socket.challenge = message.nativeChallenge;
        socket.emit({ type: 'hosted', code: this.ownDeviceId, deviceId: this.ownDeviceId, account: { id: this.account.profile.id }, accountAuthorized: true });
        await this.publishPresence(socket, true);
        break;
      }
      case 'join': {
        if (socket.role || typeof message.code !== 'string' || !DEVICE.test(message.code.toLowerCase())) throw new Error('Selecciona un PC de tu cuenta.');
        const host = await this.findHost(message.code.toLowerCase());
        if (!host || !host.online || host.expiresAt <= this.now()) { socket.emit({ type: 'error', message: 'Ese PC no está conectado.' }); break; }
        if (!this.live(socket, null)) return;
        if (host.busy) { socket.emit({ type: 'error', message: 'Ese PC ya está en una sesión.' }); break; }
        if (host.deviceId === this.ownDeviceId) { socket.emit({ type: 'error', message: 'Conecta desde otro dispositivo de tu cuenta.' }); break; }
        socket.role = 'viewer';
        const connectionId = crypto.randomUUID();
        const proof = await createAccountPeerProof(this.account.secret, {
          accountId: this.account.profile.id, hostId: host.deviceId, viewerId: this.ownDeviceId,
          connectionId, challenge: host.nativeChallenge, issuedAt: this.now(), purpose: 'connect',
        });
        if (!this.live(socket, 'viewer')) return;
        const pending: Pair = { connectionId, peerSocketId: host.replySocketId, peerDeviceId: host.deviceId, peerName: host.name, proof, lastPulse: this.now(), counter: 0, leave: null };
        socket.pending = pending;
        pending.leave = await this.prepare(socket, 'leave', host.replySocketId, { connectionId });
        if (!this.live(socket, 'viewer') || socket.pending !== pending) return;
        socket.waitForPair(15000);
        socket.emit({ type: 'pending' });
        await this.send(socket, 'join', host.replySocketId, { connectionId, name: name(message.name, 'Mi dispositivo'), proof });
        break;
      }
      case 'signal':
        if (socket.pair && validSignal(message.signal)) await this.send(socket, 'signal', socket.pair.peerSocketId, { connectionId: socket.pair.connectionId, signal: message.signal });
        break;
      case 'disconnect-peer':
        await this.endPair(socket);
        break;
      case 'leave':
        await this.endPair(socket);
        if (socket.role === 'host') { await this.publishPresence(socket, false); socket.role = null; }
        else socket.role = null;
        break;
      case 'ping': socket.emit({ type: 'pong' }); break;
      default: socket.emit({ type: 'error', message: 'Mensaje no admitido por el enlace privado.' });
    }
  }
  private async findHost(id: string) {
    const existing = this.devices.get(id);
    if (existing?.online && existing.expiresAt > this.now()) return existing;
    const until = Date.now() + 5000;
    while (!this.disposed && Date.now() < until) {
      await new Promise(resolve => setTimeout(resolve, 100));
      const host = this.devices.get(id);
      if (host?.online && host.expiresAt > this.now()) return host;
    }
    return null;
  }
  private async acceptJoin(socket: CloudSocket, body: Body) {
    const { connectionId, proof } = body.data;
    if (!this.live(socket, 'host') || typeof connectionId !== 'string' || !UUID.test(connectionId)) return;
    if (socket.pair) { await this.send(socket, 'reject', body.from, { connectionId, message: 'Ese PC ya está en una sesión.' }); return; }
    if (!await verifyAccountPeerProof(this.account.secret, proof, {
      expectedAccountId: this.account.profile.id, expectedHostId: this.ownDeviceId, expectedViewerId: body.deviceId,
      expectedConnectionId: connectionId, expectedChallenge: socket.challenge, expectedPurpose: 'connect', now: this.now(), maxAgeMs: this.ttlMs,
    })) return;
    if (!this.live(socket, 'host') || socket.pair) return;
    const pair: Pair = {
      connectionId, peerSocketId: body.from, peerDeviceId: body.deviceId, peerName: name(body.data.name, 'Mi dispositivo'),
      proof: proof as AccountPeerProof, lastPulse: this.now(), counter: 0, leave: null,
    };
    socket.pair = pair;
    pair.leave = await this.prepare(socket, 'leave', pair.peerSocketId, { connectionId });
    if (!this.live(socket, 'host') || socket.pair !== pair) return;
    await this.send(socket, 'paired', body.from, { connectionId, name: socket.hostName, proof });
    if (socket.pair !== pair || socket.readyState !== 1) return;
    socket.emit({ type: 'paired', initiator: true, peerId: pair.peerDeviceId, name: pair.peerName,
      deviceId: this.ownDeviceId, deviceName: socket.hostName, account: { id: this.account.profile.id },
      connectionId, accountAuthorized: true, accountProof: proof });
    await this.publishPresence(socket, true);
  }
  private async acceptPair(socket: CloudSocket, body: Body) {
    const pair = socket.pending;
    if (socket.role !== 'viewer' || !pair || pair.connectionId !== body.data.connectionId || pair.peerSocketId !== body.from || pair.peerDeviceId !== body.deviceId) return;
    if (!await verifyAccountPeerProof(this.account.secret, body.data.proof, {
      expectedAccountId: this.account.profile.id, expectedHostId: pair.peerDeviceId, expectedViewerId: this.ownDeviceId,
      expectedConnectionId: pair.connectionId, expectedChallenge: pair.proof.challenge, expectedPurpose: 'connect', now: this.now(), maxAgeMs: this.ttlMs,
    })) return;
    if (!this.live(socket, 'viewer') || socket.pending !== pair || socket.pair) return;
    socket.paired(); socket.pair = pair;
    pair.leave = await this.prepare(socket, 'leave', pair.peerSocketId, { connectionId: pair.connectionId });
    if (!this.live(socket, 'viewer') || socket.pair !== pair) return;
    socket.emit({ type: 'paired', initiator: false, peerId: pair.peerDeviceId, name: name(body.data.name, pair.peerName),
      deviceId: pair.peerDeviceId, deviceName: name(body.data.name, pair.peerName), account: { id: this.account.profile.id },
      connectionId: pair.connectionId, accountAuthorized: true, accountProof: body.data.proof });
    if (!this.live(socket, 'viewer') || socket.pair !== pair) return;
    const pulse = async () => {
      if (socket.pair !== pair || socket.readyState !== 1 || !this.checkAccount()) return;
      const proof = await createAccountPeerProof(this.account.secret, {
        accountId: this.account.profile.id, hostId: pair.peerDeviceId, viewerId: this.ownDeviceId,
        connectionId: pair.connectionId, challenge: pair.proof.challenge, issuedAt: this.now(), counter: ++pair.counter, purpose: 'keepalive',
      });
      if (socket.pair !== pair) return;
      await this.send(socket, 'pulse', pair.peerSocketId, { connectionId: pair.connectionId, proof });
      pair.leave = await this.prepare(socket, 'leave', pair.peerSocketId, { connectionId: pair.connectionId });
    };
    socket.pulseTimer = setInterval(() => { void pulse().catch(() => {}); }, this.heartbeatMs);
    void pulse().catch(() => {});
  }
  private async endPair(socket: CloudSocket) {
    const pair = socket.pair;
    if (pair) {
      try { await this.send(socket, 'leave', pair.peerSocketId, { connectionId: pair.connectionId }); } catch { if (pair.leave) void this.publish(pair.leave).catch(() => {}); }
    }
    this.clearPair(socket, false);
  }
  expirePending(socket: CloudSocket) {
    if (!this.live(socket) || !socket.pending) return;
    if (socket.pending.leave) void this.publish(socket.pending.leave).catch(() => {});
    this.clearPair(socket, false);
    socket.emit({ type: 'error', message: 'El PC no ha respondido. Comprueba que siga conectado.' });
  }
  private clearPair(socket: CloudSocket, notify: boolean, republish = true) {
    socket.pair = null;
    socket.pending = null;
    socket.paired();
    if (socket.pulseTimer) clearInterval(socket.pulseTimer);
    socket.pulseTimer = null;
    if (notify) socket.emit({ type: 'peer-left' });
    if (socket.role === 'host' && republish) void this.publishPresence(socket, true).catch(() => {});
    else socket.role = null;
  }
  removeSocket(socket: CloudSocket, code = 1000, reason = '') {
    if (!this.sockets.delete(socket.id)) return;
    const leave = socket.pair?.leave ?? socket.pending?.leave;
    if (leave) void this.publish(leave).catch(() => {});
    if (socket.offline) void this.publish(socket.offline).catch(() => {});
    const device = this.devices.get(this.ownDeviceId);
    if (device?.replySocketId === socket.id) { device.online = false; device.busy = false; }
    this.clearPair(socket, false, false);
    socket.closed(code, reason);
    this.notify();
    this.scheduleIdle();
  }
  private lastHeartbeat = 0;
  private async tick() {
    if (!this.checkAccount()) return;
    const now = this.now();
    let changed = false;
    for (const [key, seen] of this.seen) if (now - seen > this.ttlMs) this.seen.delete(key);
    for (const device of this.devices.values()) if (device.online && device.expiresAt <= now) { device.online = false; device.busy = false; changed = true; }
    for (const socket of this.sockets.values()) {
      const pair = socket.pair;
      if (pair && socket.role === 'host' && now - pair.lastPulse > this.ttlMs) { await this.endPair(socket); socket.emit({ type: 'peer-left' }); }
      else if (pair && socket.role === 'viewer') {
        const host = this.devices.get(pair.peerDeviceId);
        if (host && (!host.online || host.expiresAt <= now)) this.clearPair(socket, true);
      }
    }
    if (now - this.lastHeartbeat >= this.heartbeatMs) {
      this.lastHeartbeat = now;
      for (const socket of this.sockets.values()) {
        if (socket.role === 'host') {
          void this.publishPresence(socket, true).catch(() => {});
          if (socket.pair) socket.pair.leave = await this.prepare(socket, 'leave', socket.pair.peerSocketId, { connectionId: socket.pair.connectionId }).catch(() => null);
        }
      }
    }
    if (changed) this.notify();
  }
  private scheduleIdle() {
    if (this.disposed || this.sockets.size || this.observers.size || this.idleTimer) return;
    this.idleTimer = setTimeout(() => { this.idleTimer = null; if (!this.sockets.size && !this.observers.size) this.dispose(); }, 5000);
  }
  close(reason = '') { this.dispose(reason); }
  dispose(reason = '') {
    if (this.disposed) return;
    // Send pre-authorized, encrypted offline messages while MQTT is still live.
    for (const socket of [...this.sockets.values()]) this.removeSocket(socket, 1000, reason);
    this.disposed = true;
    this.generation++;
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.tickTimer = null; this.idleTimer = null;
    if (typeof window !== 'undefined') window.removeEventListener('inhouse-account-changed', this.accountChanged);
    this.status = 'offline'; this.error = reason || null;
    this.rejectWaiters(); this.notify(); this.observers.clear();
    const client = this.client;
    this.client = null;
    if (client) {
      const force = setTimeout(() => { client.end(true); }, 1000);
      client.end(false, {}, () => clearTimeout(force));
    }
  }
}

let sharedHub: CloudHub | null = null;
/** Never create a second connection for directory/session users of one account. */
export function getCloudHub(account: CloudAccount, options?: CloudHubOptions): CloudHub {
  if (sharedHub && !sharedHub.closed) {
    sharedHub.updateAccount(account);
    if (!sharedHub.closed) return sharedHub;
  }
  sharedHub = new CloudHub(account, options);
  return sharedHub;
}
