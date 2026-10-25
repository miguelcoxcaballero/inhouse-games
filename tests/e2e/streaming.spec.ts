import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, randomInt } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { installGoogleFixture, GOOGLE_TEST_PROFILE, GOOGLE_TEST_TOKEN } from './google-fixture';

type Peer = { context: BrowserContext; page: Page };
let signalingUrl = '';
const serviceToken = randomBytes(24).toString('base64url');
let signaling: { listen(): Promise<{ port: number }>; close(): Promise<void> } | undefined;
let turn: ChildProcess | undefined;
let turnDirectory = '';
let createSignalingServer: any;
let signalingOptions: Record<string, unknown>;

async function unusedPort() {
  const listener = net.createServer();
  await new Promise<void>((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
  const port = (listener.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  return port;
}

test.beforeAll(async () => {
  // The managed Chromium policy forbids non-proxied UDP. Exercise a real TURN
  // TCP relay without overriding that policy. Both browser fixtures explicitly
  // select relay ICE so CI with direct UDP available exercises the same path.
  const systemTurn = (process.env.PATH ?? '').split(path.delimiter).map((directory) => path.join(directory, 'turnserver')).find(existsSync);
  const unpackedRoot = path.resolve(process.cwd(), '..', '.tools', 'coturn');
  const executable = process.env.COTURN_BIN || systemTurn || path.join(unpackedRoot, 'usr', 'bin', 'turnserver');
  if (!existsSync(executable)) throw new Error('These WebRTC tests require coturn. Install coturn or set COTURN_BIN. See docs/TESTING.md.');
  const turnPort = await unusedPort();
  const relayBase = randomInt(30000, 44000);
  const username = 'inhouse-e2e';
  const credential = randomBytes(24).toString('base64url');
  turnDirectory = await mkdtemp(path.join(os.tmpdir(), 'inhouse-turn-e2e-'));
  const args = ['-n', '--listening-ip=127.0.0.1', '--relay-ip=127.0.0.1', `--listening-port=${turnPort}`,
    `--min-port=${relayBase}`, `--max-port=${relayBase + 100}`, '--no-udp', '--no-tls', '--no-dtls', '--no-cli',
    '--allow-loopback-peers', '--lt-cred-mech', '--realm=inhouse-e2e', `--user=${username}:${credential}`,
    `--pidfile=${path.join(turnDirectory, 'coturn.pid')}`, `--log-file=${path.join(turnDirectory, 'coturn.log')}`, '--no-stdout-log'];
  const libraries = process.env.COTURN_LIB_DIR || (executable.startsWith(unpackedRoot) ? path.join(unpackedRoot, 'usr', 'lib', 'x86_64-linux-gnu') : '');
  turn = libraries
    ? spawn('/lib64/ld-linux-x86-64.so.2', ['--library-path', libraries, executable, ...args], { stdio: 'ignore' })
    : spawn(executable, args, { stdio: 'ignore' });
  let turnError: Error | null = null;
  turn.once('error', (error) => { turnError = error; });
  await expect.poll(async () => {
    if (turnError) throw turnError;
    if (turn?.exitCode != null) throw new Error(`The local coturn fixture exited with code ${turn.exitCode}.`);
    return new Promise<boolean>((resolve) => {
      const socket = net.createConnection({ host: '127.0.0.1', port: turnPort });
      socket.once('connect', () => { socket.destroy(); resolve(true); });
      socket.once('error', () => { socket.destroy(); resolve(false); });
    });
  }).toBe(true);
  const serverModule = '../../server/index.mjs';
  createSignalingServer = (await import(serverModule)).createSignalingServer;
  signalingOptions = { port: 0, host: '127.0.0.1', sessionStorePath: path.join(turnDirectory, 'account-sessions.json'), googleVerifier: async (token: string) => {
    if (token !== GOOGLE_TEST_TOKEN) throw new Error('Invalid test identity token');
    return { ...GOOGLE_TEST_PROFILE, expiresAt: Date.now() + 3600_000 };
  }, env: {
    NODE_ENV: 'development', ALLOWED_ORIGINS: 'http://127.0.0.1:5173', SERVICE_TOKEN: serviceToken,
    TURN_URLS: `turn:127.0.0.1:${turnPort}?transport=tcp`, TURN_USERNAME: username, TURN_CREDENTIAL: credential,
  } };
  signaling = createSignalingServer(signalingOptions);
  const address = await signaling!.listen();
  signalingOptions.port = address.port;
  signalingUrl = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
  await signaling?.close();
  turn?.kill('SIGTERM');
  if (turn && turn.exitCode === null) await new Promise<void>((resolve) => {
    const timer = setTimeout(() => { turn?.kill('SIGKILL'); resolve(); }, 3000);
    turn!.once('exit', () => { clearTimeout(timer); resolve(); });
  });
  if (turnDirectory) await rm(turnDirectory, { recursive: true, force: true });
});

async function requireTurnRelay(page: Page) {
  await page.addInitScript(() => {
    const NativeRTCPeerConnection = window.RTCPeerConnection;
    // This remains the browser's native WebRTC implementation: only its real
    // ICE configuration is constrained. Media, SDP, transport and stats are not
    // simulated. Otherwise CI may choose a direct route and never test TURN.
    window.RTCPeerConnection = class extends NativeRTCPeerConnection {
      constructor(configuration: RTCConfiguration = {}) {
        super({ ...configuration, iceTransportPolicy: 'relay' });
      }
    };
  });
}

/** Only screen acquisition and the Windows boundary are substituted. WebRTC,
 * signaling, encryption, data channels, encoding, decoding and stats stay real. */
async function peer(browser: Browser, native = false, allowControl = true): Promise<Peer> {
  // Isolated browser storage models separate physical participants.
  const context = await browser.newContext({ permissions: ['microphone', 'camera'] });
  const page = await context.newPage();
  await requireTurnRelay(page);
  await installGoogleFixture(page, { signedIn: true, mockServiceSession: false });
  await page.addInitScript(({ signalingUrl, serviceToken }) => {
    localStorage.setItem('inhouse.signalingUrl', signalingUrl);
    localStorage.setItem('inhouse.serviceToken', serviceToken);
  }, { signalingUrl, serviceToken });
  await page.goto('/#/client');
  await expect(page.getByTestId('join-code')).toBeVisible();
  await page.evaluate(async ({ native, allowControl, signalingUrl, serviceToken }) => {
    localStorage.setItem('inhouse.signalingUrl', signalingUrl);
    localStorage.setItem('inhouse.serviceToken', serviceToken);
    const w = window as any;
    const moduleUrl = '/src/lib/session.ts';
    const { LinkSession, DEFAULT_SETTINGS } = await import(moduleUrl);
    const video = document.createElement('video');
    video.id = 'e2e-remote-video';
    video.autoplay = true;
    video.muted = true;
    video.playsInline = true;
    video.style.cssText = 'position:fixed;bottom:0;right:0;width:320px;height:180px;z-index:999999;pointer-events:none';
    document.body.append(video);

    const harness: any = {
      settings: { ...DEFAULT_SETTINGS, resolution: 'native', fps: 30, bitrate: 4, codec: 'auto', adaptive: false },
      latest: null, inputs: [], control: false, controlRequests: 0, releases: 0,
      capturesEnded: 0, requestCounts: [], source: null, canvasTimer: null,
      audioContext: null, video, decodedCallbacks: 0,
    };
    w.__linkHarness = harness;
    const countFrames = () => {
      harness.decodedCallbacks++;
      if (w.__linkHarness) video.requestVideoFrameCallback(countFrames);
    };
    video.requestVideoFrameCallback(countFrames);

    if (native) {
      w.inhouseDesktop = {
        platform: 'win32', version: 'e2e-boundary',
        async setControlEnabled(enabled: boolean) {
          if (enabled && allowControl && !harness.control) harness.controlRequests++;
          harness.control = enabled && allowControl;
          return harness.control;
        },
        injectInput(event: Record<string, unknown>) {
          if (harness.control) harness.inputs.push(structuredClone(event));
        },
        releaseInputs() { harness.releases++; },
        captureEnded() { harness.capturesEnded++; harness.control = false; },
      };
      Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', {
        configurable: true,
        value: async () => {
          const canvas = document.createElement('canvas');
          canvas.width = 640;
          canvas.height = 360;
          const drawing = canvas.getContext('2d')!;
          let frame = 0;
          const paint = () => {
            frame++;
            drawing.fillStyle = `hsl(${frame * 3 % 360} 50% 20%)`;
            drawing.fillRect(0, 0, 640, 360);
            drawing.fillStyle = '#c8f36b';
            drawing.fillRect(frame * 11 % 560, frame * 7 % 280, 80, 80);
            drawing.font = '32px sans-serif';
            drawing.fillText(`Inhouse · frame ${frame}`, 30, 70);
          };
          paint();
          harness.canvasTimer = setInterval(paint, 1000 / 30);
          const source = canvas.captureStream(30);
          const audioContext = new AudioContext();
          const oscillator = audioContext.createOscillator();
          const gain = audioContext.createGain();
          const destination = audioContext.createMediaStreamDestination();
          gain.gain.value = 0.001;
          oscillator.frequency.value = 220;
          oscillator.connect(gain).connect(destination);
          oscillator.start();
          await audioContext.resume();
          source.addTrack(destination.stream.getAudioTracks()[0]);
          harness.source = source;
          harness.audioContext = audioContext;
          return source;
        },
      });
    }
    harness.session = new LinkSession((state: any) => {
      harness.latest = state;
      harness.requestCounts.push(state.requests.length);
      if (state.remoteStream && video.srcObject !== state.remoteStream) {
        video.srcObject = state.remoteStream;
        void video.play();
      }
    });
  }, { native, allowControl, signalingUrl, serviceToken });
  return { context, page };
}

async function cleanup(peers: Peer[]) {
  await Promise.all(peers.map(async ({ context, page }) => {
    await page.evaluate(async () => {
      const w = window as any;
      const harness = w.__linkHarness ?? w.__uiHarness;
      if (!harness) return;
      harness.session?.destroy();
      clearInterval(harness.canvasTimer);
      harness.source?.getTracks().forEach((track: MediaStreamTrack) => track.stop());
      if (harness.audioContext) await harness.audioContext.close();
      delete w.__linkHarness;
      delete w.__uiHarness;
    }).catch(() => {});
    await context.close().catch(() => {});
  }));
}

async function hostAndRequest(host: Peer, viewer: Peer) {
  await host.page.evaluate(() => {
    const h = (window as any).__linkHarness;
    return h.session.host(h.settings);
  });
  await expect.poll(() => host.page.evaluate(() => (window as any).__linkHarness.session.state.status)).toBe('hosting');
  const code = await host.page.evaluate(() => (window as any).__linkHarness.session.state.code);
  await viewer.page.evaluate((code) => {
    const h = (window as any).__linkHarness;
    return h.session.join(code, h.settings, 'Portátil de pruebas');
  }, code);
  await expect.poll(() => host.page.evaluate(() => (window as any).__linkHarness.session.state.requests.length)).toBe(1);
  await expect.poll(() => viewer.page.evaluate(() => (window as any).__linkHarness.session.state.status)).toBe('pending');
}

async function approve(host: Peer, viewer: Peer, remember = false) {
  await host.page.evaluate((remember) => {
    const h = (window as any).__linkHarness;
    h.session.approve(h.session.state.requests[0].id, true, remember);
  }, remember);
  try {
    await expect.poll(() => viewer.page.evaluate(() => (window as any).__linkHarness.session.state.status)).toBe('connected');
  } catch (error) {
    const diagnostics = await Promise.all([host, viewer].map(({ page }) => page.evaluate(async () => {
      const session = (window as any).__linkHarness.session;
      const pc = session.peer as RTCPeerConnection | null;
      const reports = pc ? Array.from((await pc.getStats()).values()) : [];
      return {
        role: session.state.role, status: session.state.status, error: session.state.error,
        connection: pc?.connectionState, signaling: pc?.signalingState, ice: pc?.iceConnectionState,
        gathering: pc?.iceGatheringState, localDescription: !!pc?.localDescription, remoteDescription: !!pc?.remoteDescription,
        candidates: reports.filter((report: any) => ['local-candidate', 'remote-candidate', 'candidate-pair'].includes(report.type))
          .map((report: any) => ({ type: report.type, state: report.state, candidateType: report.candidateType, protocol: report.protocol, nominated: report.nominated, bytesSent: report.bytesSent, bytesReceived: report.bytesReceived })),
      };
    })));
    throw new Error(`${String(error)}\nPeer diagnostics: ${JSON.stringify(diagnostics)}`);
  }
  await expect.poll(() => host.page.evaluate(() => (window as any).__linkHarness.session.state.status)).toBe('connected');
  await expect.poll(() => viewer.page.evaluate(() => {
    const video = (window as any).__linkHarness.video as HTMLVideoElement;
    return video.videoWidth > 0 && video.videoHeight > 0;
  })).toBe(true);
}

async function maxSenderBitrate(host: Peer) {
  return host.page.evaluate(() => {
    const connection = (window as any).__linkHarness.session.peer as RTCPeerConnection;
    return connection.getSenders().find((sender) => sender.track?.kind === 'video')?.getParameters().encodings[0]?.maxBitrate;
  });
}

async function uiPeer(browser: Browser, native: boolean): Promise<Peer> {
  const context = await browser.newContext({ permissions: ['microphone', 'camera'] });
  const page = await context.newPage();
  await requireTurnRelay(page);
  await installGoogleFixture(page, { signedIn: true, mockServiceSession: false });
  await page.addInitScript(({ native, signalingUrl, serviceToken }) => {
    const w = window as any;
    localStorage.setItem('inhouse.signalingUrl', signalingUrl);
    localStorage.setItem('inhouse.serviceToken', serviceToken);
    localStorage.setItem('inhouse.link.settings', JSON.stringify({ resolution: 'native', fps: 30, bitrate: 10, codec: 'auto', audio: true, adaptive: false }));
    const harness: any = { inputs: [], control: false, capturesEnded: 0, releases: 0, source: null, canvasTimer: null, audioContext: null };
    w.__uiHarness = harness;
    if (!native) return;
    w.inhouseDesktop = {
      platform: 'win32', version: 'e2e-boundary',
      async setControlEnabled(enabled: boolean) { harness.control = enabled; return enabled; },
      injectInput(event: Record<string, unknown>) { if (harness.control) harness.inputs.push(structuredClone(event)); },
      releaseInputs() { harness.releases++; },
      captureEnded() { harness.capturesEnded++; harness.control = false; },
    };
    Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', {
      configurable: true,
      value: async () => {
        const canvas = document.createElement('canvas');
        canvas.width = 640; canvas.height = 360;
        const drawing = canvas.getContext('2d')!;
        let frame = 0;
        const paint = () => {
          frame++;
          drawing.fillStyle = '#101d16'; drawing.fillRect(0, 0, 640, 360);
          drawing.fillStyle = '#94e8ab'; drawing.fillRect(frame * 9 % 560, 135, 80, 80);
          drawing.font = '30px sans-serif'; drawing.fillText(`Inhouse Link · ${frame}`, 32, 70);
        };
        paint(); harness.canvasTimer = setInterval(paint, 1000 / 30);
        const stream = canvas.captureStream(30);
        const audio = new AudioContext();
        const oscillator = audio.createOscillator();
        const gain = audio.createGain(); gain.gain.value = 0.001;
        const destination = audio.createMediaStreamDestination();
        oscillator.connect(gain).connect(destination); oscillator.start();
        await audio.resume(); stream.addTrack(destination.stream.getAudioTracks()[0]);
        harness.source = stream; harness.audioContext = audio;
        return stream;
      },
    });
  }, { native, signalingUrl, serviceToken });
  await page.goto('/#/client');
  await expect(page.getByTestId('join-code')).toBeVisible();
  return { context, page };
}

test('transmits and decodes actual WebRTC frames, reports measured stats, applies settings and forwards input', async ({ browser }) => {
  const peers: Peer[] = [];
  try {
    const host = await peer(browser, true); peers.push(host);
    const viewer = await peer(browser); peers.push(viewer);
    await hostAndRequest(host, viewer);
    await approve(host, viewer);

    await expect.poll(() => viewer.page.evaluate(() => (window as any).__linkHarness.decodedCallbacks)).toBeGreaterThan(3);
    const before = await viewer.page.evaluate(() => (window as any).__linkHarness.video.getVideoPlaybackQuality().totalVideoFrames);
    await expect.poll(() => viewer.page.evaluate(() => (window as any).__linkHarness.video.getVideoPlaybackQuality().totalVideoFrames)).toBeGreaterThan(before + 3);
    await expect.poll(() => viewer.page.evaluate(() => (window as any).__linkHarness.session.state.stats.fps ?? 0)).toBeGreaterThan(0);
    await expect.poll(() => viewer.page.evaluate(() => (window as any).__linkHarness.session.state.stats.bitrateMbps ?? 0)).toBeGreaterThan(0);
    const stats = await viewer.page.evaluate(() => (window as any).__linkHarness.session.state.stats);
    expect(stats.transport).toContain('Relay');
    expect(stats.resolution).toBe('640 × 360');
    expect(stats.codec).not.toBe('—');
    expect(stats.decodeMs).toBeGreaterThanOrEqual(0);

    await expect.poll(() => viewer.page.evaluate(() => (window as any).__linkHarness.session.state.controlEnabled)).toBe(true);
    await viewer.page.evaluate(() => {
      const session = (window as any).__linkHarness.session;
      session.sendInput({ kind: 'key', code: 'KeyW', down: true });
      session.sendInput({ kind: 'key', code: 'KeyW', down: false });
      session.sendInput({ kind: 'pointer', x: 0.25, y: 0.75 });
    });
    await expect.poll(() => host.page.evaluate(() => (window as any).__linkHarness.inputs.filter((input: any) => input.kind === 'key').length)).toBe(2);
    await expect.poll(() => host.page.evaluate(() => (window as any).__linkHarness.inputs.some((input: any) => input.kind === 'pointer' && input.x === 0.25 && input.y === 0.75))).toBe(true);

    await viewer.page.evaluate(() => {
      const h = (window as any).__linkHarness;
      return h.session.updateSettings({ ...h.settings, bitrate: 7, fps: 30, adaptive: false });
    });
    await expect.poll(() => maxSenderBitrate(host)).toBe(7_000_000);

    const captureBefore = await host.page.evaluate(() => ({
      id: (window as any).__linkHarness.source.getVideoTracks()[0].id,
      ended: (window as any).__linkHarness.capturesEnded,
      releases: (window as any).__linkHarness.releases,
    }));
    await viewer.page.evaluate(() => (window as any).__linkHarness.session.disconnect());
    await expect.poll(() => host.page.evaluate(() => (window as any).__linkHarness.session.state.status)).toBe('hosting');
    const captureAfter = await host.page.evaluate(() => {
      const h = (window as any).__linkHarness;
      return { id: h.source.getVideoTracks()[0].id, active: h.source.active, readyState: h.source.getVideoTracks()[0].readyState, ended: h.capturesEnded, control: h.control, releases: h.releases };
    });
    expect(captureAfter.id).toBe(captureBefore.id);
    expect(captureAfter.active).toBe(true);
    expect(captureAfter.readyState).toBe('live');
    expect(captureAfter.ended).toBe(captureBefore.ended);
    expect(captureAfter.control).toBe(true);
    expect(captureAfter.releases).toBeGreaterThan(captureBefore.releases);

    await host.page.evaluate(() => (window as any).__linkHarness.session.disconnect());
    const stopped = await host.page.evaluate(() => {
      const h = (window as any).__linkHarness;
      return { readyState: h.source.getVideoTracks()[0].readyState, control: h.control, ended: h.capturesEnded };
    });
    expect(stopped.readyState).toBe('ended');
    expect(stopped.control).toBe(false);
    expect(stopped.ended).toBeGreaterThan(captureBefore.ended);
  } finally { await cleanup(peers); }
});

test('explicit enrollment enables mutually authenticated reconnect, while an invalid credential still needs approval', async ({ browser }) => {
  const peers: Peer[] = [];
  try {
    const host = await peer(browser, true); peers.push(host);
    const viewer = await peer(browser); peers.push(viewer);
    await hostAndRequest(host, viewer);
    await approve(host, viewer, true);
    await expect.poll(() => viewer.page.evaluate(() => (window as any).__linkHarness.session.getTrustedHosts().length)).toBe(1);
    await expect.poll(() => host.page.evaluate(() => (window as any).__linkHarness.session.getTrustedDevices().length)).toBe(1);
    const deviceId = await viewer.page.evaluate(() => (window as any).__linkHarness.session.getTrustedHosts()[0].deviceId);
    const consentCount = await host.page.evaluate(() => (window as any).__linkHarness.controlRequests);
    const trustedPublic = await viewer.page.evaluate(() => (window as any).__linkHarness.session.getTrustedHosts()[0]);
    expect(trustedPublic).not.toHaveProperty('token');

    await viewer.page.evaluate(() => (window as any).__linkHarness.session.disconnect());
    await expect.poll(() => host.page.evaluate(() => (window as any).__linkHarness.session.state.status)).toBe('hosting');
    await host.page.evaluate(() => { (window as any).__linkHarness.requestCounts = []; });
    await viewer.page.evaluate((deviceId) => {
      const h = (window as any).__linkHarness;
      return h.session.join(deviceId, h.settings, 'Portátil vinculado');
    }, deviceId);
    await expect.poll(() => viewer.page.evaluate(() => (window as any).__linkHarness.session.state.status)).toBe('connected');
    await expect.poll(() => viewer.page.evaluate(() => (window as any).__linkHarness.session.state.controlEnabled)).toBe(true);
    expect(await viewer.page.evaluate(() => (window as any).__linkHarness.session.trustedHostVerified)).toBe(true);
    expect(await host.page.evaluate(() => (window as any).__linkHarness.requestCounts.every((count: number) => count === 0))).toBe(true);
    expect(await host.page.evaluate(() => (window as any).__linkHarness.controlRequests)).toBe(consentCount);

    await viewer.page.evaluate(() => (window as any).__linkHarness.session.disconnect());
    await expect.poll(() => host.page.evaluate(() => (window as any).__linkHarness.session.state.status)).toBe('hosting');
    await viewer.page.evaluate(async (deviceId) => {
      const trustUrl = '/src/lib/trust.ts';
      const { storedHosts, saveHost } = await import(trustUrl);
      const hosts = storedHosts();
      saveHost({ ...hosts[0], token: 'A'.repeat(43) });
      const h = (window as any).__linkHarness;
      return h.session.join(deviceId, h.settings, 'Credencial modificada');
    }, deviceId);
    await expect.poll(() => host.page.evaluate(() => (window as any).__linkHarness.session.state.requests.length)).toBe(1);
    expect(await viewer.page.evaluate(() => (window as any).__linkHarness.session.state.status)).toBe('pending');
    await host.page.evaluate(() => {
      const session = (window as any).__linkHarness.session;
      session.approve(session.state.requests[0].id, false);
    });
    await expect.poll(() => viewer.page.evaluate(() => (window as any).__linkHarness.session.state.status)).toBe('error');
    expect(await host.page.evaluate(() => (window as any).__linkHarness.source.active)).toBe(true);
  } finally { await cleanup(peers); }
});

test('a host that denies native permission can stream but rejects input even if a viewer bypasses its own input gate', async ({ browser }) => {
  const peers: Peer[] = [];
  try {
    const host = await peer(browser, true, false); peers.push(host);
    const viewer = await peer(browser); peers.push(viewer);
    await hostAndRequest(host, viewer);
    await approve(host, viewer);
    expect(await host.page.evaluate(() => (window as any).__linkHarness.session.state.controlEnabled)).toBe(false);
    expect(await viewer.page.evaluate(() => (window as any).__linkHarness.session.state.controlEnabled)).toBe(false);
    await expect.poll(() => viewer.page.evaluate(() => (window as any).__linkHarness.session.control?.readyState)).toBe('open');
    await viewer.page.evaluate(() => {
      const h = (window as any).__linkHarness;
      h.session.control.send(JSON.stringify({ type: 'input', event: { kind: 'key', code: 'KeyA', down: true } }));
      h.session.sendInput({ kind: 'button', button: 0, down: true });
      return h.session.updateSettings({ ...h.settings, bitrate: 6, adaptive: false });
    });
    // This later message uses the same ordered data channel: applying it confirms
    // the host has already processed (and rejected) the preceding input message.
    await expect.poll(() => maxSenderBitrate(host)).toBe(6_000_000);
    expect(await host.page.evaluate(() => (window as any).__linkHarness.inputs.length)).toBe(0);
  } finally { await cleanup(peers); }
});

test('a signaling service restart preserves host identity, capture and permission for trusted reconnect', async ({ browser }) => {
  const peers: Peer[] = [];
  try {
    const host = await peer(browser, true); peers.push(host);
    const viewer = await peer(browser); peers.push(viewer);
    await hostAndRequest(host, viewer);
    await approve(host, viewer, true);
    await expect.poll(() => viewer.page.evaluate(() => (window as any).__linkHarness.session.getTrustedHosts().length)).toBe(1);
    const before = await host.page.evaluate(() => {
      const h = (window as any).__linkHarness;
      return { deviceId: h.session.state.deviceId, trackId: h.source.getVideoTracks()[0].id, consent: h.controlRequests, ended: h.capturesEnded };
    });
    await signaling!.close();
    await expect.poll(() => host.page.evaluate(() => (window as any).__linkHarness.session.state.status)).toBe('connecting');
    expect(await host.page.evaluate(() => (window as any).__linkHarness.source.active)).toBe(true);
    signaling = createSignalingServer(signalingOptions);
    await signaling!.listen();
    await expect.poll(() => host.page.evaluate(() => (window as any).__linkHarness.session.state.status), { timeout: 20000 }).toBe('hosting');
    const after = await host.page.evaluate(() => {
      const h = (window as any).__linkHarness;
      return { deviceId: h.session.state.deviceId, trackId: h.source.getVideoTracks()[0].id, consent: h.controlRequests, ended: h.capturesEnded, control: h.control };
    });
    expect(after).toEqual({ ...before, control: true });
    await viewer.page.evaluate((deviceId) => {
      const h = (window as any).__linkHarness;
      return h.session.join(deviceId, h.settings);
    }, before.deviceId);
    await expect.poll(() => viewer.page.evaluate(() => (window as any).__linkHarness.session.state.status)).toBe('connected');
    await expect.poll(() => viewer.page.evaluate(() => (window as any).__linkHarness.session.state.controlEnabled)).toBe(true);
    expect(await viewer.page.evaluate(() => (window as any).__linkHarness.session.trustedHostVerified)).toBe(true);
  } finally { await cleanup(peers); }
});

test('the actual interface hosts, approves, plays video and operates its floating menu, shortcuts and drag', async ({ browser }) => {
  const peers: Peer[] = [];
  try {
    const host = await uiPeer(browser, true); peers.push(host);
    const viewer = await uiPeer(browser, false); peers.push(viewer);
    await host.page.getByTestId('host-button').click();
    await expect(host.page.getByTestId('host-code')).toHaveText(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    const code = (await host.page.getByTestId('host-code').innerText()).trim();
    await viewer.page.getByTestId('join-code').fill(code);
    await viewer.page.getByTestId('join-name').fill('Portátil interfaz');
    await viewer.page.getByTestId('connect-button').click();
    await expect(host.page.getByRole('dialog')).toContainText(GOOGLE_TEST_PROFILE.email);
    await host.page.getByTestId('approve-once').click();
    const video = viewer.page.getByTestId('remote-video');
    await expect(video).toBeVisible();
    await expect.poll(() => video.evaluate((element) => (element as HTMLVideoElement).videoWidth)).toBe(640);
    await expect.poll(() => video.evaluate((element) => (element as HTMLVideoElement).getVideoPlaybackQuality().totalVideoFrames)).toBeGreaterThan(3);

    const toggle = viewer.page.getByTestId('session-menu-toggle');
    await toggle.click();
    await expect(viewer.page.getByTestId('session-menu')).toBeVisible();
    await viewer.page.keyboard.press('Control+Shift+KeyM');
    await expect(viewer.page.getByTestId('session-menu')).toHaveCount(0);
    await video.click();
    await viewer.page.keyboard.press('Control+Shift+KeyS');
    await expect(viewer.page.getByTestId('session-stats')).toBeVisible();
    await expect(viewer.page.getByTestId('session-stats')).toContainText('Relay');
    await mkdir('artifacts/screenshots', { recursive: true });
    await viewer.page.screenshot({ path: 'artifacts/screenshots/inhouse-link-live-session.png', fullPage: true });
    await viewer.page.keyboard.press('Control+Shift+KeyS');
    await expect(viewer.page.getByTestId('session-stats')).toHaveCount(0);

    const initial = (await toggle.boundingBox())!;
    await viewer.page.mouse.move(initial.x + initial.width / 2, initial.y + initial.height / 2);
    await viewer.page.mouse.down();
    await viewer.page.mouse.move(initial.x + initial.width / 2 + 110, initial.y + initial.height / 2 + 70, { steps: 8 });
    await viewer.page.mouse.up();
    const moved = (await toggle.boundingBox())!;
    expect(moved.x).toBeGreaterThan(initial.x + 80);
    expect(moved.y).toBeGreaterThan(initial.y + 40);
    expect(await viewer.page.evaluate(() => JSON.parse(localStorage.getItem('inhouse.link.menu-position')!).x)).toBeGreaterThan(initial.x + 80);

    await toggle.click();
    await viewer.page.getByLabel('Fotogramas por segundo').selectOption('30');
    const bitrate = viewer.page.getByLabel('Límite de bitrate');
    await bitrate.press('Home');
    for (let count = 0; count < 7; count++) await bitrate.press('ArrowRight');
    await expect(bitrate).toHaveValue('12');
    await viewer.page.screenshot({ path: 'artifacts/screenshots/inhouse-link-live-menu.png', fullPage: true });
    await viewer.page.getByRole('button', { name: 'Cerrar menú', exact: true }).click();
    await video.click();
    await viewer.page.keyboard.press('Control+Shift+KeyF');
    await expect.poll(() => viewer.page.evaluate(() => !!document.fullscreenElement)).toBe(true);
    await viewer.page.keyboard.press('Control+Shift+KeyF');
    await expect.poll(() => viewer.page.evaluate(() => !!document.fullscreenElement)).toBe(false);
    await viewer.page.keyboard.press('Control+Alt+Shift+KeyQ');
    await expect(viewer.page.getByTestId('session-stage')).toHaveCount(0);
    await expect(host.page.getByTestId('host-code')).toBeVisible();
    expect(await host.page.evaluate(() => (window as any).__uiHarness.source.active)).toBe(true);
    await host.page.getByRole('button', { name: 'Dejar de compartir', exact: true }).click();
    expect(await host.page.evaluate(() => (window as any).__uiHarness.source.getVideoTracks()[0].readyState)).toBe('ended');
    expect(await host.page.evaluate(() => (window as any).__uiHarness.control)).toBe(false);
  } finally { await cleanup(peers); }
});
