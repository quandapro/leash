// Cross-checks a live run: what the agent saw (Claude Code stream-json), what reached the provider (recorder
// JSONL) and what Leash recorded (SQLite). Prints per-request tokens, cache hits, cost agreement and leaks.
// Usage: node e2e/live/report.ts <trace dir with upstream.jsonl and claude-*.out> <path to leash.db>
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { redactBody } from '../../src/guard/redact.ts';

type Obj = Record<string, unknown>;
const [dir = '.', dbPath = 'data/leash.db'] = process.argv.slice(2);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const pct = (a: number, b: number) => (b ? `${(100 * a / b).toFixed(1)}%` : 'n/a');
const usd = (v: number) => `$${v.toFixed(6)}`;
let problems = 0;
const problem = (msg: string) => { problems++; console.log(`  PROBLEM: ${msg}`); };

// 1. Agent side
for (const file of fs.readdirSync(dir).filter((f) => /^claude-.*\.out$/.test(f)).sort()) {
  for (const line of fs.readFileSync(path.join(dir, file), 'utf8').split('\n')) {
    if (!line.startsWith('{')) continue;
    let m: Obj;
    try { m = JSON.parse(line) as Obj; } catch { continue; }
    if (m.type !== 'result') continue;
    const u = (m.usage ?? {}) as Obj;
    console.log(`${file}: ${m.subtype} turns=${m.num_turns} wall=${m.duration_ms}ms in=${num(u.input_tokens)} cache_read=${num(u.cache_read_input_tokens)} out=${num(u.output_tokens)} (agent's own cost estimate ${usd(num(m.total_cost_usd))})`);
  }
}

// 2. Provider side
interface Up { id: number; ms: number; ttfb: number | null; path: string; status: number; req: unknown; resp: string; reqHeaders: Record<string, string> }
const ups = fs.readFileSync(path.join(dir, 'upstream.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Up)
  .filter((u) => /\/messages(\?|$)|\/chat\/completions|\/responses/.test(u.path));

function usageOf(resp: string): Obj {
  const usage: Obj = {};
  const merge = (u: unknown) => { for (const [k, v] of Object.entries((u ?? {}) as Obj)) if (v !== null) usage[k] = v; };
  if (resp.includes('data:')) {
    for (const l of resp.split('\n')) {
      if (!l.startsWith('data:')) continue;
      try {
        const d = JSON.parse(l.slice(5)) as Obj;
        merge((d.message as Obj | undefined)?.usage);
        merge(d.usage);
        merge((d.response as Obj | undefined)?.usage);
      } catch { /* [DONE] or keep-alive */ }
    }
  } else {
    try { merge((JSON.parse(resp) as Obj).usage); } catch { /* not JSON */ }
  }
  return usage;
}

const db = new DatabaseSync(dbPath, { readOnly: true });
const rows = db.prepare('SELECT id, session_id, model, status, in_tok, cache_r, cache_w, out_tok, cost, redactions, latency_ms FROM requests WHERE blocked IS NULL ORDER BY id').all() as Obj[];
if (rows.length !== ups.length) problem(`Leash recorded ${rows.length} forwarded requests, the provider saw ${ups.length}`);

console.log('\nreq  status  in      cache_read  out    hit     provider_cost  leash_cost     overhead');
const tot = { in: 0, cr: 0, cw: 0, out: 0, upCost: 0, leashCost: 0 };
const overheads: number[] = [];
ups.forEach((u, i) => {
  const usage = usageOf(u.resp);
  const row = rows[i] ?? {};
  const inT = num(usage.input_tokens ?? usage.prompt_tokens), cr = num(usage.cache_read_input_tokens), cw = num(usage.cache_creation_input_tokens);
  const out = num(usage.output_tokens ?? usage.completion_tokens), cost = num(usage.cost);
  tot.in += inT; tot.cr += cr; tot.cw += cw; tot.out += out; tot.upCost += cost; tot.leashCost += num(row.cost);
  const overhead = num(row.latency_ms) - u.ms;
  overheads.push(overhead);
  console.log(`#${String(u.id).padEnd(3)} ${String(u.status).padEnd(7)} ${String(inT).padEnd(7)} ${String(cr).padEnd(11)} ${String(out).padEnd(6)} ${pct(cr, inT + cr + cw).padEnd(7)} ${usd(cost).padEnd(14)} ${usd(num(row.cost)).padEnd(14)} ${overhead}ms`);
  if (num(row.in_tok) !== inT || num(row.cache_r) !== cr || num(row.out_tok) !== out) problem(`request ${u.id}: Leash tokens differ from the provider's`);
  if (cost && Math.abs(cost - num(row.cost)) > 1e-9) problem(`request ${u.id}: Leash cost ${num(row.cost)} differs from billed ${cost}`);
  if (u.status >= 400) problem(`request ${u.id}: provider returned ${u.status}: ${u.resp.slice(0, 200)}`);
  if (u.reqHeaders['x-api-key']?.includes('prefix=lsh_') || u.reqHeaders.authorization?.includes('prefix=Bearer lsh_')) problem(`request ${u.id}: a Leash key reached the provider`);
  // Anything the redactor would still catch in user-side content means a secret left the server.
  if (u.req && typeof u.req === 'object') {
    const leaks = redactBody(structuredClone(u.req as Obj), false);
    if (leaks.length) problem(`request ${u.id}: secrets reached the provider: ${[...new Set(leaks)].join(', ')}`);
  }
});
const prompt = tot.in + tot.cr + tot.cw;
const warm = ups.slice(1).reduce((a, u) => { const g = usageOf(u.resp); return { cr: a.cr + num(g.cache_read_input_tokens), all: a.all + num(g.input_tokens) + num(g.cache_read_input_tokens) + num(g.cache_creation_input_tokens) }; }, { cr: 0, all: 0 });
overheads.sort((a, b) => a - b);
console.log(`\ntotal: in=${tot.in} cache_read=${tot.cr} cache_write=${tot.cw} out=${tot.out}`);
console.log(`cache hit: ${pct(tot.cr, prompt)} of all prompt tokens, ${pct(warm.cr, warm.all)} after the first (cold) request`);
console.log(`cost: provider billed ${usd(tot.upCost)}, Leash recorded ${usd(tot.leashCost)}`);
console.log(`Leash overhead (Leash latency - provider latency): median ${overheads[Math.floor(overheads.length / 2)] ?? 0}ms, max ${overheads.at(-1) ?? 0}ms`);

// 3. Leash bookkeeping
for (const s of db.prepare('SELECT id, label, status, requests, spend FROM sessions').all() as Obj[]) {
  console.log(`session ${s.id} [${s.status}] requests=${s.requests} spend=${usd(num(s.spend))} label="${String(s.label).slice(0, 80)}"`);
  if (String(s.label).includes('<system-reminder>')) problem('session label is an injected system reminder');
}
for (const a of db.prepare('SELECT level, rule, message FROM alerts ORDER BY id').all() as Obj[]) console.log(`alert ${a.level} ${a.rule}: ${a.message}`);
console.log(problems ? `\n${problems} problem(s) found` : '\nall checks passed');
process.exitCode = problems ? 1 : 0;
