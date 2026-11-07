// Alert delivery: every alert is stored; new ones are also sent to Telegram and/or a webhook when configured.
import type { Config } from './config.ts';
import { decrypt, encrypt, type Keys } from './crypto.ts';
import type { Alert, Store } from './db.ts';

export interface AlertInput {
  sessionId: string | null;
  keyId: number | null;
  keyName?: string;
  rule: string;
  level: Alert['level'];
  message: string;
}

export interface AlertSettings {
  telegramToken: string | null;
  telegramChat: string | null;
  webhookUrl: string | null;
}

const ICON: Record<Alert['level'], string> = { info: 'ℹ️', warn: '⚠️', block: '⛔' };

export class Alerter {
  private store: Store;
  private cfg: Config;
  private keys: Keys;

  constructor(store: Store, cfg: Config, keys: Keys) {
    this.store = store;
    this.cfg = cfg;
    this.keys = keys;
  }

  settings(): AlertSettings {
    const tok = this.store.getSetting('telegram_token');
    return {
      telegramToken: tok ? decrypt(this.keys, tok) : null,
      telegramChat: this.store.getSetting('telegram_chat') ?? null,
      webhookUrl: this.store.getSetting('webhook_url') ?? null,
    };
  }

  saveSettings(s: { telegramToken?: string; telegramChat: string; webhookUrl: string }): void {
    if (s.telegramToken !== undefined) this.store.setSetting('telegram_token', s.telegramToken ? encrypt(this.keys, s.telegramToken) : null);
    this.store.setSetting('telegram_chat', s.telegramChat || null);
    this.store.setSetting('webhook_url', s.webhookUrl || null);
  }

  /** Stores the alert (deduplicated) and delivers it if it is new. */
  raise(a: AlertInput, now = Date.now()): void {
    const id = this.store.insertAlert({ ts: now, session_id: a.sessionId, key_id: a.keyId, rule: a.rule, level: a.level, message: a.message });
    if (!id) return;
    void this.deliver(a, now);
  }

  async deliver(a: AlertInput, now = Date.now()): Promise<string[]> {
    const s = this.settings();
    const link = a.sessionId ? `${this.cfg.publicUrl}/sessions/${encodeURIComponent(a.sessionId)}` : `${this.cfg.publicUrl}/alerts`;
    const text = `${ICON[a.level]} Leash ${a.level}: ${a.message}${a.keyName ? `\nKey: ${a.keyName}` : ''}\n${link}`;
    const errors: string[] = [];
    const jobs: Promise<void>[] = [];
    if (s.telegramToken && s.telegramChat) {
      jobs.push(post(`${this.cfg.telegramApi}/bot${s.telegramToken}/sendMessage`, { chat_id: s.telegramChat, text, disable_web_page_preview: true })
        .catch((e: Error) => { errors.push(`Telegram: ${e.message}`); }));
    }
    if (s.webhookUrl) {
      jobs.push(post(s.webhookUrl, { source: 'leash', ts: new Date(now).toISOString(), level: a.level, rule: a.rule, message: a.message, session: a.sessionId, key: a.keyName ?? null, link, text })
        .catch((e: Error) => { errors.push(`Webhook: ${e.message}`); }));
    }
    await Promise.all(jobs);
    for (const e of errors) console.error(JSON.stringify({ level: 'error', msg: 'alert delivery failed', detail: e }));
    return errors;
  }
}

async function post(url: string, body: unknown): Promise<void> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    redirect: 'error',
    signal: AbortSignal.timeout(5000),
  });
  // Never echo the response body: a Telegram URL carries the bot token.
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  await res.body?.cancel();
}
