import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile, unlink, chmod } from 'node:fs/promises';
import path from 'node:path';

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

export class AccountSessionError extends Error {
  constructor(message, status = 503) { super(message); this.name = 'AccountSessionError'; this.status = status; }
}

export function validAppToken(value) {
  return typeof value === 'string' && /^ihl_[A-Za-z0-9_-]{43}$/.test(value);
}

export function accountSessionHash(token) { return createHash('sha256').update(token).digest('hex'); }

function validProfile(value) {
  return value && typeof value.id === 'string' && value.id.length > 0 && value.id.length <= 256
    && typeof value.name === 'string' && value.name.length <= 120
    && typeof value.email === 'string' && value.email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.email)
    && typeof value.photo === 'string' && value.photo.length <= 2048 && (!value.photo || value.photo.startsWith('https://'));
}

/** Opaque app sessions: only SHA-256 token hashes and public account metadata persist. */
export class AccountSessionStore {
  constructor(options = {}) {
    this.file = options.file === null ? null : path.resolve(options.file ?? 'data/account-sessions.json');
    this.now = options.now ?? Date.now;
    this.ttlMs = Math.min(THIRTY_DAYS_MS, Math.max(1, options.ttlMs ?? THIRTY_DAYS_MS));
    this.maxSessions = options.maxSessions ?? 1000;
    this.maxPerAccount = options.maxPerAccount ?? 20;
    this.records = new Map();
    this.loaded = false;
    this.queue = Promise.resolve();
  }

  async load() {
    if (this.loaded) return;
    if (this.file) {
      let contents;
      try {
        const info = await stat(this.file);
        if (!info.isFile() || info.size > 16 * 1024 * 1024) throw new AccountSessionError('El almacén de sesiones no tiene un tamaño o formato válido.');
        contents = await readFile(this.file, 'utf8');
      } catch (error) {
        if (error.code !== 'ENOENT') throw new AccountSessionError('No se pudo leer el almacén de sesiones de cuenta.');
      }
      if (contents !== undefined) {
        let document;
        try { document = JSON.parse(contents); } catch { throw new AccountSessionError('El almacén de sesiones está dañado; no se ha sobrescrito.'); }
        if (document?.version !== 1 || !Array.isArray(document.sessions) || document.sessions.length > this.maxSessions) {
          throw new AccountSessionError('El almacén de sesiones tiene un formato no compatible.');
        }
        for (const record of document.sessions) {
          if (!record || typeof record.hash !== 'string' || !/^[a-f0-9]{64}$/.test(record.hash)
            || !validProfile(record.profile) || !Number.isFinite(record.expiresAt) || !Number.isFinite(record.createdAt)
            || record.expiresAt <= record.createdAt || this.records.has(record.hash)) {
            throw new AccountSessionError('El almacén de sesiones contiene una entrada no válida.');
          }
          if (record.expiresAt > this.now()) this.records.set(record.hash, Object.freeze({
            hash: record.hash, profile: Object.freeze({ ...record.profile }), expiresAt: record.expiresAt, createdAt: record.createdAt,
          }));
        }
        await chmod(this.file, 0o600);
      }
    }
    this.loaded = true;
  }

  lookup(token) {
    if (!validAppToken(token)) return null;
    const hash = accountSessionHash(token);
    const record = this.records.get(hash);
    return record && record.expiresAt > this.now() ? record : null;
  }

  transact(operation) {
    const result = this.queue.catch(() => {}).then(operation);
    this.queue = result;
    return result;
  }

  async persist() {
    if (!this.file) return;
    const directory = path.dirname(this.file);
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const document = { version: 1, sessions: [...this.records.values()] };
      await writeFile(temporary, JSON.stringify(document), { mode: 0o600, flag: 'wx' });
      await rename(temporary, this.file);
    } catch {
      await unlink(temporary).catch(() => {});
      throw new AccountSessionError('No se pudo guardar la sesión de cuenta de forma segura.');
    }
  }

  pruneInMemory() {
    let changed = false;
    for (const [hash, record] of this.records) {
      if (record.expiresAt <= this.now()) { this.records.delete(hash); changed = true; }
    }
    return changed;
  }

  create(profile) {
    return this.transact(async () => {
      if (!this.loaded) await this.load();
      if (!validProfile(profile)) throw new AccountSessionError('El perfil de cuenta no es válido.', 401);
      this.pruneInMemory();
      if (this.records.size >= this.maxSessions || [...this.records.values()].filter((entry) => entry.profile.id === profile.id).length >= this.maxPerAccount) {
        throw new AccountSessionError('Se ha alcanzado el límite de sesiones guardadas. Cierra una sesión anterior.', 429);
      }
      const accessToken = `ihl_${randomBytes(32).toString('base64url')}`;
      const hash = accountSessionHash(accessToken);
      const record = Object.freeze({ hash, profile: Object.freeze({ ...profile }), createdAt: this.now(), expiresAt: this.now() + this.ttlMs });
      this.records.set(hash, record);
      try { await this.persist(); }
      catch (error) { this.records.delete(hash); throw error; }
      return { accessToken, expiresAt: record.expiresAt, profile: record.profile };
    });
  }

  revoke(hash) {
    return this.transact(async () => {
      const previous = this.records.get(hash);
      if (!previous) return false;
      this.records.delete(hash);
      try { await this.persist(); }
      catch (error) { this.records.set(hash, previous); throw error; }
      return true;
    });
  }

  pruneExpired() {
    return this.transact(async () => { if (this.pruneInMemory()) await this.persist(); });
  }

  async flush() { await this.queue.catch(() => {}); }
}
