// Reads token usage from provider responses, streamed (SSE) or not.
import type { Usage } from '../guard/pricing.ts';
import type { ApiFormat } from '../guard/loop.ts';

export class SseParser {
  private buf = '';
  private onEvent: (event: string, data: string) => void;

  constructor(onEvent: (event: string, data: string) => void) {
    this.onEvent = onEvent;
  }

  push(chunk: string): void {
    this.buf += chunk;
    // Guard against an upstream that never sends a blank line.
    if (this.buf.length > 4 * 1024 * 1024) this.buf = this.buf.slice(-1024 * 1024);
    let idx: number;
    while ((idx = this.findBoundary()) >= 0) {
      const raw = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx).replace(/^(\r?\n){1,2}/, '');
      this.dispatch(raw);
    }
  }

  end(): void {
    if (this.buf.trim()) this.dispatch(this.buf);
    this.buf = '';
  }

  private findBoundary(): number {
    const a = this.buf.indexOf('\n\n');
    const b = this.buf.indexOf('\r\n\r\n');
    if (a < 0) return b;
    if (b < 0) return a;
    return Math.min(a, b);
  }

  private dispatch(raw: string): void {
    let event = 'message';
    const data: string[] = [];
    for (const line of raw.split(/\r?\n/)) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
    if (data.length) this.onEvent(event, data.join('\n'));
  }
}

export const emptyUsage = (): Usage => ({ input: 0, output: 0, cacheWrite: 0, cacheRead: 0 });

type Obj = Record<string, unknown>;
const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

// OpenRouter and some gateways report what they billed; providers that don't simply omit it.
function reportedCost(u: Obj, into: Usage): void {
  if (isNum(u.cost) && u.cost >= 0) into.reportedCost = u.cost;
}

function fromAnthropic(u: Obj | undefined, into: Usage): void {
  if (!u) return;
  // Only numbers overwrite: gateways send `null` for fields they fill in later events.
  if (isNum(u.input_tokens)) into.input = u.input_tokens;
  if (isNum(u.cache_creation_input_tokens)) into.cacheWrite = u.cache_creation_input_tokens;
  if (isNum(u.cache_read_input_tokens)) into.cacheRead = u.cache_read_input_tokens;
  if (isNum(u.output_tokens)) into.output = u.output_tokens;
  reportedCost(u, into);
}

function fromOpenAIChat(u: Obj | undefined, into: Usage): void {
  if (!u) return;
  const cached = n((u.prompt_tokens_details as Obj | undefined)?.cached_tokens);
  into.input = Math.max(0, n(u.prompt_tokens) - cached);
  into.cacheRead = cached;
  into.output = n(u.completion_tokens);
  reportedCost(u, into);
}

function fromResponses(u: Obj | undefined, into: Usage): void {
  if (!u) return;
  const cached = n((u.input_tokens_details as Obj | undefined)?.cached_tokens);
  into.input = Math.max(0, n(u.input_tokens) - cached);
  into.cacheRead = cached;
  into.output = n(u.output_tokens);
  reportedCost(u, into);
}

/** Usage from a complete JSON response body. */
export function usageFromJson(format: ApiFormat, body: Obj): Usage {
  const u = emptyUsage();
  if (format === 'anthropic') fromAnthropic(body.usage as Obj, u);
  else if (format === 'openai-chat') fromOpenAIChat(body.usage as Obj, u);
  else fromResponses(body.usage as Obj, u);
  return u;
}

/** Accumulates usage from SSE events as they stream past. */
export class StreamUsage {
  usage = emptyUsage();
  model: string | null = null;
  private format: ApiFormat;

  constructor(format: ApiFormat) {
    this.format = format;
  }

  onEvent(event: string, data: string): void {
    if (data === '[DONE]') return;
    let msg: Obj;
    try { msg = JSON.parse(data) as Obj; } catch { return; }
    if (this.format === 'anthropic') {
      const type = msg.type ?? event;
      if (type === 'message_start') {
        const m = msg.message as Obj | undefined;
        if (typeof m?.model === 'string') this.model = m.model;
        fromAnthropic(m?.usage as Obj, this.usage);
      } else if (type === 'message_delta') {
        fromAnthropic(msg.usage as Obj, this.usage); // cumulative counts
      }
    } else if (this.format === 'openai-chat') {
      if (typeof msg.model === 'string') this.model = msg.model;
      if (msg.usage) fromOpenAIChat(msg.usage as Obj, this.usage);
    } else {
      const type = msg.type ?? event;
      if (type === 'response.completed' || type === 'response.incomplete' || type === 'response.failed') {
        const r = msg.response as Obj | undefined;
        if (typeof r?.model === 'string') this.model = r.model;
        fromResponses(r?.usage as Obj, this.usage);
      }
    }
  }
}
