// Loop detection. Every agent request carries the conversation so far, so the rules run statelessly over the
// tool calls and tool results in that history. Works for Anthropic Messages, OpenAI Chat Completions and
// OpenAI Responses bodies.
import { createHash } from 'node:crypto';
import { preview } from './redact.ts';

export type ApiFormat = 'anthropic' | 'openai-chat' | 'openai-responses';

export interface ToolEventIn {
  kind: 'call' | 'result';
  name: string;
  argsHash: string;
  path: string | null;
  resultHash: string | null;
  isError: boolean;
  preview: string;
}

export interface Finding {
  rule: 'repeated_call' | 'file_reread' | 'identical_failure';
  level: 'warn' | 'block';
  message: string;
}

export interface LoopPolicy {
  repeatWindow: number;
  repeatWarn: number;
  repeatBlock: number;
  rereadWarn: number;
  failureBlock: number;
}

export const DEFAULT_POLICY: LoopPolicy = { repeatWindow: 10, repeatWarn: 3, repeatBlock: 4, rereadWarn: 5, failureBlock: 3 };

function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stableStringify((v as Record<string, unknown>)[k])).join(',') + '}';
  }
  return JSON.stringify(v) ?? 'null';
}

export function hash(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 16);
}

function parseArgs(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw ?? {};
  try { return JSON.parse(raw); } catch { return raw; }
}

function pathOf(args: unknown): string | null {
  if (!args || typeof args !== 'object') return null;
  const a = args as Record<string, unknown>;
  const p = a.file_path ?? a.path ?? a.filePath ?? a.notebook_path ?? a.filename;
  return typeof p === 'string' ? p : null;
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((c) => {
      if (typeof c === 'string') return c;
      if (c && typeof c === 'object') {
        const o = c as Record<string, unknown>;
        if (typeof o.text === 'string') return o.text;
        if (typeof o.output === 'string') return o.output;
      }
      return '';
    }).join('\n');
  }
  if (content && typeof content === 'object') return stableStringify(content);
  return '';
}

function call(name: string, args: unknown): ToolEventIn {
  const s = typeof args === 'string' ? args : stableStringify(args);
  return { kind: 'call', name, argsHash: hash(name + '\u0000' + s), path: pathOf(args), resultHash: null, isError: false, preview: preview(s) };
}

function result(name: string, content: unknown, isError: boolean): ToolEventIn {
  const text = textOf(content);
  return { kind: 'result', name, argsHash: '', path: null, resultHash: hash(text), isError, preview: preview(text) };
}

// Claude Code wraps injected context in <system-reminder> tags; it is not what the user typed.
function userText(content: unknown): string {
  return textOf(content).replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
}

const SESSION_ID = /^[0-9a-f][0-9a-f-]{7,63}$/i;

// Claude Code puts its session id in metadata.user_id: a JSON object ({"session_id": ...}) since 2.1,
// `user_<hash>_account_<uuid>_session_<uuid>` before that.
function claudeCodeSession(uid: unknown): string | null {
  if (typeof uid !== 'string' || !uid) return null;
  if (uid.startsWith('{')) {
    try {
      const sid = (JSON.parse(uid) as { session_id?: unknown }).session_id;
      if (typeof sid === 'string' && SESSION_ID.test(sid)) return sid;
    } catch { /* fall through to the legacy format */ }
  }
  return /session_([0-9a-f-]{8,})/i.exec(uid)?.[1] ?? null;
}

export interface Extracted {
  events: ToolEventIn[];
  firstUserText: string;
  clientSessionId: string | null;
}

export function extract(format: ApiFormat, body: Record<string, unknown>): Extracted {
  const events: ToolEventIn[] = [];
  const names = new Map<string, string>(); // call id -> tool name
  let firstUserText = '';
  let clientSessionId: string | null = null;

  if (format === 'anthropic') {
    const meta = body.metadata as Record<string, unknown> | undefined;
    clientSessionId = claudeCodeSession(meta?.user_id);
    for (const msg of (Array.isArray(body.messages) ? body.messages : []) as Record<string, unknown>[]) {
      const content = msg.content;
      if (msg.role === 'user' && !firstUserText) firstUserText = userText(content);
      if (!Array.isArray(content)) continue;
      for (const block of content as Record<string, unknown>[]) {
        if (block?.type === 'tool_use') {
          const name = String(block.name ?? 'tool');
          if (typeof block.id === 'string') names.set(block.id, name);
          events.push(call(name, block.input));
        } else if (block?.type === 'tool_result') {
          const name = names.get(String(block.tool_use_id)) ?? 'tool';
          events.push(result(name, block.content, block.is_error === true));
        }
      }
    }
  } else if (format === 'openai-chat') {
    for (const msg of (Array.isArray(body.messages) ? body.messages : []) as Record<string, unknown>[]) {
      if (msg.role === 'user' && !firstUserText) firstUserText = userText(msg.content);
      if (msg.role === 'assistant' && Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls as Record<string, unknown>[]) {
          const fn = (tc.function ?? {}) as Record<string, unknown>;
          const name = String(fn.name ?? 'tool');
          if (typeof tc.id === 'string') names.set(tc.id, name);
          events.push(call(name, parseArgs(fn.arguments)));
        }
      } else if (msg.role === 'tool') {
        const text = textOf(msg.content);
        events.push(result(names.get(String(msg.tool_call_id)) ?? 'tool', text, /^(error|exception)/i.test(text.trim())));
      }
    }
  } else {
    const input = body.input;
    if (typeof input === 'string') firstUserText = userText(input);
    for (const item of (Array.isArray(input) ? input : []) as Record<string, unknown>[]) {
      const type = item.type ?? (item.role ? 'message' : undefined);
      if (type === 'message' && item.role === 'user' && !firstUserText) firstUserText = textOf(item.content);
      else if (type === 'function_call' || type === 'custom_tool_call') {
        const name = String(item.name ?? 'tool');
        if (typeof item.call_id === 'string') names.set(item.call_id, name);
        events.push(call(name, type === 'function_call' ? parseArgs(item.arguments) : item.input));
      } else if (type === 'local_shell_call') {
        if (typeof item.call_id === 'string') names.set(item.call_id, 'local_shell');
        events.push(call('local_shell', item.action));
      } else if (type === 'function_call_output' || type === 'custom_tool_call_output' || type === 'local_shell_call_output') {
        const out = item.output;
        const text = textOf(out);
        let isError = false;
        try {
          const parsed = JSON.parse(text) as { metadata?: { exit_code?: number } };
          isError = typeof parsed?.metadata?.exit_code === 'number' && parsed.metadata.exit_code !== 0;
        } catch { /* plain text output */ }
        events.push(result(names.get(String(item.call_id)) ?? 'tool', text, isError));
      }
    }
  }
  return { events, firstUserText, clientSessionId };
}

const READ_TOOLS = /^(read|read_file|readfile|view|view_file|open_file|cat)$/i;
const WRITE_TOOLS = /^(write|edit|multiedit|write_file|create_file|edit_file|str_replace|apply_patch|notebookedit)$/i;
const ERROR_TEXT = /\b(error|failed|failure|exception|traceback|panic|fatal)\b/i;

/** Evaluates loop rules over the events after the session's offset. */
export function evaluate(all: ToolEventIn[], offset: number, policy: LoopPolicy = DEFAULT_POLICY): Finding[] {
  const events = all.slice(Math.max(0, Math.min(offset, all.length)));
  const findings: Finding[] = [];
  const calls = events.filter((e) => e.kind === 'call');

  // 1. The same call (tool + identical arguments) repeated within the recent window.
  const recent = calls.slice(-policy.repeatWindow);
  const counts = new Map<string, { n: number; name: string }>();
  for (const c of recent) {
    const cur = counts.get(c.argsHash) ?? { n: 0, name: c.name };
    cur.n++;
    counts.set(c.argsHash, cur);
  }
  let worst = { n: 0, name: '' };
  for (const v of counts.values()) if (v.n > worst.n) worst = v;
  if (worst.n >= policy.repeatBlock) {
    findings.push({ rule: 'repeated_call', level: 'block', message: `Same ${worst.name} call repeated ${worst.n} times in the last ${recent.length} tool calls` });
  } else if (worst.n >= policy.repeatWarn) {
    findings.push({ rule: 'repeated_call', level: 'warn', message: `Same ${worst.name} call repeated ${worst.n} times in the last ${recent.length} tool calls` });
  }

  // 2. The same file read again and again with no write in between.
  const reads = new Map<string, number>();
  let rereadPath = '';
  let rereadN = 0;
  for (const c of calls) {
    if (!c.path) continue;
    const isView = /str_replace_based_edit_tool|str_replace_editor/i.test(c.name) ? /"command":"view"/.test(c.preview) : READ_TOOLS.test(c.name);
    const isWrite = /str_replace_based_edit_tool|str_replace_editor/i.test(c.name) ? !isView : WRITE_TOOLS.test(c.name);
    if (isWrite) reads.delete(c.path);
    else if (isView) {
      const n = (reads.get(c.path) ?? 0) + 1;
      reads.set(c.path, n);
      if (n > rereadN) { rereadN = n; rereadPath = c.path; }
    }
  }
  if (rereadN >= policy.rereadWarn) {
    findings.push({ rule: 'file_reread', level: 'warn', message: `${rereadPath} read ${rereadN} times without being changed` });
  }

  // 3. The same failing result several times in a row.
  const results = events.filter((e) => e.kind === 'result');
  const last = results.at(-1);
  if (last && (last.isError || ERROR_TEXT.test(last.preview))) {
    let streak = 0;
    for (let i = results.length - 1; i >= 0 && results[i]!.resultHash === last.resultHash; i--) streak++;
    if (streak >= policy.failureBlock) {
      findings.push({ rule: 'identical_failure', level: 'block', message: `Same ${last.name} failure ${streak} times in a row: ${last.preview.slice(0, 120)}` });
    }
  }
  return findings;
}
