import type { Page, Route } from '@playwright/test';
import type { GoogleProfile } from '../../src/lib/google-account.ts';
import { installGoogleFixture } from './google-fixture';

const MARKER = 'inhouse.link.realm';
const FILES_PATH = '/drive/v3/files';
const UPLOAD_PATH = '/upload/drive/v3/files';
const DRIVE_ROUTES = /^https:\/\/www\.googleapis\.com\/(?:upload\/)?drive\/v3\/files(?:\/[^?]*)?(?:\?.*)?$/;

type DriveMetadata = {
  id: string;
  name: string;
  mimeType: string;
  createdTime: string;
  ownedByMe: true;
  shared: false;
  size: string;
  appProperties: Record<string, string>;
};

export type CloudDriveFixtureFile = {
  ownerId: string;
  metadata: DriveMetadata;
  contents: Record<string, unknown>;
};

export type CloudGoogleIdentity = { token: string; profile: GoogleProfile };

function plain(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function multipartJson(route: Route): [Record<string, unknown>, Record<string, unknown>] {
  const request = route.request();
  const contentType = request.headers()['content-type'] ?? '';
  const match = /(?:^|;)\s*boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  const boundary = match?.[1] ?? match?.[2]?.trim();
  const data = request.postDataBuffer();
  if (!contentType.toLowerCase().startsWith('multipart/related;') || !boundary || !data) throw new Error('Invalid multipart upload');
  const body = new TextDecoder('utf-8', { fatal: true }).decode(data);
  const parts = body.split(`--${boundary}`);
  if (parts.length !== 4 || parts[0] !== '' || parts[3] !== '--\r\n') throw new Error('Invalid multipart upload');
  return parts.slice(1, 3).map((part) => {
    if (!part.startsWith('\r\n') || !part.endsWith('\r\n')) throw new Error('Invalid multipart part');
    const value = part.slice(2, -2);
    const divider = value.indexOf('\r\n\r\n');
    if (divider < 0 || !/^Content-Type:\s*application\/json(?:[;\s]|$)/im.test(value.slice(0, divider))) throw new Error('Expected JSON multipart part');
    const result: unknown = JSON.parse(value.slice(divider + 4));
    if (!plain(result)) throw new Error('Expected JSON object');
    return result;
  }) as [Record<string, unknown>, Record<string, unknown>];
}

/**
 * Only Google's identity and private Drive HTTP boundary are substituted. The
 * real obtainDriveRealm helper generates, uploads and retrieves the capability;
 * this provider never creates a realm secret or inserts an application session.
 */
export function createCloudDriveFixture() {
  const identities = new Map<string, GoogleProfile>();
  const files: CloudDriveFixtureFile[] = [];
  let sequence = 0;

  function ownedFiles(accountId: string) {
    return files.filter((file) => file.ownerId === accountId)
      .sort((left, right) => Date.parse(left.metadata.createdTime) - Date.parse(right.metadata.createdTime)
        || left.metadata.id.localeCompare(right.metadata.id));
  }

  async function respond(route: Route, status: number, value: unknown) {
    await route.fulfill({
      status, contentType: 'application/json',
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        'Cache-Control': 'no-store',
      },
      body: JSON.stringify(value),
    });
  }

  async function handleDrive(route: Route) {
    const request = route.request();
    if (request.method() === 'OPTIONS') { await respond(route, 200, {}); return; }
    // App-local tokens and unknown OAuth tokens are never Drive credentials.
    const token = request.headers().authorization?.replace(/^Bearer /, '') ?? '';
    const profile = identities.get(token);
    if (!profile) { await respond(route, 401, { error: { message: 'Unknown Google test credential' } }); return; }
    const url = new URL(request.url());

    if (url.pathname === FILES_PATH && request.method() === 'GET') {
      const query = url.searchParams.get('q') ?? '';
      const ownPrivateRealm = /trashed\s*=\s*false/.test(query) && /'me'\s+in\s+owners/.test(query)
        && /appProperties\s+has\s*\{\s*key\s*=\s*'inhouse\.link\.realm'\s+and\s+value\s*=\s*'1'\s*\}/.test(query);
      if (!ownPrivateRealm || url.searchParams.has('pageToken')) {
        await respond(route, 400, { error: { message: 'Expected private realm file query' } }); return;
      }
      await respond(route, 200, { files: ownedFiles(profile.id).map((file) => file.metadata) });
      return;
    }

    if (url.pathname === UPLOAD_PATH && request.method() === 'POST' && url.searchParams.get('uploadType') === 'multipart') {
      let metadata: Record<string, unknown>;
      let contents: Record<string, unknown>;
      try { [metadata, contents] = multipartJson(route); }
      catch { await respond(route, 400, { error: { message: 'Invalid test Drive multipart upload' } }); return; }
      const properties = metadata.appProperties;
      if (typeof metadata.name !== 'string' || typeof metadata.mimeType !== 'string' || !plain(properties)
        || properties[MARKER] !== '1' || Object.values(properties).some((value) => typeof value !== 'string')) {
        await respond(route, 400, { error: { message: 'Expected an app-marked realm file' } }); return;
      }
      // Preserve the exact contents produced by the real helper. Drive stores
      // opaque file bytes; account/secret validation belongs to obtainDriveRealm.
      const file: CloudDriveFixtureFile = {
        ownerId: profile.id, contents,
        metadata: {
          id: `cloud-drive-file-${++sequence}`, name: metadata.name, mimeType: metadata.mimeType,
          createdTime: new Date(Date.now() + sequence).toISOString(),
          ownedByMe: true, shared: false, size: String(Buffer.byteLength(JSON.stringify(contents))),
          appProperties: { ...properties } as Record<string, string>,
        },
      };
      files.push(file);
      await respond(route, 200, file.metadata);
      return;
    }

    if (url.pathname.startsWith(`${FILES_PATH}/`) && request.method() === 'GET') {
      const id = decodeURIComponent(url.pathname.slice(FILES_PATH.length + 1));
      const file = files.find((candidate) => candidate.ownerId === profile.id && candidate.metadata.id === id);
      // A different account cannot infer whether a private file ID exists.
      if (!file) { await respond(route, 404, { error: { message: 'File not found' } }); return; }
      await respond(route, 200, url.searchParams.get('alt') === 'media' ? file.contents : file.metadata);
      return;
    }
    await respond(route, 405, { error: { message: 'Unsupported test Drive operation' } });
  }

  return {
    async install(page: Page, identity: CloudGoogleIdentity) {
      const known = identities.get(identity.token);
      if (known && known.id !== identity.profile.id) throw new Error('A Google test token cannot identify two accounts');
      identities.set(identity.token, structuredClone(identity.profile));
      await installGoogleFixture(page, { ...identity, mockServiceSession: false });
      await page.route(DRIVE_ROUTES, handleDrive);
    },
    /** Return detached snapshots so assertions cannot change provider state. */
    get files(): CloudDriveFixtureFile[] { return structuredClone(files); },
    realmFor(accountId: string) {
      const file = ownedFiles(accountId)[0];
      if (!file) return null;
      const contents = file.contents;
      if (contents.schema !== 1 || contents.accountId !== accountId || typeof contents.secret !== 'string') {
        throw new Error('The real helper did not upload a realm for this Google account');
      }
      return { id: file.metadata.id, fileId: file.metadata.id, accountId, secret: contents.secret };
    },
  };
}
