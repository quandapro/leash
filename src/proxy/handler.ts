// The proxy path: authenticate the virtual key, run the guards, forward to the provider, meter the response.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Config } from '../config.ts';
import { decrypt, sha256, type Keys } from '../crypto.ts';
import type { Key, Provider, ProviderKind, Store } from '../db.ts';
import type { Alerter } from '../alerts.ts';
import { HttpError, header, readBody, sendJson } from '../http.ts';
import { checkBudget } from '../guard/budget.ts';
import { evaluate, extract, hash, type ApiFormat } from '../guard/loop.ts';
import type { PriceBook, Usage } from '../guard/pricing.ts';
import { preview, redactBody } from '../guard/redact.ts';
import { SseParser, StreamUsage, emptyUsage, usageFromJson } from './usage.ts';

export interface ProxyContext {
  cfg: Config;
  store: Store;
  keys: Keys;
  prices: PriceBook;
  alerter: Alerter;
}

interface Route {
  kind: ProviderKind;
  format: ApiFormat | null; // null = pass-through endpoint with no metering
  method: 'GET' | 'POST';
  upstream: string;
  guarded: boolean;
}

const ROUTES: Record<string, Route> = {
  '/anthropic/v1/messages': { kind: 'anthropic', format: 'anthropic', method: 'POST', upstream: '/v1/messages', guarded: true },
  '/anthropic/v1/messages/count_tokens': { kind: 'anthropic', format: null, method: 'POST', upstream: '/v1/messages/count_tokens', guarded: false },
  '/anthropic/v1/models': { kind: 'anthropic', format: null, method: 'GET', upstream: '/v1/models', guarded: false },
  '/openai/v1/chat/completions': { kind: 'openai', format: 'openai-chat', method: 'POST', upstream: '/chat/completions', guarded: true },
  '/openai/v1/responses': { kind: 'openai', format: 'openai-responses', method: 'POST', upstream: '/responses', guarded: true },
  '/openai/v1/models': { kind: 'openai', format: null, method: 'GET', upstream: '/models', guarded: false },
};

const VELOCITY_WINDOW_MS = 10 * 60_000;
const VELOCITY_LIMIT_USD = Number(process.env.LEASH_VELOCITY_USD ?? 5);
const TURN_CEILING = Number(process.env.LEASH_TURN_CEILING ?? 200);

const FORWARD_REQUEST_HEADERS = ['content-type', 'accept', 'anthropic-version', 'anthropic-beta', 'openai-beta', 'openai-organization', 'openai-project', 'user-agent', 'x-stainless-helper-method'];
const FORWARD_RESPONSE_HEADER = /^(content-type|request-id|x-request-id|retry-after|openai-processing-ms|openai-version|anthropic-ratelimit-.*|x-ratelimit-.*)$/i;

export function isProxyPath(path: string): boolean {
  return path.startsWith('/anthropic/') || path.startsWith('/openai/');
}

function errorBody(kind: ProviderKind, status: number, type: string, message: string): unknown {
  if (kind === 'anthropic') return { type: 'error', error: { type, message } };
  return { error: { message, type, code: type } };
}

function fail(res: ServerResponse, kind: ProviderKind, status: number, type: string, message: string, extra: Record<string, string> = {}): void {
  if (!res.headersSent) sendJson(res, status, errorBody(kind, status, type, message), extra);
  else res.end();
}

function blockedMessage(reason: string, cfg: Config, sessionId: string | null): string {
  const where = sessionId ? `${cfg.publicUrl}/sessions/${encodeURIComponent(sessionId)}` : `${cfg.publicUrl}/keys`;
  return `Leash stopped this request: ${reason}. Review and resume at ${where}`;
}

function bearer(req: IncomingMessage): string | undefined {
  const x = header(req, 'x-api-key');
  if (x) return x.trim();
  const auth = header(req, 'authorization');
  const m = auth ? /^Bearer\s+(.+)$/i.exec(auth) : null;
  return m?.[1]?.trim();
}

function globMatch(pattern: string, value: string): boolean {
  const re = new RegExp('^' + pattern.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i');
  return re.test(value);
}

export function modelAllowed(key: Key, model: string): boolean {
  const patterns = key.model_allow.split(',').map((s) => s.trim()).filter(Boolean);
  return patterns.length === 0 || patterns.some((p) => globMatch(p, model));
}

function sessionIdFor(req: IncomingMessage, key: Key, clientSessionId: string | null, firstUserText: string): string | null {
  const explicit = header(req, 'x-leash-session');
  if (explicit && /^[A-Za-z0-9._:-]{1,128}$/.test(explicit)) return `${key.id}:${explicit}`;
  if (clientSessionId) return `${key.id}:cc-${clientSessionId}`;
  if (firstUserText) return `${key.id}:${hash(firstUserText)}`;
  return null;
}

export async function handleProxy(req: IncomingMessage, res: ServerResponse, url: URL, ctx: ProxyContext): Promise<void> {
  const { cfg, store, prices, alerter } = ctx;
  const route = ROUTES[url.pathname];
  const kind: ProviderKind = url.pathname.startsWith('/anthropic/') ? 'anthropic' : 'openai';
  if (!route) return fail(res, kind, 404, 'not_found_error', `Leash does not proxy ${url.pathname}`);
  if (req.method !== route.method) return fail(res, kind, 405, 'invalid_request_error', `Use ${route.method} for ${url.pathname}`);

  // 1. Authenticate. Only Leash keys are accepted; provider keys sent by clients are never forwarded.
  const token = bearer(req);
  if (!token) return fail(res, kind, 401, 'authentication_error', 'Missing API key. Send your Leash key (lsh_...) as x-api-key or a Bearer token.');
  if (!token.startsWith('lsh_')) return fail(res, kind, 401, 'authentication_error', 'This gateway accepts Leash keys (lsh_...) only. Create one in the Leash dashboard.');
  const key = store.keyByHash(sha256(token));
  if (!key || key.revoked_at) return fail(res, kind, 401, 'authentication_error', 'Invalid or revoked Leash key.');
  const provider = store.getProvider(key.provider_id);
  if (!provider) return fail(res, kind, 500, 'api_error', 'The provider for this key no longer exists.');
  if (provider.kind !== route.kind) {
    return fail(res, kind, 400, 'invalid_request_error', `This key belongs to the ${provider.kind} provider "${provider.name}"; use the /${provider.kind}/ endpoints.`);
  }

  const now = Date.now();
  if (!key.last_used_at || now - key.last_used_at > 60_000) store.touchKey(key.id, now);

  if (route.method === 'GET') return forwardSimple(req, res, url, route, provider, ctx, undefined);

  let body: Record<string, unknown>;
  try {
    const raw = await readBody(req, cfg.maxBodyBytes);
    const parsed = JSON.parse(raw.toString('utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    body = parsed as Record<string, unknown>;
  } catch (e) {
    if (e instanceof HttpError) return fail(res, kind, e.status, 'request_too_large', e.message);
    return fail(res, kind, 400, 'invalid_request_error', 'Request body must be a JSON object.');
  }

  const model = typeof body.model === 'string' ? body.model : '';
  if (!model) return fail(res, kind, 400, 'invalid_request_error', 'Request has no model.');
  if (!modelAllowed(key, model)) {
    return fail(res, kind, 403, 'permission_error', `Model ${model} is not allowed for this Leash key (allowed: ${key.model_allow}).`);
  }

  // 2. Secret redaction applies to every endpoint that sends prompt text upstream.
  const hits = key.redact_mode === 'log' ? redactBody(body, false) : redactBody(body, key.redact_mode === 'redact');
  if (hits.length && key.redact_mode === 'block') {
    alerter.raise({ sessionId: null, keyId: key.id, keyName: key.name, rule: 'secret_blocked', level: 'block', message: `Request blocked: it contained ${summarize(hits)}` }, now);
    store.insertRequest({ session_id: null, key_id: key.id, ts: now, model, in_tok: 0, out_tok: 0, cache_w: 0, cache_r: 0, cost: 0, latency_ms: 0, status: 403, blocked: 'secret', price_known: 1, redactions: hits.length });
    return fail(res, kind, 403, 'permission_error', blockedMessage(`the request contains ${summarize(hits)}`, cfg, null));
  }

  if (!route.guarded || !route.format) return forwardSimple(req, res, url, route, provider, ctx, body);
  const format = route.format;

  // 3. Session and loop rules over the conversation history.
  const ex = extract(format, body);
  const sessionId = sessionIdFor(req, key, ex.clientSessionId, ex.firstUserText);
  let session = sessionId ? store.ensureSession(sessionId, key.id, preview(ex.firstUserText, 120), now) : undefined;

  const record = (status: number, blocked: string | null) => store.insertRequest({
    session_id: sessionId, key_id: key.id, ts: now, model, in_tok: 0, out_tok: 0, cache_w: 0, cache_r: 0, cost: 0,
    latency_ms: 0, status, blocked, price_known: 1, redactions: hits.length,
  });

  if (hits.length) {
    alerter.raise({ sessionId, keyId: key.id, keyName: key.name, rule: 'secret_redacted', level: 'info',
      message: `${key.redact_mode === 'log' ? 'Detected (not redacted)' : 'Redacted'} ${summarize(hits)} before sending to ${provider.name}` }, now);
  }

  if (session && sessionId) {
    if (session.status === 'blocked') {
      record(403, 'session_blocked');
      return fail(res, kind, 403, 'permission_error', blockedMessage(session.status_reason ?? 'this session is paused', cfg, sessionId));
    }

    // Store events not seen before (for replay); reset bookkeeping if the history got shorter (compaction).
    let processed = session.processed_events;
    let offset = session.tool_offset;
    if (ex.events.length < processed) { processed = 0; offset = 0; }
    store.transaction(() => {
    if (ex.events.length > processed) {
      store.insertToolEvents(ex.events.slice(processed).map((e) => ({
        session_id: sessionId, ts: now, kind: e.kind, name: e.name, args_hash: e.argsHash, path: e.path,
        result_hash: e.resultHash, is_error: e.isError ? 1 : 0, preview: e.preview,
      })));
    }
    store.setProcessedEvents(sessionId, ex.events.length, offset);
    });

    if (key.loop_mode !== 'off') {
      for (const f of evaluate(ex.events, offset)) {
        const enforce = f.level === 'block' && key.loop_mode === 'enforce';
        alerter.raise({ sessionId, keyId: key.id, keyName: key.name, rule: f.rule, level: enforce ? 'block' : 'warn', message: f.message }, now);
        if (enforce) {
          store.setSessionStatus(sessionId, 'blocked', f.message);
          record(403, f.rule);
          return fail(res, kind, 403, 'permission_error', blockedMessage(f.message, cfg, sessionId));
        }
        if (session.status === 'active') store.setSessionStatus(sessionId, 'warned', f.message);
      }
    }

    const since = Math.max(now - VELOCITY_WINDOW_MS, session.resumed_at ?? 0);
    const velocity = store.sessionSpendSince(sessionId, since);
    if (VELOCITY_LIMIT_USD > 0 && velocity >= VELOCITY_LIMIT_USD && key.loop_mode !== 'off') {
      const msg = `session spent $${velocity.toFixed(2)} in the last 10 minutes (limit $${VELOCITY_LIMIT_USD.toFixed(2)})`;
      if (key.loop_mode === 'enforce') {
        alerter.raise({ sessionId, keyId: key.id, keyName: key.name, rule: 'spend_velocity', level: 'block', message: msg }, now);
        store.setSessionStatus(sessionId, 'blocked', msg);
        record(403, 'spend_velocity');
        return fail(res, kind, 403, 'permission_error', blockedMessage(msg, cfg, sessionId));
      }
      alerter.raise({ sessionId, keyId: key.id, keyName: key.name, rule: 'spend_velocity', level: 'warn', message: msg }, now);
    }
    if (session.requests + 1 >= TURN_CEILING) {
      alerter.raise({ sessionId, keyId: key.id, keyName: key.name, rule: 'turn_ceiling', level: 'warn', message: `Session reached ${session.requests + 1} requests` }, now);
    }
    session = store.getSession(sessionId);
  }

  // 4. Budgets, using an upper-bound estimate for this request.
  const maxTokens = Number(body.max_tokens ?? body.max_completion_tokens ?? body.max_output_tokens) || undefined;
  const estimate = prices.estimate(provider.kind, model, JSON.stringify(body).length, maxTokens);
  const verdict = checkBudget(store, key, estimate, now);
  for (const w of verdict.warnings) alerter.raise({ sessionId: null, keyId: key.id, keyName: key.name, rule: 'budget_80', level: 'warn', message: w }, now);
  if (!verdict.ok) {
    alerter.raise({ sessionId: null, keyId: key.id, keyName: key.name, rule: 'budget', level: 'block', message: verdict.reason! }, now);
    record(403, 'budget');
    return fail(res, kind, 403, 'permission_error', blockedMessage(verdict.reason!, cfg, null));
  }

  // Chat Completions only reports usage on streams when asked to.
  if (format === 'openai-chat' && body.stream === true) {
    body.stream_options = { ...((body.stream_options as object) ?? {}), include_usage: true };
  }

  await forwardMetered(req, res, url, route, format, provider, key, sessionId, body, model, hits.length, now, ctx);
}

function summarize(hits: string[]): string {
  const counts = new Map<string, number>();
  for (const h of hits) counts.set(h, (counts.get(h) ?? 0) + 1);
  return [...counts].map(([k, v]) => `${v} ${k.replace(/_/g, ' ')}${v > 1 ? 's' : ''}`).join(', ');
}

function upstreamRequest(req: IncomingMessage, url: URL, route: Route, provider: Provider, ctx: ProxyContext, body: unknown, signal: AbortSignal): Promise<Response> {
  const headers = new Headers();
  for (const h of FORWARD_REQUEST_HEADERS) {
    const v = header(req, h);
    if (v) headers.set(h, v);
  }
  headers.set('accept-encoding', 'identity');
  const secret = decrypt(ctx.keys, provider.enc_key);
  if (provider.kind === 'anthropic') {
    headers.set('x-api-key', secret);
    if (!headers.has('anthropic-version')) headers.set('anthropic-version', '2023-06-01');
  } else {
    headers.set('authorization', `Bearer ${secret}`);
  }
  if (body !== undefined) headers.set('content-type', 'application/json');
  return fetch(provider.base_url + route.upstream + url.search, {
    method: route.method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual', // never follow a redirect while carrying the provider key
    signal,
  });
}

function copyResponseHeaders(up: Response, extra: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = { 'cache-control': 'no-store', ...extra };
  up.headers.forEach((v, k) => { if (FORWARD_RESPONSE_HEADER.test(k)) out[k] = v; });
  return out;
}

function abortOnClose(req: IncomingMessage, res: ServerResponse): AbortController {
  const ac = new AbortController();
  res.on('close', () => { if (!res.writableFinished) ac.abort(); });
  req.on('aborted', () => ac.abort());
  return ac;
}

async function forwardSimple(req: IncomingMessage, res: ServerResponse, url: URL, route: Route, provider: Provider, ctx: ProxyContext, body: unknown): Promise<void> {
  const ac = abortOnClose(req, res);
  let up: Response;
  try {
    up = await upstreamRequest(req, url, route, provider, ctx, body, ac.signal);
  } catch {
    return fail(res, provider.kind, 502, 'api_error', `Leash could not reach ${provider.name}.`);
  }
  const buf = Buffer.from(await up.arrayBuffer());
  res.writeHead(up.status, { ...copyResponseHeaders(up, {}), 'content-length': String(buf.length) });
  res.end(buf);
}

async function forwardMetered(
  req: IncomingMessage, res: ServerResponse, url: URL, route: Route, format: ApiFormat, provider: Provider, key: Key,
  sessionId: string | null, body: Record<string, unknown>, model: string, redactions: number, startedAt: number, ctx: ProxyContext,
): Promise<void> {
  const { store, prices, alerter } = ctx;
  const ac = abortOnClose(req, res);
  let up: Response;
  try {
    up = await upstreamRequest(req, url, route, provider, ctx, body, ac.signal);
  } catch {
    store.insertRequest({ session_id: sessionId, key_id: key.id, ts: startedAt, model, in_tok: 0, out_tok: 0, cache_w: 0, cache_r: 0, cost: 0, latency_ms: Date.now() - startedAt, status: 502, blocked: null, price_known: 1, redactions });
    return fail(res, provider.kind, 502, 'api_error', `Leash could not reach ${provider.name}.`);
  }

  const extra: Record<string, string> = sessionId ? { 'x-leash-session': sessionId } : {};
  let usage: Usage = emptyUsage();
  let reportedModel: string | null = null;
  const isStream = (up.headers.get('content-type') ?? '').includes('text/event-stream');

  try {
    if (isStream && up.body) {
      res.writeHead(up.status, copyResponseHeaders(up, extra));
      res.flushHeaders();
      const meter = new StreamUsage(format);
      const parser = new SseParser((e, d) => meter.onEvent(e, d));
      const decoder = new TextDecoder();
      const reader = up.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parser.push(decoder.decode(value, { stream: true }));
        if (!res.write(value)) await new Promise<void>((r) => { res.once('drain', r); res.once('close', r); });
        if (res.destroyed) { await reader.cancel(); break; }
      }
      parser.end();
      res.end();
      usage = meter.usage;
      reportedModel = meter.model;
    } else {
      const buf = Buffer.from(await up.arrayBuffer());
      if (up.ok) {
        try {
          const json = JSON.parse(buf.toString('utf8')) as Record<string, unknown>;
          usage = usageFromJson(format, json);
          if (typeof json.model === 'string') reportedModel = json.model;
        } catch { /* non-JSON success body: nothing to meter */ }
      }
      res.writeHead(up.status, { ...copyResponseHeaders(up, extra), 'content-length': String(buf.length) });
      res.end(buf);
    }
  } catch (e) {
    if (!res.headersSent) fail(res, provider.kind, 502, 'api_error', `Upstream stream from ${provider.name} failed.`);
    else res.destroy(e as Error);
  } finally {
    // Metering happens even if the client disconnected mid-stream: the tokens were still billed.
    const meteredModel = reportedModel ?? model;
    const { usd, known } = prices.cost(provider.kind, meteredModel, usage);
    const ts = Date.now();
    store.transaction(() => {
    store.insertRequest({
      session_id: sessionId, key_id: key.id, ts, model: meteredModel, in_tok: usage.input, out_tok: usage.output,
      cache_w: usage.cacheWrite, cache_r: usage.cacheRead, cost: usd, latency_ms: ts - startedAt, status: up.status,
      blocked: null, price_known: known ? 1 : 0, redactions,
    });
    if (sessionId) store.recordSessionRequest(sessionId, usd, ts);
    });
    if (!known && usd > 0) {
      alerter.raise({ sessionId: null, keyId: key.id, keyName: key.name, rule: 'unpriced_model', level: 'info',
        message: `No price set for ${meteredModel}; charged at the fail-safe rate. Set a price on the Providers page.` }, ts);
    }
  }
}
