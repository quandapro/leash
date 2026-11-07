// Dashboard pages. Server-rendered HTML, no client framework; every form posts with a CSRF token.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Config } from '../config.ts';
import { encrypt, decrypt, mask, randomToken, sha256, type Keys } from '../crypto.ts';
import { startOfDayUtc, startOfMonthUtc, type LoopMode, type ProviderKind, type RedactMode, type Store } from '../db.ts';
import type { Alerter } from '../alerts.ts';
import type { PriceBook } from '../guard/pricing.ts';
import { globalDailyLimit } from '../guard/budget.ts';
import { HttpError, readBody, redirect, sendHtml, sendJson } from '../http.ts';
import { CSS, JS, LOGO } from './assets.ts';
import type { Auth } from './auth.ts';
import { Safe, ago, html, int, usd, when } from './html.ts';

export interface DashboardContext {
  cfg: Config;
  store: Store;
  keys: Keys;
  prices: PriceBook;
  alerter: Alerter;
  auth: Auth;
  version: string;
}

interface Page {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  sid: string;
  csrf: string;
  ctx: DashboardContext;
}

const MESSAGES: Record<string, string> = {
  provider_added: 'Provider added.', provider_updated: 'Provider key updated.', provider_deleted: 'Provider deleted.',
  provider_in_use: 'Revoke the keys that use this provider first.', key_revoked: 'Key revoked.', key_updated: 'Key policy saved.',
  session_resumed: 'Session resumed. Earlier repetitions no longer count toward loop rules.', alert_resolved: 'Alert resolved.',
  settings_saved: 'Settings saved.', price_saved: 'Price saved.', price_deleted: 'Price removed.', test_sent: 'Test alert sent.',
  budget_saved: 'Global budget saved.',
};

function layout(p: Page, title: string, active: string, body: Safe, opts: { refresh?: number } = {}): string {
  const msg = p.url.searchParams.get('m');
  const err = p.url.searchParams.get('e');
  const nav: [string, string][] = [['/', 'Overview'], ['/sessions', 'Sessions'], ['/keys', 'Keys'], ['/providers', 'Providers'], ['/alerts', 'Alerts']];
  return html`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · Leash</title>${opts.refresh ? html`<meta http-equiv="refresh" content="${opts.refresh}">` : ''}
<link rel="stylesheet" href="/static/app.css"><script src="/static/app.js" defer></script></head><body>
<header class="top"><a class="brand" href="/">${new Safe(LOGO)}Leash</a>
<nav>${nav.map(([href, label]) => html`<a href="${href}" class="${active === href ? 'on' : ''}">${label}</a>`)}</nav>
<span class="spacer"></span>
<form class="inline" method="post" action="/logout"><input type="hidden" name="_csrf" value="${p.csrf}"><button class="ghost small">Sign out</button></form></header>
<main>${msg && MESSAGES[msg] ? html`<div class="notice good flash">${MESSAGES[msg]}</div>` : ''}${err && MESSAGES[err] ? html`<div class="notice bad flash">${MESSAGES[err]}</div>` : ''}${body}</main></body></html>`.value;
}

const hidden = (p: Page) => html`<input type="hidden" name="_csrf" value="${p.csrf}">`;

function statusChip(status: string): Safe {
  const cls = status === 'blocked' ? 'bad' : status === 'warned' ? 'warn' : 'good';
  return html`<span class="chip ${cls}">${status}</span>`;
}
function levelChip(level: string): Safe {
  const cls = level === 'block' ? 'bad' : level === 'warn' ? 'warn' : '';
  return html`<span class="chip ${cls}">${level}</span>`;
}

function spendBars(days: { day: number; spend: number }[], now: number): Safe {
  const series: { day: number; spend: number }[] = [];
  const start = startOfDayUtc(now) - 13 * 86_400_000;
  for (let i = 0; i < 14; i++) {
    const day = start + i * 86_400_000;
    series.push({ day, spend: days.find((d) => d.day === day)?.spend ?? 0 });
  }
  const max = Math.max(...series.map((s) => s.spend), 0.01);
  const w = 700, h = 120, bw = w / 14;
  return html`<svg class="bars" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="Spend per day, last 14 days">
${series.map((s, i) => {
    const bh = Math.max(s.spend > 0 ? 2 : 0, (s.spend / max) * (h - 22));
    const d = new Date(s.day);
    return html`<rect x="${(i * bw + 3).toFixed(1)}" y="${(h - 16 - bh).toFixed(1)}" width="${(bw - 6).toFixed(1)}" height="${bh.toFixed(1)}" rx="2"><title>${d.toISOString().slice(0, 10)}: ${usd(s.spend)}</title></rect>
<text x="${(i * bw + bw / 2).toFixed(1)}" y="${h - 3}" text-anchor="middle">${d.getUTCDate()}</text>`;
  })}</svg>`;
}

// ---------- Pages ----------

function overview(p: Page): string {
  const { store } = p.ctx;
  const now = Date.now();
  const today = store.totalSpendSince(startOfDayUtc(now));
  const month = store.totalSpendSince(startOfMonthUtc(now));
  const active = store.activeSessionCount(now - 86_400_000);
  const open = store.openAlertCount();
  const keys = store.listKeys().filter((k) => !k.revoked_at);
  const sessions = store.listSessions(8);
  const providers = store.listProviders();
  // Only models that still have no price (a price set later fixes future requests).
  const unpriced = store.unpricedModels().filter((u) => !p.ctx.prices.rate('openai', u.model).known && !p.ctx.prices.rate('anthropic', u.model).known);
  const globalLimit = globalDailyLimit(store);

  const body = html`<h1>Overview</h1><p class="lead">Spend, sessions and alerts across every agent that talks through Leash.</p>
${providers.length === 0 ? html`<div class="notice">Start by <a href="/providers">adding a provider</a> (your Anthropic or OpenAI-compatible API key), then <a href="/keys">create a Leash key</a> for each agent.</div>` : ''}
${unpriced.length ? html`<div class="notice warn">No price set for ${unpriced.map((u) => u.model).join(', ')}. These are charged at the fail-safe rate until you <a href="/providers#prices">set a price</a>.</div>` : ''}
<div class="grid">
<div class="card stat"><div class="label">Spend today</div><div class="value">${usd(today)}</div><div class="sub">${globalLimit ? `of ${usd(globalLimit)} global limit` : 'UTC day'}</div></div>
<div class="card stat"><div class="label">Spend this month</div><div class="value">${usd(month)}</div><div class="sub">UTC month</div></div>
<div class="card stat"><div class="label">Sessions, 24 h</div><div class="value">${int(active)}</div><div class="sub"><a href="/sessions">view all</a></div></div>
<div class="card stat"><div class="label">Open alerts</div><div class="value">${int(open)}</div><div class="sub"><a href="/alerts">review</a></div></div>
</div>
<h2>Spend, last 14 days</h2><div class="card">${spendBars(store.dailySpend(14, now), now)}</div>
<h2>Keys</h2>${keys.length === 0 ? html`<p class="muted">No active keys yet.</p>` : html`<div class="scroll"><table><thead><tr><th>Key</th><th>Provider</th><th class="num">Today</th><th class="num">Daily limit</th><th class="num">Month</th><th class="num">Monthly limit</th><th>Last used</th></tr></thead><tbody>
${keys.map((k) => html`<tr><td><a href="/keys/${k.id}">${k.name}</a></td><td>${k.provider_name}</td>
<td class="num">${usd(store.keySpendSince(k.id, startOfDayUtc(now)))}</td><td class="num">${usd(k.daily_usd)}</td>
<td class="num">${usd(store.keySpendSince(k.id, startOfMonthUtc(now)))}</td><td class="num">${usd(k.monthly_usd)}</td><td>${ago(k.last_used_at, now)}</td></tr>`)}
</tbody></table></div>`}
<h2>Recent sessions</h2>${sessionsTable(sessions, now)}`;
  return layout(p, 'Overview', '/', body, { refresh: 30 });
}

function sessionsTable(sessions: ReturnType<Store['listSessions']>, now: number): Safe {
  if (sessions.length === 0) return html`<p class="muted">No sessions yet. They appear when an agent sends its first request.</p>`;
  return html`<div class="scroll"><table><thead><tr><th>Session</th><th>Key</th><th>Status</th><th class="num">Requests</th><th class="num">Spend</th><th>Last activity</th></tr></thead><tbody>
${sessions.map((s) => html`<tr><td><a href="/sessions/${encodeURIComponent(s.id)}">${s.label || s.id}</a>${s.status_reason ? html`<div class="muted">${s.status_reason}</div>` : ''}</td>
<td>${s.key_name ?? '—'}</td><td>${statusChip(s.status)}</td><td class="num">${int(s.requests)}</td><td class="num">${usd(s.spend)}</td><td>${ago(s.last_at, now)}</td></tr>`)}
</tbody></table></div>`;
}

function sessionsPage(p: Page): string {
  const body = html`<h1>Sessions</h1><p class="lead">One row per agent conversation. Blocked sessions stay paused until you resume them.</p>${sessionsTable(p.ctx.store.listSessions(200), Date.now())}`;
  return layout(p, 'Sessions', '/sessions', body, { refresh: 15 });
}

function sessionPage(p: Page, id: string): string | null {
  const { store } = p.ctx;
  const s = store.getSession(id);
  if (!s) return null;
  const now = Date.now();
  const key = store.getKey(s.key_id);
  const reqs = store.sessionRequests(id);
  const events = store.sessionToolEvents(id, 300);
  const alerts = store.sessionAlerts(id);
  const body = html`<p><a href="/sessions">← Sessions</a></p><h1>${s.label || 'Session'}</h1>
<p class="lead"><span class="mono">${s.id}</span> · key ${key?.name ?? '—'} · started ${when(s.started_at)}</p>
${s.status === 'blocked' ? html`<div class="notice bad"><strong>Blocked:</strong> ${s.status_reason}
<form class="inline" method="post" action="/sessions/${encodeURIComponent(s.id)}/resume">${hidden(p)} <button class="small">Resume session</button></form>
<div class="muted">Resuming clears the loop history counted so far. The agent's next request goes through.</div></div>` : ''}
<div class="grid"><div class="card stat"><div class="label">Status</div><div class="value">${statusChip(s.status)}</div></div>
<div class="card stat"><div class="label">Requests</div><div class="value">${int(s.requests)}</div></div>
<div class="card stat"><div class="label">Spend</div><div class="value">${usd(s.spend)}</div></div>
<div class="card stat"><div class="label">Last activity</div><div class="value">${ago(s.last_at, now)}</div></div></div>
${alerts.length ? html`<h2>Alerts</h2><div class="scroll"><table><thead><tr><th>Time</th><th>Level</th><th>Rule</th><th>Message</th></tr></thead><tbody>
${alerts.map((a) => html`<tr><td>${when(a.ts)}</td><td>${levelChip(a.level)}</td><td class="mono">${a.rule}</td><td>${a.message}${a.resolved_at ? html` <span class="chip">resolved</span>` : ''}</td></tr>`)}</tbody></table></div>` : ''}
<h2>Tool activity <span class="muted">(newest first, previews redacted)</span></h2>
${events.length === 0 ? html`<p class="muted">No tool calls in this session.</p>` : html`<div class="scroll"><table class="timeline"><thead><tr><th>Time</th><th>Kind</th><th>Tool</th><th>Detail</th></tr></thead><tbody>
${events.map((e) => html`<tr><td>${when(e.ts).slice(11)}</td><td>${e.kind === 'call' ? 'call' : html`<span class="chip ${e.is_error ? 'bad' : ''}">result</span>`}</td><td class="mono">${e.name}</td>
<td class="mono">${e.path ? html`<strong>${e.path}</strong> ` : ''}${e.preview}</td></tr>`)}</tbody></table></div>`}
<h2>Requests</h2>${reqs.length === 0 ? html`<p class="muted">No requests.</p>` : html`<div class="scroll"><table><thead><tr><th>Time</th><th>Model</th><th class="num">In</th><th class="num">Out</th><th class="num">Cache read</th><th class="num">Cost</th><th class="num">ms</th><th>Result</th></tr></thead><tbody>
${reqs.slice(-200).reverse().map((r) => html`<tr><td>${when(r.ts).slice(11)}</td><td class="mono">${r.model}</td><td class="num">${int(r.in_tok + r.cache_w)}</td><td class="num">${int(r.out_tok)}</td><td class="num">${int(r.cache_r)}</td>
<td class="num">${usd(r.cost)}${r.price_known ? '' : '*'}</td><td class="num">${int(r.latency_ms)}</td><td>${r.blocked ? html`<span class="chip bad">${r.blocked}</span>` : html`<span class="chip ${r.status < 400 ? 'good' : 'bad'}">${r.status}</span>`}${r.redactions ? html` <span class="chip warn">${r.redactions} redacted</span>` : ''}</td></tr>`)}
</tbody></table></div>`}`;
  return layout(p, 'Session', '/sessions', body);
}

function keyForm(p: Page, values: { name?: string; provider_id?: number; daily?: string; monthly?: string; models?: string; redact?: string; loop?: string }, action: string, submit: string, withProvider: boolean): Safe {
  const providers = p.ctx.store.listProviders();
  const sel = (cur: string | undefined, v: string) => (cur === v ? new Safe(' selected') : '');
  return html`<form class="stack" method="post" action="${action}">${hidden(p)}
${withProvider ? html`<div class="row"><label>Name<input name="name" required maxlength="60" placeholder="laptop-claude-code" value="${values.name ?? ''}"></label>
<label>Provider<select name="provider_id" required>${providers.map((pr) => html`<option value="${pr.id}"${values.provider_id === pr.id ? new Safe(' selected') : ''}>${pr.name} (${pr.kind})</option>`)}</select></label></div>` : ''}
<div class="row"><label>Daily budget (USD)<input name="daily_usd" type="number" min="0" step="0.01" placeholder="no limit" value="${values.daily ?? ''}"></label>
<label>Monthly budget (USD)<input name="monthly_usd" type="number" min="0" step="0.01" placeholder="no limit" value="${values.monthly ?? ''}"></label></div>
<label>Allowed models (comma-separated, * wildcard; empty = all)<input name="model_allow" maxlength="500" placeholder="claude-sonnet-*, claude-haiku-*" value="${values.models ?? ''}"></label>
<div class="row"><label>Secrets in prompts<select name="redact_mode"><option value="redact"${sel(values.redact, 'redact')}>Redact before sending</option><option value="block"${sel(values.redact, 'block')}>Block the request</option><option value="log"${sel(values.redact, 'log')}>Detect and alert only</option></select></label>
<label>Loop rules<select name="loop_mode"><option value="enforce"${sel(values.loop, 'enforce')}>Enforce (block loops)</option><option value="warn"${sel(values.loop, 'warn')}>Warn only</option><option value="off"${sel(values.loop, 'off')}>Off</option></select></label></div>
<div><button>${submit}</button></div></form>`;
}

function keysPage(p: Page): string {
  const { store } = p.ctx;
  const now = Date.now();
  const keys = store.listKeys();
  const providers = store.listProviders();
  const limit = globalDailyLimit(store);
  const body = html`<h1>Keys</h1><p class="lead">Give each agent or machine its own Leash key. Provider keys never leave this server.</p>
<div class="scroll"><table><thead><tr><th>Name</th><th>Key</th><th>Provider</th><th class="num">Today</th><th class="num">Daily</th><th class="num">Monthly</th><th>Guards</th><th>Last used</th></tr></thead><tbody>
${keys.length === 0 ? html`<tr><td colspan="8" class="muted">No keys yet.</td></tr>` : keys.map((k) => html`<tr><td><a href="/keys/${k.id}">${k.name}</a>${k.revoked_at ? html` <span class="chip bad">revoked</span>` : ''}</td>
<td class="mono">${k.prefix}…</td><td>${k.provider_name ?? '—'}</td><td class="num">${usd(store.keySpendSince(k.id, startOfDayUtc(now)))}</td>
<td class="num">${usd(k.daily_usd)}</td><td class="num">${usd(k.monthly_usd)}</td><td><span class="chip">secrets: ${k.redact_mode}</span> <span class="chip">loops: ${k.loop_mode}</span></td><td>${ago(k.last_used_at, now)}</td></tr>`)}
</tbody></table></div>
<h2>Create a key</h2>${providers.length === 0 ? html`<div class="notice">Add a <a href="/providers">provider</a> first.</div>` : keyForm(p, { daily: '10', monthly: '100' }, '/keys', 'Create key', true)}
<h2>Global daily budget</h2><form class="stack" method="post" action="/settings/budget">${hidden(p)}
<label>Stop every key once total spend today reaches (USD, empty = no limit)<input name="global_daily_usd" type="number" min="0" step="0.01" value="${limit ?? ''}"></label><div><button class="ghost">Save</button></div></form>`;
  return layout(p, 'Keys', '/keys', body);
}

function keyPage(p: Page, id: number): string | null {
  const { store } = p.ctx;
  const k = store.getKey(id);
  if (!k) return null;
  const now = Date.now();
  const provider = store.getProvider(k.provider_id);
  const body = html`<p><a href="/keys">← Keys</a></p><h1>${k.name}</h1>
<p class="lead"><span class="mono">${k.prefix}…</span> · ${provider?.name ?? 'deleted provider'} · created ${when(k.created_at)} · last used ${ago(k.last_used_at, now)}</p>
${k.revoked_at ? html`<div class="notice bad">Revoked ${when(k.revoked_at)}. Requests with this key are rejected.</div>` : ''}
<div class="grid"><div class="card stat"><div class="label">Today</div><div class="value">${usd(store.keySpendSince(k.id, startOfDayUtc(now)))}</div><div class="sub">limit ${usd(k.daily_usd)}</div></div>
<div class="card stat"><div class="label">This month</div><div class="value">${usd(store.keySpendSince(k.id, startOfMonthUtc(now)))}</div><div class="sub">limit ${usd(k.monthly_usd)}</div></div></div>
${provider ? html`<h2>Setup</h2>${setupSnippets(p, provider.kind, `${k.prefix}…`)}` : ''}
${k.revoked_at ? '' : html`<h2>Policy</h2>${keyForm(p, { daily: k.daily_usd?.toString() ?? '', monthly: k.monthly_usd?.toString() ?? '', models: k.model_allow, redact: k.redact_mode, loop: k.loop_mode }, `/keys/${k.id}/policy`, 'Save policy', false)}
<h2>Revoke</h2><form method="post" action="/keys/${k.id}/revoke" data-confirm="Revoke this key? Agents using it stop working immediately.">${hidden(p)}<button class="danger">Revoke key</button></form>`}`;
  return layout(p, k.name, '/keys', body);
}

function setupSnippets(p: Page, kind: ProviderKind, token: string): Safe {
  const base = p.ctx.cfg.publicUrl;
  if (kind === 'anthropic') {
    return html`<p><strong>Claude Code</strong> (and any Anthropic SDK): set these before starting it.</p>
<button class="ghost small copy" data-copy="snip-cc">Copy</button><pre id="snip-cc">export ANTHROPIC_BASE_URL=${base}/anthropic
export ANTHROPIC_API_KEY=${token}</pre>
<p class="muted">Windows PowerShell: <code>$env:ANTHROPIC_BASE_URL="${base}/anthropic"; $env:ANTHROPIC_API_KEY="${token}"</code></p>`;
  }
  return html`<p><strong>Codex CLI</strong>: add to <code>~/.codex/config.toml</code> and export <code>LEASH_API_KEY</code>.</p>
<button class="ghost small copy" data-copy="snip-codex">Copy</button><pre id="snip-codex">model_provider = "leash"

[model_providers.leash]
name = "Leash"
base_url = "${base}/openai/v1"
env_key = "LEASH_API_KEY"
wire_api = "responses"</pre>
<button class="ghost small copy" data-copy="snip-env">Copy</button><pre id="snip-env">export LEASH_API_KEY=${token}
export OPENAI_BASE_URL=${base}/openai/v1
export OPENAI_API_KEY=${token}</pre>
<p class="muted">Any OpenAI-compatible client (Cline, aider, Continue, OpenClaw, Hermes): base URL <code>${base}/openai/v1</code>, API key = your Leash key.</p>`;
}

function keyCreated(p: Page, name: string, kind: ProviderKind, token: string): string {
  const body = html`<h1>Key created: ${name}</h1>
<div class="notice warn">Copy this key now. Leash stores only its hash and cannot show it again.</div>
<button class="ghost small copy" data-copy="newkey">Copy</button><pre id="newkey">${token}</pre>
<h2>Setup</h2>${setupSnippets(p, kind, token)}<p><a href="/keys">Back to keys</a></p>`;
  return layout(p, 'Key created', '/keys', body);
}

function providersPage(p: Page): string {
  const { store, keys } = p.ctx;
  const providers = store.listProviders();
  const prices = store.listPrices();
  const body = html`<h1>Providers</h1><p class="lead">Your real API keys, encrypted at rest with AES-256-GCM. Agents only ever see their Leash keys.</p>
<div class="scroll"><table><thead><tr><th>Name</th><th>Type</th><th>Base URL</th><th>API key</th><th></th></tr></thead><tbody>
${providers.length === 0 ? html`<tr><td colspan="5" class="muted">No providers yet.</td></tr>` : providers.map((pr) => {
    let shown = '••••';
    try { shown = mask(decrypt(keys, pr.enc_key)); } catch { shown = 'cannot decrypt (LEASH_SECRET changed?)'; }
    return html`<tr><td>${pr.name}</td><td>${pr.kind}</td><td class="mono">${pr.base_url}</td><td class="mono">${shown}</td>
<td><form class="inline" method="post" action="/providers/${pr.id}/delete" data-confirm="Delete provider ${pr.name}?">${hidden(p)}<button class="danger small">Delete</button></form></td></tr>`;
  })}</tbody></table></div>
<h2>Add a provider</h2><form class="stack" method="post" action="/providers">${hidden(p)}
<div class="row"><label>Name<input name="name" required maxlength="40" pattern="[A-Za-z0-9_-]+" placeholder="anthropic"></label>
<label>Type<select name="kind"><option value="anthropic">Anthropic</option><option value="openai">OpenAI-compatible</option></select></label></div>
<label>Base URL (empty = official API)<input name="base_url" maxlength="300" placeholder="https://api.anthropic.com or https://openrouter.ai/api/v1"></label>
<label>API key<input name="api_key" type="password" required maxlength="1000" autocomplete="off"></label>
<div><button>Add provider</button></div></form>
<h2>Update a provider's API key</h2>${providers.length === 0 ? html`<p class="muted">No providers.</p>` : html`<form class="stack" method="post" action="/providers/rotate">${hidden(p)}
<div class="row"><label>Provider<select name="id">${providers.map((pr) => html`<option value="${pr.id}">${pr.name}</option>`)}</select></label>
<label>New API key<input name="api_key" type="password" required maxlength="1000" autocomplete="off"></label></div><div><button class="ghost">Update key</button></div></form>`}
<h2 id="prices">Model prices</h2><p class="muted">USD per million tokens. Claude models are priced built in; set prices for OpenAI-compatible models or to override. Prefix match: <code>gpt-5</code> covers <code>gpt-5-mini</code> unless that has its own row.</p>
${prices.length ? html`<div class="scroll"><table><thead><tr><th>Type</th><th>Model prefix</th><th class="num">Input</th><th class="num">Output</th><th class="num">Cache write</th><th class="num">Cache read</th><th></th></tr></thead><tbody>
${prices.map((pr) => html`<tr><td>${pr.kind}</td><td class="mono">${pr.model}</td><td class="num">${pr.input}</td><td class="num">${pr.output}</td><td class="num">${pr.cache_write}</td><td class="num">${pr.cache_read}</td>
<td><form class="inline" method="post" action="/prices/delete">${hidden(p)}<input type="hidden" name="kind" value="${pr.kind}"><input type="hidden" name="model" value="${pr.model}"><button class="danger small">Remove</button></form></td></tr>`)}</tbody></table></div>` : ''}
<form class="stack" method="post" action="/prices">${hidden(p)}<div class="row">
<label>Type<select name="kind"><option value="openai">OpenAI-compatible</option><option value="anthropic">Anthropic</option></select></label>
<label>Model prefix<input name="model" required maxlength="120" placeholder="gpt-5"></label></div><div class="row">
<label>Input<input name="input" type="number" min="0" step="0.0001" required></label><label>Output<input name="output" type="number" min="0" step="0.0001" required></label>
<label>Cache write<input name="cache_write" type="number" min="0" step="0.0001" placeholder="1.25 × input"></label><label>Cache read<input name="cache_read" type="number" min="0" step="0.0001" placeholder="0.1 × input"></label></div>
<div><button class="ghost">Save price</button></div></form>`;
  return layout(p, 'Providers', '/providers', body);
}

function alertsPage(p: Page): string {
  const { store, alerter } = p.ctx;
  const now = Date.now();
  const alerts = store.listAlerts(200);
  const s = alerter.settings();
  const body = html`<h1>Alerts</h1><p class="lead">Every warning and block, newest first. New alerts also go to Telegram or a webhook if configured.</p>
<div class="scroll"><table><thead><tr><th>When</th><th>Level</th><th>Rule</th><th>Message</th><th>Key</th><th></th></tr></thead><tbody>
${alerts.length === 0 ? html`<tr><td colspan="6" class="muted">No alerts. Quiet is good.</td></tr>` : alerts.map((a) => html`<tr><td>${ago(a.ts, now)}</td><td>${levelChip(a.level)}</td><td class="mono">${a.rule}</td>
<td>${a.message}${a.session_id ? html` · <a href="/sessions/${encodeURIComponent(a.session_id)}">session</a>` : ''}</td><td>${a.key_name ?? '—'}</td>
<td>${a.resolved_at ? html`<span class="chip">resolved</span>` : html`<form class="inline" method="post" action="/alerts/${a.id}/resolve">${hidden(p)}<button class="ghost small">Resolve</button></form>`}</td></tr>`)}
</tbody></table></div>
<h2>Notifications</h2><form class="stack" method="post" action="/alerts/settings">${hidden(p)}
<div class="row"><label>Telegram bot token ${s.telegramToken ? html`<span class="chip good">set</span>` : ''}<input name="telegram_token" type="password" maxlength="200" autocomplete="off" placeholder="${s.telegramToken ? 'leave empty to keep' : '123456:ABC…'}"></label>
<label>Telegram chat ID<input name="telegram_chat" maxlength="40" value="${s.telegramChat ?? ''}"></label></div>
<label>Webhook URL (receives JSON for each new alert)<input name="webhook_url" type="url" maxlength="500" value="${s.webhookUrl ?? ''}" placeholder="https://hooks.example.com/leash"></label>
<label><span><input type="checkbox" name="clear_telegram" value="1"> Remove the saved Telegram token</span></label>
<div><button>Save</button></div></form>
<form method="post" action="/alerts/test">${hidden(p)}<p><button class="ghost">Send a test alert</button></p></form>`;
  return layout(p, 'Alerts', '/alerts', body);
}

function loginPage(error: string | null): string {
  return html`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in · Leash</title><link rel="stylesheet" href="/static/app.css"></head><body><div class="login">
<h1 class="brand">${new Safe(LOGO)} Leash</h1><p class="lead">Enter the admin token from your <code>LEASH_ADMIN_TOKEN</code> setting.</p>
${error ? html`<div class="notice bad">${error}</div>` : ''}
<form class="stack card" method="post" action="/login"><label>Admin token<input name="token" type="password" required autofocus autocomplete="current-password"></label><div><button>Sign in</button></div></form>
</div></body></html>`.value;
}

/** Read-only JSON summary for scripts and monitoring (requires a dashboard session). */
function stats(store: Store) {
  const now = Date.now();
  const day = startOfDayUtc(now);
  const month = startOfMonthUtc(now);
  return {
    spend_today: store.totalSpendSince(day),
    spend_month: store.totalSpendSince(month),
    open_alerts: store.openAlertCount(),
    keys: store.listKeys().map((k) => ({
      id: k.id, name: k.name, provider: k.provider_name, revoked: !!k.revoked_at, daily_usd: k.daily_usd, monthly_usd: k.monthly_usd,
      spend_today: store.keySpendSince(k.id, day), spend_month: store.keySpendSince(k.id, month), last_used_at: k.last_used_at,
    })),
    sessions: store.listSessions(50).map((s) => ({
      id: s.id, key: s.key_name, status: s.status, reason: s.status_reason, requests: s.requests, spend: s.spend, last_at: s.last_at,
    })),
    alerts: store.listAlerts(50).map((a) => ({ id: a.id, ts: a.ts, level: a.level, rule: a.rule, message: a.message, session: a.session_id, resolved: !!a.resolved_at })),
  };
}

// ---------- Form parsing ----------

function optMoney(v: string | null): number | null {
  if (v === null || v.trim() === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 1_000_000) throw new HttpError(400, 'Budgets must be between 0 and 1,000,000');
  return Math.round(n * 100) / 100;
}
function money(v: string | null, label: string): number {
  const n = Number(v);
  if (v === null || v.trim() === '' || !Number.isFinite(n) || n < 0 || n > 10_000) throw new HttpError(400, `${label} must be a price between 0 and 10,000`);
  return n;
}
function oneOf<T extends string>(v: string | null, allowed: readonly T[], fallback: T): T {
  return allowed.includes(v as T) ? (v as T) : fallback;
}
function modelList(v: string | null): string {
  const s = (v ?? '').trim();
  if (s.length > 500 || !/^[A-Za-z0-9.*:/_,\- ]*$/.test(s)) throw new HttpError(400, 'Allowed models may contain letters, digits, * . : / _ - and commas');
  return s.split(',').map((x) => x.trim()).filter(Boolean).join(', ');
}
function upstreamUrl(cfg: Config, raw: string, kind: ProviderKind): string {
  const value = raw.trim() || (kind === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com/v1');
  let u: URL;
  try { u = new URL(value); } catch { throw new HttpError(400, 'Base URL is not a valid URL'); }
  if (u.username || u.password || u.search || u.hash) throw new HttpError(400, 'Base URL must not contain credentials, a query or a fragment');
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && cfg.allowHttpUpstream)) {
    throw new HttpError(400, 'Base URL must use https:// so your API key is never sent in plain text');
  }
  return u.toString().replace(/\/+$/, '');
}

// ---------- Router ----------

export async function handleDashboard(req: IncomingMessage, res: ServerResponse, url: URL, ctx: DashboardContext): Promise<void> {
  const path = url.pathname;
  if (path === '/static/app.css') return void res.writeHead(200, { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'public, max-age=3600', 'x-content-type-options': 'nosniff' }).end(CSS);
  if (path === '/static/app.js') return void res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'public, max-age=3600', 'x-content-type-options': 'nosniff' }).end(JS);
  if (path === '/favicon.ico') return void res.writeHead(204).end();

  if (path === '/login') {
    if (req.method === 'GET') return sendHtml(res, 200, loginPage(null));
    if (req.method !== 'POST') return sendHtml(res, 405, loginPage(null));
    if (ctx.auth.locked(req)) return sendHtml(res, 429, loginPage('Too many failed attempts. Try again in 15 minutes.'));
    const form = new URLSearchParams((await readBody(req, 16_384)).toString('utf8'));
    const cookie = ctx.auth.login(req, form.get('token') ?? '');
    if (!cookie) return sendHtml(res, 401, loginPage('That token is not correct.'));
    return redirect(res, '/', { 'set-cookie': cookie });
  }

  const sid = ctx.auth.session(req);
  if (!sid) {
    if (path.startsWith('/api/')) return sendJson(res, 401, { error: 'sign in to the dashboard first' });
    if (req.method === 'GET') return redirect(res, '/login');
    return sendHtml(res, 401, loginPage('Your session expired. Sign in again.'));
  }
  const p: Page = { req, res, url, sid, csrf: ctx.auth.csrf(sid), ctx };
  const { store, keys, cfg, alerter, prices } = ctx;

  if (req.method === 'GET' && path === '/api/stats') return sendJson(res, 200, stats(store));

  if (req.method === 'GET') {
    let page: string | null = null;
    let m: RegExpExecArray | null;
    if (path === '/') page = overview(p);
    else if (path === '/sessions') page = sessionsPage(p);
    else if ((m = /^\/sessions\/([^/]+)$/.exec(path))) page = sessionPage(p, decodeURIComponent(m[1]!));
    else if (path === '/keys') page = keysPage(p);
    else if ((m = /^\/keys\/(\d+)$/.exec(path))) page = keyPage(p, Number(m[1]));
    else if (path === '/providers') page = providersPage(p);
    else if (path === '/alerts') page = alertsPage(p);
    if (page === null) return sendHtml(res, 404, layout(p, 'Not found', '', html`<h1>Not found</h1><p><a href="/">Back to overview</a></p>`));
    return sendHtml(res, 200, page);
  }

  if (req.method !== 'POST') return sendHtml(res, 405, 'Method not allowed');
  const form = new URLSearchParams((await readBody(req, 65_536)).toString('utf8'));
  if (!ctx.auth.verifyPost(req, sid, form)) return sendHtml(res, 403, layout(p, 'Forbidden', '', html`<h1>Request rejected</h1><p>The form token did not match. Reload the page and try again.</p>`));

  try {
    let m: RegExpExecArray | null;
    if (path === '/logout') return redirect(res, '/login', { 'set-cookie': ctx.auth.logout(req, sid) });

    if (path === '/providers') {
      const name = (form.get('name') ?? '').trim();
      const kind = oneOf(form.get('kind'), ['anthropic', 'openai'] as const, 'anthropic');
      const apiKey = (form.get('api_key') ?? '').trim();
      if (!/^[A-Za-z0-9_-]{1,40}$/.test(name)) throw new HttpError(400, 'Provider name: letters, digits, - and _ only');
      if (!apiKey) throw new HttpError(400, 'API key is required');
      if (store.providerByName(name)) throw new HttpError(400, `A provider named ${name} already exists`);
      store.createProvider({ name, kind, base_url: upstreamUrl(cfg, form.get('base_url') ?? '', kind), enc_key: encrypt(keys, apiKey) });
      return redirect(res, '/providers?m=provider_added');
    }
    if (path === '/providers/rotate') {
      const pr = store.getProvider(Number(form.get('id')));
      const apiKey = (form.get('api_key') ?? '').trim();
      if (!pr || !apiKey) throw new HttpError(400, 'Choose a provider and enter the new key');
      store.updateProvider(pr.id, pr.base_url, encrypt(keys, apiKey));
      return redirect(res, '/providers?m=provider_updated');
    }
    if ((m = /^\/providers\/(\d+)\/delete$/.exec(path))) {
      return redirect(res, store.deleteProvider(Number(m[1])) ? '/providers?m=provider_deleted' : '/providers?e=provider_in_use');
    }
    if (path === '/prices') {
      const kind = oneOf(form.get('kind'), ['anthropic', 'openai'] as const, 'openai');
      const model = (form.get('model') ?? '').trim().toLowerCase();
      if (!/^[a-z0-9.:/_-]{1,120}$/.test(model)) throw new HttpError(400, 'Model prefix: letters, digits and . : / _ - only');
      const input = money(form.get('input'), 'Input');
      const cw = form.get('cache_write')?.trim() ? money(form.get('cache_write'), 'Cache write') : input * 1.25;
      const cr = form.get('cache_read')?.trim() ? money(form.get('cache_read'), 'Cache read') : input * 0.1;
      store.setPrice({ kind, model, input, output: money(form.get('output'), 'Output'), cache_write: cw, cache_read: cr });
      prices.load(store.listPrices());
      return redirect(res, '/providers?m=price_saved#prices');
    }
    if (path === '/prices/delete') {
      store.deletePrice(form.get('kind') ?? '', form.get('model') ?? '');
      prices.load(store.listPrices());
      return redirect(res, '/providers?m=price_deleted#prices');
    }
    if (path === '/keys') {
      const name = (form.get('name') ?? '').trim();
      if (!name || name.length > 60) throw new HttpError(400, 'Key name is required (up to 60 characters)');
      const provider = store.getProvider(Number(form.get('provider_id')));
      if (!provider) throw new HttpError(400, 'Choose a provider');
      const token = randomToken('lsh_', 24);
      store.createKey({
        name, prefix: token.slice(0, 10), hash: sha256(token), provider_id: provider.id, model_allow: modelList(form.get('model_allow')),
        daily_usd: optMoney(form.get('daily_usd')), monthly_usd: optMoney(form.get('monthly_usd')),
        redact_mode: oneOf<RedactMode>(form.get('redact_mode'), ['redact', 'block', 'log'], 'redact'),
        loop_mode: oneOf<LoopMode>(form.get('loop_mode'), ['enforce', 'warn', 'off'], 'enforce'),
      });
      return sendHtml(res, 200, keyCreated(p, name, provider.kind, token));
    }
    if ((m = /^\/keys\/(\d+)\/policy$/.exec(path))) {
      const k = store.getKey(Number(m[1]));
      if (!k) throw new HttpError(404, 'No such key');
      store.updateKeyPolicy(k.id, {
        daily_usd: optMoney(form.get('daily_usd')), monthly_usd: optMoney(form.get('monthly_usd')), model_allow: modelList(form.get('model_allow')),
        redact_mode: oneOf<RedactMode>(form.get('redact_mode'), ['redact', 'block', 'log'], k.redact_mode),
        loop_mode: oneOf<LoopMode>(form.get('loop_mode'), ['enforce', 'warn', 'off'], k.loop_mode),
      });
      return redirect(res, `/keys/${k.id}?m=key_updated`);
    }
    if ((m = /^\/keys\/(\d+)\/revoke$/.exec(path))) {
      store.revokeKey(Number(m[1]));
      return redirect(res, `/keys/${Number(m[1])}?m=key_revoked`);
    }
    if (path === '/settings/budget') {
      const v = optMoney(form.get('global_daily_usd'));
      store.setSetting('global_daily_usd', v === null ? null : String(v));
      return redirect(res, '/keys?m=budget_saved');
    }
    if ((m = /^\/sessions\/([^/]+)\/resume$/.exec(path))) {
      const id = decodeURIComponent(m[1]!);
      if (!store.getSession(id)) throw new HttpError(404, 'No such session');
      store.resumeSession(id, Date.now());
      return redirect(res, `/sessions/${encodeURIComponent(id)}?m=session_resumed`);
    }
    if ((m = /^\/alerts\/(\d+)\/resolve$/.exec(path))) {
      store.resolveAlert(Number(m[1]), Date.now());
      return redirect(res, '/alerts?m=alert_resolved');
    }
    if (path === '/alerts/settings') {
      const webhook = (form.get('webhook_url') ?? '').trim();
      if (webhook) {
        let u: URL;
        try { u = new URL(webhook); } catch { throw new HttpError(400, 'Webhook URL is not valid'); }
        if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new HttpError(400, 'Webhook URL must be http(s)');
      }
      const chat = (form.get('telegram_chat') ?? '').trim();
      if (chat && !/^-?[0-9]{1,20}$|^@[A-Za-z0-9_]{4,40}$/.test(chat)) throw new HttpError(400, 'Telegram chat ID is a number (or @channel)');
      const tok = (form.get('telegram_token') ?? '').trim();
      if (tok && !/^[0-9]{5,15}:[A-Za-z0-9_-]{20,80}$/.test(tok)) throw new HttpError(400, 'That does not look like a Telegram bot token');
      alerter.saveSettings({ telegramToken: form.get('clear_telegram') ? '' : tok || undefined, telegramChat: chat, webhookUrl: webhook });
      return redirect(res, '/alerts?m=settings_saved');
    }
    if (path === '/alerts/test') {
      const errors = await alerter.deliver({ sessionId: null, keyId: null, rule: 'test', level: 'info', message: 'Test alert from your Leash dashboard' });
      if (errors.length) throw new HttpError(502, `Delivery failed: ${errors.join('; ')}`);
      return redirect(res, '/alerts?m=test_sent');
    }
  } catch (e) {
    if (e instanceof HttpError) {
      return sendHtml(res, e.status, layout(p, 'Error', '', html`<h1>Could not save</h1><div class="notice bad">${e.message}</div><p>Use your browser's back button to fix the form, or <a href="/">return to the overview</a>.</p>`));
    }
    throw e;
  }
  return sendHtml(res, 404, layout(p, 'Not found', '', html`<h1>Not found</h1>`));
}
