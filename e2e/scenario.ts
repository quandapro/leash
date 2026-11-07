// End-to-end scenario: drives the dashboard like a person and the proxy like an agent, against a mock provider.
// Used by test/server.test.ts (in process) and e2e/run.ts (production Docker image, 2 vCPU / 4 GB).
import assert from 'node:assert/strict';

export interface ScenarioOptions {
  leash: string;            // Leash base URL as seen by this process
  admin: string;            // admin token
  mock: string;             // mock provider URL as seen by this process
  mockFromLeash: string;    // mock provider URL as seen by Leash
  log?: (msg: string) => void;
}

// Fake credentials are assembled at runtime so the source never contains a secret-shaped literal.
export const FAKE = {
  aws: 'AKIA' + 'Z7QF3LMXQ2' + 'TESTKE',
  anthropic: 'sk-' + 'ant-' + 'api03-' + 'e2eFakeKeyForLeashTests0123456789',
  password: 'db_pass' + 'word=' + 'q8Zr2Lx9Vt4Kp7Wm3Nc6',
};

class Dashboard {
  private cookie = '';
  private base: string;
  constructor(base: string) { this.base = base; }

  async get(path: string): Promise<Response> {
    return fetch(this.base + path, { headers: { cookie: this.cookie }, redirect: 'manual' });
  }

  async csrf(path = '/'): Promise<string> {
    const html = await (await this.get(path)).text();
    const m = /name="_csrf" value="([0-9a-f]{64})"/.exec(html);
    assert.ok(m, `no CSRF token on ${path}`);
    return m[1]!;
  }

  async post(path: string, fields: Record<string, string>, opts: { csrf?: boolean; origin?: string } = {}): Promise<Response> {
    const form = new URLSearchParams(fields);
    if (opts.csrf !== false) form.set('_csrf', await this.csrf());
    const headers: Record<string, string> = { cookie: this.cookie, 'content-type': 'application/x-www-form-urlencoded' };
    if (opts.origin) headers.origin = opts.origin;
    const res = await fetch(this.base + path, { method: 'POST', headers, body: form, redirect: 'manual' });
    const set = res.headers.get('set-cookie');
    if (set) this.cookie = set.split(';')[0]!;
    return res;
  }

  async stats(): Promise<any> {
    const res = await this.get('/api/stats');
    assert.equal(res.status, 200);
    return res.json();
  }
}

type Json = Record<string, any>;

async function call(leash: string, path: string, key: string, body: Json, extraHeaders: Record<string, string> = {}): Promise<{ status: number; json: Json | null; text: string; headers: Headers }> {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...extraHeaders };
  if (path.startsWith('/anthropic/')) { headers['x-api-key'] = key; headers['anthropic-version'] = '2023-06-01'; }
  else headers.authorization = `Bearer ${key}`;
  const res = await fetch(leash + path, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await res.text();
  let json: Json | null = null;
  try { json = JSON.parse(text); } catch { /* SSE */ }
  return { status: res.status, json, text, headers: res.headers };
}

function loopHistory(pairs: number): Json[] {
  const messages: Json[] = [{ role: 'user', content: 'Make the test suite pass' }];
  for (let i = 0; i < pairs; i++) {
    messages.push({ role: 'assistant', content: [{ type: 'tool_use', id: `toolu_${i}`, name: 'Bash', input: { command: 'npm test' } }] });
    messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu_${i}`, is_error: true, content: 'Error: 1 failing test in auth.spec.ts' }] });
  }
  return messages;
}

export async function scenario(o: ScenarioOptions): Promise<void> {
  const log = o.log ?? (() => {});
  const d = new Dashboard(o.leash);
  const step = async (name: string, fn: () => Promise<void>) => { await fn(); log(`ok  ${name}`); };
  const received = async (): Promise<{ path: string; headers: Json; body: Json }[]> => (await fetch(o.mock + '/__received')).json() as any;
  await fetch(o.mock + '/__reset');

  let anthropicKey = '';
  let openaiKey = '';
  let anthropicKeyId = 0;

  await step('health endpoint', async () => {
    const r = await fetch(o.leash + '/healthz');
    assert.equal(r.status, 200);
    assert.equal((await r.json() as Json).ok, true);
  });

  await step('dashboard requires sign-in', async () => {
    assert.equal((await d.get('/')).status, 303);
    assert.equal((await d.get('/api/stats')).status, 401);
    const bad = await d.post('/login', { token: 'wrong-token-wrong-token-wrong' }, { csrf: false });
    assert.equal(bad.status, 401);
    const good = await d.post('/login', { token: o.admin }, { csrf: false });
    assert.equal(good.status, 303);
    const cookie = good.headers.get('set-cookie') ?? '';
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    const home = await d.get('/');
    assert.equal(home.status, 200);
    assert.match(home.headers.get('content-security-policy') ?? '', /default-src 'none'/);
    assert.equal(home.headers.get('x-frame-options'), 'DENY');
  });

  await step('state-changing posts need CSRF token and same origin', async () => {
    assert.equal((await d.post('/settings/budget', { global_daily_usd: '1' }, { csrf: false })).status, 403);
    assert.equal((await d.post('/settings/budget', { global_daily_usd: '1' }, { origin: 'https://evil.example' })).status, 403);
  });

  await step('providers seeded from env, keys stored encrypted', async () => {
    const html = await (await d.get('/providers')).text();
    assert.match(html, /anthropic/);
    assert.match(html, /openai/);
    assert.doesNotMatch(html, /mock-anthropic-provider-key/, 'provider key must never be shown in full');
  });

  await step('create keys', async () => {
    const page = await (await d.get('/keys')).text();
    const ids = [...page.matchAll(/<option value="(\d+)">([a-z]+) \((Anthropic|OpenAI-compatible)\)<\/option>/g)];
    const aId = ids.find((m) => m[3] === 'Anthropic')![1]!;
    const oId = ids.find((m) => m[3] === 'OpenAI-compatible')![1]!;
    const mk = async (name: string, provider: string) => {
      const res = await d.post('/keys', { name, provider_id: provider, daily_usd: '1000', monthly_usd: '', model_allow: '', redact_mode: 'redact', loop_mode: 'enforce' });
      assert.equal(res.status, 200);
      const m = /<pre id="newkey">(lsh_[A-Za-z0-9_-]+)<\/pre>/.exec(await res.text());
      assert.ok(m, 'new key shown once');
      return m[1]!;
    };
    anthropicKey = await mk('e2e-claude', aId);
    openaiKey = await mk('e2e-openai', oId);
    anthropicKeyId = (await d.stats()).keys.find((k: Json) => k.name === 'e2e-claude').id;
  });

  await step('proxy rejects missing, foreign and provider keys', async () => {
    const body = { model: 'claude-sonnet-5-5', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] };
    assert.equal((await call(o.leash, '/anthropic/v1/messages', '', body)).status, 401);
    const provider = await call(o.leash, '/anthropic/v1/messages', FAKE.anthropic, body);
    assert.equal(provider.status, 401);
    assert.match(provider.json!.error.message, /Leash keys/);
    assert.equal((await call(o.leash, '/anthropic/v1/messages', 'lsh_doesnotexist000000000000000000', body)).status, 401);
    assert.equal((await call(o.leash, '/openai/v1/chat/completions', anthropicKey, { model: 'x', messages: [] })).status, 400, 'key bound to its provider type');
  });

  await step('anthropic non-streaming request is forwarded and metered', async () => {
    const r = await call(o.leash, '/anthropic/v1/messages', anthropicKey, { model: 'claude-sonnet-5-5', max_tokens: 100, messages: [{ role: 'user', content: 'hello there' }] });
    assert.equal(r.status, 200);
    assert.equal(r.json!.content[0].text, 'Hello from mock');
    assert.ok(r.headers.get('x-leash-session'));
    const up = (await received()).at(-1)!;
    assert.equal(up.headers['x-api-key'], 'mock-anthropic-provider-key', 'real key injected upstream');
    // 1000 in x $2 + 500 out x $10 + 2000 cache read x $0.20 per million = $0.0074
    const k = (await d.stats()).keys.find((x: Json) => x.name === 'e2e-claude');
    assert.ok(Math.abs(k.spend_today - 0.0074) < 1e-9, `spend ${k.spend_today}`);
  });

  await step('anthropic streaming passes through and is metered', async () => {
    const r = await call(o.leash, '/anthropic/v1/messages', anthropicKey, { model: 'claude-sonnet-5-5', max_tokens: 100, stream: true, messages: [{ role: 'user', content: 'stream please' }] });
    assert.equal(r.status, 200);
    assert.match(r.text, /Hello from mock/);
    assert.match(r.text, /message_stop/);
    const k = (await d.stats()).keys.find((x: Json) => x.name === 'e2e-claude');
    assert.ok(Math.abs(k.spend_today - 0.0148) < 1e-9, `spend ${k.spend_today}`);
  });

  await step('secrets are redacted from user content, model output is untouched', async () => {
    const r = await call(o.leash, '/anthropic/v1/messages', anthropicKey, {
      model: 'claude-sonnet-5-5', max_tokens: 100,
      messages: [
        { role: 'user', content: `deploy with ${FAKE.aws} and ${FAKE.password}` },
        { role: 'assistant', content: [{ type: 'text', text: `example key ${FAKE.aws}` }] },
        { role: 'user', content: [{ type: 'text', text: `my key is ${FAKE.anthropic}` }] },
      ],
    });
    assert.equal(r.status, 200);
    const sent = JSON.stringify((await received()).at(-1)!.body);
    assert.match(sent, /\[REDACTED:aws_access_key\]/);
    assert.match(sent, /\[REDACTED:assigned_secret\]/);
    assert.match(sent, /\[REDACTED:anthropic_key\]/);
    assert.ok(sent.includes(`example key ${FAKE.aws}`), 'assistant turn must not be edited');
    const stats = await d.stats();
    assert.ok(stats.alerts.some((a: Json) => a.rule === 'secret_redacted'));
  });

  let loopSession = '';
  await step('loop: repeated failing tool call is blocked with a non-retryable 403', async () => {
    const body = { model: 'claude-sonnet-5-5', max_tokens: 100, messages: loopHistory(2) };
    const hdr = { 'x-leash-session': 'loop-test' };
    assert.equal((await call(o.leash, '/anthropic/v1/messages', anthropicKey, body, hdr)).status, 200, '2 repeats pass');
    body.messages = loopHistory(4);
    const blocked = await call(o.leash, '/anthropic/v1/messages', anthropicKey, body, hdr);
    assert.equal(blocked.status, 403);
    assert.equal(blocked.json!.error.type, 'permission_error');
    assert.match(blocked.json!.error.message, /Leash stopped this request/);
    const again = await call(o.leash, '/anthropic/v1/messages', anthropicKey, body, hdr);
    assert.equal(again.status, 403, 'session stays blocked');
    loopSession = `${anthropicKeyId}:loop-test`;
    const s = (await d.stats()).sessions.find((x: Json) => x.id === loopSession);
    assert.equal(s.status, 'blocked');
  });

  await step('loop: resuming from the dashboard lets the session continue', async () => {
    const res = await d.post(`/sessions/${encodeURIComponent(loopSession)}/resume`, {});
    assert.equal(res.status, 303);
    const r = await call(o.leash, '/anthropic/v1/messages', anthropicKey, { model: 'claude-sonnet-5-5', max_tokens: 100, messages: loopHistory(5) }, { 'x-leash-session': 'loop-test' });
    assert.equal(r.status, 200, 'old repetitions no longer count');
    const page = await (await d.get(`/sessions/${encodeURIComponent(loopSession)}`)).text();
    assert.match(page, /npm test/, 'replay shows tool calls');
  });

  await step('budget: daily limit blocks the next request', async () => {
    assert.equal((await d.post(`/keys/${anthropicKeyId}/policy`, { daily_usd: '0.01', monthly_usd: '', model_allow: '', redact_mode: 'redact', loop_mode: 'enforce' })).status, 303);
    const r = await call(o.leash, '/anthropic/v1/messages', anthropicKey, { model: 'claude-sonnet-5-5', max_tokens: 100, messages: [{ role: 'user', content: 'budget test' }] });
    assert.equal(r.status, 403);
    assert.match(r.json!.error.message, /daily budget/);
  });

  await step('model allowlist', async () => {
    await d.post(`/keys/${anthropicKeyId}/policy`, { daily_usd: '1000', monthly_usd: '', model_allow: 'claude-haiku-*', redact_mode: 'redact', loop_mode: 'enforce' });
    const r = await call(o.leash, '/anthropic/v1/messages', anthropicKey, { model: 'claude-sonnet-5-5', max_tokens: 10, messages: [{ role: 'user', content: 'x' }] });
    assert.equal(r.status, 403);
    assert.match(r.json!.error.message, /not allowed/);
    const ok = await call(o.leash, '/anthropic/v1/messages', anthropicKey, { model: 'claude-haiku-5-5', max_tokens: 10, messages: [{ role: 'user', content: 'x' }] });
    assert.equal(ok.status, 200);
  });

  await step('secret block mode refuses the request', async () => {
    await d.post(`/keys/${anthropicKeyId}/policy`, { daily_usd: '1000', monthly_usd: '', model_allow: '', redact_mode: 'block', loop_mode: 'enforce' });
    const before = (await received()).length;
    const r = await call(o.leash, '/anthropic/v1/messages', anthropicKey, { model: 'claude-sonnet-5-5', max_tokens: 10, messages: [{ role: 'user', content: `key ${FAKE.aws}` }] });
    assert.equal(r.status, 403);
    assert.equal((await received()).length, before, 'nothing reached the provider');
    await d.post(`/keys/${anthropicKeyId}/policy`, { daily_usd: '1000', monthly_usd: '', model_allow: '', redact_mode: 'redact', loop_mode: 'enforce' });
  });

  await step('openai chat streaming gets usage injected and metered', async () => {
    const r = await call(o.leash, '/openai/v1/chat/completions', openaiKey, { model: 'gpt-mock', stream: true, messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(r.status, 200);
    assert.match(r.text, /\[DONE\]/);
    const up = (await received()).at(-1)!;
    assert.equal(up.body.stream_options.include_usage, true);
    assert.equal(up.headers.authorization, 'Bearer mock-openai-provider-key');
    const k = (await d.stats()).keys.find((x: Json) => x.name === 'e2e-openai');
    // unpriced model -> fail-safe $15/$60: (1000 x 15 + 300 x 60 + 200 x 1.5) / 1e6
    assert.ok(Math.abs(k.spend_today - 0.0333) < 1e-9, `spend ${k.spend_today}`);
  });

  await step('openai responses API (streamed) and custom price', async () => {
    assert.equal((await d.post('/prices', { kind: 'openai', model: 'gpt-mock', input: '1', output: '2', cache_write: '', cache_read: '' })).status, 303);
    const r = await call(o.leash, '/openai/v1/responses', openaiKey, { model: 'gpt-mock', stream: true, input: [{ role: 'user', content: 'hi' }] });
    assert.equal(r.status, 200);
    assert.match(r.text, /response.completed/);
    const k = (await d.stats()).keys.find((x: Json) => x.name === 'e2e-openai');
    // previous 0.0333 + (800 x 1 + 100 x 2) / 1e6
    assert.ok(Math.abs(k.spend_today - 0.0343) < 1e-9, `spend ${k.spend_today}`);
  });

  await step('pass-through endpoints', async () => {
    const models = await fetch(o.leash + '/openai/v1/models', { headers: { authorization: `Bearer ${openaiKey}` } });
    assert.equal(models.status, 200);
    const ct = await call(o.leash, '/anthropic/v1/messages/count_tokens', anthropicKey, { model: 'claude-sonnet-5-5', messages: [{ role: 'user', content: 'count' }] });
    assert.equal(ct.json!.input_tokens, 42);
    assert.equal((await fetch(o.leash + '/anthropic/v1/files', { method: 'POST', headers: { 'x-api-key': anthropicKey } })).status, 404, 'unlisted paths are not proxied');
  });

  await step('webhook and telegram alert delivery', async () => {
    const res = await d.post('/alerts/settings', { webhook_url: `${o.mockFromLeash}/webhook`, telegram_chat: '', telegram_token: '' });
    assert.equal(res.status, 303);
    assert.equal((await d.post('/alerts/test', {})).status, 303);
    assert.ok((await received()).some((r) => r.path === '/webhook' && r.body.source === 'leash'));
  });

  await step('revoked key stops working immediately', async () => {
    await d.post(`/keys/${anthropicKeyId}/revoke`, {});
    const r = await call(o.leash, '/anthropic/v1/messages', anthropicKey, { model: 'claude-sonnet-5-5', max_tokens: 10, messages: [{ role: 'user', content: 'x' }] });
    assert.equal(r.status, 401);
  });

  await step('every dashboard page renders', async () => {
    for (const path of ['/', '/sessions', '/keys', `/keys/${anthropicKeyId}`, '/providers', '/alerts', `/sessions/${encodeURIComponent(loopSession)}`]) {
      const r = await d.get(path);
      assert.equal(r.status, 200, path);
    }
  });

  await step('sign out', async () => {
    assert.equal((await d.post('/logout', {})).status, 303);
    assert.equal((await d.get('/')).status, 303);
  });
}
