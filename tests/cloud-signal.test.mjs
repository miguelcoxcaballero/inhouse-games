import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import net from 'node:net';
import { Aedes } from 'aedes';
import { connect } from 'mqtt';
import { CloudHub } from '../src/lib/cloud-signal.ts';
import { decryptRealmPacket, encryptRealmPacket, verifyAccountPeerProof } from '../server/drive-realm.mjs';

const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function until(condition, timeout = 4000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await condition();
    if (value) return value;
    await pause(15);
  }
  throw new Error('Timed out waiting for the real MQTT peers.');
}
async function signer() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const publicKey = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const { crv, kty, x, y } = publicKey;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify({ crv, kty, x, y })));
  const deviceId = Buffer.from(digest).toString('hex').slice(0, 32);
  return async nonce => ({ deviceId, identity: { publicKey, signature: Buffer.from(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, new TextEncoder().encode(nonce))).toString('base64url') } });
}
function account(secret = randomBytes(32).toString('base64url'), id = 'drive-account-test') {
  return {
    profile: { id, name: 'Private Google profile', email: 'private-profile@example.test', photo: '' },
    secret, expiresAt: Date.now() + 86400000, fileId: 'private-drive-file', clientToken: `ild_${randomBytes(32).toString('base64url')}`,
  };
}
async function fixture(t) {
  const broker = await Aedes.createBroker();
  const server = net.createServer(broker.handle);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `mqtt://127.0.0.1:${server.address().port}`;
  const captured = [];
  broker.on('publish', (packet, client) => {
    if (client && packet.payload.length) captured.push({ topic: packet.topic, payload: Buffer.from(packet.payload), qos: packet.qos, retain: packet.retain });
  });
  const hubs = [];
  const make = async (capability = account(), extra = {}) => {
    const identityProvider = await signer();
    let current = capability;
    let mqttClient;
    const hub = new CloudHub(capability, {
      brokerUrl: `ws://127.0.0.1:${server.address().port}`,
      brokerFactory: (_url, options) => { mqttClient = connect(endpoint, { ...options, reconnectPeriod: 0 }); return mqttClient; },
      identityProvider, accountProvider: () => current, heartbeatMs: 100, presenceTtlMs: 1200, connectTimeoutMs: 3000, ...extra,
    });
    const states = [];
    const unsubscribe = hub.subscribeDevices(state => states.push(state));
    hubs.push(hub);
    return { hub, capability, identityProvider, states, unsubscribe, logout: () => { current = null; }, client: () => mqttClient };
  };
  t.after(async () => {
    for (const hub of hubs) hub.dispose();
    await pause(150);
    await new Promise(resolve => broker.close(resolve));
    await new Promise(resolve => server.close(resolve));
  });
  return { broker, make, captured };
}
async function socket(peer) {
  const endpoint = await peer.hub.createSocket();
  const messages = [];
  endpoint.onmessage = event => messages.push(JSON.parse(event.data));
  const hello = await until(() => messages.find(message => message.type === 'hello'));
  assert.match(hello.nonce, /^[A-Za-z0-9_-]{43}$/);
  return { endpoint, messages, hello, take: type => until(() => messages.find(message => message.type === type)) };
}
async function host(peer, label = 'Murcia private host') {
  const result = await socket(peer);
  const identity = await peer.identityProvider(result.hello.nonce);
  const challenge = randomBytes(32).toString('base64url');
  result.endpoint.send(JSON.stringify({ type: 'host', name: label, identity: identity.identity, nativeChallenge: challenge }));
  const hosted = await result.take('hosted');
  return { ...result, hosted, challenge };
}

test('real MQTT discovery is account-isolated and every broker application payload is encrypted', async t => {
  const { make, captured } = await fixture(t);
  const capability = account();
  const source = await make(capability);
  const viewer = await make(capability);
  const outsider = await make(account(undefined, 'other-account-test'));
  const sharing = await host(source);
  const observer = await socket(outsider);
  assert.equal(observer.hello.account.id, 'other-account-test');
  await until(() => viewer.hub.snapshot.devices.find(device => device.deviceId === sharing.hosted.deviceId)?.online);
  await pause(100);
  assert.equal(outsider.hub.snapshot.devices.length, 0);
  assert.ok(captured.length > 0);
  for (const packet of captured) {
    const clear = packet.payload.toString();
    assert.deepEqual(Object.keys(JSON.parse(clear)).sort(), ['ciphertext', 'nonce', 'v']);
    for (const privateValue of [capability.profile.id, capability.profile.email, capability.profile.name, capability.secret, capability.fileId, capability.clientToken, 'Murcia private host', sharing.challenge]) {
      assert.equal(clear.includes(privateValue), false, 'Broker payload exposed an account value.');
      assert.equal(packet.topic.includes(privateValue), false, 'Broker topic exposed an account value.');
    }
  }
});

test('own-account peers auto-pair with verified native proofs, route signals and emit fresh keepalives', async t => {
  const { make } = await fixture(t);
  const capability = account();
  const source = await make(capability);
  const viewer = await make(capability);
  const sharing = await host(source);
  const watching = await socket(viewer);
  await until(() => viewer.hub.snapshot.devices.some(device => device.deviceId === sharing.hosted.deviceId && device.online));
  watching.endpoint.send(JSON.stringify({ type: 'join', code: sharing.hosted.deviceId, name: 'Valencia laptop' }));
  const hostPair = await sharing.take('paired');
  const viewerPair = await watching.take('paired');
  assert.equal(hostPair.initiator, true);
  assert.equal(viewerPair.initiator, false);
  assert.equal(hostPair.accountAuthorized, true);
  assert.equal(hostPair.connectionId, viewerPair.connectionId);
  assert.equal(await verifyAccountPeerProof(capability.secret, hostPair.accountProof, {
    expectedAccountId: capability.profile.id, expectedHostId: sharing.hosted.deviceId,
    expectedViewerId: viewer.hub.identity, expectedChallenge: sharing.challenge,
    expectedConnectionId: hostPair.connectionId, expectedPurpose: 'connect',
  }), true);
  sharing.endpoint.send(JSON.stringify({ type: 'signal', signal: { description: { type: 'offer', sdp: 'v=0\r\nprivate-real-signal-test' } } }));
  assert.equal((await watching.take('signal')).signal.description.sdp, 'v=0\r\nprivate-real-signal-test');
  const firstPulse = await sharing.take('account-keepalive');
  assert.equal(await verifyAccountPeerProof(capability.secret, firstPulse.proof, {
    expectedAccountId: capability.profile.id, expectedHostId: sharing.hosted.deviceId,
    expectedViewerId: viewer.hub.identity, expectedChallenge: sharing.challenge,
    expectedConnectionId: hostPair.connectionId, expectedPurpose: 'keepalive', minCounter: 0,
  }), true);
  await until(() => sharing.messages.filter(message => message.type === 'account-keepalive').length >= 2);
  const pulses = sharing.messages.filter(message => message.type === 'account-keepalive');
  assert.ok(pulses[1].proof.counter > pulses[0].proof.counter);
  watching.endpoint.close();
  await sharing.take('peer-left');
  assert.equal(sharing.endpoint.role, 'host');
  await until(() => source.hub.snapshot.devices.find(device => device.deviceId === sharing.hosted.deviceId)?.busy === false);
});

test('encrypted MQTT replay and ciphertext tampering do not redeliver a signal', async t => {
  const { make, broker, captured } = await fixture(t);
  const capability = account();
  const source = await make(capability);
  const viewer = await make(capability);
  const sharing = await host(source);
  const watching = await socket(viewer);
  await until(() => viewer.hub.snapshot.devices.some(device => device.online));
  watching.endpoint.send(JSON.stringify({ type: 'join', code: sharing.hosted.deviceId }));
  await watching.take('paired'); await sharing.take('paired');
  const before = captured.length;
  sharing.endpoint.send(JSON.stringify({ type: 'signal', signal: { description: { type: 'offer', sdp: 'v=0\r\nunique-sdp' } } }));
  await watching.take('signal');
  const originals = captured.slice(before).filter(packet => packet.topic.endsWith(`/inbox/${watching.endpoint.id}`));
  assert.ok(originals.length);
  for (const packet of originals) {
    await new Promise((resolve, reject) => broker.publish({ ...packet, retain: false, dup: false }, error => error ? reject(error) : resolve()));
    const corrupt = JSON.parse(packet.payload.toString());
    corrupt.ciphertext = (corrupt.ciphertext[0] === 'A' ? 'B' : 'A') + corrupt.ciphertext.slice(1);
    await new Promise((resolve, reject) => broker.publish({ ...packet, payload: Buffer.from(JSON.stringify(corrupt)), retain: false, dup: false }, error => error ? reject(error) : resolve()));
  }
  await pause(200);
  assert.equal(watching.messages.filter(message => message.type === 'signal').length, 1);
});

test('logout announces offline immediately and abrupt transport loss expires presence', async t => {
  const { make } = await fixture(t);
  const capability = account();
  const source = await make(capability);
  const viewer = await make(capability);
  const sharing = await host(source);
  await until(() => viewer.hub.snapshot.devices.find(device => device.deviceId === sharing.hosted.deviceId)?.online);
  source.logout();
  await until(() => source.hub.closed);
  await until(() => viewer.hub.snapshot.devices.find(device => device.deviceId === sharing.hosted.deviceId)?.online === false);
  const second = await make(capability, { heartbeatMs: 100, presenceTtlMs: 500 });
  const secondHost = await host(second, 'Second host');
  await until(() => viewer.hub.snapshot.devices.find(device => device.deviceId === secondHost.hosted.deviceId)?.online);
  second.client().end(true);
  await until(() => viewer.hub.snapshot.devices.find(device => device.deviceId === secondHost.hosted.deviceId)?.online === false, 3000);
});

test('a packet with valid account encryption but a modified signed body cannot replace a host identity', async t => {
  const { make, broker, captured } = await fixture(t);
  const capability = account();
  const source = await make(capability);
  const viewer = await make(capability);
  const sharing = await host(source, 'Authentic host name');
  await until(() => viewer.hub.snapshot.devices.find(device => device.deviceId === sharing.hosted.deviceId)?.online);
  const presence = captured.find(packet => packet.topic.endsWith(`/presence/${sharing.endpoint.id}`));
  assert.ok(presence);
  const signed = await decryptRealmPacket(capability.secret, presence.topic, JSON.parse(presence.payload.toString()));
  signed.body.id = crypto.randomUUID();
  signed.body.sentAt = Date.now();
  signed.body.data.sequence = 1000000;
  signed.body.data.name = 'Forged host identity';
  const encrypted = await encryptRealmPacket(capability.secret, presence.topic, signed);
  await new Promise((resolve, reject) => broker.publish({ topic: presence.topic, payload: Buffer.from(JSON.stringify(encrypted)), qos: 1, retain: false, dup: false }, error => error ? reject(error) : resolve()));
  await pause(200);
  assert.equal(viewer.hub.snapshot.devices.find(device => device.deviceId === sharing.hosted.deviceId).name, 'Authentic host name');
});

test('closing a pending viewer during real HMAC verification cannot resurrect its pair or keepalive timer', async t => {
  const { make } = await fixture(t);
  const capability = account();
  const source = await make(capability);
  const viewer = await make(capability);
  const sharing = await host(source);
  const watching = await socket(viewer);
  await until(() => viewer.hub.snapshot.devices.some(device => device.online));
  const original = crypto.subtle.verify;
  let hmacCalls = 0;
  let entered;
  let release;
  const gated = new Promise(resolve => { entered = resolve; });
  const resume = new Promise(resolve => { release = resolve; });
  crypto.subtle.verify = async function (algorithm, ...arguments_) {
    if ((typeof algorithm === 'string' ? algorithm : algorithm.name) === 'HMAC' && ++hmacCalls === 2) {
      entered();
      await resume;
    }
    return original.call(this, algorithm, ...arguments_);
  };
  try {
    watching.endpoint.send(JSON.stringify({ type: 'join', code: sharing.hosted.deviceId }));
    await Promise.race([gated, pause(4000).then(() => { throw new Error('HMAC race gate was not reached.'); })]);
    watching.endpoint.close();
    await sharing.take('peer-left');
    release();
    await pause(150);
    assert.equal(watching.endpoint.readyState, 3);
    assert.equal(watching.endpoint.pair, null);
    assert.equal(watching.endpoint.pulseTimer, null);
  } finally { release(); crypto.subtle.verify = original; }
});

test('concurrent local host registrations remain exclusive after asynchronous signature verification', async t => {
  const { make } = await fixture(t);
  const source = await make(account());
  const first = await socket(source);
  const second = await socket(source);
  const identities = await Promise.all([source.identityProvider(first.hello.nonce), source.identityProvider(second.hello.nonce)]);
  const nonces = new Set([first.hello.nonce, second.hello.nonce]);
  const original = crypto.subtle.verify;
  let verifying = 0;
  let entered;
  let release;
  const gated = new Promise(resolve => { entered = resolve; });
  const resume = new Promise(resolve => { release = resolve; });
  crypto.subtle.verify = async function (algorithm, ...arguments_) {
    const value = arguments_[2];
    if ((typeof algorithm === 'string' ? algorithm : algorithm.name) === 'ECDSA' && nonces.has(new TextDecoder().decode(value))) {
      if (++verifying === 2) entered();
      await resume;
    }
    return original.call(this, algorithm, ...arguments_);
  };
  try {
    for (const [index, candidate] of [first, second].entries()) candidate.endpoint.send(JSON.stringify({ type: 'host', name: `Host ${index}`, identity: identities[index].identity, nativeChallenge: randomBytes(32).toString('base64url') }));
    await Promise.race([gated, pause(4000).then(() => { throw new Error('Signature race gate was not reached.'); })]);
    release();
    await until(() => [...first.messages, ...second.messages].some(message => message.type === 'error'));
    await pause(100);
    assert.equal([first, second].filter(candidate => candidate.endpoint.role === 'host').length, 1);
    assert.equal([...first.messages, ...second.messages].filter(message => message.type === 'hosted').length, 1);
  } finally { release(); crypto.subtle.verify = original; }
});
