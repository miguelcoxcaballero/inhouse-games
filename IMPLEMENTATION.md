# Inhouse Link — implementation contract

Original implementation. Do not copy source code from reference products. Build a working WebRTC streaming application, not simulated telemetry. Windows desktop app hosts and views; the web product is a viewer. A browser-approved synthetic capture is used only by transport integration tests.

## Stack and ownership

- React + TypeScript + Vite in `src/`.
- Node.js ESM + `ws` signaling service in `server/index.mjs`.
- Electron app in `desktop/main.cjs` and `desktop/preload.cjs`.
- Root agent owns manifests, build scripts, documentation, integration and end-to-end checks.
- UI agent owns `src/App.tsx`, `src/styles.css` and UI components.
- Streaming agent owns `src/lib/session.ts`, `src/lib/input.ts`, `src/lib/stats.ts`.
- Server agent owns `server/` and signaling tests.
- Desktop agent owns `desktop/` including native Windows input helper.

## Shared renderer API

Export `LinkSession` class and types from `src/lib/session.ts`:

```ts
type LinkSettings = { resolution: 'native' | '1080p' | '1440p' | '4k'; fps: 30 | 60 | 120; bitrate: number; codec: 'auto' | 'h264' | 'vp9' | 'av1'; audio: boolean; adaptive: boolean };
type SessionStats = { rttMs: number | null; decodeMs: number | null; bitrateMbps: number | null; fps: number | null; packetLoss: number | null; resolution: string; transport: string; codec: string };
type LinkState = { status: 'idle' | 'connecting' | 'hosting' | 'pending' | 'negotiating' | 'connected' | 'disconnected' | 'error'; role: 'host' | 'viewer' | null; code: string; deviceId: string; error: string | null; peerName: string; requests: { id: string; name: string }[]; stats: SessionStats; remoteStream: MediaStream | null; localStream: MediaStream | null; controlEnabled: boolean };
class LinkSession {
  constructor(onChange: (state: LinkState) => void);
  get state(): LinkState;
  host(settings: LinkSettings): Promise<void>;
  join(code: string, settings: LinkSettings, name?: string): Promise<void>;
  approve(id: string, allow: boolean, remember?: boolean): void;
  setControlEnabled(enabled: boolean): Promise<boolean>;
  setViewerInputEnabled(enabled: boolean): void;
  clearTrustedDevices(): void;
  updateSettings(settings: LinkSettings): Promise<void>;
  sendInput(event: Record<string, unknown>): void;
  disconnect(): void;
  destroy(): void;
}
export const DEFAULT_SETTINGS: LinkSettings;
```

`attachRemoteInput(element: HTMLVideoElement, session: LinkSession): () => void` exported from `input.ts`; release held keys on blur and disconnect. UI may alternatively implement input forwarding using `sendInput`.

All latency statistics reflect WebRTC reports, never hardcoded values. Null renders as unavailable. Viewer settings travel to host over reliable control channel and update live sender parameters. Resolution caps preserve aspect ratio. Browser limitations and unsupported codecs must be explicit.

## Signaling protocol

WebSocket at `/signal`; service default port 8080. Client sends:

- `{type:'host', name?:string}` → `{type:'hosted', code:string}`.
- `{type:'join',code:string,name?:string}` → viewer `{type:'pending'}`, host `{type:'join-request',id:string,name:string}`.
- Host `{type:'approve',id:string,allow:boolean}` → both `{type:'paired',peerId:string,name:string,initiator:boolean}` (host initiator true). Rejection sends `{type:'rejected',message:string}` to viewer.
- `{type:'signal',signal:{description?:RTCSessionDescriptionInit,candidate?:RTCIceCandidateInit}}` → paired remote `{type:'signal',signal:...}`. Server routes only approved pair, without trusting client target IDs.
- `{type:'leave'}` cleans up room/session; other peer receives `{type:'peer-left'}`.
- Errors `{type:'error',message:string}`. `{type:'ping'}` → `{type:'pong'}`.

`GET /api/config` returns `{iceServers: RTCIceServer[], version:string}`. Default no public external STUN/TURN; environment `STUN_URLS`, `TURN_URLS`, `TURN_USERNAME`, `TURN_CREDENTIAL` or preferably `TURN_SECRET` dynamic credentials for the coturn shared-secret mechanism. No TURN secrets in client bundles or committed files. Include clear external network deployment instructions.

The final protocol additionally implements a per-connection `hello` challenge, signed P-256 host identities and stable device IDs, remembered-device nonce-bound HMAC proofs, and expiring TURN credentials (`iceExpiresAt`). See `server/README.md` for exact fields. `SERVICE_TOKEN` protects ICE configuration with Bearer authorization and WebSocket signaling with a non-reflected authentication subprotocol; it is required when TURN is configured. Client service origin/key are configured at runtime in settings, never baked into bundles.

## Electron bridge

Expose `window.inhouseDesktop` from preload:

```ts
{ platform: string; version: string;
  setControlEnabled(enabled: boolean): Promise<boolean>;
  injectInput(event: Record<string, unknown>): void;
  releaseInputs(): void;
  captureEnded(): void;
  minimizeHost?(): void;
}
```

Electron host capture uses `setDisplayMediaRequestHandler` and desktopCapturer. Windows system audio where supported. Native input injection only on Windows, only while local capture is active and host explicitly enables control. Other OS/browser return false. Input events: `{kind:'pointer',x:number,y:number}` coordinates normalized 0..1; `{kind:'button',button:0|1|2,down:boolean}`; `{kind:'wheel',dx:number,dy:number}`; `{kind:'key',code:string,down:boolean}`; `{kind:'release'}`. Validate in Electron main; reject unknown events. Never execute arbitrary input commands, URLs, or code.

## UX

Spanish-first. Verified Inhouse branding: dark surfaces, orange #E07A3C, cream, Comfortaa and DM Sans, a house symbol and lowercase product names. Dashboard, functional host and join flows, visible approval request, explicit connection statuses, no invented computer inventories. In-session floating Inhouse button opens a menu with disconnect, fullscreen, statistics, quality/codec/fps/bitrate/audio and input capture. Drag button and persist position. Five shortcuts are configurable; only Ctrl+Shift+I was directly verified as a Parsec shortcut in available official documentation. Other presets must not be described as verified full Parsec parity (see docs/comparison.md). Browser-reserved keys cannot all be forwarded. No simulated product sessions or invented telemetry.

## Readiness

Run meaningful signaling integration tests, browser tests with two peers and a synthetic media source, typecheck, production build, and build Windows artifact when possible. Benchmarking against alternatives on actual Murcia↔Valencia hardware is not possible here: never claim superior latency or fidelity without measurements. Document current feature gaps, including gamepad/native capture/driver requirements.

## Account integration (0.2)

The web client and Windows application require the Google Identity Services flow shared with Inhouse Notes/Read (same public client and drive.file). The server verifies the Google audience/scope/profile, then issues opaque revocable app sessions of up to thirty days, persisting only token hashes and account metadata. Account state and remembered devices are partitioned by Drive permissionId. App sessions are bound to the configured service origin; switching service requires reauthentication. The Windows broker uses the regular browser and a one-use encrypted ECDH/HKDF/AES-GCM handoff, never an embedded Google login. See docs/google-account.md and server/README.md.
