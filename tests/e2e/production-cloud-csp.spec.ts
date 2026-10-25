import { test, expect } from '@playwright/test';
import { Aedes } from 'aedes';
import { createServer } from 'node:http';
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer, createWebSocketStream } from 'ws';

test('production security headers allow the real browser MQTT connection and its keepalive worker', async ({ browser }) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'inhouse-production-csp-'));
  const broker = await Aedes.createBroker();
  let keepalivePings = 0;
  broker.on('ping', () => { keepalivePings++; });
  const brokerHttp = createServer();
  const brokerWebSocket = new WebSocketServer({ server: brokerHttp });
  brokerWebSocket.on('connection', socket => broker.handle(createWebSocketStream(socket)));
  await new Promise<void>(resolve => brokerHttp.listen(0, '127.0.0.1', resolve));
  const brokerPort = (brokerHttp.address() as { port: number }).port;
  await writeFile(path.join(temporary, 'index.html'), '<!doctype html><html lang="es"><title>inhouse production CSP</title><body>Production transport check</body></html>');
  await copyFile(path.resolve('node_modules/mqtt/dist/mqtt.esm.js'), path.join(temporary, 'mqtt.js'));
  const serverModule = '../../server/index.mjs';
  const { createSignalingServer } = await import(serverModule);
  const application = createSignalingServer({ host: '127.0.0.1', port: 0, staticDir: temporary, env: { NODE_ENV: 'production' } });
  const address = await application.listen();
  const context = await browser.newContext();
  const page = await context.newPage();
  const workerErrors: string[] = [];
  page.on('pageerror', error => workerErrors.push(error.message));
  try {
    const response = await page.goto(`http://127.0.0.1:${address.port}/`);
    const policy = response!.headers()['content-security-policy'];
    expect(policy).toContain('https://accounts.google.com');
    expect(policy).toMatch(/connect-src[^;]*wss:/);
    const result = await page.evaluate(async brokerUrl => {
      const moduleUrl = '/mqtt.js';
      const { default: mqtt } = await import(moduleUrl);
      const blobWorker = await new Promise<boolean>(resolve => {
        const source = URL.createObjectURL(new Blob(["self.postMessage('worker-ready')"], { type: 'text/javascript' }));
        try {
          const worker = new Worker(source);
          const finish = (allowed: boolean) => { clearTimeout(timeout); worker.terminate(); URL.revokeObjectURL(source); resolve(allowed); };
          const timeout = setTimeout(() => finish(false), 1000);
          worker.onmessage = () => finish(true);
          worker.onerror = () => finish(false);
        } catch { URL.revokeObjectURL(source); resolve(false); }
      });
      return new Promise<{ connected: boolean; received: boolean; blobWorker: boolean }>(resolve => {
        let connected = false;
        let received = false;
        const topic = `inhouse-production-test/${crypto.randomUUID()}`;
        const client = mqtt.connect(brokerUrl, {
          clientId: `csp-${crypto.randomUUID().replaceAll('-', '').slice(0, 19)}`,
          username: 'public', password: 'public', protocolVersion: 4,
          reconnectPeriod: 0, connectTimeout: 3000, keepalive: 2,
        });
        const finish = () => { clearTimeout(timer); client.end(true); resolve({ connected, received, blobWorker }); };
        const timer = setTimeout(finish, 6500);
        client.on('error', () => {});
        client.on('connect', () => {
          connected = true;
          client.subscribe(topic, { qos: 1 }, (error: Error | null) => {
            if (error) finish();
            else client.publish(topic, 'production-loopback-probe', { qos: 1 });
          });
        });
        client.on('message', (_topic: string, value: Uint8Array) => {
          if (new TextDecoder().decode(value) === 'production-loopback-probe') received = true;
        });
      });
    }, `ws://127.0.0.1:${brokerPort}`);
    expect(keepalivePings).toBeGreaterThanOrEqual(2);
    expect(result).toEqual({ connected: true, received: true, blobWorker: true });
    expect(workerErrors).toEqual([]);
  } finally {
    await context.close();
    await application.close();
    for (const client of brokerWebSocket.clients) client.terminate();
    await new Promise<void>(resolve => broker.close(resolve));
    await new Promise<void>(resolve => brokerWebSocket.close(() => resolve()));
    await new Promise<void>(resolve => brokerHttp.close(() => resolve()));
    await rm(temporary, { recursive: true, force: true });
  }
});
