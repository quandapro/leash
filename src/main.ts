// Entry point: load config, open storage, seed providers from env, serve the proxy and dashboard.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { Alerter } from './alerts.ts';
import { ConfigError, loadConfig, type Config } from './config.ts';
import { deriveKeys, encrypt, type Keys } from './crypto.ts';
import { Store } from './db.ts';
import { Auth } from './dashboard/auth.ts';
import { handleDashboard } from './dashboard/routes.ts';
import { PriceBook } from './guard/pricing.ts';
import { HttpError, sendJson } from './http.ts';
import { handleProxy, isProxyPath } from './proxy/handler.ts';

const VERSION = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;

function log(level: 'info' | 'error', msg: string, extra: Record<string, unknown> = {}): void {
  console[level === 'error' ? 'error' : 'log'](JSON.stringify({ ts: new Date().toISOString(), level, msg, ...extra }));
}

/** Creates or refreshes the default providers from LEASH_ANTHROPIC_KEY / LEASH_OPENAI_KEY. */
function seedProviders(cfg: Config, store: Store, keys: Keys): void {
  const seeds = [
    { name: 'anthropic', kind: 'anthropic' as const, key: cfg.bootstrap.anthropicKey, base: cfg.bootstrap.anthropicBaseUrl },
    { name: 'openai', kind: 'openai' as const, key: cfg.bootstrap.openaiKey, base: cfg.bootstrap.openaiBaseUrl },
  ];
  for (const s of seeds) {
    if (!s.key) continue;
    if (!s.base.startsWith('https://') && !cfg.allowHttpUpstream) throw new ConfigError(`${s.name} base URL must use https://`);
    const existing = store.providerByName(s.name);
    if (existing) store.updateProvider(existing.id, s.base, encrypt(keys, s.key));
    else store.createProvider({ name: s.name, kind: s.kind, base_url: s.base, enc_key: encrypt(keys, s.key) });
  }
}

export function buildServer(cfg: Config, store: Store) {
  const keys = deriveKeys(cfg.secret);
  const prices = new PriceBook();
  prices.load(store.listPrices());
  const alerter = new Alerter(store, cfg, keys);
  const auth = new Auth(cfg, store, keys);
  seedProviders(cfg, store, keys);

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const started = Date.now();
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://leash.local');
    } catch {
      return sendJson(res, 400, { error: 'bad request' });
    }
    if (isProxyPath(url.pathname)) {
      res.once('finish', () => log('info', 'proxy', { method: req.method, path: url.pathname, status: res.statusCode, ms: Date.now() - started }));
    }
    try {
      if (url.pathname === '/healthz') return sendJson(res, 200, { ok: true, version: VERSION });
      if (isProxyPath(url.pathname)) await handleProxy(req, res, url, { cfg, store, keys, prices, alerter });
      else await handleDashboard(req, res, url, { cfg, store, keys, prices, alerter, auth, version: VERSION });
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status >= 500) log('error', 'request failed', { path: url.pathname, error: (e as Error).message });
      if (!res.headersSent) sendJson(res, status, { error: status >= 500 ? 'internal error' : (e as Error).message });
      else res.destroy();
    }
  });
  server.headersTimeout = 30_000;
  server.requestTimeout = 300_000; // receiving the request body; responses may stream longer
  server.keepAliveTimeout = 65_000;
  return server;
}

function main(): void {
  let cfg: Config;
  try {
    cfg = loadConfig();
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(`Leash cannot start: ${e.message}`);
      process.exit(1);
    }
    throw e;
  }
  const store = new Store(cfg.dataDir);
  const server = buildServer(cfg, store);
  store.purge(cfg.retentionDays, Date.now());
  const purge = setInterval(() => store.purge(cfg.retentionDays, Date.now()), 6 * 3600_000);
  purge.unref();

  server.listen(cfg.port, cfg.host, () => log('info', `Leash ${VERSION} listening`, { port: cfg.port, publicUrl: cfg.publicUrl }));

  const stop = (signal: string) => {
    log('info', 'shutting down', { signal });
    server.close(() => { store.close(); process.exit(0); });
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/').replace(/^(?=[A-Za-z]:)/, '/')}` || process.argv[1]?.endsWith('main.ts')) main();
