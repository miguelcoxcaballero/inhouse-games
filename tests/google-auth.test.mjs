import test from 'node:test';
import assert from 'node:assert/strict';
import { createGoogleTokenVerifier, DEFAULT_GOOGLE_CLIENT_ID, GoogleAuthError } from '../server/google-auth.mjs';

const TOKEN = 'ya29.unit-test-access-token';
const PROFILE = { user: { displayName: 'Cuenta de Google', emailAddress: 'verified@example.test', permissionId: 'google-drive-user-123', photoLink: 'https://lh3.googleusercontent.com/a/example' } };
const VALID_INFO = { aud: DEFAULT_GOOGLE_CLIENT_ID, scope: 'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/userinfo.profile', expires_in: '3600' };

function fakeProvider({ info = VALID_INFO, profile = PROFILE, tokenStatus = 200, profileStatus = 200, now = () => 1000 } = {}) {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(url.includes('/tokeninfo') ? info : profile), { status: url.includes('/tokeninfo') ? tokenStatus : profileStatus });
  };
  return { calls, verify: createGoogleTokenVerifier({ fetcher, now }) };
}

test('real verifier checks Google audience and obtains identity from Drive user metadata without token URLs', async () => {
  const f = fakeProvider();
  const account = await f.verify(TOKEN);
  assert.deepEqual(account, { id: 'google-drive-user-123', name: 'Cuenta de Google', email: 'verified@example.test', photo: PROFILE.user.photoLink, expiresAt: 3_601_000 });
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0].url, 'https://oauth2.googleapis.com/tokeninfo');
  assert.equal(f.calls[0].init.method, 'POST');
  assert.equal(f.calls[0].init.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(f.calls[1].init.method, 'GET');
  assert.match(f.calls[1].url, /^https:\/\/www\.googleapis\.com\/drive\/v3\/about\?fields=user\(/);
  for (const call of f.calls) {
    assert.ok(!call.url.includes(TOKEN));
    assert.equal(call.init.redirect, 'error');
    assert.ok(call.init.signal instanceof AbortSignal);
  }
});

test('a token for another OAuth client is rejected before reading profile metadata', async () => {
  const f = fakeProvider({ info: { ...VALID_INFO, aud: 'different-client.apps.googleusercontent.com' } });
  await assert.rejects(f.verify(TOKEN), (error) => error instanceof GoogleAuthError && error.status === 401);
  assert.equal(f.calls.length, 1);
});

test('existing Notes full-Drive grants are accepted only for the exact shared OAuth client', async () => {
  const scope = 'https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/userinfo.profile';
  const notes = fakeProvider({ info: { ...VALID_INFO, scope } });
  assert.equal((await notes.verify(TOKEN)).id, PROFILE.user.permissionId);
  assert.equal(notes.calls.length, 2);
  assert.match(notes.calls[1].url, /\/drive\/v3\/about\?/);
  const wrongClient = fakeProvider({ info: { ...VALID_INFO, scope, aud: 'another-client.apps.googleusercontent.com' } });
  await assert.rejects(wrongClient.verify(TOKEN), (error) => error instanceof GoogleAuthError && error.status === 401);
  assert.equal(wrongClient.calls.length, 1);
});

test('expired, missing-scope and invalid provider identities fail closed', async () => {
  for (const override of [
    { info: { ...VALID_INFO, expires_in: 0 } },
    { info: { ...VALID_INFO, scope: 'profile' } },
    { profile: { user: { displayName: 'Claimed name', emailAddress: 'not-an-email' } } },
    { tokenStatus: 401 },
    { profileStatus: 403 },
  ]) {
    const f = fakeProvider(override);
    await assert.rejects(f.verify(TOKEN), (error) => error instanceof GoogleAuthError && error.status === 401);
  }
});

test('provider failures are sanitized and token syntax is checked before network work', async () => {
  const f = fakeProvider();
  for (const token of ['', 'bad\nvalue', TOKEN + ' ', 'x'.repeat(8193)]) {
    await assert.rejects(f.verify(token), GoogleAuthError);
  }
  assert.equal(f.calls.length, 0);
  const verify = createGoogleTokenVerifier({ fetcher: async () => { throw new Error(`leaky provider error ${TOKEN}`); } });
  await assert.rejects(verify(TOKEN), (error) => error.status === 503 && !error.message.includes(TOKEN));
});

test('parallel checks share a request and bounded cache never outlives token expiry', async () => {
  let clock = 1000;
  const f = fakeProvider({ info: { ...VALID_INFO, expires_in: '10' }, now: () => clock });
  const [first, second] = await Promise.all([f.verify(TOKEN), f.verify(TOKEN)]);
  assert.deepEqual(first, second);
  assert.equal(f.calls.length, 2);
  clock = 5000;
  await f.verify(TOKEN);
  assert.equal(f.calls.length, 2);
  clock = 11000;
  await f.verify(TOKEN);
  assert.equal(f.calls.length, 4);
});

test('custom OAuth client ID is checked server-side instead of trusting claimed profile data', async () => {
  const verify = createGoogleTokenVerifier({ clientId: 'configured-client', fetcher: async (url) => new Response(JSON.stringify(url.includes('tokeninfo') ? { ...VALID_INFO, aud: 'configured-client' } : PROFILE)) });
  assert.equal((await verify(TOKEN)).email, 'verified@example.test');
});
