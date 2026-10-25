import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { installGoogleFixture } from './google-fixture';

test.beforeEach(async ({ page }) => {
  await installGoogleFixture(page, { signedIn: true });
});

test('web presents original Inhouse identity and explains the Windows host', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/#/client');
  await expect(page).toHaveTitle(/inhouse link/i);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Tu PC.');
  await expect(page.getByTestId('connect-button')).toBeDisabled();
  await expect(page.getByText('Servicio de conexión disponible')).toBeVisible();
  await page.getByTestId('host-button').click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('dialog')).toContainText('PC Windows');
  await page.getByRole('button', { name: 'Cerrar ventana' }).click();
  await page.evaluate(() => document.fonts.ready);
  await mkdir('artifacts/screenshots', { recursive: true });
  await page.screenshot({ path: 'artifacts/screenshots/inhouse-link-home.png', fullPage: true });
  expect(errors).toEqual([]);
});

test('quality, server address, and custom shortcuts persist across reload', async ({ page }) => {
  await page.goto('/#/client');
  await page.getByTestId('settings-open').click();
  await page.getByLabel('Resolución', { exact: true }).selectOption('1440p');
  await page.getByLabel('Fotogramas por segundo').selectOption('120');
  await page.getByLabel('Códec de vídeo', { exact: true }).selectOption('h264');
  const shortcut = page.getByLabel('Atajo Menú de sesión');
  await shortcut.focus();
  await shortcut.press('Control+Alt+KeyM');
  await expect(shortcut).toHaveValue('Ctrl + Alt + M');
  await page.getByTestId('signaling-url').fill('http://127.0.0.1:5173');
  await page.getByTestId('save-settings').click();
  // Saving the service revalidates its account session and remounts the client.
  await expect(page.getByTestId('join-code')).toBeVisible();
  await page.getByTestId('settings-open').click();
  await expect(page.getByTestId('signaling-url')).toHaveValue('http://127.0.0.1:5173');
  await page.reload();
  await page.getByTestId('settings-open').click();
  await expect(page.getByLabel('Resolución', { exact: true })).toHaveValue('1440p');
  await expect(page.getByLabel('Fotogramas por segundo')).toHaveValue('120');
  await expect(page.getByLabel('Códec de vídeo', { exact: true })).toHaveValue('h264');
  await expect(page.getByLabel('Atajo Menú de sesión')).toHaveValue('Ctrl + Alt + M');
  await expect(page.getByTestId('signaling-url')).toHaveValue('http://127.0.0.1:5173');
  await page.screenshot({ path: 'artifacts/screenshots/inhouse-link-settings.png', fullPage: true });
});

test('invalid network addresses are rejected and denied signaling fails honestly', async ({ page }) => {
  await page.goto('/#/client');
  await page.getByTestId('settings-open').click();
  await page.getByTestId('signaling-url').fill('http://example.com');
  await page.getByTestId('save-settings').click();
  await expect(page.getByRole('status')).toContainText('HTTPS');
  expect(await page.evaluate(() => localStorage.getItem('inhouse.signalingUrl'))).toBeNull();
  await page.getByRole('button', { name: 'Conexión', exact: true }).click();
  await page.route('**/api/config', route => route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'Google session denied' }) }));
  await page.getByTestId('join-code').fill('ABCDEFGH');
  await page.getByTestId('connect-button').click();
  await expect(page.getByRole('status').filter({ hasText: 'No se ha podido conectar' })).toBeVisible();
  await expect(page.getByTestId('remote-video')).toHaveCount(0);
});

test('layout stays usable on a narrow browser', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#/client');
  await expect(page.getByTestId('join-code')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: 'artifacts/screenshots/inhouse-link-mobile.png', fullPage: true });
});
