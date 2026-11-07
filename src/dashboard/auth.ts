// Dashboard authentication: admin token login, server-side sessions, CSRF tokens, login throttling.
import type { IncomingMessage } from 'node:http';
import type { Config } from '../config.ts';
import { hmac, randomToken, safeEqual, sha256, type Keys } from '../crypto.ts';
import type { Store } from '../db.ts';
import { clientIp, header, isHttps, parseCookies } from '../http.ts';

const COOKIE = 'leash_sid';
const SESSION_MS = 7 * 86_400_000;
const MAX_FAILS = 10;
const LOCK_MS = 15 * 60_000;

export class Auth {
  private cfg: Config;
  private store: Store;
  private keys: Keys;
  private fails = new Map<string, { n: number; until: number }>();

  constructor(cfg: Config, store: Store, keys: Keys) {
    this.cfg = cfg;
    this.store = store;
    this.keys = keys;
  }

  /** Returns the raw session id when the request carries a valid admin session. */
  session(req: IncomingMessage): string | null {
    const sid = parseCookies(req)[COOKIE];
    if (!sid || sid.length > 128) return null;
    return this.store.adminSessionValid(sha256(sid), Date.now()) ? sid : null;
  }

  csrf(sid: string): string {
    return hmac(this.keys, 'csrf:' + sid);
  }

  /** Same-origin check plus CSRF token match for state-changing requests. */
  verifyPost(req: IncomingMessage, sid: string, form: URLSearchParams): boolean {
    const site = header(req, 'sec-fetch-site');
    if (site && site !== 'same-origin' && site !== 'none') return false;
    const origin = header(req, 'origin');
    if (origin && origin !== 'null') {
      const host = header(req, 'host');
      let ok = false;
      try { ok = new URL(origin).host === host || origin === new URL(this.cfg.publicUrl).origin; } catch { ok = false; }
      if (!ok) return false;
    }
    const token = form.get('_csrf') ?? '';
    return token.length > 0 && safeEqual(token, this.csrf(sid));
  }

  locked(req: IncomingMessage): boolean {
    const f = this.fails.get(clientIp(req, this.cfg.trustProxy));
    return !!f && f.n >= MAX_FAILS && f.until > Date.now();
  }

  /** Checks the token; on success creates a session and returns the Set-Cookie header. */
  login(req: IncomingMessage, token: string): string | null {
    const ip = clientIp(req, this.cfg.trustProxy);
    const now = Date.now();
    if (!safeEqual(token, this.cfg.adminToken)) {
      const f = this.fails.get(ip);
      const n = f && f.until > now ? f.n + 1 : 1;
      this.fails.set(ip, { n, until: now + LOCK_MS });
      if (this.fails.size > 10_000) this.fails.clear();
      return null;
    }
    this.fails.delete(ip);
    const sid = randomToken('', 32);
    this.store.createAdminSession(sha256(sid), now + SESSION_MS);
    return this.cookie(req, sid, SESSION_MS / 1000);
  }

  logout(req: IncomingMessage, sid: string): string {
    this.store.deleteAdminSession(sha256(sid));
    return this.cookie(req, '', 0);
  }

  private cookie(req: IncomingMessage, value: string, maxAge: number): string {
    const secure = isHttps(req, this.cfg.trustProxy, this.cfg.publicUrl) ? '; Secure' : '';
    return `${COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
  }
}
