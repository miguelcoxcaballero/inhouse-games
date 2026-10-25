import { expect, test } from '@playwright/test';
import { installGoogleFixture } from './google-fixture';

test.beforeEach(async ({ page }) => {
  await installGoogleFixture(page, { signedIn: true });
  await page.goto('/#/client');
  await expect(page.getByTestId('join-code')).toBeVisible();
});

test('a saved host cannot replace pairing credentials before proving its identity', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const moduleUrl = '/src/lib/session.ts';
    const trustUrl = '/src/lib/trust.ts';
    const { LinkSession } = await import(moduleUrl);
    const { createCredential, saveHost, storedHosts, prove } = await import(trustUrl);
    const original = { ...createCredential('PC conocido'), deviceId: 'a'.repeat(32), lastSeen: Date.now() };
    saveHost(original);
    const session: any = new LinkSession(() => {});
    session.current = { ...session.state, role: 'viewer', status: 'connected', deviceId: original.deviceId };
    session.expectedTrustedHost = original;
    session.connectionNonce = 'fresh-nonce';
    const channel: any = { label: 'control', readyState: 'open', bufferedAmount: 0, send() {}, close() { this.readyState = 'closed'; } };
    session.bindChannel(channel);
    await channel.onmessage({ data: JSON.stringify({ type: 'trusted-device', deviceId: original.deviceId, id: 'b'.repeat(32), token: 'B'.repeat(43), name: 'Impostor' }) });
    const afterForged = storedHosts()[0];
    await channel.onmessage({ data: JSON.stringify({ type: 'host-auth', proof: await prove(original.token, `host:fresh-nonce:${original.deviceId}`) }) });
    const verified = session.trustedHostVerified;
    session.destroy();
    return { tokenUnchanged: afterForged.token === original.token, nameUnchanged: afterForged.name === original.name, verified };
  });
  expect(result).toEqual({ tokenUnchanged: true, nameUnchanged: true, verified: true });
});

test('input backpressure queues a reliable release and bounds further input until draining', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const moduleUrl = '/src/lib/session.ts';
    const { LinkSession } = await import(moduleUrl);
    const session: any = new LinkSession(() => {});
    session.current = { ...session.state, role: 'viewer', status: 'connected', controlEnabled: true };
    const sent: any[] = [];
    const channel: any = { label: 'control', readyState: 'open', bufferedAmount: 70000, send(value: string) { sent.push(JSON.parse(value)); }, close() { this.readyState = 'closed'; } };
    session.bindChannel(channel);
    session.sendInput({ kind: 'key', code: 'KeyW', down: false });
    for (let i = 0; i < 100; i++) session.sendInput({ kind: 'key', code: 'KeyW', down: true });
    const whileBlocked = structuredClone(sent);
    channel.bufferedAmount = 0;
    channel.onbufferedamountlow();
    session.sendInput({ kind: 'key', code: 'KeyD', down: true });
    const resumed = structuredClone(sent);
    session.destroy();
    return { whileBlocked, resumed };
  });
  expect(result.whileBlocked).toEqual([{ type: 'input', event: { kind: 'release' } }]);
  expect(result.resumed[1]).toEqual({ type: 'input', event: { kind: 'key', code: 'KeyD', down: true } });
});

test('revoking devices cancels enrollment and an outstanding native approval', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const moduleUrl = '/src/lib/session.ts';
    const { LinkSession } = await import(moduleUrl);
    let resolveConsent: (allowed: boolean) => void = () => {};
    (window as any).inhouseDesktop = {
      platform: 'win32', version: 'security-boundary',
      setControlEnabled: (enabled: boolean) => enabled ? new Promise<boolean>((resolve) => { resolveConsent = resolve; }) : Promise.resolve(false),
      injectInput() {}, releaseInputs() {}, captureEnded() {},
    };
    const source = document.createElement('canvas').captureStream();
    const sent: any[] = [];
    const session: any = new LinkSession(() => {});
    session.socket = { readyState: WebSocket.OPEN, send(value: string) { sent.push(JSON.parse(value)); }, close() {} };
    session.current = { ...session.state, role: 'host', status: 'hosting', localStream: source, requests: [{ id: 'first', name: 'Primer portátil' }] };
    session.approve('first', true, true);
    session.clearTrustedDevices();
    resolveConsent(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const result = { approved: sent.some((message) => message.type === 'approve'), saved: session.getTrustedDevices().length, pendingEnrollment: !!session.trustToCreate, track: source.getVideoTracks()[0].readyState };
    session.destroy();
    return result;
  });
  expect(result).toEqual({ approved: false, saved: 0, pendingEnrollment: false, track: 'ended' });
});

test('two approval clicks cannot create competing server approvals', async ({ page }) => {
  const approvals = await page.evaluate(async () => {
    const moduleUrl = '/src/lib/session.ts';
    const { LinkSession } = await import(moduleUrl);
    let resolveConsent: (allowed: boolean) => void = () => {};
    (window as any).inhouseDesktop = {
      platform: 'win32', version: 'security-boundary',
      setControlEnabled: (enabled: boolean) => enabled ? new Promise<boolean>((resolve) => { resolveConsent = resolve; }) : Promise.resolve(false),
      injectInput() {}, releaseInputs() {}, captureEnded() {},
    };
    const source = document.createElement('canvas').captureStream();
    const sent: any[] = [];
    const session: any = new LinkSession(() => {});
    session.socket = { readyState: WebSocket.OPEN, send(value: string) { sent.push(JSON.parse(value)); }, close() {} };
    session.current = { ...session.state, role: 'host', status: 'hosting', localStream: source, requests: [{ id: 'first', name: 'Uno' }, { id: 'second', name: 'Dos' }] };
    session.approve('first', true);
    session.approve('second', true);
    resolveConsent(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const approved = sent.filter((message) => message.type === 'approve');
    session.destroy();
    return approved;
  });
  expect(approvals).toEqual([{ type: 'approve', id: 'first', allow: true }]);
});
