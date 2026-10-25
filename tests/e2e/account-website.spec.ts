import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { installGoogleFixture, GOOGLE_TEST_PROFILE, GOOGLE_TEST_SESSION_KEY } from './google-fixture';

test('the web client requires Google and uses the shared Notes/Read client and scope', async ({ page }) => {
  await installGoogleFixture(page);
  await page.goto('/#/client');
  const login = page.getByTestId('login-google');
  await expect(login).toBeEnabled();
  await expect(page.getByTestId('join-code')).toHaveCount(0);
  await login.click();
  await expect(page.getByTestId('join-code')).toBeVisible();
  const init = await page.evaluate(() => (window as any).__googleInitCalls[0]);
  expect(init).toEqual({
    client_id: '435784295430-cmug30o42f1vu4ijgor9sjb0ro4oo37o.apps.googleusercontent.com',
    scope: 'https://www.googleapis.com/auth/drive.file',
  });
  expect(await page.evaluate(() => (window as any).__googleTokenRequests[0].prompt)).toBe('select_account');
  await page.getByTestId('account-menu').click();
  await expect(page.getByRole('menu')).toContainText(GOOGLE_TEST_PROFILE.email);
  await page.getByTestId('account-signout').click();
  await expect(login).toBeEnabled();
  await expect(page.getByTestId('join-code')).toHaveCount(0);
  expect(await page.evaluate(key => localStorage.getItem(key), GOOGLE_TEST_SESSION_KEY)).toBeNull();
  await page.reload();
  await expect(login).toBeEnabled();
  await expect(page.getByTestId('join-code')).toHaveCount(0);
});

test('a remembered profile with a rejected Google session cannot enter the client', async ({ page }) => {
  await installGoogleFixture(page, { signedIn: true, rejectProfile: true });
  await page.goto('/#/client');
  await expect(page.getByTestId('login-error')).toContainText('caducado');
  await expect(page.getByTestId('join-code')).toHaveCount(0);
  expect(await page.evaluate(key => localStorage.getItem(key), GOOGLE_TEST_SESSION_KEY)).toBeNull();
});

test('Google denial keeps the login gate and reports a retryable error', async ({ page }) => {
  await installGoogleFixture(page, { error: 'access_denied' });
  await page.goto('/#/client');
  const login = page.getByTestId('login-google');
  await expect(login).toBeEnabled();
  await login.click();
  await expect(page.getByTestId('login-error')).toContainText('Google no autorizó');
  await expect(login).toBeEnabled();
  await expect(page.getByTestId('join-code')).toHaveCount(0);
});

test('switching Google accounts isolates remembered devices and host identities', async ({ page }) => {
  const secondToken = 'e2e-google-access-token-second-account';
  const secondProfile = { id: 'e2e-second-account', name: 'Segunda cuenta', email: 'second-account@example.test', photo: '' };
  await installGoogleFixture(page, { signedIn: true, accounts: { [secondToken]: secondProfile } });
  await page.goto('/#/client');
  await expect(page.getByTestId('join-code')).toBeVisible();
  const firstIdentity = await page.evaluate(async () => {
    const moduleUrl = '/src/lib/trust.ts';
    const trust = await import(moduleUrl);
    trust.saveHost({ ...trust.createCredential('PC de la primera cuenta'), deviceId: 'a'.repeat(32), lastSeen: Date.now() });
    return (await trust.identityForNonce('first-account-challenge')).deviceId;
  });
  await page.getByTestId('account-menu').click();
  await page.getByTestId('account-signout').click();
  await page.evaluate(token => { (window as any).__googleNextToken = token; }, secondToken);
  await page.getByTestId('login-google').click();
  await expect(page.getByTestId('join-code')).toBeVisible();
  const other = await page.evaluate(async () => {
    const moduleUrl = '/src/lib/trust.ts';
    const trust = await import(moduleUrl);
    return { hosts: trust.getTrustedHosts(), identity: (await trust.identityForNonce('second-account-challenge')).deviceId };
  });
  expect(other.hosts).toEqual([]);
  expect(other.identity).not.toBe(firstIdentity);
  await page.getByTestId('account-menu').click();
  await expect(page.getByRole('menu')).toContainText(secondProfile.email);
});

test('downloads are public and expose only validated release assets with published checksums', async ({ page }) => {
  await installGoogleFixture(page);
  const content = Buffer.from('inhouse-link-release-download-fixture');
  const checksum = createHash('sha256').update(content).digest('hex');
  const manifest = {
    version: '0.2.0', tag: 'v0.2.0-e2e', publishedAt: '2026-10-25T10:00:00Z',
    downloads: {
      windows: { url: '/downloads/release-fixture.exe', sha256: checksum, size: content.length },
      web: { url: '/downloads/release-fixture-web.zip', sha256: checksum, size: content.length },
      source: { url: '/downloads/release-fixture-source.zip', sha256: checksum, size: content.length },
    },
  };
  await page.route('**/release.json', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(manifest) }));
  await page.route('**/downloads/release-fixture.exe', route => route.fulfill({
    status: 200, contentType: 'application/octet-stream',
    headers: { 'Content-Disposition': 'attachment; filename=Inhouse-Link-Windows.exe' }, body: content,
  }));
  await page.goto('/#/downloads');
  await expect(page.getByTestId('downloads-page')).toBeVisible();
  await expect(page.getByText('Versión 0.2.0', { exact: true })).toBeVisible();
  for (const kind of ['windows', 'web', 'source']) {
    await expect(page.getByTestId(`download-${kind}`)).toHaveAttribute('href', new URL(manifest.downloads[kind as keyof typeof manifest.downloads].url, 'http://127.0.0.1:5173').href);
  }
  await expect(page.locator('code').filter({ hasText: checksum })).toHaveCount(3);
  expect(await page.evaluate(key => localStorage.getItem(key), GOOGLE_TEST_SESSION_KEY)).toBeNull();
  const downloaded = page.waitForEvent('download');
  await page.getByTestId('download-windows').click();
  const download = await downloaded;
  expect(download.suggestedFilename()).toBe('Inhouse-Link-Windows.exe');
  expect(await download.failure()).toBeNull();
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  expect(createHash('sha256').update(Buffer.concat(chunks)).digest('hex')).toBe(checksum);
  await mkdir('artifacts/screenshots', { recursive: true });
  await page.screenshot({ path: 'artifacts/screenshots/inhouse-link-downloads.png', fullPage: true });
});

test('invalid release metadata never offers an unsafe executable link', async ({ page }) => {
  await installGoogleFixture(page);
  await page.route('**/release.json', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
    version: '0.2.0', tag: 'invalid-fixture', downloads: {
      windows: { url: 'javascript:alert(1)', sha256: 'f'.repeat(64), size: 123 },
      web: { url: 'https://example.test/unverified.zip', sha256: 'not-a-checksum', size: 123 },
    },
  }) }));
  await page.goto('/#/downloads');
  await expect(page.getByTestId('downloads-page')).toBeVisible();
  await expect(page.getByTestId('download-windows')).toHaveCount(0);
  await expect(page.getByTestId('download-web')).toHaveCount(0);
  await expect(page.getByTestId('download-source')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'No disponible', exact: true })).toHaveCount(3);
});

test('the product and download site stays usable on mobile without signing in', async ({ page }) => {
  await installGoogleFixture(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Los juegos');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.getByRole('navigation', { name: 'Web de inhouse link' }).getByRole('link', { name: 'Descargas', exact: true }).click();
  await expect(page.getByTestId('downloads-page')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});
