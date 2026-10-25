import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  GOOGLE_CLIENT_ID, GOOGLE_SCOPE, GOOGLE_SESSION_KEY, GoogleAccount, getGoogleSession, ensureServiceAccountSession,
} from '../src/lib/google-account.ts';
import { CLOUD_ACCOUNT_KEY, createCloudAccountFromRealm, rememberCloudAccount, getCloudAccount } from '../src/lib/cloud-account.ts';
import { useCloudAccountTransport } from '../src/lib/service-config.ts';

const original = { fetch: globalThis.fetch, window: globalThis.window, localStorage: globalThis.localStorage };
const memory = new Map();
const accounts = [];
const profile = { id: 'google-permission-fixture', name: 'Cuenta de prueba', email: 'test@example.invalid', photo: 'https://lh3.googleusercontent.com/test-photo' };
const googleProfile = () => new Response(JSON.stringify({ user: {
  permissionId: profile.id, displayName: profile.name, emailAddress: profile.email, photoLink: profile.photo,
} }), { status: 200 });

function account() {
  const changes = [];
  const result = new GoogleAccount(state => changes.push(state));
  accounts.push(result);
  return { account: result, changes };
}

function store(session = {}) {
  localStorage.setItem(GOOGLE_SESSION_KEY, JSON.stringify({
    accessToken: 'synthetic-google-access', expiresAt: Date.now() + 3600_000, profile, ...session,
  }));
}

beforeEach(() => {
  memory.clear();
  globalThis.localStorage = {
    getItem: key => memory.get(key) ?? null,
    setItem: (key, value) => memory.set(key, value),
    removeItem: key => memory.delete(key),
  };
  globalThis.window = Object.assign(new EventTarget(), { google: { accounts: { oauth2: { initTokenClient: () => ({ requestAccessToken() {} }) } } } });
  globalThis.fetch = async () => googleProfile();
});

afterEach(() => {
  for (const instance of accounts.splice(0)) instance.destroy();
  globalThis.fetch = original.fetch;
  if (original.window === undefined) delete globalThis.window; else globalThis.window = original.window;
  if (original.localStorage === undefined) delete globalThis.localStorage; else globalThis.localStorage = original.localStorage;
});

test('a remembered profile or expired token is never an authenticated Google session', () => {
  store({ accessToken: '' });
  assert.equal(getGoogleSession(), null);
  store({ expiresAt: Date.now() + 59_000 });
  assert.equal(getGoogleSession(), null);
  store({ profile: { name: 'Remembered avatar only' } });
  assert.equal(getGoogleSession(), null);
  memory.set(GOOGLE_SESSION_KEY, '{not JSON');
  assert.equal(getGoogleSession(), null);
  store();
  const current = getGoogleSession();
  assert.equal(current.profile.id, profile.id);
  current.profile.name = 'external mutation';
  assert.equal(getGoogleSession().profile.name, profile.name);
});

test('web login uses Notes/Read public client and drive.file synchronously from the click, then verifies the profile', async () => {
  let configuration;
  let inClick = false;
  let fetchCalls = 0;
  window.google.accounts.oauth2.initTokenClient = options => {
    configuration = options;
    return { requestAccessToken(request) {
      assert.equal(inClick, true, 'GIS popup must open before the click returns');
      assert.equal(request.prompt, 'select_account');
      options.callback({ access_token: 'synthetic-google-access', expires_in: 3600, scope: GOOGLE_SCOPE });
    } };
  };
  globalThis.fetch = async (url, request) => {
    fetchCalls++;
    assert.equal(url, 'https://www.googleapis.com/drive/v3/about?fields=user(displayName,emailAddress,photoLink,permissionId)');
    assert.equal(request.headers.Authorization, 'Bearer synthetic-google-access');
    return googleProfile();
  };
  const events = [];
  window.addEventListener('inhouse-account-changed', event => events.push(event.detail));
  const { account: instance } = account();
  await instance.initialize();
  assert.equal(instance.state.status, 'signed-out');
  inClick = true;
  const login = instance.signIn();
  inClick = false;
  await login;
  assert.equal(configuration.client_id, '435784295430-cmug30o42f1vu4ijgor9sjb0ro4oo37o.apps.googleusercontent.com');
  assert.equal(configuration.scope, 'https://www.googleapis.com/auth/drive.file');
  assert.equal(configuration.include_granted_scopes, true);
  assert.equal('redirect_uri' in configuration, false);
  assert.equal('client_secret' in configuration, false);
  assert.equal(fetchCalls, 1);
  assert.equal(instance.state.status, 'signed-in');
  assert.deepEqual(instance.state.profile, profile);
  assert.equal(getGoogleSession().accessToken, 'synthetic-google-access');
  assert.equal(events.at(-1).accountId, profile.id);
  assert.equal('accessToken' in events.at(-1), false);
});

test('restored sessions are revalidated with Google and rejected when access has been revoked', async () => {
  store();
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response('{}', { status: 401 }); };
  const { account: instance } = account();
  await instance.initialize();
  assert.equal(calls, 1);
  assert.equal(instance.state.status, 'error');
  assert.equal(instance.state.profile, null);
  assert.equal(getGoogleSession(), null);
});

test('native login to an explicit Node service uses the external-browser bridge and still verifies the Google profile', async () => {
  let nativeCalls = 0;
  localStorage.setItem('inhouse.signalingUrl', 'https://native-service.example.invalid');
  globalThis.fetch = async url => String(url).startsWith('https://www.googleapis.com/') ? googleProfile() : new Response('{}', { status: 503 });
  delete window.google;
  window.inhouseDesktop = { googleSignIn: async () => { nativeCalls++; return { accessToken: 'native-synthetic-access', expiresAt: Date.now() + 3600_000 }; } };
  const { account: instance } = account();
  await instance.initialize();
  assert.equal(instance.state.status, 'signed-out');
  await instance.signIn();
  assert.equal(nativeCalls, 1);
  assert.equal(instance.state.status, 'signed-in');
  assert.equal(getGoogleSession().accessToken, 'native-synthetic-access');
  assert.deepEqual(instance.state.profile, profile);
});

test('missing requested Drive scope does not create a fake signed-in account', async () => {
  window.google.accounts.oauth2.initTokenClient = options => ({ requestAccessToken() {
    options.callback({ access_token: 'synthetic-google-access', expires_in: 3600, scope: 'openid email profile' });
  } });
  const { account: instance } = account();
  await assert.rejects(instance.signIn(), /permiso/);
  assert.equal(instance.state.status, 'error');
  assert.equal(getGoogleSession(), null);
});

test('an existing full-Drive grant from Notes is accepted while Link still requests only drive.file', async () => {
  let configuration;
  window.google.accounts.oauth2.initTokenClient = options => {
    configuration = options;
    return { requestAccessToken() {
      options.callback({ access_token: 'synthetic-notes-existing-grant', expires_in: 3600,
        scope: 'https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/calendar.events' });
    } };
  };
  const { account: instance } = account();
  await instance.signIn();
  assert.equal(configuration.client_id, GOOGLE_CLIENT_ID);
  assert.equal(configuration.scope, 'https://www.googleapis.com/auth/drive.file');
  assert.equal(configuration.include_granted_scopes, true);
  assert.equal(instance.state.status, 'signed-in');
  assert.equal(getGoogleSession().accessToken, 'synthetic-notes-existing-grant');
});

test('signing out while the Google popup is pending prevents its late callback from restoring access', async () => {
  let callback;
  window.google.accounts.oauth2.initTokenClient = options => { callback = options.callback; return { requestAccessToken() {} }; };
  const { account: instance } = account();
  const login = instance.signIn();
  const rejected = assert.rejects(login, /cancelado/);
  instance.signOut();
  callback({ access_token: 'synthetic-google-access', expires_in: 3600, scope: GOOGLE_SCOPE });
  await rejected;
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(instance.state.status, 'signed-out');
  assert.equal(getGoogleSession(), null);
});

test('signing out during a profile request discards the late account response', async () => {
  let release;
  globalThis.fetch = () => new Promise(resolve => { release = resolve; });
  window.google.accounts.oauth2.initTokenClient = options => ({ requestAccessToken() {
    options.callback({ access_token: 'synthetic-google-access', expires_in: 3600, scope: GOOGLE_SCOPE });
  } });
  const { account: instance } = account();
  const login = instance.signIn();
  const rejected = assert.rejects(login, /cancelado/);
  instance.signOut();
  release(googleProfile());
  await rejected;
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(instance.state.status, 'signed-out');
  assert.equal(getGoogleSession(), null);
});

test('a popup-close event after delivery of its token cannot cancel or race the chosen profile response', async () => {
  let release;
  let configuration;
  globalThis.fetch = () => new Promise(resolve => { release = resolve; });
  window.google.accounts.oauth2.initTokenClient = options => {
    configuration = options;
    return { requestAccessToken() { options.callback({ access_token: 'synthetic-google-access', expires_in: 3600, scope: GOOGLE_SCOPE }); } };
  };
  const { account: instance } = account();
  const login = instance.signIn();
  configuration.error_callback({ type: 'popup_closed' });
  configuration.callback({ access_token: 'duplicate-token-must-not-win', expires_in: 3600, scope: GOOGLE_SCOPE });
  release(googleProfile());
  await login;
  assert.equal(instance.state.status, 'signed-in');
  assert.equal(getGoogleSession().accessToken, 'synthetic-google-access');
});

test('signing out in another tab immediately notifies active session owners', async () => {
  store();
  const { account: instance } = account();
  await instance.initialize();
  const reasons = [];
  window.addEventListener('inhouse-account-changed', event => reasons.push(event.detail));
  localStorage.removeItem(GOOGLE_SESSION_KEY);
  const changed = new Event('storage');
  changed.key = GOOGLE_SESSION_KEY;
  window.dispatchEvent(changed);
  assert.equal(reasons.at(-1).reason, 'signed-out');
  assert.equal(reasons.at(-1).accountId, null);
  assert.equal(getGoogleSession(), null);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(instance.state.status, 'signed-out');
});

test('native Google expiry for an explicit Node service emits signed-out without silently reopening Google', async context => {
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100_000 });
  let nativeCalls = 0;
  localStorage.setItem('inhouse.signalingUrl', 'https://native-service.example.invalid');
  globalThis.fetch = async url => String(url).startsWith('https://www.googleapis.com/') ? googleProfile() : new Response('{}', { status: 503 });
  window.inhouseDesktop = { googleSignIn: async () => { nativeCalls++; throw new Error('must not open'); } };
  store({ expiresAt: Date.now() + 61_000 });
  const events = [];
  window.addEventListener('inhouse-account-changed', event => events.push(event.detail));
  const { account: instance } = account();
  await instance.initialize();
  assert.equal(instance.state.status, 'signed-in');
  context.mock.timers.tick(1000);
  assert.equal(instance.state.status, 'signed-out');
  assert.equal(getGoogleSession(), null);
  assert.equal(nativeCalls, 0);
  assert.equal(events.at(-1).reason, 'expired');
  context.mock.timers.reset();
});

const serviceOrigin = 'https://link.example.invalid';
const appToken = 'ihl_' + 'a'.repeat(43);
function storedApp(expiresAt = Date.now() + 30 * 86400_000) {
  localStorage.setItem('inhouse.signalingUrl', serviceOrigin);
  store({ accessToken: appToken, expiresAt, issuer: serviceOrigin });
}
function immediateGoogle() {
  window.google.accounts.oauth2.initTokenClient = options => ({ requestAccessToken() {
    options.callback({ access_token: 'synthetic-google-access', expires_in: 3600, scope: GOOGLE_SCOPE });
  } });
}

test('Google login exchanges for an issuer-bound durable service session without inventing its lifetime', async () => {
  localStorage.setItem('inhouse.signalingUrl', serviceOrigin);
  localStorage.setItem('inhouse.serviceToken', 'synthetic-service-key');
  immediateGoogle();
  const expiresAt = Date.now() + 30 * 86400_000;
  globalThis.fetch = async (url, request) => {
    if (String(url).startsWith('https://www.googleapis.com/')) return googleProfile();
    assert.equal(String(url), serviceOrigin + '/api/auth/session');
    assert.equal(request.method, 'POST');
    assert.equal(request.headers.Authorization, 'Bearer synthetic-google-access');
    assert.equal(request.headers['X-Inhouse-Service-Key'], 'synthetic-service-key');
    assert.equal(String(url).includes('synthetic-google-access'), false);
    return new Response(JSON.stringify({ accessToken: appToken, expiresAt, profile }), { status: 201 });
  };
  const { account: instance } = account();
  await instance.signIn();
  assert.equal(instance.state.status, 'signed-in');
  assert.equal(instance.state.error, null);
  assert.deepEqual(getGoogleSession(), { accessToken: appToken, expiresAt, profile, issuer: serviceOrigin });
  assert.equal((await ensureServiceAccountSession(new URL(serviceOrigin))).accessToken, appToken);
});

test('a saved service session restores against its issuer, without sending ihl_ tokens to Google', async () => {
  storedApp();
  localStorage.setItem('inhouse.serviceToken', 'synthetic-protected-service');
  const saved = getGoogleSession();
  let calls = 0;
  globalThis.fetch = async (url, request) => {
    calls++;
    assert.equal(String(url), serviceOrigin + '/api/auth/session');
    assert.equal(request.method, undefined);
    assert.equal(request.headers.Authorization, 'Bearer ' + appToken);
    assert.equal(request.headers['X-Inhouse-Service-Key'], 'synthetic-protected-service');
    return new Response(JSON.stringify({ profile, expiresAt: saved.expiresAt }), { status: 200 });
  };
  const { account: instance } = account();
  await instance.initialize();
  assert.equal(calls, 1);
  assert.equal(instance.state.status, 'signed-in');
  assert.equal(getGoogleSession().accessToken, appToken);
});

test('changing the service prevents its previous app credential being sent to the new origin', async () => {
  storedApp();
  const { account: instance } = account();
  globalThis.fetch = async () => new Response(JSON.stringify({ profile, expiresAt: Date.now() + 86400_000 }), { status: 200 });
  await instance.initialize();
  let requests = 0;
  globalThis.fetch = async () => { requests++; throw new Error('No old token may be transmitted'); };
  localStorage.setItem('inhouse.signalingUrl', 'https://another.example.invalid');
  assert.equal(getGoogleSession(), null);
  await assert.rejects(ensureServiceAccountSession(new URL(serviceOrigin)), /ha cambiado/);
  window.dispatchEvent(new Event('inhouse-service-changed'));
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(requests, 0);
  assert.equal(instance.state.status, 'signed-out');
});

test('service sign-out revokes the remote token while clearing local access immediately', async () => {
  storedApp();
  localStorage.setItem('inhouse.serviceToken', 'synthetic-protected-service');
  const calls = [];
  globalThis.fetch = async (url, request) => {
    calls.push({ url: String(url), request });
    return new Response(null, { status: 204 });
  };
  const { account: instance } = account();
  instance.signOut();
  assert.equal(getGoogleSession(), null);
  assert.equal(instance.state.status, 'signed-out');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].request.method, 'DELETE');
  assert.equal(calls[0].request.headers.Authorization, 'Bearer ' + appToken);
  assert.equal(calls[0].request.headers['X-Inhouse-Service-Key'], 'synthetic-protected-service');
  assert.equal(calls[0].url, serviceOrigin + '/api/auth/session');
});

test('a failed service exchange preserves the actually verified Google login without extending it', async () => {
  localStorage.setItem('inhouse.signalingUrl', serviceOrigin);
  immediateGoogle();
  globalThis.fetch = async url => String(url).startsWith('https://www.googleapis.com/')
    ? googleProfile() : new Response('{}', { status: 503 });
  const { account: instance } = account();
  const started = Date.now();
  await instance.signIn();
  assert.equal(instance.state.status, 'signed-in');
  assert.match(instance.state.error, /servicio/);
  assert.equal(getGoogleSession().accessToken, 'synthetic-google-access');
  assert.equal(getGoogleSession().issuer, undefined);
  assert.ok(getGoogleSession().expiresAt <= Date.now() + 3600_000);
  assert.ok(getGoogleSession().expiresAt >= started + 3600_000);
});

test('logout during a service exchange cannot restore the late durable credential', async () => {
  localStorage.setItem('inhouse.signalingUrl', serviceOrigin);
  store();
  let release;
  globalThis.fetch = () => new Promise(resolve => { release = resolve; });
  const upgraded = ensureServiceAccountSession(new URL(serviceOrigin));
  const rejected = assert.rejects(upgraded, /ha cambiado/);
  const { account: instance } = account();
  instance.signOut();
  release(new Response(JSON.stringify({ accessToken: appToken, expiresAt: Date.now() + 30 * 86400_000, profile }), { status: 201 }));
  await rejected;
  assert.equal(getGoogleSession(), null);
});

test('the desktop broker keeps its Google grant in memory and never accepts or replaces a saved app credential', async () => {
  storedApp();
  const before = localStorage.getItem(GOOGLE_SESSION_KEY);
  let googleRequests = 0;
  globalThis.fetch = async url => {
    assert.ok(String(url).startsWith('https://www.googleapis.com/'));
    googleRequests++;
    return googleProfile();
  };
  immediateGoogle();
  const instance = new GoogleAccount(() => {}, { googleOnly: true });
  accounts.push(instance);
  await instance.initialize();
  assert.equal(instance.state.status, 'signed-out');
  assert.equal(instance.getOAuthSession(), null);
  assert.equal(googleRequests, 0);
  assert.equal(localStorage.getItem(GOOGLE_SESSION_KEY), before);
  await instance.signIn();
  assert.equal(instance.getOAuthSession().accessToken, 'synthetic-google-access');
  assert.equal(instance.getOAuthSession().issuer, undefined);
  assert.equal(localStorage.getItem(GOOGLE_SESSION_KEY), before);
  instance.signOut();
  instance.destroy();
  assert.equal(instance.getOAuthSession(), null);
  assert.equal(localStorage.getItem(GOOGLE_SESSION_KEY), before);
});

test('a thirty-day app session survives the JavaScript timer limit and expires at the server deadline', async context => {
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100_000 });
  const expiresAt = Date.now() + 30 * 86400_000;
  storedApp(expiresAt);
  window.inhouseDesktop = { googleSignIn: async () => { throw new Error('must not open Google'); } };
  globalThis.fetch = async () => new Response(JSON.stringify({ profile, expiresAt }), { status: 200 });
  const { account: instance } = account();
  await instance.initialize();
  assert.equal(instance.state.status, 'signed-in');
  context.mock.timers.tick(2_000_000_000);
  assert.equal(instance.state.status, 'signed-in');
  assert.equal(getGoogleSession().expiresAt, expiresAt);
  context.mock.timers.tick(expiresAt - Date.now() - 60_000);
  assert.equal(instance.state.status, 'signed-out');
  assert.equal(getGoogleSession(), null);
  context.mock.timers.reset();
});

test('a temporary service outage preserves a durable credential but does not falsely authenticate its owner', async () => {
  storedApp();
  const saved = localStorage.getItem(GOOGLE_SESSION_KEY);
  globalThis.fetch = async () => new Response('{}', { status: 503 });
  const { account: instance } = account();
  await instance.initialize();
  assert.equal(instance.state.status, 'error');
  assert.equal(instance.state.profile, null);
  assert.equal(localStorage.getItem(GOOGLE_SESSION_KEY), saved);
  globalThis.fetch = async () => new Response(JSON.stringify({ profile, expiresAt: getGoogleSession().expiresAt }), { status: 200 });
  await instance.signIn();
  assert.equal(instance.state.status, 'signed-in');
  assert.equal(getGoogleSession().accessToken, appToken);
});

const privateRealm = { id: 'drive-realm-fixture', fileId: 'drive-realm-fixture', accountId: profile.id, secret: 'A'.repeat(43) };
const realmMetadata = {
  id: privateRealm.fileId, createdTime: '2026-01-01T00:00:00.000Z', ownedByMe: true, shared: false,
  appProperties: { 'inhouse.link.realm': '1' },
};
function pages() { window.location = new URL('https://miguelcoxcaballero.github.io/inhouse-games/#/client'); }
function mirrorCloud(expiresAt = Date.now() + 30 * 86400_000) {
  const cloud = createCloudAccountFromRealm(profile, privateRealm, expiresAt);
  rememberCloudAccount(cloud);
  store({ kind: 'cloud', accessToken: cloud.clientToken, expiresAt: cloud.expiresAt });
  return cloud;
}
function cloudDriveResponse(url) {
  const target = new URL(String(url));
  if (target.pathname === '/drive/v3/about') return googleProfile();
  if (target.pathname === '/drive/v3/files') return new Response(JSON.stringify({ files: [realmMetadata] }));
  if (target.pathname === `/drive/v3/files/${privateRealm.fileId}`) {
    return new Response(JSON.stringify(target.searchParams.get('alt') === 'media'
      ? { schema: 1, accountId: profile.id, secret: privateRealm.secret } : realmMetadata));
  }
  throw new Error('Unexpected fixture request: ' + target.origin + target.pathname);
}

test('Pages signs in with the same Google grant and stores a separate private thirty-day capability', async () => {
  pages(); immediateGoogle();
  assert.equal(useCloudAccountTransport(), true);
  const requests = [];
  globalThis.fetch = async (url, request) => {
    requests.push(String(url));
    assert.equal(new URL(String(url)).origin, 'https://www.googleapis.com');
    assert.equal(request.headers.Authorization, 'Bearer synthetic-google-access');
    return cloudDriveResponse(url);
  };
  const { account: instance } = account();
  const googleExpiry = Date.now() + 3600_000;
  await instance.signIn();
  assert.equal(instance.state.status, 'signed-in');
  const session = getGoogleSession();
  assert.equal(session.kind, 'cloud');
  assert.match(session.accessToken, /^ild_[A-Za-z0-9_-]{43}$/);
  assert.ok(session.expiresAt > googleExpiry, 'the local capability has its own lifetime');
  assert.ok(session.expiresAt <= Date.now() + 30 * 86400_000);
  assert.equal(session.issuer, undefined);
  assert.equal(getCloudAccount().secret, privateRealm.secret);
  assert.equal(instance.getOAuthSession(), null);
  assert.equal([...memory.values()].some(value => value.includes('synthetic-google-access')), false);
  assert.ok(requests.some(url => url.includes('/drive/v3/files?')));
});

test('a cloud profile or token alone cannot authenticate without its matching private realm capability', () => {
  pages();
  store({ kind: 'cloud', accessToken: 'ild_' + 'A'.repeat(43) });
  assert.equal(getGoogleSession(), null);
  const cloud = mirrorCloud();
  assert.equal(getGoogleSession().accessToken, cloud.clientToken);
  store({ kind: 'cloud', accessToken: cloud.clientToken, expiresAt: cloud.expiresAt, profile: { ...profile, email: 'another@example.invalid' } });
  assert.equal(getGoogleSession(), null);
  store({ accessToken: cloud.clientToken, expiresAt: cloud.expiresAt });
  assert.equal(getGoogleSession(), null, 'a local capability cannot be mistaken for an OAuth token');
  mirrorCloud();
  localStorage.removeItem(CLOUD_ACCOUNT_KEY);
  assert.equal(getGoogleSession(), null);
});

test('a valid browser cloud capability restores without treating it as a Google access token', async () => {
  pages(); const cloud = mirrorCloud();
  let requests = 0;
  globalThis.fetch = async url => {
    requests++;
    assert.ok(String(url).endsWith('/service.json'));
    return new Response(JSON.stringify({ schema: 1, signalingUrl: null }));
  };
  const { account: instance } = account();
  await instance.initialize();
  assert.equal(instance.state.status, 'signed-in');
  assert.equal(getGoogleSession().accessToken, cloud.clientToken);
  assert.ok(requests <= 1);
});

test('switching to an explicit server rejects a cloud capability without transmitting it', async () => {
  pages(); mirrorCloud();
  localStorage.setItem('inhouse.signalingUrl', serviceOrigin);
  assert.equal(useCloudAccountTransport(), false);
  assert.equal(getGoogleSession(), null);
  let requests = 0;
  globalThis.fetch = async () => { requests++; throw new Error('A local cloud capability must never leave this client.'); };
  await assert.rejects(ensureServiceAccountSession(new URL(serviceOrigin)), /Inicia sesión/);
  const { account: instance } = account();
  await instance.initialize();
  assert.equal(instance.state.status, 'signed-out');
  assert.equal(getCloudAccount(), null);
  assert.equal(requests, 0);
});

test('native cloud login uses its independently verified main-process realm and never persists the Google grant', async () => {
  let calls = 0;
  window.inhouseDesktop = {
    cloudAccountRestore: async () => null,
    googleSignIn: async options => {
      calls++; assert.equal(options.cloudMode, true);
      return {
        accessToken: 'native-fresh-google-grant', expiresAt: Date.now() + 3600_000,
        cloudRealm: privateRealm, profile, cloudSessionExpiresAt: Date.now() + 30 * 86400_000,
      };
    },
  };
  let googleCalls = 0;
  globalThis.fetch = async url => { googleCalls++; assert.ok(String(url).includes('/drive/v3/about?')); return googleProfile(); };
  const { account: instance } = account();
  await instance.initialize();
  await instance.signIn();
  assert.equal(calls, 1);
  assert.equal(googleCalls, 1);
  assert.equal(instance.state.status, 'signed-in');
  assert.equal(getGoogleSession().kind, 'cloud');
  assert.equal([...memory.values()].some(value => value.includes('native-fresh-google-grant')), false);
});

test('native cloud restoration requires the main-process anchor even if the renderer remembers a realm', async () => {
  window.inhouseDesktop = { cloudAccountRestore: async () => null };
  mirrorCloud();
  globalThis.fetch = async () => { throw new Error('No Google request is needed to reject an absent native anchor.'); };
  const { account: instance } = account();
  await instance.initialize();
  assert.equal(instance.state.status, 'signed-out');
  assert.equal(getGoogleSession(), null);
  assert.equal(getCloudAccount(), null);
  window.inhouseDesktop.cloudAccountRestore = async () => ({ realm: privateRealm, profile, expiresAt: Date.now() + 30 * 86400_000 });
  await instance.initialize();
  assert.equal(instance.state.status, 'signed-in');
  assert.equal(getGoogleSession().kind, 'cloud');
});

test('cloud sign-out forgets local and native capabilities without deleting the private Drive file', async () => {
  let forgotten = 0;
  window.inhouseDesktop = { cloudAccountForget: () => { forgotten++; } };
  mirrorCloud();
  let requests = 0;
  globalThis.fetch = async () => { requests++; throw new Error('Signing out must not delete a Drive file.'); };
  const { account: instance } = account();
  instance.signOut();
  assert.equal(instance.state.status, 'signed-out');
  assert.equal(getGoogleSession(), null);
  assert.equal(getCloudAccount(), null);
  assert.equal(forgotten, 1);
  assert.equal(requests, 0);
});

test('cloud capability expiry clears account state without silently extending Google authorization', async context => {
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100_000 });
  pages(); const cloud = mirrorCloud();
  let silentRequests = 0;
  window.google.accounts.oauth2.initTokenClient = () => { silentRequests++; throw new Error('No automatic OAuth refresh for local capabilities.'); };
  const { account: instance } = account();
  await instance.initialize();
  context.mock.timers.tick(2_000_000_000);
  assert.equal(instance.state.status, 'signed-in');
  context.mock.timers.tick(cloud.expiresAt - Date.now() - 60_000);
  assert.equal(instance.state.status, 'signed-out');
  assert.equal(getCloudAccount(), null);
  assert.equal(getGoogleSession(), null);
  assert.equal(silentRequests, 0);
  context.mock.timers.reset();
});

test('logging out during private Drive discovery cannot restore a late cloud capability', async () => {
  pages(); immediateGoogle();
  let release;
  globalThis.fetch = async url => {
    if (new URL(String(url)).pathname === '/drive/v3/files') return new Promise(resolve => { release = resolve; });
    return cloudDriveResponse(url);
  };
  const { account: instance } = account();
  const login = instance.signIn();
  const rejected = assert.rejects(login, /cancelado|cambiado/);
  for (let turn = 0; turn < 20 && !release; turn++) await new Promise(resolve => setTimeout(resolve, 0));
  assert.ok(release);
  instance.signOut();
  release(new Response(JSON.stringify({ files: [realmMetadata] })));
  await rejected;
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(instance.state.status, 'signed-out');
  assert.equal(getCloudAccount(), null);
  assert.equal(getGoogleSession(), null);
});
