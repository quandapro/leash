// SQLite storage via node:sqlite. Stores metadata only (tokens, cost, tool names, hashes), never full prompts.
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export type ProviderKind = 'anthropic' | 'openai';
export type RedactMode = 'redact' | 'block' | 'log';
export type LoopMode = 'enforce' | 'warn' | 'off';
export type SessionStatus = 'active' | 'warned' | 'blocked';

export interface Provider {
  id: number; name: string; kind: ProviderKind; base_url: string; enc_key: string; created_at: number;
}
export interface Key {
  id: number; name: string; prefix: string; hash: string; provider_id: number; model_allow: string;
  daily_usd: number | null; monthly_usd: number | null; redact_mode: RedactMode; loop_mode: LoopMode;
  revoked_at: number | null; created_at: number; last_used_at: number | null;
}
export interface Session {
  id: string; key_id: number; label: string; started_at: number; last_at: number; requests: number; spend: number;
  status: SessionStatus; status_reason: string | null; tool_offset: number; processed_events: number; resumed_at: number | null;
}
export interface RequestRow {
  session_id: string | null; key_id: number; ts: number; model: string; in_tok: number; out_tok: number;
  cache_w: number; cache_r: number; cost: number; latency_ms: number; status: number; blocked: string | null;
  price_known: number; redactions: number;
}
export interface ToolEvent {
  session_id: string; ts: number; kind: 'call' | 'result'; name: string; args_hash: string; path: string | null;
  result_hash: string | null; is_error: number; preview: string;
}
export interface Alert {
  id: number; ts: number; session_id: string | null; key_id: number | null; rule: string; level: 'info' | 'warn' | 'block';
  message: string; resolved_at: number | null;
}
export interface Price { kind: ProviderKind; model: string; input: number; output: number; cache_write: number; cache_read: number }

const MIGRATIONS: string[] = [
  `CREATE TABLE providers (
     id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, kind TEXT NOT NULL CHECK (kind IN ('anthropic','openai')),
     base_url TEXT NOT NULL, enc_key TEXT NOT NULL, created_at INTEGER NOT NULL);
   CREATE TABLE keys (
     id INTEGER PRIMARY KEY, name TEXT NOT NULL, prefix TEXT NOT NULL, hash TEXT NOT NULL UNIQUE,
     provider_id INTEGER NOT NULL REFERENCES providers(id), model_allow TEXT NOT NULL DEFAULT '',
     daily_usd REAL, monthly_usd REAL, redact_mode TEXT NOT NULL DEFAULT 'redact', loop_mode TEXT NOT NULL DEFAULT 'enforce',
     revoked_at INTEGER, created_at INTEGER NOT NULL, last_used_at INTEGER);
   CREATE TABLE sessions (
     id TEXT PRIMARY KEY, key_id INTEGER NOT NULL, label TEXT NOT NULL DEFAULT '', started_at INTEGER NOT NULL,
     last_at INTEGER NOT NULL, requests INTEGER NOT NULL DEFAULT 0, spend REAL NOT NULL DEFAULT 0,
     status TEXT NOT NULL DEFAULT 'active', status_reason TEXT, tool_offset INTEGER NOT NULL DEFAULT 0,
     processed_events INTEGER NOT NULL DEFAULT 0, resumed_at INTEGER);
   CREATE INDEX sessions_last ON sessions(last_at);
   CREATE TABLE requests (
     id INTEGER PRIMARY KEY, session_id TEXT, key_id INTEGER NOT NULL, ts INTEGER NOT NULL, model TEXT NOT NULL,
     in_tok INTEGER NOT NULL, out_tok INTEGER NOT NULL, cache_w INTEGER NOT NULL, cache_r INTEGER NOT NULL,
     cost REAL NOT NULL, latency_ms INTEGER NOT NULL, status INTEGER NOT NULL, blocked TEXT,
     price_known INTEGER NOT NULL DEFAULT 1, redactions INTEGER NOT NULL DEFAULT 0);
   CREATE INDEX requests_key_ts ON requests(key_id, ts);
   CREATE INDEX requests_session_ts ON requests(session_id, ts);
   CREATE INDEX requests_ts ON requests(ts);
   CREATE TABLE tool_events (
     id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, ts INTEGER NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL,
     args_hash TEXT NOT NULL, path TEXT, result_hash TEXT, is_error INTEGER NOT NULL DEFAULT 0, preview TEXT NOT NULL);
   CREATE INDEX tool_events_session ON tool_events(session_id, id);
   CREATE TABLE alerts (
     id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, session_id TEXT, key_id INTEGER, rule TEXT NOT NULL,
     level TEXT NOT NULL, message TEXT NOT NULL, resolved_at INTEGER);
   CREATE INDEX alerts_ts ON alerts(ts);
   CREATE TABLE settings (k TEXT PRIMARY KEY, v TEXT NOT NULL);
   CREATE TABLE admin_sessions (id_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
   CREATE TABLE prices (
     kind TEXT NOT NULL, model TEXT NOT NULL, input REAL NOT NULL, output REAL NOT NULL,
     cache_write REAL NOT NULL, cache_read REAL NOT NULL, PRIMARY KEY (kind, model));`,
];

const DAY = 86_400_000;

export function startOfDayUtc(now: number): number {
  return Math.floor(now / DAY) * DAY;
}
export function startOfMonthUtc(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

export class Store {
  db: DatabaseSync;

  constructor(dataDir: string | ':memory:') {
    if (dataDir !== ':memory:') mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(dataDir === ':memory:' ? ':memory:' : join(dataDir, 'leash.db'));
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;');
    this.migrate();
  }

  private migrate(): void {
    const row = this.db.prepare('PRAGMA user_version').get() as { user_version: number };
    for (let v = row.user_version; v < MIGRATIONS.length; v++) {
      this.db.exec('BEGIN');
      try {
        this.db.exec(MIGRATIONS[v]!);
        this.db.exec(`PRAGMA user_version = ${v + 1}`);
        this.db.exec('COMMIT');
      } catch (e) {
        this.db.exec('ROLLBACK');
        throw e;
      }
    }
  }

  close(): void { this.db.close(); }

  private stmts = new Map<string, StatementSync>();
  private stmt(sql: string): StatementSync {
    let s = this.stmts.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.stmts.set(sql, s);
    }
    return s;
  }
  private get<T>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.stmt(sql).get(...params) as T | undefined;
  }
  private all<T>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.stmt(sql).all(...params) as T[];
  }
  private run(sql: string, ...params: SQLInputValue[]): number {
    return Number(this.stmt(sql).run(...params).lastInsertRowid);
  }

  /** Runs fn in one transaction (one WAL commit instead of one per statement). */
  transaction<T>(fn: () => T): T {
    if (this.db.isTransaction) return fn();
    this.db.exec('BEGIN');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  // Providers
  listProviders(): Provider[] { return this.all('SELECT * FROM providers ORDER BY name'); }
  getProvider(id: number): Provider | undefined { return this.get('SELECT * FROM providers WHERE id = ?', id); }
  providerByName(name: string): Provider | undefined { return this.get('SELECT * FROM providers WHERE name = ?', name); }
  createProvider(p: Omit<Provider, 'id' | 'created_at'>): number {
    return this.run('INSERT INTO providers (name, kind, base_url, enc_key, created_at) VALUES (?, ?, ?, ?, ?)',
      p.name, p.kind, p.base_url, p.enc_key, Date.now());
  }
  updateProvider(id: number, baseUrl: string, encKey: string): void {
    this.run('UPDATE providers SET base_url = ?, enc_key = ? WHERE id = ?', baseUrl, encKey, id);
  }
  deleteProvider(id: number): boolean {
    const used = this.get<{ n: number }>('SELECT COUNT(*) AS n FROM keys WHERE provider_id = ? AND revoked_at IS NULL', id);
    if ((used?.n ?? 0) > 0) return false;
    // Only revoked keys remain; they cannot authenticate, so they go with the provider.
    this.run('DELETE FROM keys WHERE provider_id = ?', id);
    this.run('DELETE FROM providers WHERE id = ?', id);
    return true;
  }

  // Virtual keys
  listKeys(): (Key & { provider_name: string; provider_kind: ProviderKind })[] {
    return this.all(`SELECT k.*, p.name AS provider_name, p.kind AS provider_kind
                     FROM keys k LEFT JOIN providers p ON p.id = k.provider_id ORDER BY k.revoked_at IS NOT NULL, k.created_at DESC`);
  }
  getKey(id: number): Key | undefined { return this.get('SELECT * FROM keys WHERE id = ?', id); }
  keyByHash(hash: string): Key | undefined { return this.get('SELECT * FROM keys WHERE hash = ?', hash); }
  createKey(k: Omit<Key, 'id' | 'created_at' | 'last_used_at' | 'revoked_at'>): number {
    return this.run(`INSERT INTO keys (name, prefix, hash, provider_id, model_allow, daily_usd, monthly_usd, redact_mode, loop_mode, created_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      k.name, k.prefix, k.hash, k.provider_id, k.model_allow, k.daily_usd, k.monthly_usd, k.redact_mode, k.loop_mode, Date.now());
  }
  updateKeyPolicy(id: number, p: Pick<Key, 'daily_usd' | 'monthly_usd' | 'model_allow' | 'redact_mode' | 'loop_mode'>): void {
    this.run('UPDATE keys SET daily_usd = ?, monthly_usd = ?, model_allow = ?, redact_mode = ?, loop_mode = ? WHERE id = ?',
      p.daily_usd, p.monthly_usd, p.model_allow, p.redact_mode, p.loop_mode, id);
  }
  revokeKey(id: number): void { this.run('UPDATE keys SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?', Date.now(), id); }
  touchKey(id: number, ts: number): void { this.run('UPDATE keys SET last_used_at = ? WHERE id = ?', ts, id); }

  // Sessions
  getSession(id: string): Session | undefined { return this.get('SELECT * FROM sessions WHERE id = ?', id); }
  ensureSession(id: string, keyId: number, label: string, now: number): Session {
    this.run('INSERT OR IGNORE INTO sessions (id, key_id, label, started_at, last_at) VALUES (?, ?, ?, ?, ?)', id, keyId, label, now, now);
    return this.getSession(id)!;
  }
  recordSessionRequest(id: string, cost: number, now: number): void {
    this.run('UPDATE sessions SET requests = requests + 1, spend = spend + ?, last_at = ? WHERE id = ?', cost, now, id);
  }
  setSessionStatus(id: string, status: SessionStatus, reason: string | null): void {
    this.run('UPDATE sessions SET status = ?, status_reason = ? WHERE id = ?', status, reason, id);
  }
  setProcessedEvents(id: string, n: number, toolOffset: number): void {
    this.run('UPDATE sessions SET processed_events = ?, tool_offset = ? WHERE id = ?', n, toolOffset, id);
  }
  resumeSession(id: string, now: number): void {
    // Repetitions before the resume stop counting: the offset moves to everything seen so far.
    this.run(`UPDATE sessions SET status = 'active', status_reason = NULL, tool_offset = processed_events, resumed_at = ? WHERE id = ?`, now, id);
    this.run('UPDATE alerts SET resolved_at = ? WHERE session_id = ? AND resolved_at IS NULL', now, id);
  }
  listSessions(limit = 100): (Session & { key_name: string })[] {
    return this.all(`SELECT s.*, k.name AS key_name FROM sessions s LEFT JOIN keys k ON k.id = s.key_id
                     ORDER BY s.last_at DESC LIMIT ?`, limit);
  }
  activeSessionCount(since: number): number {
    return this.get<{ n: number }>('SELECT COUNT(*) AS n FROM sessions WHERE last_at >= ?', since)?.n ?? 0;
  }

  // Requests and spend
  insertRequest(r: RequestRow): number {
    return this.run(`INSERT INTO requests (session_id, key_id, ts, model, in_tok, out_tok, cache_w, cache_r, cost, latency_ms, status, blocked, price_known, redactions)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      r.session_id, r.key_id, r.ts, r.model, r.in_tok, r.out_tok, r.cache_w, r.cache_r, r.cost, r.latency_ms, r.status, r.blocked, r.price_known, r.redactions);
  }
  keySpendSince(keyId: number, since: number): number {
    return this.get<{ s: number | null }>('SELECT SUM(cost) AS s FROM requests WHERE key_id = ? AND ts >= ?', keyId, since)?.s ?? 0;
  }
  totalSpendSince(since: number): number {
    return this.get<{ s: number | null }>('SELECT SUM(cost) AS s FROM requests WHERE ts >= ?', since)?.s ?? 0;
  }
  sessionSpendSince(sessionId: string, since: number): number {
    return this.get<{ s: number | null }>('SELECT SUM(cost) AS s FROM requests WHERE session_id = ? AND ts >= ?', sessionId, since)?.s ?? 0;
  }
  dailySpend(days: number, now: number): { day: number; spend: number; requests: number }[] {
    const since = startOfDayUtc(now) - (days - 1) * DAY;
    return this.all(`SELECT (ts / ${DAY}) * ${DAY} AS day, SUM(cost) AS spend, COUNT(*) AS requests
                     FROM requests WHERE ts >= ? GROUP BY day ORDER BY day`, since);
  }
  sessionRequests(sessionId: string): (RequestRow & { id: number })[] {
    return this.all('SELECT * FROM requests WHERE session_id = ? ORDER BY ts', sessionId);
  }
  unpricedModels(): { model: string; n: number }[] {
    return this.all('SELECT model, COUNT(*) AS n FROM requests WHERE price_known = 0 GROUP BY model ORDER BY n DESC LIMIT 20');
  }

  // Tool events
  insertToolEvents(events: ToolEvent[]): void {
    const stmt = this.stmt(`INSERT INTO tool_events (session_id, ts, kind, name, args_hash, path, result_hash, is_error, preview)
                                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const e of events) stmt.run(e.session_id, e.ts, e.kind, e.name, e.args_hash, e.path, e.result_hash, e.is_error, e.preview);
  }
  sessionToolEvents(sessionId: string, limit = 500): (ToolEvent & { id: number })[] {
    return this.all('SELECT * FROM tool_events WHERE session_id = ? ORDER BY id DESC LIMIT ?', sessionId, limit);
  }

  // Alerts
  /** Inserts an alert unless an unresolved one with the same session, rule and level exists. Returns the id or 0. */
  insertAlert(a: Omit<Alert, 'id' | 'resolved_at'>): number {
    const dup = a.session_id
      ? this.get<{ id: number }>('SELECT id FROM alerts WHERE session_id = ? AND rule = ? AND level = ? AND resolved_at IS NULL', a.session_id, a.rule, a.level)
      : this.get<{ id: number }>('SELECT id FROM alerts WHERE session_id IS NULL AND key_id IS ? AND rule = ? AND level = ? AND resolved_at IS NULL AND ts >= ?',
          a.key_id, a.rule, a.level, startOfDayUtc(a.ts));
    if (dup) return 0;
    return this.run('INSERT INTO alerts (ts, session_id, key_id, rule, level, message) VALUES (?, ?, ?, ?, ?, ?)',
      a.ts, a.session_id, a.key_id, a.rule, a.level, a.message);
  }
  listAlerts(limit = 200): (Alert & { key_name: string | null })[] {
    return this.all(`SELECT a.*, k.name AS key_name FROM alerts a LEFT JOIN keys k ON k.id = a.key_id ORDER BY a.ts DESC LIMIT ?`, limit);
  }
  sessionAlerts(sessionId: string): Alert[] { return this.all('SELECT * FROM alerts WHERE session_id = ? ORDER BY ts', sessionId); }
  resolveAllAlerts(ts: number): void { this.run('UPDATE alerts SET resolved_at = ? WHERE resolved_at IS NULL', ts); }
  openAlertCount(): number { return this.get<{ n: number }>('SELECT COUNT(*) AS n FROM alerts WHERE resolved_at IS NULL')?.n ?? 0; }
  resolveAlert(id: number, now: number): void { this.run('UPDATE alerts SET resolved_at = COALESCE(resolved_at, ?) WHERE id = ?', now, id); }

  // Settings
  getSetting(k: string): string | undefined { return this.get<{ v: string }>('SELECT v FROM settings WHERE k = ?', k)?.v; }
  setSetting(k: string, v: string | null): void {
    if (v === null || v === '') this.run('DELETE FROM settings WHERE k = ?', k);
    else this.run('INSERT INTO settings (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', k, v);
  }

  // Admin sessions (stores only a hash of the cookie value)
  createAdminSession(idHash: string, expiresAt: number): void {
    this.run('INSERT INTO admin_sessions (id_hash, expires_at) VALUES (?, ?)', idHash, expiresAt);
  }
  adminSessionValid(idHash: string, now: number): boolean {
    return !!this.get('SELECT 1 FROM admin_sessions WHERE id_hash = ? AND expires_at > ?', idHash, now);
  }
  deleteAdminSession(idHash: string): void { this.run('DELETE FROM admin_sessions WHERE id_hash = ?', idHash); }

  // Prices
  listPrices(): Price[] { return this.all('SELECT * FROM prices ORDER BY kind, model'); }
  setPrice(p: Price): void {
    this.run(`INSERT INTO prices (kind, model, input, output, cache_write, cache_read) VALUES (?, ?, ?, ?, ?, ?)
              ON CONFLICT(kind, model) DO UPDATE SET input = excluded.input, output = excluded.output,
              cache_write = excluded.cache_write, cache_read = excluded.cache_read`,
      p.kind, p.model, p.input, p.output, p.cache_write, p.cache_read);
  }
  deletePrice(kind: string, model: string): void { this.run('DELETE FROM prices WHERE kind = ? AND model = ?', kind, model); }

  /** Deletes data older than the retention window. */
  purge(retentionDays: number, now: number): void {
    const cutoff = now - retentionDays * DAY;
    this.run('DELETE FROM requests WHERE ts < ?', cutoff);
    this.run('DELETE FROM tool_events WHERE ts < ?', cutoff);
    this.run('DELETE FROM alerts WHERE ts < ?', cutoff);
    this.run('DELETE FROM sessions WHERE last_at < ?', cutoff);
    this.run('DELETE FROM admin_sessions WHERE expires_at < ?', now);
  }
}
