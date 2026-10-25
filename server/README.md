# Signaling service

This is an original WebSocket signaling service. Screen video, system audio and input travel directly over encrypted WebRTC, or through a configured TURN relay. They do not travel through this HTTP service.

Google authentication is required by default. It uses the same GIS OAuth client and Drive user-metadata flow as the other Inhouse applications, with no new Firebase account backend and no Drive file writes. The server independently verifies the access token before providing ICE credentials or accepting signaling; an email supplied in a client message is never an identity assertion.

Run from the repository root with `npm start` after building the web app. Default binding is `127.0.0.1:8080`. To load a local deployment configuration with Node 22+, use `node --env-file=.env server/index.mjs`. Do not commit `.env` or TURN credentials.

## Deployment

Outside localhost, serve the web client and `/signal` through HTTPS with a reverse proxy that supports WebSocket upgrades. Preserve the public `Host` header and proxy `/api/config` and `/health` to the service. Set `ALLOWED_ORIGINS` to the exact HTTPS origins of any separately hosted web clients (comma-separated, without trailing slashes). Unlisted remote browser origins are rejected.

The Windows desktop renderer is served from the stable `http://127.0.0.1:48715` address so that locally stored device identities survive restarts. Exact HTTP loopback origins (`127.0.0.1`, `localhost`, `::1`) can retrieve ICE configuration and connect to WebSocket signaling when they provide any configured service key. Origin permission does not grant remote-control authorization: a live invitation and host approval are still required. Native clients without an Origin header can also connect when authenticated; Origin is not an authentication mechanism.

Keep the service bound to localhost when using a local reverse proxy. `TRUST_PROXY=1` enables IP rate limiting based on the final valid `X-Forwarded-For` address only when the actual TCP peer is loopback. Do not expose that proxy to untrusted local processes or allow clients to overwrite its forwarding behavior. The default ignores forwarded headers.

`GET /health` reports process readiness; it does not prove that NAT traversal, video or native Windows input works. The server keeps sessions for independently verified Google accounts, without storing Google credentials or trusted-device pairing secrets. Every connection needs host approval: the host application can approve a previously remembered device after verifying its nonce-bound HMAC proof. Anonymous idle invitations expire after 15 minutes; a signed host identity remains discoverable while its sharing connection stays open.

## Google account validation

The default OAuth client ID is `435784295430-cmug30o42f1vu4ijgor9sjb0ro4oo37o.apps.googleusercontent.com`; override it with `GOOGLE_CLIENT_ID` only when the frontend is configured to use that same client. The public web origin that executes GIS must be authorized for that Google OAuth client by its owner. The desktop app opens an HTTPS web broker for the same Google flow; its localhost callback only receives the encrypted handoff and is not a Google OAuth redirect URI or an origin requiring a new OAuth client.

`server/google-auth.mjs` POSTs to Google's `https://oauth2.googleapis.com/tokeninfo` endpoint with the token in the Authorization header, not a URL. It verifies the token's audience against the configured OAuth client, its expiry and its `drive.file` scope. Then it reads only `https://www.googleapis.com/drive/v3/about?fields=user(displayName,emailAddress,photoLink,permissionId)` to obtain the real user's identity. The token-info POST route follows Google's official [Node authentication client](https://github.com/googleapis/google-auth-library-nodejs/blob/main/src/auth/oauth2client.ts). TLS checks stay enabled and redirects are rejected.

Provider checks have a shared eight-second deadline. Successful results are cached by SHA-256 token hash for at most five minutes and never beyond token expiry; at most 1000 entries and 32 provider checks are retained concurrently. Raw access tokens are not put in cache keys, URLs, saved files or logs. Provider errors are sanitized. `GOOGLE_ALLOWED_EMAILS` optionally limits access to a comma-separated list of administrator-approved Google email addresses; absent that list, any correctly verified Google account can request a host's consent.

Google login does not grant remote input or automatically approve a connection. The host still approves its first connection and separately authorizes Windows keyboard/mouse control. Trusted-device proofs are checked independently. Pending requests display the verified Google email/name and rooms retain their authenticated owner's profile.

`GET /api/auth/session` returns the verified public `account:{id,name,email}` and token `expiresAt`, when needed by a client. `/api/config` includes that same public profile with its ICE configuration. `/health` and static UI/download files remain public so the sign-in page can load.

After the same Google sign-in, `POST /api/auth/session` exchanges the verified Google access token for an opaque Inhouse session valid for 30 days. It returns `{accessToken,expiresAt,profile:{id,name,email,photo}}`; `profile.id` is Google's Drive `permissionId`, matching the other Inhouse applications, and `photo` comes from its `photoLink`. This allows the Windows host to remain signed in beyond the Google access token's usual one-hour lifetime without saving that Google credential or requesting a refresh token.

The generated `ihl_` token is accepted in the same HTTP Bearer header and `google.` WebSocket credential slot as a Google access token. A valid Inhouse session is checked locally; it does not cause another Google request. `GET /api/auth/session` returns both its public `account` and `profile`, with the original expiry. Repeating POST with an existing Inhouse token returns that same token/expiry and never silently extends its lifetime. `DELETE /api/auth/session` revokes the current Inhouse session, persists the revocation and closes all signaling sockets authenticated by that token. It does not revoke another account's sessions.

Only SHA-256 token hashes, public profile metadata and creation/expiry times are saved in the server-side session store; neither raw Inhouse tokens nor Google access tokens are written there. The default is `data/account-sessions.json`, or `INHOUSE_SESSION_FILE` when configured. Writes use a temporary 0600 file and atomic rename, with the containing directory created as 0700. The store loads before listening and a malformed existing store fails closed without being overwritten. Keep the directory private and outside source control; the desktop app uses its own user-data directory. Deleting this store signs out all remembered account sessions, requiring the same Google login again.

Expired sessions are rejected immediately and pruned. New sessions are limited to 1000 per service and 20 per account, with at most 10 mints per minute per client IP. Already authenticated account sessions are still subject to `GOOGLE_ALLOWED_EMAILS` on new API/signaling connections. These account sessions authenticate the user; they do not replace host approval, native input consent or the separate trusted-device HMAC.

## NAT traversal

The default has no external STUN or TURN dependency and can work on a directly reachable local network. Remote Internet connections, especially through CGNAT or restrictive Wi-Fi, generally need configured ICE infrastructure:

- `STUN_URLS`: comma-separated `stun:` or `stuns:` URLs.
- `TURN_URLS`: comma-separated `turn:` or `turns:` URLs.
- `SERVICE_TOKEN`: optional owner-managed additional service access key. Choose a long random value and enter the same value in each authorized client's service settings. It is separate from Google access tokens, the TURN shared secret and remembered-device pairing tokens.
- `TURN_SECRET`: server-only coturn shared secret, paired with coturn `use-auth-secret` and the same `static-auth-secret`. Clients receive an HMAC credential expiring after one hour, not this secret.
- `TURN_TTL_SECONDS`: optional credential lifetime, clamped to 60–86400 seconds; default 3600.
- `TURN_USERNAME` and `TURN_CREDENTIAL`: static fallback when `TURN_SECRET` is absent. These credentials are necessarily delivered to clients, so prefer expiring credentials and enforce TURN quotas.

TURN configuration enables a relay fallback; it does not guarantee a direct route or low latency. Publish the required relay ports and TURN allocation range for your own TURN installation. The service intentionally does not guess or provision public relays.

`/api/config` and `/api/auth/session` require `Authorization: Bearer <Google access token or Inhouse session token>`. When `SERVICE_TOKEN` is configured, `X-Inhouse-Service-Key` must additionally contain that key. WebSocket signaling requires `inhouse-link-v1` and `google.<base64url(UTF8 account token)>`, plus `auth.<base64url(UTF8 service key)>` when configured, in `Sec-WebSocket-Protocol`. The server compares the additional service key with `timingSafeEqual` and negotiates only `inhouse-link-v1`; it never echoes credential protocols, logs keys, or puts them in URLs. CORS preflight permits `Authorization` and `X-Inhouse-Service-Key` only from allowed origins. The client stores its entered additional service key locally under `inhouse.serviceToken`.

With Google validation enabled, TURN may be configured without the additional service key. For a personal Internet relay, restrict Google accounts with `GOOGLE_ALLOWED_EMAILS`, configure coturn allocation/bandwidth quotas, and optionally require the additional service key. Expiring TURN credentials alone do not prevent relay abuse. Rotate an additional shared service key if an authorized client is lost.

## API and tests

`createSignalingServer({host, port, staticDir, env, ...})` returns `listen()`, `close()`, `httpServer`, `wss` and an `address` getter. Port zero allocates a local ephemeral port for tests; the desktop app uses the stable port 48715. The `dist/` directory is served with a SPA fallback and traversal/symlink protection. Binary downloads placed under `dist/downloads/` are served as files.

Unit/integration fixtures may explicitly inject `googleVerifier:async(accessToken)=>({id,name,email,expiresAt})`. The production CLI and desktop app do not inject a fake verifier. Legacy local fixtures can use `googleAuth:false`; this option is rejected if the fixture binds to a non-loopback host, has no environment-variable bypass and is never a compiled frontend flag. Such fixtures still require an additional service key if they configure TURN. This exception does not exist in the sign-in UI.

Tests using the real account-session flow set `sessionStorePath:null` for a fresh in-memory store or provide an isolated temporary path to test restart persistence. Production keeps the default file store. The desktop app supplies a `sessionStorePath` beneath `app.getPath('userData')`.

The desktop app may provide `handleDesktopAuth:async(req,res)=>boolean` to serve its validated local callback and encrypted completion endpoints. This hook runs before default headers/routing, must return true only when it handled the request, and owns callback origin/nonce validation. It is absent from the public CLI server. Failures return a generic error without callback secrets.

`GET /api/config` also returns `iceExpiresAt` (Unix milliseconds) for dynamic TURN credentials, or `null` when their expiry is not managed by this service. Clients should refresh the configuration before that time and restart ICE for active relay sessions.

The protocol is specified in `IMPLEMENTATION.md`. The additional `{type:"request-cancelled",id}` event removes expired/canceled prompts from the host UI. Paired sessions do not expire at the invitation TTL. A viewer leaving keeps the host's room open; a host leaving removes its room. Only approved peers can exchange SDP and ICE.

Each socket first receives `{type:"hello",nonce}` with a random 32-byte challenge. A host can provide `identity:{publicKey,signature}` in its `host` message. The public key is a P-256 JWK; the signature is ECDSA SHA-256 over the UTF-8 nonce, encoded as base64url raw IEEE-p1363 bytes. A verified host gets a stable `deviceId` derived from its public key and included in `hosted` and both `paired` messages. Another socket cannot replace an online host alias. The host's private key stays on the host.

`join.code` accepts the normal invitation code or a stable 32-hex-character host device ID. Optional `join.trust:{id,proof}` is forwarded in `join-request.trust` with the server's actual connection nonce; a client-supplied nonce is ignored. The server never auto-approves trust claims, never learns the shared pairing token, and never receives that token in a signal. The host must verify the HMAC proof locally before approving a remembered device. Pairing-token enrollment belongs in the encrypted WebRTC data channel after an explicit initial approval.

Run `node --test tests/signaling.test.mjs tests/google-auth.test.mjs` after dependencies are installed. Tests cover provider audience/expiry/scope and profile validation using injected HTTP responses, hash-cache behavior, approval, isolation, routing, rejection, teardown, expiry, malformed messages, origin policy, TURN HMAC credentials, static file isolation, signed host identity, stable discovery, duplicate-alias protection, nonce-bound trust forwarding, independent Google/service-key authentication, provider timeouts, email allowlists, desktop hooks, Authorization preflight, account-session restart persistence, private file permissions, revocation, expiry and cross-account isolation. Mocked provider tests do not establish that live Google consent or the deployment's OAuth origins work.
