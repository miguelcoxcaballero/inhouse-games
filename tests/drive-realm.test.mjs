import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
  obtainDriveRealm, deriveRealmTopic, encryptRealmPacket, decryptRealmPacket,
  createAccountPeerProof, verifyAccountPeerProof,
} from '../server/drive-realm.mjs';

const PROFILE = { id: 'google-drive-permission-owner' };
const ACCESS_TOKEN = 'ya29.test-only-drive-token';
const marker = { 'inhouse.link.realm': '1' };
const secret = () => randomBytes(32).toString('base64url');
const contents = (key = secret(), accountId = PROFILE.id) => ({ schema: 1, accountId, secret: key });
const metadata = (id = 'realm-file-1', extra = {}) => ({
  id, createdTime: '2026-10-25T10:00:00.000Z', ownedByMe: true, shared: false,
  appProperties: marker, size: '150', ...extra,
});

function driveFixture({ files = [metadata()], documents, listPages, onCreate, onMetadata, onMedia } = {}) {
  const calls = [];
  const stored = new Map(documents ?? files.map((file) => [file.id, contents()]));
  let current = [...files];
  const fetcher = async (input, init = {}) => {
    const url = new URL(input);
    calls.push({ url, init });
    assert.equal(url.protocol, 'https:');
    assert.equal(url.hostname, 'www.googleapis.com');
    assert.equal(init.headers.Authorization, `Bearer ${ACCESS_TOKEN}`);
    assert.equal(init.redirect, 'error');
    assert.equal(init.cache, 'no-store');
    assert.ok(init.signal instanceof AbortSignal);
    assert.ok(!url.toString().includes(ACCESS_TOKEN));
    if (url.pathname === '/drive/v3/files') {
      assert.match(url.searchParams.get('q'), /'me' in owners/);
      assert.match(url.searchParams.get('q'), /trashed = false/);
      assert.match(url.searchParams.get('q'), /inhouse\.link\.realm/);
      assert.match(url.searchParams.get('fields'), /ownedByMe/);
      assert.match(url.searchParams.get('fields'), /shared/);
      return Response.json(listPages ? listPages(url.searchParams.get('pageToken')) : { files: current });
    }
    if (url.pathname === '/upload/drive/v3/files') {
      assert.equal(init.method, 'POST');
      assert.equal(url.searchParams.get('uploadType'), 'multipart');
      const boundary = /boundary=([^;]+)/.exec(init.headers['Content-Type'])[1];
      const parts = init.body.split(`--${boundary}`).slice(1, -1).map((part) => JSON.parse(part.split('\r\n\r\n')[1].trim()));
      const [uploadMetadata, document] = parts;
      assert.equal(uploadMetadata.mimeType, 'application/json');
      assert.deepEqual(uploadMetadata.appProperties, marker);
      assert.equal(uploadMetadata.permissions, undefined);
      assert.equal(uploadMetadata.parents, undefined);
      assert.equal(document.accountId, PROFILE.id);
      assert.match(document.secret, /^[A-Za-z0-9_-]{43}$/);
      const created = metadata('new-private-realm', { createdTime: '2026-10-25T11:00:00.000Z' });
      stored.set(created.id, document);
      current = [...current, created];
      onCreate?.({ created, document, metadata: uploadMetadata, files: current, stored });
      return Response.json(created);
    }
    const id = decodeURIComponent(url.pathname.split('/').at(-1));
    const file = current.find((item) => item.id === id);
    if (!file) return Response.json({ error: 'not found' }, { status: 404 });
    if (url.searchParams.get('alt') === 'media') return onMedia ? onMedia(file, stored.get(id)) : Response.json(stored.get(id));
    return Response.json(onMetadata ? onMetadata(file) : file);
  };
  return { calls, stored, fetcher };
}

test('existing private owned realm is read without modifying Drive or exposing access tokens in URLs', async () => {
  const key = secret();
  const f = driveFixture({ documents: [['realm-file-1', contents(key)]] });
  const realm = await obtainDriveRealm(ACCESS_TOKEN, PROFILE, { fetcher: f.fetcher });
  assert.deepEqual(realm, { id: 'realm-file-1', fileId: 'realm-file-1', accountId: PROFILE.id, secret: key });
  assert.equal(f.calls.length, 3);
  assert.ok(f.calls.every(({ init }) => init.method === undefined));
  assert.equal(f.calls.filter(({ url }) => url.searchParams.get('alt') === 'media').length, 1);
});

test('empty account creates exactly one private app file and reuses it on later calls', async () => {
  const f = driveFixture({ files: [] });
  const options = { fetcher: f.fetcher, settleAttempts: 1, settleDelayMs: 0 };
  const realm = await obtainDriveRealm(ACCESS_TOKEN, PROFILE, options);
  assert.equal(realm.fileId, 'new-private-realm');
  const again = await obtainDriveRealm(ACCESS_TOKEN, PROFILE, options);
  assert.deepEqual(again, realm);
  const writes = f.calls.filter(({ init }) => init.method === 'POST');
  assert.equal(writes.length, 1);
  assert.ok(!writes[0].init.body.includes(ACCESS_TOKEN));
  assert.ok(!writes[0].init.body.includes('permissions'));
  assert.ok(f.calls.every(({ url }) => !url.pathname.includes('permissions')));
});

test('concurrent creators converge on the oldest private realm, not necessarily their new file', async () => {
  const canonicalSecret = secret();
  const f = driveFixture({ files: [], onCreate({ files, stored }) {
    files.push(metadata('older-racing-realm', { createdTime: '2026-10-25T09:00:00.000Z' }));
    stored.set('older-racing-realm', contents(canonicalSecret));
  } });
  const realm = await obtainDriveRealm(ACCESS_TOKEN, PROFILE, { fetcher: f.fetcher, settleAttempts: 2, settleDelayMs: 0 });
  assert.equal(realm.fileId, 'older-racing-realm');
  assert.equal(realm.secret, canonicalSecret);
  assert.equal(f.calls.filter(({ url }) => url.searchParams.get('alt') === 'media')[0].url.pathname, '/drive/v3/files/older-racing-realm');
});

test('pagination and a deterministic ID tie-breaker select the same canonical realm', async () => {
  const first = metadata('z-realm');
  const canonical = metadata('A-realm');
  const f = driveFixture({ files: [first, canonical], listPages(pageToken) {
    return pageToken ? { files: [canonical] } : { files: [first], nextPageToken: 'page-2' };
  } });
  const realm = await obtainDriveRealm(ACCESS_TOKEN, PROFILE, { fetcher: f.fetcher });
  assert.equal(realm.fileId, canonical.id);
  assert.equal(f.calls.filter(({ url }) => url.pathname === '/drive/v3/files').length, 2);
});

test('foreign, shared, unmarked and unknown-privacy metadata are rejected before reading file content', async () => {
  for (const override of [{ ownedByMe: false }, { ownedByMe: undefined }, { shared: true }, { shared: undefined }, { appProperties: {} }]) {
    const f = driveFixture({ files: [metadata('untrusted-file', override)] });
    await assert.rejects(obtainDriveRealm(ACCESS_TOKEN, PROFILE, { fetcher: f.fetcher }), /privado/);
    assert.equal(f.calls.length, 1);
  }
});

test('privacy is checked again after listing so a newly shared realm is never read', async () => {
  const f = driveFixture({ onMetadata: (file) => ({ ...file, shared: true }) });
  await assert.rejects(obtainDriveRealm(ACCESS_TOKEN, PROFILE, { fetcher: f.fetcher }), /privado/);
  assert.equal(f.calls.filter(({ url }) => url.searchParams.get('alt') === 'media').length, 0);
});

test('malformed account data and malformed secret cannot establish a realm', async () => {
  for (const document of [contents(secret(), 'another-account'), { ...contents(), schema: 2 }, { ...contents(), secret: 'too-short' }, null]) {
    const f = driveFixture({ documents: [['realm-file-1', document]] });
    await assert.rejects(obtainDriveRealm(ACCESS_TOKEN, PROFILE, { fetcher: f.fetcher }));
  }
});

test('media size and incomplete/repeated pagination fail closed without creating or reading another file', async () => {
  const oversized = driveFixture({ files: [metadata('huge-file', { size: '9000000' })] });
  await assert.rejects(obtainDriveRealm(ACCESS_TOKEN, PROFILE, { fetcher: oversized.fetcher }), /tamaño/);
  assert.equal(oversized.calls.filter(({ url }) => url.searchParams.get('alt') === 'media').length, 0);
  const hugeBody = driveFixture({ onMedia: () => new Response('x'.repeat(5000)) });
  await assert.rejects(obtainDriveRealm(ACCESS_TOKEN, PROFILE, { fetcher: hugeBody.fetcher }), /grande/);
  const incomplete = driveFixture({ listPages: () => ({ files: [metadata()], nextPageToken: 'repeat-page' }) });
  await assert.rejects(obtainDriveRealm(ACCESS_TOKEN, PROFILE, { fetcher: incomplete.fetcher }), /lista/);
  assert.ok(incomplete.calls.every(({ url }) => url.pathname === '/drive/v3/files'));
});

test('fetch errors are sanitized and an aborted Drive request cannot silently create a realm', async () => {
  await assert.rejects(obtainDriveRealm(ACCESS_TOKEN, PROFILE, { fetcher: async () => { throw new Error(`network details ${ACCESS_TOKEN}`); } }), (error) => !error.message.includes(ACCESS_TOKEN));
  const abort = new AbortController();
  abort.abort();
  let writes = 0;
  const fetcher = async (_url, init) => { if (init.method === 'POST') writes++; init.signal.throwIfAborted(); return Response.json({ files: [] }); };
  await assert.rejects(obtainDriveRealm(ACCESS_TOKEN, PROFILE, { fetcher, signal: abort.signal }));
  assert.equal(writes, 0);
});

test('real AES-GCM encrypts packets and binds them to the exact broker channel', async () => {
  const key = secret();
  const channel = await deriveRealmTopic(key);
  assert.match(channel, /^inhouse\/link\/v1\/[a-f0-9]{64}$/);
  assert.equal(await deriveRealmTopic(key), channel);
  assert.notEqual(await deriveRealmTopic(secret()), channel);
  const payload = { type: 'offer', sdp: 'private-offer', sender: 'device-a' };
  const first = await encryptRealmPacket(key, channel, payload);
  const second = await encryptRealmPacket(key, channel, payload);
  assert.match(first.nonce, /^[A-Za-z0-9_-]{16}$/);
  assert.notEqual(first.nonce, second.nonce);
  assert.ok(!JSON.stringify(first).includes(payload.sdp));
  assert.deepEqual(await decryptRealmPacket(key, channel, first), payload);
  await assert.rejects(decryptRealmPacket(key, `${channel}/other`, first));
  await assert.rejects(decryptRealmPacket(secret(), channel, first));
  const corrupt = first.ciphertext.slice(0, -2) + (first.ciphertext.at(-2) === 'A' ? 'B' : 'A') + first.ciphertext.at(-1);
  await assert.rejects(decryptRealmPacket(key, channel, { ...first, ciphertext: corrupt }));
});

test('packet and nonce limits reject broker garbage before unbounded decoding', async () => {
  const key = secret();
  const packet = await encryptRealmPacket(key, 'channel', { hello: 'world' });
  await assert.rejects(decryptRealmPacket(key, 'channel', { ...packet, v: 2 }));
  await assert.rejects(decryptRealmPacket(key, 'channel', { ...packet, nonce: 'A'.repeat(1000000) }));
  await assert.rejects(decryptRealmPacket(key, 'channel', { ...packet, ciphertext: 'A'.repeat(1000000) }));
  await assert.rejects(encryptRealmPacket(key, 'channel', 'x'.repeat(5000), { maxPacketBytes: 1000 }));
  await assert.rejects(decryptRealmPacket(key, 'channel', packet, { maxPacketBytes: 1 }));
});

function proofFields(extra = {}) {
  return { accountId: PROFILE.id, hostId: 'host-device', viewerId: 'viewer-device', connectionId: 'connection-1', challenge: secret(), issuedAt: Date.now(), counter: 0, purpose: 'connect', ...extra };
}

test('native proofs bind every identity, challenge, purpose and counter using real HMAC', async () => {
  const key = secret();
  const fields = proofFields();
  const proof = await createAccountPeerProof(key, fields);
  assert.match(proof.proof, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(await verifyAccountPeerProof(key, proof, { expected: fields }), true);
  for (const [field, value] of Object.entries({ accountId: 'different-account', hostId: 'different-host', viewerId: 'different-viewer', connectionId: 'different-connection', challenge: secret(), issuedAt: fields.issuedAt + 1, counter: 1, purpose: 'keepalive' })) {
    assert.equal(await verifyAccountPeerProof(key, { ...proof, [field]: value }), false, field);
  }
  assert.equal(await verifyAccountPeerProof(secret(), proof), false);
  assert.equal(await verifyAccountPeerProof(key, proof, { expectedAccountId: 'another-account' }), false);
});

test('fresh receiver challenges, monotonic counters and freshness limits reject replays', async () => {
  const key = secret();
  const now = Date.now();
  const fields = proofFields({ purpose: 'keepalive', issuedAt: now, counter: 8 });
  const proof = await createAccountPeerProof(key, fields);
  assert.equal(await verifyAccountPeerProof(key, proof, { expectedChallenge: fields.challenge, minCounter: 7, now }), true);
  assert.equal(await verifyAccountPeerProof(key, proof, { expectedChallenge: fields.challenge, minCounter: 8, now }), false);
  assert.equal(await verifyAccountPeerProof(key, proof, { expectedChallenge: secret(), now }), false);
  assert.equal(await verifyAccountPeerProof(key, proof, { now: now + 60_001 }), false);
  assert.equal(await verifyAccountPeerProof(key, proof, { now: now - 5001 }), false);
  assert.equal(await verifyAccountPeerProof(key, proof, { minCounter: NaN }), false);
  await assert.rejects(createAccountPeerProof(key, { ...fields, counter: Number.MAX_SAFE_INTEGER + 1 }));
  await assert.rejects(createAccountPeerProof(key, { ...fields, counter: undefined }));
});
