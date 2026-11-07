// Runs inside the e2e compose network: the full scenario, then a latency comparison (direct vs through Leash).
import assert from 'node:assert/strict';
import { scenario } from './scenario.ts';

const leash = process.env.LEASH_URL ?? 'http://localhost:18080';
const mock = process.env.MOCK_URL ?? 'http://localhost:9090';
const admin = process.env.ADMIN ?? '';

async function login(): Promise<{ cookie: string; csrf: string }> {
  const res = await fetch(leash + '/login', { method: 'POST', body: new URLSearchParams({ token: admin }), redirect: 'manual' });
  const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0]!;
  const page = await (await fetch(leash + '/keys', { headers: { cookie } })).text();
  return { cookie, csrf: /name="_csrf" value="([0-9a-f]{64})"/.exec(page)![1]! };
}

async function newKey(): Promise<string> {
  const { cookie, csrf } = await login();
  const page = await (await fetch(leash + '/keys', { headers: { cookie } })).text();
  const providerId = /<option value="(\d+)">anthropic \(Anthropic\)<\/option>/.exec(page)![1]!;
  const res = await fetch(leash + '/keys', {
    method: 'POST', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: csrf, name: 'load', provider_id: providerId, daily_usd: '', monthly_usd: '', model_allow: '', redact_mode: 'redact', loop_mode: 'enforce' }),
  });
  return /<pre id="newkey">(lsh_[A-Za-z0-9_-]+)<\/pre>/.exec(await res.text())![1]!;
}

function pct(xs: number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
}

async function measure(url: string, headers: Record<string, string>, n: number, concurrency: number, stream: boolean): Promise<number[]> {
  const times: number[] = [];
  let i = 0;
  const worker = async () => {
    while (i < n) {
      const id = i++;
      const body = JSON.stringify({ model: 'claude-sonnet-5-5', max_tokens: 64, stream, messages: [{ role: 'user', content: `load ${id % 50}` }] });
      const t0 = performance.now();
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', ...headers }, body });
      await res.arrayBuffer();
      assert.equal(res.status, 200);
      times.push(performance.now() - t0);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return times;
}

const log = (m: string) => console.log(m);
await scenario({ leash, admin, mock, mockFromLeash: mock, log });
log('scenario passed');

const key = await newKey();
for (const stream of [false, true]) {
  await measure(mock + '/v1/messages', { 'x-api-key': 'mock-anthropic-provider-key' }, 50, 8, stream); // warm up
  await measure(leash + '/anthropic/v1/messages', { 'x-api-key': key }, 50, 8, stream);
  const direct = await measure(mock + '/v1/messages', { 'x-api-key': 'mock-anthropic-provider-key' }, 500, 16, stream);
  const proxied = await measure(leash + '/anthropic/v1/messages', { 'x-api-key': key }, 500, 16, stream);
  const overhead50 = pct(proxied, 50) - pct(direct, 50);
  const overhead95 = pct(proxied, 95) - pct(direct, 95);
  log(`${stream ? 'stream ' : 'json   '} direct p50 ${pct(direct, 50).toFixed(1)} ms p95 ${pct(direct, 95).toFixed(1)} ms | leash p50 ${pct(proxied, 50).toFixed(1)} ms p95 ${pct(proxied, 95).toFixed(1)} ms | added p50 ${overhead50.toFixed(1)} ms p95 ${overhead95.toFixed(1)} ms`);
  assert.ok(overhead95 < 50, `p95 overhead ${overhead95.toFixed(1)} ms exceeds 50 ms`);
}
log('load test passed');
