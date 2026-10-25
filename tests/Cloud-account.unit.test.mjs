import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  CLOUD_ACCOUNT_KEY, getCloudAccount, prepareCloudAccount, createCloudAccountFromRealm,
  rememberCloudAccount, clearCloudAccount,
} from '../src/lib/cloud-account.ts';

const LIFETIME = 30 * 86400_000;
const originals = { localStorage: globalThis.localStorage, fetch: globalThis.fetch };
const profile = { id: 'drive-permission-fixture', name: 'Cuenta de prueba', email: 'fixture@example.test', photo: 'https://lh3.googleusercontent.com/fixture' };
const secret = Buffer.alloc(32, 7).toString('base64url');
const fileId = 'DriveFile_fixture-123';
const clientToken = 'ild_' + Buffer.alloc(32, 9).toString('base64url');
const realm = { accountId: profile.id, fileId, id: fileId, secret };
let memory;

function stored(overrides = {}) {
  return {
    schema: 1, accountId: profile.id, profile: { ...profile }, secret, fileId, clientToken,
    issuedAt: Date.now(), expiresAt: Date.now() + LIFETIME, ...overrides,
  };
}

function save(overrides = {}) {
  localStorage.setItem(CLOUD_ACCOUNT_KEY, JSON.stringify(stored(overrides)));
}

function assertCanonical(value) {
  assert.match(value, /^[A-Za-z0-9_-]{43}$/);
  const bytes = Buffer.from(value, 'base64url');
  assert.equal(bytes.length, 32);
  assert.equal(bytes.toString('base64url'), value);
}

beforeEach(() => {
  memory = new Map();
  globalThis.localStorage = {
    getItem: key => memory.get(key) ?? null,
    setItem: (key, value) => memory.set(key, String(value)),
    removeItem: key => memory.delete(key),
  };
  globalThis.fetch = async () => { assert.fail('This unit test did not authorize a network request'); };
});

afterEach(() => {
  for (const [key, value] of Object.entries(originals)) {
    if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
  }
});

test('a complete private cloud capability is restored as a clone without storage metadata', () => {
  save();
  const account = getCloudAccount();
  assert.deepEqual(account, { profile, secret, fileId, clientToken, expiresAt: JSON.parse(memory.get(CLOUD_ACCOUNT_KEY)).expiresAt });
  account.profile.name = 'External mutation';
  account.secret = Buffer.alloc(32, 1).toString('base64url');
  assert.equal(getCloudAccount().profile.name, profile.name);
  assert.equal(getCloudAccount().secret, secret);
  assert.equal('accountId' in account, false);
  assert.equal('issuedAt' in account, false);
});

test('an avatar, a Google grant or malformed storage cannot become a cloud capability', () => {
  const invalid = [
    null, {}, { profile }, { accessToken: 'fake-google-oauth', profile },
    { ...stored(), schema: 2 }, { ...stored(), accountId: 'another-account' },
    { ...stored(), profile: { name: profile.name, photo: profile.photo } },
  ];
  for (const value of invalid) {
    memory.set(CLOUD_ACCOUNT_KEY, JSON.stringify(value));
    assert.equal(getCloudAccount(), null);
  }
  memory.set(CLOUD_ACCOUNT_KEY, '{malformed JSON');
  assert.equal(getCloudAccount(), null);
});

test('private secrets and local client tokens must encode exactly 32 canonical bytes', () => {
  const invalidSecrets = [
    '', 'a'.repeat(42), 'a'.repeat(44), Buffer.alloc(33, 7).toString('base64url'),
    secret.slice(0, -1) + 'B', secret + '=', secret.replace(/./, '+'),
  ];
  for (const invalid of invalidSecrets) {
    save({ secret: invalid });
    assert.equal(getCloudAccount(), null);
    save({ clientToken: 'ild_' + invalid });
    assert.equal(getCloudAccount(), null);
  }
  save({ clientToken: 'ihl_' + clientToken.slice(4) });
  assert.equal(getCloudAccount(), null);
  save();
  assertCanonical(getCloudAccount().secret);
  assertCanonical(getCloudAccount().clientToken.slice(4));
});

test('invalid profile fields and file identifiers are rejected before use', () => {
  const invalidProfiles = [
    { ...profile, id: '' }, { ...profile, id: '../another-account' }, { ...profile, name: {} },
    { ...profile, email: 'not an email' }, { ...profile, photo: 'http://avatar.example.test/a' },
    { ...profile, photo: 'https://user:password@avatar.example.test/a' },
  ];
  for (const invalid of invalidProfiles) {
    save({ profile: invalid, accountId: invalid.id });
    assert.equal(getCloudAccount(), null);
  }
  for (const invalid of ['', '../file', 'file/child', 'id with spaces', 'a'.repeat(257), 42]) {
    save({ fileId: invalid });
    assert.equal(getCloudAccount(), null);
  }
});

test('restoration enforces expiry, issuance time and the thirty-day maximum lifetime', context => {
  context.mock.timers.enable({ apis: ['Date'], now: 1_800_000_000_000 });
  try {
    const now = Date.now();
    const invalid = [
      { expiresAt: now - 1 }, { expiresAt: now + 60_000 }, { expiresAt: Infinity },
      { issuedAt: now + 60_001 }, { issuedAt: -1 }, { issuedAt: NaN },
      { issuedAt: now - LIFETIME, expiresAt: now + 3600_000 },
      { issuedAt: now, expiresAt: now + LIFETIME + 1 },
    ];
    for (const value of invalid) {
      save(value);
      assert.equal(getCloudAccount(), null);
    }
    save({ issuedAt: now, expiresAt: now + LIFETIME });
    assert.ok(getCloudAccount());
    context.mock.timers.tick(LIFETIME - 60_000);
    assert.equal(getCloudAccount(), null);
  } finally { context.mock.timers.reset(); }
});

test('realm conversion binds the exact Google account and generates independent canonical client credentials', () => {
  const expiresAt = Date.now() + 86400_000;
  const first = createCloudAccountFromRealm(profile, realm, expiresAt);
  const second = createCloudAccountFromRealm(profile, realm, expiresAt);
  assert.equal(first.secret, secret);
  assert.equal(first.fileId, fileId);
  assert.equal(first.expiresAt, expiresAt);
  assertCanonical(first.clientToken.slice(4));
  assertCanonical(second.clientToken.slice(4));
  assert.notEqual(first.clientToken, second.clientToken);
  assert.equal(getCloudAccount(), null, 'conversion alone must never persist account state');
  first.profile.name = 'External mutation';
  assert.equal(profile.name, 'Cuenta de prueba');
});

test('realm conversion rejects another account, invalid capabilities and excessive expiry', () => {
  const expiresAt = Date.now() + 86400_000;
  for (const invalid of [
    { ...realm, accountId: 'another-account' }, { ...realm, id: 'different-file' },
    { ...realm, fileId: '../bad-file' }, { ...realm, secret: secret.slice(0, -1) + 'B' },
  ]) assert.throws(() => createCloudAccountFromRealm(profile, invalid, expiresAt));
  assert.throws(() => createCloudAccountFromRealm(profile, realm, Date.now() + LIFETIME + 61_000));
  assert.throws(() => createCloudAccountFromRealm(profile, realm, Date.now() + 59_000));
  assert.throws(() => createCloudAccountFromRealm(profile, realm, NaN));
});

test('only the same realm, profile and expiry reuse a remembered client credential', () => {
  const expiresAt = Date.now() + 86400_000;
  const first = createCloudAccountFromRealm(profile, realm, expiresAt);
  rememberCloudAccount(first);
  assert.equal(createCloudAccountFromRealm(profile, realm, expiresAt).clientToken, first.clientToken);
  assert.notEqual(createCloudAccountFromRealm({ ...profile, name: 'Updated profile' }, realm, expiresAt).clientToken, first.clientToken);
  assert.notEqual(createCloudAccountFromRealm(profile, { ...realm, secret: Buffer.alloc(32, 8).toString('base64url') }, expiresAt).clientToken, first.clientToken);
  assert.notEqual(createCloudAccountFromRealm(profile, realm, expiresAt - 1000).clientToken, first.clientToken);
});

test('the allowed clock margin is clamped so a remembered session never exceeds thirty days', context => {
  context.mock.timers.enable({ apis: ['Date'], now: 1_800_000_000_000 });
  try {
    const account = createCloudAccountFromRealm(profile, realm, Date.now() + LIFETIME + 30_000);
    assert.equal(account.expiresAt, Date.now() + LIFETIME);
    rememberCloudAccount(account);
    const persisted = JSON.parse(memory.get(CLOUD_ACCOUNT_KEY));
    assert.equal(persisted.expiresAt - persisted.issuedAt, LIFETIME);
  } finally { context.mock.timers.reset(); }
});

test('remember writes only the validated private capability in one atomic storage operation', () => {
  const account = createCloudAccountFromRealm(profile, realm, Date.now() + 86400_000);
  account.accessToken = 'fake-google-oauth-never-persist';
  account.profile.accessToken = 'another-fake-google-oauth';
  let writes = 0;
  localStorage.setItem = (key, value) => { writes++; memory.set(key, value); };
  rememberCloudAccount(account);
  assert.equal(writes, 1);
  const raw = memory.get(CLOUD_ACCOUNT_KEY);
  assert.equal(raw.includes('fake-google-oauth'), false);
  const persisted = JSON.parse(raw);
  assert.deepEqual(Object.keys(persisted).sort(), ['accountId', 'clientToken', 'expiresAt', 'fileId', 'issuedAt', 'profile', 'schema', 'secret']);
  assert.equal(persisted.accountId, profile.id);
  assert.deepEqual(persisted.profile, profile);
  assert.equal(persisted.schema, 1);
});

test('failed storage cannot claim a durable login and does not replace an existing capability', () => {
  save();
  const before = memory.get(CLOUD_ACCOUNT_KEY);
  const account = createCloudAccountFromRealm(profile, realm, Date.now() + 86400_000);
  localStorage.setItem = () => { throw new Error('storage denied'); };
  assert.throws(() => rememberCloudAccount(account), /guardar|almacenamiento/);
  assert.equal(memory.get(CLOUD_ACCOUNT_KEY), before);
  assert.throws(() => rememberCloudAccount({ ...account, secret: 'malformed' }));
  assert.equal(memory.get(CLOUD_ACCOUNT_KEY), before);
});

test('clear removes only this local capability without invoking Drive or changing another app', () => {
  save();
  localStorage.setItem('other-app-session', 'unrelated');
  clearCloudAccount();
  assert.equal(getCloudAccount(), null);
  assert.equal(localStorage.getItem('other-app-session'), 'unrelated');
  clearCloudAccount();
});

test('missing or unavailable local storage is safe for reads and clear but cannot remember a session', () => {
  const account = createCloudAccountFromRealm(profile, realm, Date.now() + 86400_000);
  delete globalThis.localStorage;
  assert.equal(getCloudAccount(), null);
  assert.doesNotThrow(clearCloudAccount);
  assert.throws(() => rememberCloudAccount(account), /guardar|almacenamiento/);
  globalThis.localStorage = { getItem() { throw new Error('denied'); }, removeItem() { throw new Error('denied'); } };
  assert.equal(getCloudAccount(), null);
  assert.doesNotThrow(clearCloudAccount);
});

function driveFixture(accountId = profile.id) {
  const requests = [];
  const metadata = { id: fileId, createdTime: '2026-10-25T00:00:00.000Z', ownedByMe: true, shared: false, appProperties: { 'inhouse.link.realm': '1' } };
  globalThis.fetch = async (url, request) => {
    const parsed = new URL(url);
    requests.push({ url: parsed, request });
    assert.equal(parsed.origin, 'https://www.googleapis.com');
    assert.equal(request.headers.Authorization, 'Bearer fake-google-oauth-fixture');
    assert.equal(parsed.searchParams.has('access_token'), false);
    assert.equal(request.method, undefined, 'an existing realm needs only metadata and content reads');
    let body;
    if (parsed.pathname === '/drive/v3/files') body = { files: [metadata] };
    else if (parsed.pathname === '/drive/v3/files/' + fileId && parsed.searchParams.get('alt') === 'media') body = { schema: 1, accountId, secret };
    else if (parsed.pathname === '/drive/v3/files/' + fileId) body = metadata;
    else assert.fail('Unexpected Drive endpoint');
    return new Response(JSON.stringify(body), { status: 200 });
  };
  return requests;
}

test('prepare obtains the account-bound private Drive realm but does not persist until the caller accepts it', async () => {
  const requests = driveFixture();
  const prepared = await prepareCloudAccount('fake-google-oauth-fixture', profile);
  assert.equal(requests.length, 3);
  assert.equal(prepared.secret, secret);
  assert.equal(prepared.fileId, fileId);
  assert.deepEqual(prepared.profile, profile);
  assertCanonical(prepared.clientToken.slice(4));
  assert.equal(getCloudAccount(), null);
  assert.equal(memory.size, 0);
  rememberCloudAccount(prepared);
  assert.equal(getCloudAccount().fileId, fileId);
  assert.equal(memory.get(CLOUD_ACCOUNT_KEY).includes('fake-google-oauth-fixture'), false);
});

test('prepare rejects a mismatched Drive owner without replacing the remembered local session', async () => {
  save();
  const before = memory.get(CLOUD_ACCOUNT_KEY);
  driveFixture('different-drive-account');
  await assert.rejects(prepareCloudAccount('fake-google-oauth-fixture', profile), /cuenta/);
  assert.equal(memory.get(CLOUD_ACCOUNT_KEY), before);
});
