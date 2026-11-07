// Outbound secret redaction. Walks the user-visible text of a request body and replaces anything that looks
// like a credential with a deterministic marker. Signed or binary fields (thinking, signatures, images) are
// never touched, because changing them breaks the provider's validation.

interface Rule { name: string; re: RegExp }

const RULES: Rule[] = [
  { name: 'private_key', re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/g },
  { name: 'anthropic_key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { name: 'openai_key', re: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}/g },
  { name: 'leash_key', re: /\blsh_[A-Za-z0-9_-]{24,}/g },
  { name: 'aws_access_key', re: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g },
  { name: 'github_token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/g },
  { name: 'gitlab_token', re: /\bglpat-[A-Za-z0-9_-]{20,}/g },
  { name: 'slack_token', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  { name: 'stripe_key', re: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g },
  { name: 'google_api_key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  { name: 'connection_string', re: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqps?):\/\/[^\s:@/]+:[^\s@/]{4,}@/g },
];

// KEY=value / "token": "value" pairs, kept only when the value looks random enough to be a real secret.
const ASSIGNMENT = /\b([A-Za-z0-9_.-]*(?:api[_-]?key|secret|token|passw(?:or)?d|pwd|access[_-]?key|private[_-]?key|client[_-]?secret)[A-Za-z0-9_.-]*)(["']?\s*[:=]\s*["']?)([^\s"'`,;)\]}]{12,})/gi;

const MARKER = /^\[REDACTED:/;

export function entropy(s: string): number {
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of freq.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

function looksLikeReference(v: string): boolean {
  return /^(\$|\{|<|process\.env|os\.environ|env\(|getenv|secrets\.|vault:|%|xxx|\*\*\*|placeholder|changeme|your[_-])/i.test(v);
}

export function redactString(s: string, hits: string[]): string {
  let out = s;
  for (const rule of RULES) {
    out = out.replace(rule.re, () => {
      hits.push(rule.name);
      return `[REDACTED:${rule.name}]`;
    });
  }
  out = out.replace(ASSIGNMENT, (whole, name: string, sep: string, value: string) => {
    if (MARKER.test(value) || looksLikeReference(value) || entropy(value) < 3.5) return whole;
    hits.push('assigned_secret');
    return `${name}${sep}[REDACTED:assigned_secret]`;
  });
  return out;
}

// Keys whose values must stay byte-identical (signatures, ids, encrypted reasoning, binary payloads).
const SKIP_KEYS = new Set([
  'signature', 'data', 'id', 'tool_use_id', 'call_id', 'previous_response_id', 'encrypted_content',
  'model', 'metadata', 'tools', 'tool_choice', 'type', 'role', 'name', 'cache_control', 'image_url', 'file_id', 'url',
]);
// Content block types that are signed, binary, or written by the model itself. Model output is never
// rewritten: the provider produced it, and editing past assistant turns invalidates preserved thinking.
const SKIP_TYPES = new Set([
  'thinking', 'redacted_thinking', 'reasoning', 'image', 'input_image', 'input_file', 'document', 'input_audio',
  'tool_use', 'server_tool_use', 'function_call', 'custom_tool_call', 'local_shell_call',
]);

function walk(value: unknown, hits: string[], mutate: boolean): unknown {
  if (typeof value === 'string') {
    const out = redactString(value, hits);
    return mutate ? out : value;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) value[i] = walk(value[i], hits, mutate);
    return value;
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (typeof obj.type === 'string' && SKIP_TYPES.has(obj.type)) return value;
    if (obj.role === 'assistant') return value;
    for (const k of Object.keys(obj)) {
      if (SKIP_KEYS.has(k)) continue;
      obj[k] = walk(obj[k], hits, mutate);
    }
  }
  return value;
}

/** Scans (and with mutate=true, rewrites) the prompt-bearing fields of a request body. Returns rule names hit. */
export function redactBody(body: Record<string, unknown>, mutate: boolean): string[] {
  const hits: string[] = [];
  for (const field of ['system', 'messages', 'input', 'instructions', 'prompt']) {
    if (field in body) body[field] = walk(body[field], hits, mutate);
  }
  return hits;
}

/** Short, redacted, single-line preview for storage. */
export function preview(s: string, max = 200): string {
  const flat = redactString(s, []).replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat;
}
