// Recording proxy for live tests: Leash -> recorder -> real provider. Every exchange is appended to a JSONL
// file with request/response headers and bodies; API keys are replaced by their length and first 6 characters.
// Usage: LIVE_UPSTREAM=https://openrouter.ai/api LIVE_OUT=traces/upstream.jsonl node e2e/live/recorder.ts
import http from 'node:http';
import fs from 'node:fs';

const UPSTREAM = (process.env.LIVE_UPSTREAM ?? 'https://openrouter.ai/api').replace(/\/+$/, '');
const PORT = Number(process.env.LIVE_PORT ?? 9797);
const out = fs.createWriteStream(process.env.LIVE_OUT ?? 'upstream.jsonl', { flags: 'a' });
const SECRET_HEADERS = ['x-api-key', 'authorization'];
const HOP_HEADERS = ['host', 'connection', 'content-length', 'transfer-encoding'];
let seq = 0;

http.createServer(async (req, res) => {
  const id = ++seq;
  const t0 = Date.now();
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const reqBody = Buffer.concat(chunks).toString('utf8');

  const shown: Record<string, string> = {};
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    const value = Array.isArray(v) ? v.join(',') : (v ?? '');
    shown[k] = SECRET_HEADERS.includes(k) ? `[redacted len=${value.length} prefix=${value.slice(0, 6)}]` : value;
    if (!HOP_HEADERS.includes(k)) headers.set(k, value);
  }

  let up: Response;
  try {
    up = await fetch(UPSTREAM + (req.url ?? '/'), { method: req.method, headers, body: req.method === 'GET' ? undefined : reqBody, redirect: 'manual' });
  } catch (e) {
    out.write(JSON.stringify({ id, ts: t0, path: req.url, error: String(e) }) + '\n');
    res.writeHead(502).end();
    return;
  }
  res.writeHead(up.status, Object.fromEntries([...up.headers].filter(([k]) => !['content-encoding', 'content-length', 'transfer-encoding'].includes(k))));
  let body = '';
  let ttfb: number | null = null;
  const decoder = new TextDecoder();
  if (up.body) {
    for await (const c of up.body) {
      ttfb ??= Date.now() - t0;
      body += decoder.decode(c, { stream: true });
      res.write(c);
    }
  }
  res.end();
  let reqJson: unknown = reqBody;
  try { reqJson = JSON.parse(reqBody); } catch { /* keep raw */ }
  out.write(JSON.stringify({ id, ts: t0, ms: Date.now() - t0, ttfb, method: req.method, path: req.url, reqHeaders: shown,
    req: reqJson, status: up.status, respHeaders: Object.fromEntries(up.headers), resp: body }) + '\n');
}).listen(PORT, '127.0.0.1', () => console.log(`recorder on ${PORT} -> ${UPSTREAM}`));
