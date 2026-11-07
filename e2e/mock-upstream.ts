// A fake model provider for tests: Anthropic Messages, OpenAI Chat Completions and Responses (streamed and not),
// plus Telegram and webhook sinks. GET /__received returns everything it saw so tests can assert on it.
import { createServer, type Server } from 'node:http';

export const MOCK_ANTHROPIC_KEY = 'mock-anthropic-provider-key';
export const MOCK_OPENAI_KEY = 'mock-openai-provider-key';

interface Received { path: string; headers: Record<string, string>; body: unknown }

export function startMock(port = 0, host = '127.0.0.1'): Promise<{ server: Server; url: string }> {
  const received: Received[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const text = Buffer.concat(chunks).toString('utf8');
    let body: Record<string, unknown> = {};
    try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
    const url = new URL(req.url ?? '/', 'http://mock');
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers[k] = v;

    if (url.pathname === '/__received') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(received));
    }
    if (url.pathname === '/__reset') {
      received.length = 0;
      return res.writeHead(204).end();
    }
    received.push({ path: url.pathname + url.search, headers, body });

    const json = (status: number, obj: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json', 'request-id': 'req_mock_1' });
      res.end(JSON.stringify(obj));
    };
    const sse = (events: [string | null, unknown][]) => {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      for (const [ev, data] of events) res.write((ev ? `event: ${ev}\n` : '') + `data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`);
      res.end();
    };

    // Telegram and webhook sinks
    if (/^\/bot[^/]+\/sendMessage$/.test(url.pathname) || url.pathname === '/webhook') return json(200, { ok: true });

    // Anthropic
    if (url.pathname.startsWith('/v1/')) {
      if (headers['x-api-key'] !== MOCK_ANTHROPIC_KEY) return json(401, { type: 'error', error: { type: 'authentication_error', message: 'bad key' } });
      if (url.pathname === '/v1/models') return json(200, { data: [{ id: 'claude-sonnet-5-5' }] });
      if (url.pathname === '/v1/messages/count_tokens') return json(200, { input_tokens: 42 });
      if (url.pathname === '/v1/messages') {
        const model = String(body.model);
        const usage = { input_tokens: 1000, cache_creation_input_tokens: 0, cache_read_input_tokens: 2000, output_tokens: 500 };
        if (body.stream) {
          return sse([
            ['message_start', { type: 'message_start', message: { id: 'msg_1', model, usage: { ...usage, output_tokens: 1 } } }],
            ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
            ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello from mock' } }],
            ['content_block_stop', { type: 'content_block_stop', index: 0 }],
            ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 500 } }],
            ['message_stop', { type: 'message_stop' }],
          ]);
        }
        return json(200, { id: 'msg_1', type: 'message', role: 'assistant', model, content: [{ type: 'text', text: 'Hello from mock' }], stop_reason: 'end_turn', usage });
      }
    }

    // OpenAI-compatible
    if (headers.authorization !== `Bearer ${MOCK_OPENAI_KEY}`) return json(401, { error: { message: 'bad key', type: 'invalid_request_error' } });
    if (url.pathname === '/models') return json(200, { data: [{ id: 'gpt-mock' }] });
    if (url.pathname === '/chat/completions') {
      const usage = { prompt_tokens: 1200, completion_tokens: 300, prompt_tokens_details: { cached_tokens: 200 } };
      if (body.stream) {
        const so = body.stream_options as { include_usage?: boolean } | undefined;
        return sse([
          [null, { id: 'c1', model: body.model, choices: [{ index: 0, delta: { content: 'Hi' } }] }],
          [null, { id: 'c1', model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }],
          ...(so?.include_usage ? [[null, { id: 'c1', model: body.model, choices: [], usage }] as [null, unknown]] : []),
          [null, '[DONE]'],
        ]);
      }
      return json(200, { id: 'c1', model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: 'Hi' } }], usage });
    }
    if (url.pathname === '/responses') {
      const usage = { input_tokens: 800, output_tokens: 100, input_tokens_details: { cached_tokens: 0 } };
      if (body.stream) {
        return sse([
          ['response.created', { type: 'response.created', response: { id: 'r1', model: body.model } }],
          ['response.output_text.delta', { type: 'response.output_text.delta', delta: 'Hi' }],
          ['response.completed', { type: 'response.completed', response: { id: 'r1', model: body.model, usage } }],
        ]);
      }
      return json(200, { id: 'r1', model: body.model, output: [], usage });
    }
    json(404, { error: { message: 'not found' } });
  });
  return new Promise((resolve) => {
    server.listen(port, host, () => {
      const addr = server.address();
      const p = typeof addr === 'object' && addr ? addr.port : port;
      resolve({ server, url: `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${p}` });
    });
  });
}

// Run standalone (used by the Docker e2e): node e2e/mock-upstream.ts
if (process.argv[1]?.endsWith('mock-upstream.ts')) {
  const port = Number(process.env.PORT ?? 9090);
  void startMock(port, '0.0.0.0').then(({ url }) => console.log(`mock upstream on ${url}`));
}
