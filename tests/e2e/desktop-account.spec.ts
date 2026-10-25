import { test, expect } from '@playwright/test';
import http from 'node:http';
import { createRequire } from 'node:module';
import { installGoogleFixture, GOOGLE_TEST_TOKEN } from './google-fixture';

const require = createRequire(import.meta.url);
const { createDesktopGoogleAuth } = require('../../desktop/google-auth.cjs');

test('the external browser broker hands Google access to Windows through an encrypted callback', async ({ page }) => {
  const auth = createDesktopGoogleAuth();
  const server = http.createServer((request, response) => {
    void auth.handleRequest(request, response).then((handled: boolean) => {
      if (!handled) { response.writeHead(404); response.end(); }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(48715, '127.0.0.1', resolve);
  });
  const attempt = auth.begin();
  // Attach a rejection handler immediately so teardown cancellation cannot cause
  // an unhandled rejection if a preceding UI assertion fails.
  const completed = attempt.promise.then((session: any) => ({ session }), (error: Error) => ({ error }));
  const requestUrls: string[] = [];
  page.on('request', request => requestUrls.push(request.url()));
  try {
    await installGoogleFixture(page, { mockServiceSession: false });
    await page.goto('/' + new URL(attempt.url).hash);
    await expect(page.getByRole('button', { name: 'Entrar con Google', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Entrar con Google', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Continuar en Windows' })).toBeEnabled();
    await page.getByRole('button', { name: 'Continuar en Windows' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Ya puedes volver a Inhouse Link.');
    const result = await completed;
    expect(result.error).toBeUndefined();
    expect(result.session.accessToken).toBe(GOOGLE_TEST_TOKEN);
    expect(result.session.expiresAt).toBeGreaterThan(Date.now());
    expect(page.url()).toBe('http://127.0.0.1:48715/auth/google/callback');
    expect(requestUrls.every(url => !url.includes(GOOGLE_TEST_TOKEN))).toBe(true);
  } finally {
    auth.cancel();
    await completed;
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeIdleConnections?.(); });
  }
});

test('the broker refuses a fabricated callback before attempting Google sign-in', async ({ page }) => {
  await installGoogleFixture(page);
  await page.goto('/#/desktop-auth?state=invalid&callback=https://evil.example.test/callback');
  await expect(page.getByRole('alert')).toContainText('solicitud no es válida');
  await expect(page.getByRole('button', { name: 'Entrar con Google', exact: true })).toHaveCount(0);
});
