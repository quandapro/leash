import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigError, loadConfig } from '../src/config.ts';
import { decrypt, deriveKeys, encrypt, safeEqual } from '../src/crypto.ts';
import { Store } from '../src/db.ts';
import { checkBudget } from '../src/guard/budget.ts';
import { evaluate, extract } from '../src/guard/loop.ts';
import { PriceBook } from '../src/guard/pricing.ts';
import { entropy, redactBody, redactString } from '../src/guard/redact.ts';
import { esc, html } from '../src/dashboard/html.ts';
import { SseParser, StreamUsage } from '../src/proxy/usage.ts';
import { modelAllowed } from '../src/proxy/handler.ts';
import { FAKE } from '../e2e/scenario.ts';

test('config rejects weak or missing secrets', () => {
  assert.throws(() => loadConfig({}), ConfigError);
  assert.throws(() => loadConfig({ LEASH_ADMIN_TOKEN: 'short', LEASH_SECRET: 'x'.repeat(40) }), ConfigError);
  assert.throws(() => loadConfig({ LEASH_ADMIN_TOKEN: 'a'.repeat(40), LEASH_SECRET: 'a'.repeat(40) }), /different/);
  const cfg = loadConfig({ LEASH_ADMIN_TOKEN: 'a'.repeat(24), LEASH_SECRET: 'b'.repeat(32), LEASH_PUBLIC_URL: 'https://leash.example.com/' });
  assert.equal(cfg.publicUrl, 'https://leash.example.com');
});

test('encryption round-trips and detects tampering', () => {
  const k = deriveKeys('s'.repeat(32));
  const sealed = encrypt(k, 'provider-secret');
  assert.notEqual(sealed, encrypt(k, 'provider-secret'), 'random IV');
  assert.equal(decrypt(k, sealed), 'provider-secret');
  const raw = Buffer.from(sealed.slice(3), 'base64');
  raw[raw.length - 1]! ^= 1;
  assert.throws(() => decrypt(k, 'v1:' + raw.toString('base64')));
  assert.throws(() => decrypt(deriveKeys('t'.repeat(32)), sealed));
  assert.ok(safeEqual('abc', 'abc'));
  assert.ok(!safeEqual('abc', 'abcd'));
});

test('redaction catches common credentials and leaves normal text alone', () => {
  const hits: string[] = [];
  const out = redactString(`aws ${FAKE.aws} ${FAKE.password} key ${FAKE.anthropic}`, hits);
  assert.ok(!out.includes(FAKE.aws));
  assert.ok(!out.includes(FAKE.anthropic));
  assert.ok(!out.includes('q8Zr2Lx9Vt4Kp7Wm3Nc6'));
  assert.deepEqual(new Set(hits), new Set(['aws_access_key', 'anthropic_key', 'assigned_secret']));

  const benign = ['token = process.env.API_TOKEN', 'password: ${DB_PASSWORD}', 'const api_key = getenv("KEY")',
    'commit 3f9a2c1d4e5b6a7c8d9e0f1a2b3c4d5e6f7a8b9c', 'apiKeyName = "primary"', 'secret_santa = aaaaaaaaaaaaaaaa'];
  for (const s of benign) {
    const h: string[] = [];
    assert.equal(redactString(s, h), s, s);
  }
  const pem = '-----BEGIN ' + 'RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----';
  assert.equal(redactString(pem, []), '[REDACTED:private_key]');
  assert.ok(entropy('aaaa') < 1 && entropy('q8Zr2Lx9Vt4Kp7Wm') > 3.5);
});

test('redaction never edits thinking, signatures, images or assistant turns', () => {
  const body = {
    model: 'claude-sonnet-5-5',
    system: `ops key ${FAKE.aws}`,
    messages: [
      { role: 'user', content: [{ type: 'text', text: FAKE.aws }, { type: 'image', source: { type: 'base64', data: FAKE.aws } }] },
      { role: 'assistant', content: [{ type: 'thinking', thinking: FAKE.aws, signature: 'sig' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: FAKE.aws } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: `out ${FAKE.aws}` }] },
    ],
  };
  const hits = redactBody(body as Record<string, unknown>, true);
  assert.equal(hits.length, 3);
  const s = JSON.stringify(body);
  assert.equal(s.split(FAKE.aws).length - 1, 3, 'image data, thinking and tool_use input untouched');
  assert.match(body.system, /REDACTED/);
});

test('loop rules: repeated calls, rereads and identical failures', () => {
  const msgs: unknown[] = [{ role: 'user', content: 'go' }];
  for (let i = 0; i < 3; i++) {
    msgs.push({ role: 'assistant', content: [{ type: 'tool_use', id: `a${i}`, name: 'Bash', input: { command: 'make' } }] });
    msgs.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `a${i}`, content: 'ok' }] });
  }
  let ex = extract('anthropic', { messages: msgs });
  assert.equal(ex.firstUserText, 'go');
  assert.deepEqual(evaluate(ex.events, 0).map((f) => `${f.rule}:${f.level}`), ['repeated_call:warn']);

  msgs.push({ role: 'assistant', content: [{ type: 'tool_use', id: 'a3', name: 'Bash', input: { command: 'make' } }] });
  ex = extract('anthropic', { messages: msgs });
  assert.deepEqual(evaluate(ex.events, 0).map((f) => `${f.rule}:${f.level}`), ['repeated_call:block']);
  assert.deepEqual(evaluate(ex.events, ex.events.length), [], 'offset hides history');

  // argument key order does not matter
  const a = extract('anthropic', { messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 'x', name: 'T', input: { a: 1, b: 2 } }, { type: 'tool_use', id: 'y', name: 'T', input: { b: 2, a: 1 } }] }] });
  assert.equal(a.events[0]!.argsHash, a.events[1]!.argsHash);

  // file reread: 5 reads of the same file, a write resets the count
  const reads = (n: number, write: boolean) => {
    const content: unknown[] = [];
    for (let i = 0; i < n; i++) content.push({ type: 'tool_use', id: `r${i}`, name: 'Read', input: { file_path: '/src/a.ts', offset: i } });
    if (write) content.splice(2, 0, { type: 'tool_use', id: 'w', name: 'Edit', input: { file_path: '/src/a.ts' } });
    return extract('anthropic', { messages: [{ role: 'assistant', content }] }).events;
  };
  assert.ok(evaluate(reads(5, false), 0).some((f) => f.rule === 'file_reread'));
  assert.ok(!evaluate(reads(5, true), 0).some((f) => f.rule === 'file_reread'));

  // OpenAI chat and Responses formats
  const chat = extract('openai-chat', { messages: [
    { role: 'user', content: 'hi' },
    ...[0, 1, 2].flatMap((i) => [
      { role: 'assistant', tool_calls: [{ id: `c${i}`, type: 'function', function: { name: 'run', arguments: `{"cmd":"pytest ${i}"}` } }] },
      { role: 'tool', tool_call_id: `c${i}`, content: 'Error: assertion failed' },
    ]),
  ] });
  assert.deepEqual(evaluate(chat.events, 0).map((f) => f.rule), ['identical_failure']);
  const resp = extract('openai-responses', { input: [
    { role: 'user', content: 'fix' },
    ...[0, 1, 2, 3].flatMap((i) => [
      { type: 'function_call', call_id: `f${i}`, name: 'shell', arguments: '{"command":["ls"]}' },
      { type: 'function_call_output', call_id: `f${i}`, output: 'file.txt' },
    ]),
  ] });
  assert.equal(resp.firstUserText, 'fix');
  assert.deepEqual(evaluate(resp.events, 0).map((f) => `${f.rule}:${f.level}`), ['repeated_call:block']);

  const cc = extract('anthropic', { metadata: { user_id: 'user_abc_account__session_0f8c2a6e-1111-4222-8333-944445555666' }, messages: [] });
  assert.equal(cc.clientSessionId, '0f8c2a6e-1111-4222-8333-944445555666');

  // Claude Code 2.1+: user_id is a JSON string, and the first user turn starts with injected reminders.
  const cc2 = extract('anthropic', {
    metadata: { user_id: JSON.stringify({ device_id: 'ab12', account_uuid: '', session_id: '7cdd323c-5a0f-4b9f-9f5e-b2a178f1f3de' }) },
    messages: [{ role: 'user', content: [
      { type: 'text', text: '<system-reminder>\nCodebase and user instructions are shown below.\n</system-reminder>' },
      { type: 'text', text: 'Fix the failing invoice tests' },
    ] }],
  });
  assert.equal(cc2.clientSessionId, '7cdd323c-5a0f-4b9f-9f5e-b2a178f1f3de');
  assert.equal(cc2.firstUserText, 'Fix the failing invoice tests');
  assert.equal(extract('anthropic', { metadata: { user_id: '{"session_id":"../../etc"}' }, messages: [] }).clientSessionId, null);
});

test('pricing: built-in Claude rates, prefixes, overrides and fail-safe fallback', () => {
  const p = new PriceBook();
  const u = { input: 1_000_000, output: 1_000_000, cacheWrite: 0, cacheRead: 0 };
  assert.equal(p.cost('anthropic', 'claude-opus-5-5', u).usd, 24);
  assert.equal(p.cost('anthropic', 'claude-sonnet-4-5-20250929', u).usd, 18);
  assert.equal(p.cost('anthropic', 'us.anthropic.claude-sonnet-5-5', u).usd, 12);
  assert.equal(p.cost('anthropic', 'claude-haiku-5-5', { input: 1000, output: 1000, cacheWrite: 0, cacheRead: 0 }).usd, 0.0006);
  assert.equal(p.cost('anthropic', 'claude-haiku-5-5', { input: 200_000, output: 0, cacheWrite: 0, cacheRead: 0 }).usd, 0.1, 'long-context rate');
  const unknown = p.cost('openai', 'gpt-x', u);
  assert.equal(unknown.known, false);
  assert.equal(unknown.usd, 75);
  p.load([{ kind: 'openai', model: 'gpt-x', input: 1, output: 2, cache_write: 1.25, cache_read: 0.1 }]);
  assert.deepEqual(p.cost('openai', 'gpt-x-mini', u), { usd: 3, known: true });
  assert.ok(p.estimate('anthropic', 'claude-opus-5-5', 4000, 128000) < 0.1, 'output estimate capped');
});

test('budgets block before the limit is crossed and warn at 80%', () => {
  const s = new Store(':memory:');
  const pid = s.createProvider({ name: 'a', kind: 'anthropic', base_url: 'https://x', enc_key: 'v1:x' });
  const kid = s.createKey({ name: 'k', prefix: 'lsh_x', hash: 'h', provider_id: pid, model_allow: '', daily_usd: 1, monthly_usd: null, redact_mode: 'redact', loop_mode: 'enforce' });
  const key = s.getKey(kid)!;
  const now = Date.now();
  const spend = (cost: number) => s.insertRequest({ session_id: null, key_id: kid, ts: now, model: 'm', in_tok: 0, out_tok: 0, cache_w: 0, cache_r: 0, cost, latency_ms: 0, status: 200, blocked: null, price_known: 1, redactions: 0 });
  assert.equal(checkBudget(s, key, 0.1, now).ok, true);
  spend(0.85);
  const v = checkBudget(s, key, 0.1, now);
  assert.equal(v.ok, true);
  assert.equal(v.warnings.length, 1);
  assert.equal(checkBudget(s, key, 0.2, now).ok, false);
  s.setSetting('global_daily_usd', '0.5');
  assert.match(checkBudget(s, { ...key, daily_usd: null }, 0, now).reason!, /global/);
  s.close();
});

test('model allowlist globs', () => {
  const k = { model_allow: 'claude-sonnet-*, gpt-5' } as Parameters<typeof modelAllowed>[0];
  assert.ok(modelAllowed(k, 'claude-sonnet-5-5'));
  assert.ok(modelAllowed(k, 'gpt-5'));
  assert.ok(!modelAllowed(k, 'gpt-5-pro'));
  assert.ok(!modelAllowed(k, 'claude-opus-5-5'));
  assert.ok(modelAllowed({ model_allow: '' } as typeof k, 'anything'));
});

test('SSE parser handles split chunks and CRLF; stream usage is cumulative', () => {
  const m = new StreamUsage('anthropic');
  const p = new SseParser((e, d) => m.onEvent(e, d));
  const text = 'event: message_start\r\ndata: {"type":"message_start","message":{"model":"claude-x","usage":{"input_tokens":10,"cache_read_input_tokens":5,"output_tokens":1}}}\r\n\r\n'
    + 'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":7}}\n\n';
  for (let i = 0; i < text.length; i += 7) p.push(text.slice(i, i + 7));
  p.end();
  assert.deepEqual(m.usage, { input: 10, output: 7, cacheWrite: 0, cacheRead: 5 });
  assert.equal(m.model, 'claude-x');

  // OpenRouter's Anthropic endpoint: nulls in message_start, real counts and billed cost in message_delta.
  const o = new StreamUsage('anthropic');
  o.onEvent('message_start', '{"type":"message_start","message":{"model":"deepseek/x","usage":{"input_tokens":0,"output_tokens":0,"cache_creation_input_tokens":null,"cache_read_input_tokens":null}}}');
  o.onEvent('message_delta', '{"type":"message_delta","usage":{"input_tokens":51,"output_tokens":356,"cache_creation_input_tokens":null,"cache_read_input_tokens":15872,"cost":0.000342422}}');
  assert.deepEqual(o.usage, { input: 51, output: 356, cacheWrite: 0, cacheRead: 15872, reportedCost: 0.000342422 });
  // A later null never wipes a count already seen.
  o.onEvent('message_delta', '{"type":"message_delta","usage":{"cache_read_input_tokens":null}}');
  assert.equal(o.usage.cacheRead, 15872);
});

test('html templates escape interpolations', () => {
  const evil = '<script>alert(1)</script>"\'';
  assert.equal(html`<p title="${evil}">${evil}</p>`.value, `<p title="${esc(evil)}">${esc(evil)}</p>`);
  assert.ok(!html`${evil}`.value.includes('<script>'));
});

test('retention purge removes old rows', () => {
  const s = new Store(':memory:');
  const old = Date.now() - 40 * 86_400_000;
  s.insertRequest({ session_id: 'x', key_id: 1, ts: old, model: 'm', in_tok: 0, out_tok: 0, cache_w: 0, cache_r: 0, cost: 1, latency_ms: 0, status: 200, blocked: null, price_known: 1, redactions: 0 });
  s.purge(30, Date.now());
  assert.equal(s.totalSpendSince(0), 0);
  s.close();
});
