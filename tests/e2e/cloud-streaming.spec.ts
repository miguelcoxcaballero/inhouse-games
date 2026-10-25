import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { Aedes } from 'aedes';
import { WebSocketServer, createWebSocketStream } from 'ws';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, randomInt } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createCloudDriveFixture, type CloudGoogleIdentity } from './cloud-google-fixture';
import { GOOGLE_TEST_PROFILE, GOOGLE_TEST_TOKEN, GOOGLE_OTHER_TEST_PROFILE, GOOGLE_OTHER_TEST_TOKEN, GOOGLE_TEST_SESSION_KEY } from './google-fixture';

const require = createRequire(import.meta.url);
const { createCloudAccountAuthority } = require('../../desktop/cloud-account.cjs');
const owner = { token: GOOGLE_TEST_TOKEN, profile: GOOGLE_TEST_PROFILE };
const guest = { token: GOOGLE_OTHER_TEST_TOKEN, profile: GOOGLE_OTHER_TEST_PROFILE };
const drive = createCloudDriveFixture();
let broker: Aedes;
let websocketServer: WebSocketServer;
let httpServer: Server;
let brokerUrl = '';
let turn: ChildProcess | undefined;
let turnDirectory = '';
let iceServers: RTCIceServer[] = [];
const packets: { topic: string; payload: string }[] = [];
const connections: { clientId: string; username: string; password: string }[] = [];
type Peer = { context: BrowserContext; page: Page; native: any; inputs: Record<string, unknown>[]; calls: Record<string, number>; requests: string[] };

async function unusedPort() {
  const listener = net.createServer();
  await new Promise<void>((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
  const port = (listener.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  return port;
}

test.beforeAll(async () => {
  // This is an actual MQTT 3.1.1 broker over an actual WebSocket connection.
  // Production encryption, signing, subscriptions and framing remain unchanged.
  broker = await Aedes.createBroker();
  broker.authenticate = (client, username, password, complete) => {
    // Observe the MQTT CONNECT bytes at the actual broker boundary as well as
    // publishes. This is Aedes' ordinary anonymous/public acceptance policy.
    connections.push({ clientId: client.id, username: username ?? '', password: password?.toString() ?? '' });
    complete(null, true);
  };
  broker.on('publish', (packet, client) => {
    if (client && !packet.topic.startsWith('$SYS/')) packets.push({ topic: packet.topic, payload: packet.payload.toString() });
  });
  httpServer = createServer();
  websocketServer = new WebSocketServer({ server: httpServer, path: '/mqtt' });
  websocketServer.on('connection', socket => {
    const stream = createWebSocketStream(socket);
    stream.on('error', () => {});
    broker.handle(stream);
  });
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  brokerUrl = `ws://127.0.0.1:${(httpServer.address() as net.AddressInfo).port}/mqtt`;

  const root = path.resolve(process.cwd(), '..', '.tools', 'coturn');
  const system = (process.env.PATH ?? '').split(path.delimiter).map(directory => path.join(directory, 'turnserver')).find(existsSync);
  const executable = process.env.COTURN_BIN || system || path.join(root, 'usr', 'bin', 'turnserver');
  if (!existsSync(executable)) throw new Error('Cloud media E2E requires real coturn; see docs/TESTING.md.');
  const port = await unusedPort();
  const relay = randomInt(30000, 44000);
  const username = 'inhouse-cloud-e2e';
  const credential = randomBytes(24).toString('base64url');
  turnDirectory = await mkdtemp(path.join(os.tmpdir(), 'inhouse-cloud-turn-'));
  const args = ['-n', '--listening-ip=127.0.0.1', '--relay-ip=127.0.0.1', `--listening-port=${port}`,
    `--min-port=${relay}`, `--max-port=${relay + 100}`, '--no-udp', '--no-tls', '--no-dtls', '--no-cli',
    '--allow-loopback-peers', '--lt-cred-mech', '--realm=inhouse-cloud-e2e', `--user=${username}:${credential}`,
    `--pidfile=${path.join(turnDirectory, 'coturn.pid')}`, `--log-file=${path.join(turnDirectory, 'coturn.log')}`, '--no-stdout-log'];
  const libraries = process.env.COTURN_LIB_DIR || (executable.startsWith(root) ? path.join(root, 'usr', 'lib', 'x86_64-linux-gnu') : '');
  turn = libraries ? spawn('/lib64/ld-linux-x86-64.so.2', ['--library-path', libraries, executable, ...args], { stdio: 'ignore' })
    : spawn(executable, args, { stdio: 'ignore' });
  await expect.poll(() => new Promise<boolean>((resolve) => {
    if (turn?.exitCode != null) throw new Error('The real TURN fixture stopped unexpectedly.');
    const socket = net.createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => { socket.destroy(); resolve(false); });
  })).toBe(true);
  iceServers = [{ urls: `turn:127.0.0.1:${port}?transport=tcp`, username, credential }];
});

test.afterAll(async () => {
  for (const socket of websocketServer?.clients ?? []) socket.terminate();
  if (websocketServer) await new Promise<void>(resolve => websocketServer.close(() => resolve()));
  if (broker) await new Promise<void>(resolve => broker.close(() => resolve()));
  if (httpServer) await new Promise<void>(resolve => httpServer.close(() => resolve()));
  turn?.kill('SIGTERM');
  if (turn && turn.exitCode === null) await new Promise<void>(resolve => {
    const timer = setTimeout(() => { turn?.kill('SIGKILL'); resolve(); }, 3000);
    turn!.once('exit', () => { clearTimeout(timer); resolve(); });
  });
  if (turnDirectory) await rm(turnDirectory, { recursive: true, force: true });
});

async function peer(browser: Browser, hosting: boolean, identity: CloudGoogleIdentity = owner, web = false): Promise<Peer> {
  const context = await browser.newContext();
  if (web) await context.grantPermissions(['local-network-access'], { origin: 'https://miguelcoxcaballero.github.io' });
  const page = await context.newPage();
  const requests: string[] = [];
  page.on('request', request => {
    const url = new URL(request.url());
    requests.push(`${url.origin}${url.pathname}`);
  });
  const calls: Record<string, number> = { login: 0, restore: 0, enable: 0, authorize: 0, renew: 0 };
  const inputs: Record<string, unknown>[] = [];
  let control = false;
  const notify = (kind: string, reason: string) => {
    control = false;
    void page.evaluate(({ kind, reason }) => {
      for (const callback of (window as any).__cloudHarness?.listeners[kind] ?? []) callback(reason);
    }, { kind, reason }).catch(() => {});
  };
  // Actual desktop authority, including HMAC, challenge binding, replay checks,
  // account expiry and renewable input leases. Only Electron IPC/OS is replaced.
  const authority = createCloudAccountAuthority({
    file: null,
    onHostingRevoked: (reason: string) => notify('hosting', reason),
    onPeerRevoked: (reason: string) => notify('peer', reason),
  });
  try {
    await drive.install(page, identity);
    if (web) await page.route('https://miguelcoxcaballero.github.io/**', async route => {
      // Serve the actual app/ES modules under its normal HTTPS Pages origin.
      // Only static delivery is mapped locally; Google and MQTT remain separate
      // providers, and Cloud selection uses the real github.io hostname.
      const incoming = new URL(route.request().url());
      const pathname = incoming.pathname.replace(/^\/inhouse-games(?=\/|$)/, '') || '/';
      const response = await route.fetch({ url: `http://127.0.0.1:5173${pathname}${incoming.search}` });
      await route.fulfill({ response });
    });
    if (!web) await page.exposeBinding('__cloudNative', async (_source, action: string, value: any) => {
      if (action === 'record') { calls.login++; return authority.recordSession(value.realm, value.profile); }
      if (action === 'restore') { calls.restore++; return authority.restore(); }
      if (action === 'forget') { control = false; await authority.forget(); return; }
      if (action === 'enable') { calls.enable++; return authority.enable(value); }
      if (action === 'capture') return authority.canCapture() ? { sourceId: 'cloud-e2e-primary-screen' } : null;
      if (action === 'authorize') { const allowed = await authority.authorizePeer(value); if (allowed) calls.authorize++; return allowed; }
      if (action === 'renew') { const allowed = await authority.renewPeer(value); if (allowed) calls.renew++; return allowed; }
      if (action === 'control') { control = value === true && authority.canControl(); return control; }
      if (action === 'input') { if (control && authority.canControl()) inputs.push(structuredClone(value)); return; }
      if (action === 'end') { control = false; authority.endPeer(); return; }
      if (action === 'disable') { control = false; authority.disable(); return; }
      throw new Error('Unknown native boundary operation');
    });
    await page.addInitScript(({ identity, hosting, iceServers, web }) => {
      const w = window as any;
      localStorage.removeItem('inhouse.signalingUrl');
      localStorage.removeItem('inhouse.serviceToken');
      localStorage.setItem(`inhouse.link.account-hosting:${identity.profile.id}`, String(hosting));
      localStorage.setItem('inhouse.link.settings', JSON.stringify({ resolution: 'native', fps: 30, bitrate: 5, codec: 'auto', audio: true, adaptive: false }));
      const native = (action: string, value?: unknown) => w.__cloudNative(action, value);
      const harness: any = { source: null, timer: null, audio: null, peers: [], listeners: { hosting: [], peer: [] }, captures: 0 };
      w.__cloudHarness = harness;
      const NativePeer = RTCPeerConnection;
      w.RTCPeerConnection = class extends NativePeer {
        constructor(configuration: RTCConfiguration = {}) {
          // Native ICE settings exercise a real authenticated TURN relay on every
          // environment. Peer states, SDP, DTLS, media and statistics stay native.
          super({ ...configuration, iceServers, iceTransportPolicy: 'relay' });
          harness.peers.push(this);
        }
      };
      if (web) return;
      w.inhouseDesktop = {
        platform: 'win32', version: 'cloud-e2e-boundary',
        async googleSignIn() {
          const helperUrl = '/server/drive-realm.mjs';
          const helper = await import(helperUrl);
          const realm = await helper.obtainDriveRealm(identity.token, identity.profile);
          const saved = await native('record', { realm, profile: identity.profile });
          return { accessToken: identity.token, expiresAt: Date.now() + 3600_000,
            cloudRealm: realm, profile: identity.profile, cloudSessionExpiresAt: saved.expiresAt };
        },
        cloudAccountRestore: () => native('restore'), cloudAccountForget: () => native('forget'),
        googleSignOut: () => native('forget'),
        getComputerName: async () => hosting ? 'PC Murcia privado' : 'Portátil Valencia',
        enableCloudAccountHosting: (identity: unknown) => native('enable', identity),
        getAccountCaptureSource: () => native('capture'),
        authorizeCloudPeer: (proof: unknown) => native('authorize', proof),
        renewCloudPeer: (proof: unknown) => native('renew', proof),
        setControlEnabled: (enabled: boolean) => native('control', enabled),
        injectInput: (input: unknown) => { void native('input', input); }, releaseInputs() {},
        endAccountPeer: () => { void native('end'); },
        disableAccountHosting: () => { void native('disable'); }, captureEnded: () => { void native('disable'); },
        onAccountHostingRevoked(callback: (reason: string) => void) { harness.listeners.hosting.push(callback); return () => {}; },
        onAccountPeerRevoked(callback: (reason: string) => void) { harness.listeners.peer.push(callback); return () => {}; },
      };
      Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', { configurable: true,
        value: async () => { throw new Error('Cloud account capture must not use a screen-picker gesture.'); } });
      Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: async (constraints: any) => {
        if (constraints?.video?.mandatory?.chromeMediaSourceId !== 'cloud-e2e-primary-screen') throw new Error('Unverified capture source');
        const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
        const drawing = canvas.getContext('2d')!;
        let frame = 0;
        const paint = () => {
          frame++;
          drawing.fillStyle = '#101d16'; drawing.fillRect(0, 0, 640, 360);
          drawing.fillStyle = '#94e8ab'; drawing.fillRect(frame * 9 % 560, 140, 80, 80);
          drawing.font = '30px sans-serif'; drawing.fillText(`Inhouse privado · ${frame}`, 24, 65);
        };
        paint(); harness.timer = setInterval(paint, 1000 / 30);
        const stream = canvas.captureStream(30);
        const audio = new AudioContext();
        const oscillator = audio.createOscillator();
        const gain = audio.createGain(); gain.gain.value = 0.001;
        const destination = audio.createMediaStreamDestination();
        oscillator.connect(gain).connect(destination); oscillator.start();
        await audio.resume(); stream.addTrack(destination.stream.getAudioTracks()[0]);
        harness.source = stream; harness.audio = audio; harness.captures++;
        return stream;
      } });
    }, { identity, hosting, iceServers, web });
    await page.goto(web ? 'https://miguelcoxcaballero.github.io/inhouse-games/#/client' : '/#/client');
    await expect(page.getByTestId('login-google')).toBeVisible();
    // Configure the normal shared hub on the login page, before the authenticated
    // React client mounts. No app source, MQTT replies or account data are replaced.
    await page.evaluate(async (brokerUrl) => {
      // Vite can append an HMR timestamp. Import the exact module already loaded
      // by App, so this normal singleton configuration never creates a duplicate.
      const loaded = (name: string) => {
        const url = performance.getEntriesByType('resource').map(entry => entry.name)
          .filter(url => new URL(url).pathname === `/src/lib/${name}.ts`).at(-1);
        if (!url) throw new Error(`The actual App dependency ${name} was not loaded.`);
        return url;
      };
      const { getCloudAccount } = await import(loaded('cloud-account'));
      const { getCloudHub } = await import(loaded('cloud-signal'));
      window.addEventListener('inhouse-account-changed', () => {
        const account = getCloudAccount();
        if (account) {
          const hub = getCloudHub(account, { brokerUrl, heartbeatMs: 1000, presenceTtlMs: 5000 });
          (window as any).__cloudHub = hub;
          hub.subscribeDevicesState((state: unknown) => { (window as any).__cloudDirectory = state; });
        }
      });
    }, brokerUrl);
    await page.getByTestId('login-google').click();
    await expect(page.getByTestId('account-device-list')).toBeVisible();
    await expect.poll(() => page.evaluate(() => (window as any).__cloudDirectory?.status)).toBe('connected');
    return { context, page, native: authority, inputs, calls, requests };
  } catch (error) {
    await authority.forget().catch(() => {});
    await context.close().catch(() => {});
    throw error;
  }
}

async function cleanup(peers: Peer[]) {
  for (const peer of peers) {
    await peer.page.evaluate(async () => {
      const harness = (window as any).__cloudHarness;
      (window as any).__cloudHub?.close();
      clearInterval(harness.timer);
      harness.source?.getTracks().forEach((track: MediaStreamTrack) => track.stop());
      await harness.audio?.close();
    }).catch(() => {});
    await peer.native.forget();
    await peer.context.close();
  }
}

async function expectMedia(viewer: Peer) {
  const video = viewer.page.getByTestId('remote-video');
  await expect(video).toBeVisible();
  await expect.poll(() => video.evaluate(element => (element as HTMLVideoElement).videoWidth)).toBe(640);
  await expect.poll(() => video.evaluate(element => (element as HTMLVideoElement).getVideoPlaybackQuality().totalVideoFrames)).toBeGreaterThan(3);
  await expect.poll(() => viewer.page.evaluate(async () => {
    const peers: RTCPeerConnection[] = (window as any).__cloudHarness.peers;
    const reports = await Promise.all(peers.filter(peer => peer.connectionState === 'connected').map(peer => peer.getStats()));
    return reports.flatMap(report => Array.from(report.values())).filter(report => report.type === 'inbound-rtp' && report.kind === 'audio')
      .reduce((total, report) => total + (report.bytesReceived ?? 0), 0);
  })).toBeGreaterThan(0);
  return video;
}

test('private Google accounts discover and reconnect without a server, with encrypted MQTT and real media/input', async ({ browser }) => {
  const peers: Peer[] = [];
  const packetStart = packets.length;
  const connectionStart = connections.length;
  try {
    const host = await peer(browser, true); peers.push(host);
    const viewer = await peer(browser, false); peers.push(viewer);
    const cards = viewer.page.locator('[data-testid^="account-device-card-"]');
    await expect(cards).toHaveCount(1);
    await expect(cards.first()).toContainText('PC Murcia privado');
    const id = (await cards.first().getAttribute('data-testid'))!.replace('account-device-card-', '');
    const connect = viewer.page.getByTestId(`account-device-connect-${id}`);
    expect(host.calls.enable).toBe(1);
    expect(host.native.canControl()).toBe(false);
    await connect.click();
    const video = await expectMedia(viewer);
    await expect.poll(() => host.calls.authorize).toBe(1);
    expect(host.native.canControl()).toBe(true);
    await expect(host.page.getByTestId('approve-once')).toHaveCount(0);
    await video.click(); await viewer.page.keyboard.press('KeyW');
    await expect.poll(() => host.inputs.filter(input => input.kind === 'key' && input.code === 'KeyW').length).toBe(2);
    await expect.poll(() => host.calls.renew, { timeout: 15000 }).toBeGreaterThan(0);
    const captureId = await host.page.evaluate(() => (window as any).__cloudHarness.source.getVideoTracks()[0].id);
    await viewer.page.keyboard.press('Control+Alt+Shift+KeyQ');
    await expect(viewer.page.getByTestId('session-stage')).toHaveCount(0);
    await expect.poll(() => host.native.canControl()).toBe(false);
    await expect(connect).toBeEnabled();
    await connect.click();
    await expectMedia(viewer);
    await expect.poll(() => host.calls.authorize).toBe(2);
    expect(await host.page.evaluate(() => (window as any).__cloudHarness.source.getVideoTracks()[0].id)).toBe(captureId);

    const realm = drive.realmFor(owner.profile.id)!;
    expect(drive.files.filter(file => file.ownerId === owner.profile.id)).toHaveLength(1);
    const wire = packets.slice(packetStart);
    const handshakes = connections.slice(connectionStart);
    expect(handshakes).toHaveLength(2);
    for (const handshake of handshakes) {
      expect(handshake.username).toBe('public');
      expect(handshake.password).toBe('public');
      for (const privateValue of [owner.token, owner.profile.id, owner.profile.name, owner.profile.email, realm.secret]) {
        expect(JSON.stringify(handshake)).not.toContain(privateValue);
      }
    }
    expect(wire.length).toBeGreaterThan(5);
    for (const packet of wire) {
      expect(Object.keys(JSON.parse(packet.payload)).sort()).toEqual(['ciphertext', 'nonce', 'v']);
      for (const privateValue of [owner.token, owner.profile.id, owner.profile.name, owner.profile.email, realm.secret, 'PC Murcia privado']) {
        expect(`${packet.topic} ${packet.payload}`).not.toContain(privateValue);
      }
    }
    for (const participant of peers) expect(await participant.page.evaluate(() => JSON.stringify(localStorage))).not.toContain(owner.token);

    await viewer.page.keyboard.press('Control+Alt+Shift+KeyQ');
    await expect(viewer.page.getByTestId('session-stage')).toHaveCount(0);
    await host.page.getByTestId('account-menu').click();
    await host.page.getByTestId('account-signout').click();
    await expect(host.page.getByTestId('login-google')).toBeVisible();
    await expect.poll(() => viewer.page.evaluate((id) => (window as any).__cloudDirectory?.devices.find((device: any) => device.deviceId === id)?.online ?? false, id)).toBe(false);
    expect(host.native.canCapture()).toBe(false);
    expect(host.native.canControl()).toBe(false);
  } finally { await cleanup(peers); }
});

test('another Google account has a different private realm and cannot discover or join the owner computer', async ({ browser }) => {
  const peers: Peer[] = [];
  const packetStart = packets.length;
  try {
    const host = await peer(browser, true, owner); peers.push(host);
    const viewer = await peer(browser, true, guest); peers.push(viewer);
    await expect.poll(() => host.calls.enable).toBe(1);
    await expect.poll(() => viewer.calls.enable).toBe(1);
    const ownerRealm = drive.realmFor(owner.profile.id)!;
    const otherRealm = drive.realmFor(guest.profile.id)!;
    expect(ownerRealm.secret).not.toBe(otherRealm.secret);
    expect(ownerRealm.fileId).not.toBe(otherRealm.fileId);
    await expect(viewer.page.locator('[data-testid^="account-device-card-"]')).toHaveCount(0);
    const id = await host.page.evaluate(() => (window as any).__cloudHub.identity);
    const { deriveRealmTopic, encryptRealmPacket, decryptRealmPacket } = await import('../../server/drive-realm.mjs');
    const ownerTopic = await deriveRealmTopic(ownerRealm.secret);
    const otherTopic = await deriveRealmTopic(otherRealm.secret);
    await expect.poll(() => packets.slice(packetStart).some(packet => packet.topic.startsWith(`${otherTopic}/presence/`))).toBe(true);
    const legitimate = packets.slice(packetStart).filter(packet => packet.topic.startsWith(`${otherTopic}/presence/`)).at(-1)!;
    const validOtherAccountPresence = await decryptRealmPacket(otherRealm.secret, legitimate.topic, JSON.parse(legitimate.payload)) as any;
    expect(validOtherAccountPresence.body.kind).toBe('presence');
    expect(validOtherAccountPresence.body.data.online).toBe(true);
    expect(validOtherAccountPresence.signature).toMatch(/^[A-Za-z0-9_-]{86}$/);
    const topic = `${ownerTopic}/presence/${validOtherAccountPresence.body.from}`;
    // A broker can forward arbitrary ciphertext into the owner's subscription.
    // The entire body and ECDSA signature are valid, produced by the actual guest
    // hub. Only its encryption key differs, so malformed input cannot mask a leak.
    const foreign = JSON.stringify(await encryptRealmPacket(otherRealm.secret, topic, validOtherAccountPresence));
    await host.page.evaluate(({ topic, payload }) => {
      const hub = (window as any).__cloudHub;
      (window as any).__foreignPacketProcessed = false;
      const observed = (receivedTopic: string, bytes: Uint8Array) => {
        if (receivedTopic !== topic || new TextDecoder().decode(bytes) !== payload) return;
        hub.client.off('message', observed);
        // The producer's existing message listener has already appended this
        // actual packet to its real serial decryption/verification queue.
        void hub.incoming.then(() => { (window as any).__foreignPacketProcessed = true; });
      };
      hub.client.on('message', observed);
    }, { topic, payload: foreign });
    await new Promise<void>((resolve, reject) => broker.publish({ cmd: 'publish', dup: false, topic, payload: Buffer.from(foreign), qos: 1, retain: false },
      (error?: Error | null) => error ? reject(error) : resolve()));
    await expect.poll(() => host.page.evaluate(() => (window as any).__foreignPacketProcessed)).toBe(true);
    expect(await host.page.evaluate(() => (window as any).__cloudHub.snapshot.devices.filter((device: any) => device.online).map((device: any) => device.deviceId))).toEqual([id]);
    const result = await viewer.page.evaluate(async (id) => {
      const url = performance.getEntriesByType('resource').map(entry => entry.name)
        .filter(url => new URL(url).pathname === '/src/lib/session.ts').at(-1)!;
      const { LinkSession, DEFAULT_SETTINGS } = await import(url);
      const session = new LinkSession(() => {});
      await session.join(id, DEFAULT_SETTINGS);
      return new Promise<{ status: string; error: string | null }>((resolve) => {
        const timer = setInterval(() => {
          if (session.state.status !== 'error') return;
          clearInterval(timer);
          const result = { status: session.state.status, error: session.state.error };
          session.destroy(); resolve(result);
        }, 20);
      });
    }, id);
    expect(result.status).toBe('error');
    expect(result.error).toBeTruthy();
    expect(host.calls.authorize).toBe(0);
    expect(host.native.canControl()).toBe(false);
    expect(await viewer.page.evaluate(() => (window as any).__cloudHarness.peers.length)).toBe(0);
  } finally { await cleanup(peers); }
});

test('the Pages web client signs in through Google GIS and Drive and streams from Windows without a backend or native bridge', async ({ browser }) => {
  const peers: Peer[] = [];
  try {
    const host = await peer(browser, true, owner); peers.push(host);
    const viewer = await peer(browser, false, owner, true); peers.push(viewer);
    expect(new URL(viewer.page.url()).origin).toBe('https://miguelcoxcaballero.github.io');
    expect(await viewer.page.evaluate(() => typeof (window as any).inhouseDesktop)).toBe('undefined');
    expect(viewer.calls).toEqual({ login: 0, restore: 0, enable: 0, authorize: 0, renew: 0 });
    expect(await viewer.page.evaluate(() => (window as any).__googleTokenRequests.length)).toBe(1);
    const session = await viewer.page.evaluate(key => JSON.parse(localStorage.getItem(key)!), GOOGLE_TEST_SESSION_KEY);
    expect(session.kind).toBe('cloud');
    expect(session.accessToken).toMatch(/^ild_[A-Za-z0-9_-]{43}$/);
    expect(session.profile.id).toBe(owner.profile.id);
    expect(viewer.requests.some(url => url.startsWith('https://www.googleapis.com/drive/v3/files'))).toBe(true);
    expect(viewer.requests.filter(url => new URL(url).pathname.startsWith('/api/'))).toHaveLength(0);
    const cards = viewer.page.locator('[data-testid^="account-device-card-"]');
    await expect(cards).toHaveCount(1);
    const id = (await cards.first().getAttribute('data-testid'))!.replace('account-device-card-', '');
    await viewer.page.getByTestId(`account-device-connect-${id}`).click();
    const video = await expectMedia(viewer);
    await expect.poll(() => host.calls.authorize).toBe(1);
    await expect(host.page.getByTestId('approve-once')).toHaveCount(0);
    await video.click(); await viewer.page.keyboard.press('KeyD');
    await expect.poll(() => host.inputs.filter(input => input.kind === 'key' && input.code === 'KeyD').length).toBe(2);
    await viewer.page.keyboard.press('Control+Alt+Shift+KeyQ');
    await expect(viewer.page.getByTestId('session-stage')).toHaveCount(0);
    await expect.poll(() => host.native.canControl()).toBe(false);
    await viewer.page.getByTestId('account-menu').click();
    await viewer.page.getByTestId('account-signout').click();
    await expect(viewer.page.getByTestId('login-google')).toBeVisible();
    expect(await viewer.page.evaluate(key => localStorage.getItem(key), GOOGLE_TEST_SESSION_KEY)).toBeNull();
    expect(await viewer.page.evaluate(() => localStorage.getItem('inhouse.link.cloud-account.v1'))).toBeNull();
  } finally { await cleanup(peers); }
});
