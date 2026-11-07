// Token prices in USD per million tokens. Claude prices from Anthropic's model table (2026-10);
// OpenAI-compatible prices are set by the admin. Unknown models are charged at the provider's
// most expensive known price so budgets fail safe.
import type { Price, ProviderKind } from '../db.ts';

export interface Usage {
  input: number;      // uncached input tokens
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

interface Rate { input: number; output: number; cacheWrite?: number; cacheRead?: number; longInput?: { above: number; input: number; output: number } }

// Longest prefix wins, so dated IDs such as claude-sonnet-4-5-20250929 match their family.
const CLAUDE: Record<string, Rate> = {
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25 },
  'claude-mythos-5-1': { input: 10, output: 50, cacheRead: 0.25 },
  'claude-fable-5': { input: 10, output: 50 },
  'claude-mythos-5': { input: 10, output: 50 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-opus-4-7': { input: 5, output: 25 },
  'claude-opus-4-6': { input: 5, output: 25 },
  'claude-opus-4-5': { input: 5, output: 25 },
  'claude-opus-4-1': { input: 15, output: 75 },
  'claude-opus-4': { input: 15, output: 75 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2 },
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-sonnet-4-5': { input: 3, output: 15 },
  'claude-sonnet-4': { input: 3, output: 15 },
  'claude-3-7-sonnet': { input: 3, output: 15 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, longInput: { above: 100_000, input: 0.5, output: 2.5 } },
  'claude-haiku-4-5': { input: 1, output: 5 },
  'claude-3-5-haiku': { input: 0.8, output: 4 },
};

// Fail-safe defaults for models nobody has priced yet.
const FALLBACK: Record<ProviderKind, Rate> = {
  anthropic: { input: 10, output: 50 },
  openai: { input: 15, output: 60 },
};

export function normalizeModel(model: string): string {
  const m = model.toLowerCase().trim();
  const i = m.indexOf('claude-');
  return i > 0 ? m.slice(i) : m; // strips "anthropic." / "us.anthropic." style prefixes
}

function lookup(table: Record<string, Rate>, model: string): Rate | undefined {
  let best: string | undefined;
  for (const prefix of Object.keys(table)) {
    if (model.startsWith(prefix) && (!best || prefix.length > best.length)) best = prefix;
  }
  return best ? table[best] : undefined;
}

export class PriceBook {
  private custom = new Map<string, Rate>();

  load(prices: Price[]): void {
    this.custom.clear();
    for (const p of prices) {
      this.custom.set(`${p.kind}:${normalizeModel(p.model)}`, { input: p.input, output: p.output, cacheWrite: p.cache_write, cacheRead: p.cache_read });
    }
  }

  rate(kind: ProviderKind, model: string): { rate: Rate; known: boolean } {
    const m = normalizeModel(model);
    const customTable: Record<string, Rate> = {};
    for (const [k, v] of this.custom) if (k.startsWith(kind + ':')) customTable[k.slice(kind.length + 1)] = v;
    const custom = lookup(customTable, m);
    if (custom) return { rate: custom, known: true };
    if (kind === 'anthropic') {
      const builtin = lookup(CLAUDE, m);
      if (builtin) return { rate: builtin, known: true };
    }
    return { rate: FALLBACK[kind], known: false };
  }

  cost(kind: ProviderKind, model: string, u: Usage): { usd: number; known: boolean } {
    const { rate, known } = this.rate(kind, model);
    const totalIn = u.input + u.cacheWrite + u.cacheRead;
    const long = rate.longInput && totalIn > rate.longInput.above ? rate.longInput : undefined;
    const inP = long?.input ?? rate.input;
    const outP = long?.output ?? rate.output;
    const cw = rate.cacheWrite ?? inP * 1.25;
    const cr = rate.cacheRead ?? inP * 0.1;
    const usd = (u.input * inP + u.output * outP + u.cacheWrite * cw + u.cacheRead * cr) / 1_000_000;
    return { usd, known };
  }

  /** Upper-bound estimate before a request is sent: ~4 characters per input token, output capped at 4096 tokens. */
  estimate(kind: ProviderKind, model: string, inputChars: number, maxTokens: number | undefined): number {
    const { rate } = this.rate(kind, model);
    const out = Math.min(maxTokens ?? 4096, 4096);
    return ((inputChars / 4) * rate.input + out * rate.output) / 1_000_000;
  }
}
