import type { Page } from '@playwright/test';
import { createHash } from 'node:crypto';

// Only the third-party identity boundary is controlled. No runtime bypass or
// alternative login implementation is compiled into the application.
export const GOOGLE_TEST_TOKEN = 'e2e-google-access-token-inhouse-link';
export const GOOGLE_TEST_SESSION_KEY = 'inhouse.link.google-session.v1';
export const GOOGLE_TEST_PROFILE = {
  id: 'e2e-google-account', name: 'Cuenta de pruebas',
  email: 'inhouse-e2e@example.test', photo: '',
};
export const GOOGLE_OTHER_TEST_TOKEN = 'e2e-google-access-token-guest-inhouse-link';
export const GOOGLE_OTHER_TEST_PROFILE = {
  id: 'e2e-other-google-account', name: 'Cuenta invitada de pruebas',
  email: 'guest-e2e@example.test', photo: '',
};

type Options = {
  signedIn?: boolean;
  token?: string;
  profile?: typeof GOOGLE_TEST_PROFILE;
  error?: 'access_denied' | 'popup_closed';
  rejectProfile?: boolean;
  mockServiceSession?: boolean;
  accounts?: Record<string, typeof GOOGLE_TEST_PROFILE>;
};

export async function installGoogleFixture(page: Page, options: Options = {}) {
  const token = options.token ?? GOOGLE_TEST_TOKEN;
  const profile = options.profile ?? GOOGLE_TEST_PROFILE;
  const profiles = new Map([[token, profile], ...Object.entries(options.accounts ?? {})]);
  const serviceSessions = new Map<string, { accessToken: string; expiresAt: number; profile: typeof GOOGLE_TEST_PROFILE }>();
  // Packaged Windows reads its public discovery document from Pages. Keep that
  // network document deterministic; each media fixture selects its real service.
  await page.route('https://miguelcoxcaballero.github.io/inhouse-games/service.json', route => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ schema: 1, signalingUrl: null }),
  }));
  const sdk = `(${String((config: { token: string; error?: string }) => {
    const w = window as any;
    w.__googleInitCalls = [];
    w.__googleTokenRequests = [];
    w.google = { accounts: { oauth2: {
      initTokenClient(settings: any) {
        w.__googleInitCalls.push({ client_id: settings.client_id, scope: settings.scope });
        return { requestAccessToken(request: any) {
          w.__googleTokenRequests.push(request);
          queueMicrotask(() => {
            if (config.error === 'popup_closed') settings.error_callback({ type: 'popup_closed' });
            else if (config.error) settings.callback({ error: config.error });
            else settings.callback({ access_token: w.__googleNextToken ?? config.token, expires_in: 3600, scope: 'https://www.googleapis.com/auth/drive.file' });
          });
        } };
      },
      revoke(_token: string, complete?: (result: unknown) => void) { complete?.({ successful: true }); },
    } } };
  })})(${JSON.stringify({ token, error: options.error })});`;
  await page.route('https://accounts.google.com/gsi/client', route => route.fulfill({
    status: 200, contentType: 'text/javascript', body: sdk,
  }));
  await page.route('https://www.googleapis.com/drive/v3/about?**', async route => {
    const googleToken = route.request().headers().authorization?.replace(/^Bearer /, '') ?? '';
    const googleProfile = profiles.get(googleToken);
    if (options.rejectProfile || !googleProfile) {
      await route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Test Google session denied' } }) });
      return;
    }
    await route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ user: { permissionId: googleProfile.id, displayName: googleProfile.name, emailAddress: googleProfile.email, photoLink: googleProfile.photo } }),
    });
  });
  if (options.mockServiceSession !== false) await page.route('**/api/auth/session', async route => {
    const request = route.request();
    const credential = request.headers().authorization?.replace(/^Bearer /, '') ?? '';
    if (request.method() === 'POST') {
      const googleProfile = profiles.get(credential);
      if (googleProfile) {
        const appToken = `ihl_${createHash('sha256').update(googleProfile.id).digest('base64url')}`;
        const session = { accessToken: appToken, expiresAt: Date.now() + 30 * 86400_000, profile: googleProfile };
        serviceSessions.set(appToken, session);
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(session) });
        return;
      }
    }
    if (request.method() === 'GET' && serviceSessions.has(credential)) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(serviceSessions.get(credential)) });
      return;
    }
    if (request.method() === 'DELETE') {
      serviceSessions.delete(credential);
      await route.fulfill({ status: 204, body: '' });
      return;
    }
    await route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'Test account session denied' }) });
  });
  if (options.signedIn) await page.addInitScript(({ key, token, profile }) => {
    // One initial sign-in only. Reloads must exercise the app's stored-session
    // validation and sign-out must not be undone by a test bootstrap.
    if (sessionStorage.getItem('inhouse.e2e.google-bootstrapped')) return;
    sessionStorage.setItem('inhouse.e2e.google-bootstrapped', '1');
    localStorage.setItem(key, JSON.stringify({ accessToken: token, expiresAt: Date.now() + 3600_000, profile }));
  }, { key: GOOGLE_TEST_SESSION_KEY, token, profile });
}
