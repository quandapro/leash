// Dashboard pages. Server-rendered HTML, no client framework; every form posts with a CSRF token.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Config } from '../config.ts';
import { encrypt, decrypt, mask, randomToken, sha256, type Keys } from '../crypto.ts';
import { startOfDayUtc, startOfMonthUtc, type LoopMode, type ProviderKind, type RedactMode, type Store } from '../db.ts';
import type { Alerter } from '../alerts.ts';
import type { PriceBook } from '../guard/pricing.ts';
import { globalDailyLimit } from '../guard/budget.ts';
import { HttpError, readBody, redirect, sendHtml, sendJson } from '../http.ts';
import { CSS, FONTS, JS } from './assets.ts';

// Content hash in asset URLs, so an upgrade never shows a page with last version's cached stylesheet.
const V = sha256(CSS + JS).slice(0, 10);
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
  provider_added: 'Provider added.', provider_updated: 'Provider key replaced.', provider_deleted: 'Provider deleted.',
  provider_in_use: 'Revoke the keys that use this provider first.', key_revoked: 'Key revoked. Agents using it are now refused.',
  key_updated: 'Policy saved.', session_paused: 'Session paused. Its next request is refused until you resume it.', session_resumed: 'Session resumed. Earlier repetitions no longer count toward loop rules.',
  alert_resolved: 'Alert resolved.', alerts_resolved: 'All open alerts resolved.', settings_saved: 'Notification settings saved.',
  price_saved: 'Price saved.', price_deleted: 'Price removed.', test_sent: 'Test alert sent.', budget_saved: 'Daily cap saved.',
};

// Human names for guard rules; the raw id stays visible in the alert detail for searching logs.
const RULES: Record<string, string> = {
  repeated_call: 'Repeated tool call', file_reread: 'Same file read again and again', identical_failure: 'Same failure repeated',
  spend_velocity: 'Spending fast', turn_ceiling: 'Very long session', budget: 'Budget reached', secret_blocked: 'Secret blocked',
  secret_redacted: 'Secret redacted', unpriced_model: 'Model has no price', test: 'Test alert',
  session_blocked: 'Refused while paused', secret: 'Secret in prompt', budget_80: 'Budget at 80%',
};
const GUARD_SECRETS: Record<string, string> = { redact: 'redacts secrets', block: 'blocks secrets', log: 'logs secrets' };
const GUARD_LOOPS: Record<string, string> = { enforce: 'pauses loops', warn: 'warns on loops', off: 'loop rules off' };
const ruleName = (rule: string) => RULES[rule] ?? rule.replace(/_/g, ' ');

const SESSION_STATE: Record<string, [string, string]> = { blocked: ['Paused', 'trip'], warned: ['Warned', 'caution'], active: ['Running', 'ok'] };
const LEVEL_STATE: Record<string, [string, string]> = { block: ['Blocked', 'trip'], warn: ['Warning', 'caution'], info: ['Info', 'idle'] };

function state(map: Record<string, [string, string]>, key: string): Safe {
  const [label, cls] = map[key] ?? [key, 'idle'];
  return html`<span class="state ${cls}">${label}</span>`;
}

const NAV: [string, string][] = [['/', 'Board'], ['/sessions', 'Sessions'], ['/keys', 'Keys'], ['/providers', 'Providers'], ['/alerts', 'Alerts']];

function layout(p: Page, title: string, active: string, body: Safe, opts: { refresh?: number } = {}): string {
  const msg = p.url.searchParams.get('m');
  const err = p.url.searchParams.get('e');
  const open = p.ctx.store.openAlertCount();
  return html`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · Leash</title>${opts.refresh ? html`<meta http-equiv="refresh" content="${opts.refresh}">` : ''}
<link rel="stylesheet" href="/static/app.css?v=${V}"><script src="/static/app.js?v=${V}" defer></script></head><body>
<header class="bar"><div><a class="word" href="/" aria-label="Leash board">leash<span>.</span></a>
<nav aria-label="Main">${NAV.map(([href, label]) => html`<a href="${href}"${active === href ? new Safe(' aria-current="page"') : ''}>${label}${href === '/alerts' && open ? html`<b>${int(open)}</b>` : ''}</a>`)}</nav>
<span class="spacer"></span>
<form class="inline signout" method="post" action="/logout"><input type="hidden" name="_csrf" value="${p.csrf}"><button class="quiet sm">Sign out</button></form></div></header>
<main class="page">${msg && MESSAGES[msg] ? html`<div class="banner ok" role="status"><p class="msg">${MESSAGES[msg]}</p></div>` : ''}${err && MESSAGES[err] ? html`<div class="banner trip" role="alert"><p class="msg">${MESSAGES[err]}</p></div>` : ''}${body}</main></body></html>`.value;
}

const hidden = (p: Page) => html`<input type="hidden" name="_csrf" value="${p.csrf}">`;
const hhmm = (ts: number) => when(ts).slice(11, 16);
const shortId = (id: string) => (id.length > 12 ? id.slice(0, 8) : id);

/** Spend against a cap. The notch marks 80%, where Leash starts warning. */
function meter(spent: number, cap: number | null, label: string): Safe {
  if (cap === null) return html`<div class="meter"><span class="val">${usd(spent)} <span class="of">${label}, no cap</span></span></div>`;
  const ratio = cap > 0 ? spent / cap : spent > 0 ? 1 : 0;
  const cls = ratio >= 1 ? 'trip' : ratio >= 0.8 ? 'caution' : '';
  const w = Math.min(100, Math.max(spent > 0 ? 1.5 : 0, ratio * 100));
  return html`<div class="meter ${cls}"><svg viewBox="0 0 100 8" preserveAspectRatio="none" aria-hidden="true"><rect class="track" width="100" height="8"/><rect class="fill" width="${w.toFixed(1)}" height="8"/><line class="notch" x1="80" y1="0" x2="80" y2="8"/></svg>
<span class="val">${usd(spent)} <span class="of">of ${usd(cap)} ${label}</span>${ratio >= 1 ? html` <span class="tag trip">cap reached</span>` : ''}</span></div>`;
}

// ---------- Session strips ----------

interface Tape { bars: { tok: number; fail: boolean }[]; fails: number; refused: number; model: string | null; first: number | null; last: number | null }

/** One bar per request, height by tokens. A bar is marked when a tool result in it failed or Leash refused it. */
function tapeData(store: Store, id: string, limit: number): Tape {
  const reqs = store.sessionTape(id, limit);
  if (reqs.length === 0) return { bars: [], fails: 0, refused: 0, model: null, first: null, last: null };
  const errs = store.sessionFailureTimes(id, reqs[0]!.ts);
  const bars = reqs.map((r) => ({ tok: r.tok, fail: !!r.blocked }));
  let fails = 0;
  for (const t of errs) {
    const i = reqs.findIndex((r) => r.ts >= t);
    if (i >= 0) { bars[i]!.fail = true; fails++; }
  }
  return { bars, fails, refused: reqs.filter((r) => r.blocked).length, model: reqs.at(-1)!.model, first: reqs[0]!.ts, last: reqs.at(-1)!.ts };
}

function bars(t: Tape, w: number, h: number, slots: number, gap: number): Safe {
  const max = Math.max(...t.bars.map((b) => b.tok), 1);
  const step = w / Math.max(slots, t.bars.length);
  return html`${t.bars.map((b, i) => {
    const bh = Math.max(2, Math.round((b.tok / max) * h));
    return html`<rect${b.fail ? new Safe(' class="fail"') : ''} x="${(i * step).toFixed(1)}" y="${h - bh}" width="${Math.max(1.5, step - gap).toFixed(1)}" height="${bh}"/>`;
  })}`;
}

function tape(t: Tape, caption = true): Safe {
  if (t.bars.length === 0) return html`<div class="tape"><small>no requests yet</small></div>`;
  return html`<div class="tape"><svg viewBox="0 0 168 34" preserveAspectRatio="none" aria-hidden="true">${bars(t, 168, 34, 24, 1.5)}</svg>
${caption ? html`<small>${t.fails || t.refused ? html`<b>${[t.fails ? `${int(t.fails)} failed` : '', t.refused ? `${int(t.refused)} refused` : ''].filter(Boolean).join(', ')}</b>` : 'no failures'}</small>` : ''}</div>`;
}

type SessionRow = ReturnType<Store['listSessions']>[number];

/** The guard rule behind a pause, for linking to its explanation. */
function pauseRule(store: Store, id: string, reason: string | null): string | null {
  const blocks = store.sessionAlerts(id).filter((x) => x.level === 'block');
  const a = blocks.findLast((x) => x.message === reason) ?? blocks.at(-1);
  return a ? a.rule : null;
}

function ruleLink(rule: string | null): Safe | string {
  return rule && RULE_HELP[rule] ? html` <a href="/guards#${rule}">${ruleName(rule)}</a>` : '';
}

function slip(p: Page, s: SessionRow, now: number): Safe {
  const { store } = p.ctx;
  const t = tapeData(store, s.id, 60);
  const href = `/sessions/${encodeURIComponent(s.id)}`;
  return html`<article class="slip"><div><span class="state trip">Paused ${ago(s.last_at, now)}</span>
<h3 class="task"><a href="${href}">${s.label || 'Untitled session'}</a></h3>
<div class="meta">${s.key_name ?? 'deleted key'}${t.model ? html`<span class="sep">·</span>${t.model}` : ''}<span class="sep">·</span>${shortId(s.id)}</div>
<p class="why">${s.status_reason ?? 'Paused by a guard rule.'}${ruleLink(pauseRule(store, s.id, s.status_reason))}</p></div>
${tape(t)}<div class="fig"><span class="money">${usd(s.spend)}</span><span class="n">${int(s.requests)} requests</span></div>
<div class="foot"><form class="inline" method="post" action="${href}/resume">${hidden(p)}<button class="primary">Resume</button></form><a class="btn quiet" href="${href}">Open replay</a>
<p>The agent gets a refusal until you resume it. Earlier repeats stop counting.</p></div></article>`;
}

function runningRow(p: Page, s: SessionRow, now: number): Safe {
  const { store } = p.ctx;
  const t = tapeData(store, s.id, 60);
  const call = store.lastToolCall(s.id);
  const href = `/sessions/${encodeURIComponent(s.id)}`;
  const st = s.status === 'warned' ? html`<span class="state caution">Warned</span>` : html`<span class="state ok">Running</span>`;
  return html`<li class="row"><div>${st}<h3 class="task"><a href="${href}">${s.label || 'Untitled session'}</a></h3>
<div class="last">${call ? html`${call.name} ${call.path ?? call.preview.slice(0, 80)} ` : ''}<span>${call ? '· ' : ''}${ago(s.last_at, now)} · ${s.key_name ?? 'deleted key'}${t.model ? ` · ${t.model}` : ''}</span></div>
${s.status === 'warned' && s.status_reason ? html`<p class="why caution">${s.status_reason}</p>` : ''}</div>
${tape(t)}<div class="fig"><span class="money">${usd(s.spend)}</span><span class="n">${int(s.requests)} requests</span></div>
<div class="acts"><form class="inline" method="post" action="${href}/pause">${hidden(p)}<button>Pause</button></form></div></li>`;
}

function doneRow(p: Page, s: SessionRow): Safe {
  const t = tapeData(p.ctx.store, s.id, 40);
  return html`<li class="row done"><div><h3 class="task"><a href="/sessions/${encodeURIComponent(s.id)}">${s.label || 'Untitled session'}</a></h3>
<div class="meta">${s.key_name ?? 'deleted key'}${t.model ? html`<span class="sep">·</span>${t.model}` : ''}<span class="sep">·</span>${hhmm(s.last_at)} UTC</div></div>
${tape(t, false)}<div class="fig"><span class="money">${usd(s.spend)}</span><span class="n">${int(s.requests)} requests</span></div><div></div></li>`;
}

// ---------- Board ----------

interface Flag { when: number; title: Safe | string; detail: string; acts: Safe }

/** What needs a person besides paused sessions: open blocks and warnings, unpriced models. */
function flags(p: Page, paused: Set<string>): Flag[] {
  const { store, prices } = p.ctx;
  const out: Flag[] = [];
  for (const a of store.listAlerts(200)) {
    if (a.resolved_at || a.level === 'info' || (a.session_id && paused.has(a.session_id))) continue;
    const target = a.session_id ? html`<a href="/sessions/${encodeURIComponent(a.session_id)}">Open session</a>` : a.key_id ? html`<a href="/keys/${a.key_id}">Open key</a>` : '';
    out.push({
      when: a.ts, title: `${ruleName(a.rule)}${a.key_name ? ` · ${a.key_name}` : ''}`, detail: a.message,
      acts: html`${target}${RULE_HELP[a.rule] ? html`<a href="/guards#${a.rule}">About this rule</a>` : ''}<form class="inline" method="post" action="/alerts/${a.id}/resolve">${hidden(p)}<input type="hidden" name="next" value="/"><button class="link">Resolve</button></form>`,
    });
  }
  for (const u of store.unpricedModels()) {
    if (prices.rate('openai', u.model).known || prices.rate('anthropic', u.model).known) continue;
    out.push({ when: 0, title: html`<span class="mono">${u.model}</span> has no price`, detail: `Charged at the fail-safe rate so budgets stay safe, which may stop agents early. ${int(u.n)} requests so far.`, acts: html`<a href="/providers#prices">Set a price</a>` });
  }
  return out;
}

function spendToday(p: Page, now: number): Safe {
  const { store } = p.ctx;
  const day = startOfDayUtc(now);
  const total = store.totalSpendSince(day);
  const month = store.totalSpendSince(startOfMonthUtc(now));
  const cap = globalDailyLimit(store);
  const keys = store.listKeys().map((k) => ({ k, spent: store.keySpendSince(k.id, day) })).filter((x) => x.spent > 0).sort((a, b) => b.spent - a.spent);
  const shown = keys.slice(0, 3);
  const rest = keys.slice(3).reduce((a, x) => a + x.spent, 0);
  const scale = cap !== null && cap > 0 ? Math.max(cap, total) : total || 1;
  const segs = [...shown.map((x, i) => ({ cls: x.k.daily_usd !== null && x.spent >= x.k.daily_usd ? 'kcap' : `k${i}`, v: x.spent })), ...(rest > 0 ? [{ cls: 'k2', v: rest }] : [])];
  let x = 0;
  const label = `${usd(total)} spent today${cap !== null ? ` of ${usd(cap)}` : ''}: ` + keys.map((k) => `${k.k.name} ${usd(k.spent)}`).join(', ');
  return html`<section aria-labelledby="spend-h"><div class="sechead"><h2 id="spend-h">Spend today</h2><span>resets 00:00 UTC</span></div><div class="spend">
<p class="spend-line"><span class="big">${usd(total)}</span><span>${cap !== null ? html`of the <span class="mono">${usd(cap)}</span> daily cap for all keys, warns at <span class="mono">${usd(cap * 0.8)}</span>` : html`no daily cap for all keys (<a href="/keys#cap">set one</a>)`}<span class="sep">·</span><span class="mono">${usd(month)}</span> this month</span></p>
<svg class="track" viewBox="0 0 1000 22" preserveAspectRatio="none" role="img" aria-label="${label}"><rect class="bg" y="5" width="1000" height="12"/>${segs.map((s) => {
    const w = (s.v / scale) * 1000;
    const r = html`<rect class="${s.cls}" x="${x.toFixed(1)}" y="5" width="${Math.max(2, w).toFixed(1)}" height="12"/>`;
    x += w;
    return r;
  })}${cap !== null && cap > 0 ? html`<line class="warn" x1="${((cap * 0.8) / scale) * 1000}" x2="${((cap * 0.8) / scale) * 1000}" y1="0" y2="22"/>` : ''}</svg>
${cap !== null && cap > 0 ? html`<div class="axis">${[0, 0.25, 0.5, 0.75, 1].map((f) => html`<span>${usd(cap * f).replace(/\.00$/, '')}</span>`)}</div>` : ''}
${keys.length ? html`<ul class="keys">${shown.map((k, i) => {
    const capped = k.k.daily_usd !== null && k.spent >= k.k.daily_usd;
    return html`<li${capped ? new Safe(' class="capped"') : ''}><i class="${capped ? 'kcap' : `k${i}`}"></i><a href="/keys/${k.k.id}">${k.k.name}</a> ${usd(k.spent)}${capped ? ', at its own cap' : ''}</li>`;
  })}${rest > 0 ? html`<li><i class="k2"></i>${int(keys.length - 3)} other keys ${usd(rest)}</li>` : ''}</ul>` : ''}</div></section>`;
}

function board(p: Page): string {
  const { store } = p.ctx;
  const now = Date.now();
  const all = store.listSessions(500);
  const paused = all.filter((s) => s.status === 'blocked');
  const running = all.filter((s) => s.status !== 'blocked' && now - s.last_at < 15 * 60_000);
  const done = all.filter((s) => s.status !== 'blocked' && now - s.last_at >= 15 * 60_000 && s.last_at >= startOfDayUtc(now));
  const other = flags(p, new Set(paused.map((s) => s.id)));
  const providers = store.listProviders();
  const keys = store.listKeys().filter((k) => !k.revoked_at);
  const counts = `${int(running.length)} running, ${int(done.length)} finished today.`;

  let lead: Safe;
  if (providers.length === 0) lead = html`Leash is running. Add a provider to start.`;
  else if (keys.length === 0) lead = html`Ready. Create a key for your first agent.`;
  else if (paused.length) lead = html`<b>${paused.length === 1 ? '1 agent is paused' : `${int(paused.length)} agents are paused`}</b> and waiting on you. ${counts}`;
  else if (other.length) lead = html`<b>${other.length === 1 ? '1 thing to review' : `${int(other.length)} things to review`}</b>. ${counts}`;
  else lead = html`All quiet. Nothing needs you. ${counts}`;

  const day = new Date(now).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
  const body = html`<div class="head"><div><h1>${day}</h1><p>${lead}</p></div>
<form class="find" method="get" action="/sessions" role="search"><input id="find" name="q" type="search" placeholder="Find a session, key or task" aria-label="Find a session, key or task"><kbd aria-hidden="true">/</kbd></form></div>
${providers.length === 0 ? html`<div class="empty"><strong>Connect a model API.</strong> Add your Anthropic or OpenAI-compatible key on the <a href="/providers">Providers</a> page, then create one Leash key per agent.</div>` : ''}
${providers.length && keys.length === 0 ? html`<div class="empty"><strong>Create a key.</strong> Each agent or machine gets its own Leash key, with its own budget, on the <a href="/keys">Keys</a> page.</div>` : ''}
${spendToday(p, now)}
<div class="cols"><div>
${paused.length ? html`<section aria-labelledby="paused-h"><div class="sechead"><h2 id="paused-h">Paused, waiting on you</h2><span class="hot">${paused.length === 1 ? '1 session' : `${int(paused.length)} sessions`}</span></div>
<div class="slips">${paused.map((s) => slip(p, s, now))}</div></section>` : ''}
<section aria-labelledby="run-h"><div class="sechead"><h2 id="run-h">Running</h2><span>active in the last 15 minutes</span></div>
${running.length ? html`<ul class="rows">${running.map((s) => runningRow(p, s, now))}</ul>` : html`<div class="empty">No agent has sent a request in the last 15 minutes.</div>`}</section>
<section aria-labelledby="done-h"><div class="sechead"><h2 id="done-h">Finished today</h2><span>${int(done.length)} session${done.length === 1 ? '' : 's'} · ${usd(done.reduce((a, s) => a + s.spend, 0))}</span></div>
${done.length ? html`<ul class="rows">${done.slice(0, 6).map((s) => doneRow(p, s))}</ul>${done.length > 6 ? html`<a class="more-link" href="/sessions">Show ${int(done.length - 6)} more</a>` : ''}` : html`<div class="empty">Nothing finished yet today.</div>`}</section>
</div>
<aside class="sec" aria-labelledby="flags-h"><div class="sechead"><h2 id="flags-h">Also flagged</h2><span>${int(other.length)} open</span></div>
${other.length ? html`<ul class="flags">${other.map((f) => html`<li>${f.when ? html`<span class="when">${hhmm(f.when)} UTC · ${ago(f.when, now)}</span>` : ''}<h3>${f.title}</h3><p>${f.detail}</p><div class="acts">${f.acts}</div></li>`)}</ul>` : html`<p class="side-note">Nothing else needs you.</p>`}
<p class="side-note">Paused sessions are on the board, not here. <a href="/alerts">All alerts</a> · <a href="/guards">How the guards work</a></p></aside></div>`;
  return layout(p, 'Board', '/', body, { refresh: 30 });
}

// ---------- Sessions ----------

function sessionsList(p: Page, sessions: SessionRow[], now: number): Safe {
  if (sessions.length === 0) return html`<div class="empty">No sessions yet. One appears as soon as an agent sends its first request with a Leash key.</div>`;
  return html`<ul class="rows">${sessions.map((s) => {
    const t = tapeData(p.ctx.store, s.id, 40);
    return html`<li class="row"><div>${state(SESSION_STATE, s.status)}<h3 class="task"><a href="/sessions/${encodeURIComponent(s.id)}">${s.label || 'Untitled session'}</a></h3>
<div class="meta">${s.key_name ?? 'deleted key'}${t.model ? html`<span class="sep">·</span>${t.model}` : ''}<span class="sep">·</span>${ago(s.last_at, now)}<span class="sep">·</span>${shortId(s.id)}</div>
${s.status_reason && s.status !== 'active' ? html`<p class="why${s.status === 'warned' ? ' caution' : ''}">${s.status_reason}</p>` : ''}</div>
${tape(t)}<div class="fig"><span class="money">${usd(s.spend)}</span><span class="n">${int(s.requests)} requests</span></div><div></div></li>`;
  })}</ul>`;
}

function sessionsPage(p: Page): string {
  const all = p.ctx.store.listSessions(500);
  const filter = p.url.searchParams.get('status') ?? '';
  const q = (p.url.searchParams.get('q') ?? '').trim().slice(0, 100);
  const ql = q.toLowerCase();
  const matched = ql ? all.filter((s) => [s.label, s.id, s.key_name ?? ''].some((v) => v.toLowerCase().includes(ql))) : all;
  const shown = ['blocked', 'warned', 'active'].includes(filter) ? matched.filter((s) => s.status === filter) : matched;
  const counts = { blocked: 0, warned: 0, active: 0 } as Record<string, number>;
  for (const s of matched) counts[s.status] = (counts[s.status] ?? 0) + 1;
  const qs = (status: string) => {
    const u = new URLSearchParams();
    if (status) u.set('status', status);
    if (q) u.set('q', q);
    return u.size ? `?${u}` : '';
  };
  const tabs: [string, string][] = [['', `All ${matched.length}`], ['blocked', `Paused ${counts.blocked}`], ['warned', `Warned ${counts.warned}`], ['active', `Running ${counts.active}`]];
  const body = html`<div class="head"><div><h1>Sessions</h1><p>One row per agent conversation, named by its first prompt. A paused session stays paused until you resume it.</p></div>
<form class="find" method="get" action="/sessions" role="search">${filter ? html`<input type="hidden" name="status" value="${filter}">` : ''}<input id="find" name="q" type="search" value="${q}" placeholder="Find a session, key or task" aria-label="Find a session, key or task"><kbd aria-hidden="true">/</kbd></form></div>
<nav class="filters" aria-label="Filter sessions">${tabs.map(([v, label]) => html`<a href="/sessions${qs(v)}"${filter === v ? new Safe(' aria-current="true"') : ''}>${label}</a>`)}</nav>
${q && shown.length === 0 ? html`<div class="empty">No session matches “${q}”. <a href="/sessions">Show all sessions</a></div>` : sessionsList(p, shown.slice(0, 200), Date.now())}`;
  return layout(p, 'Sessions', '/sessions', body, { refresh: q ? undefined : 15 });
}

interface Step { ts: number; tool: string; call: string; path: string | null; result: string | null; error: boolean; n: number }

/** Pairs each tool call with its result and folds identical consecutive steps into one row with a count. */
function replaySteps(events: ReturnType<Store['sessionToolEvents']>): Step[] {
  const steps: Step[] = [];
  const open: Step[] = [];
  for (const e of [...events].reverse()) {
    if (e.kind === 'call') {
      const s: Step = { ts: e.ts, tool: e.name, call: e.preview, path: e.path, result: null, error: false, n: 1 };
      steps.push(s);
      open.push(s);
    } else {
      const i = open.findIndex((s) => s.tool === e.name);
      const s = i >= 0 ? open.splice(i, 1)[0]! : (steps.push({ ts: e.ts, tool: e.name, call: '', path: null, result: null, error: false, n: 1 }), steps.at(-1)!);
      s.result = e.preview;
      s.error = !!e.is_error;
    }
  }
  const folded: Step[] = [];
  for (const s of steps) {
    const last = folded.at(-1);
    if (last && last.tool === s.tool && last.call === s.call && last.result === s.result && last.error === s.error) last.n++;
    else folded.push({ ...s });
  }
  return folded;
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

function sessionPage(p: Page, id: string): string | null {
  const { store } = p.ctx;
  const s = store.getSession(id);
  if (!s) return null;
  const now = Date.now();
  const key = store.getKey(s.key_id);
  const reqs = store.sessionRequests(id);
  const steps = replaySteps(store.sessionToolEvents(id, 400));
  const alerts = store.sessionAlerts(id);
  const t = tapeData(store, id, 200);
  const self = `/sessions/${encodeURIComponent(s.id)}`;
  const paused = s.status === 'blocked';
  const tokIn = reqs.reduce((a, r) => a + r.in_tok + r.cache_w + r.cache_r, 0);
  const cacheRead = reqs.reduce((a, r) => a + r.cache_r, 0);
  const minutes = Math.max(1, Math.round((s.last_at - s.started_at) / 60_000));
  const st = paused ? html`<span class="state trip">Paused ${ago(s.last_at, now)}</span>` : s.status === 'warned' ? html`<span class="state caution">Warned</span>` : html`<span class="state ok">Running · last request ${ago(s.last_at, now)}</span>`;
  const body = html`<nav class="crumbs" aria-label="Breadcrumb"><a href="/">Board</a> / <a href="/sessions">Sessions</a> / ${shortId(s.id)}</nav>
<article class="slip big${paused ? '' : ' calm'}"><div>${st}<h1 class="task">${s.label || 'Untitled session'}</h1>
<div class="meta">${key ? html`<a href="/keys/${key.id}">${key.name}</a>` : 'deleted key'}${t.model ? html`<span class="sep">·</span>${t.model}` : ''}<span class="sep">·</span>${s.id}</div>
${s.status_reason && s.status !== 'active' ? html`<p class="why${paused ? '' : ' caution'}">${s.status_reason}${ruleLink(pauseRule(store, s.id, s.status_reason) ?? alerts.at(-1)?.rule ?? null)}</p>` : ''}</div>
<div class="fig"><span class="money">${usd(s.spend)}</span><span class="n">${int(s.requests)} requests · ${int(minutes)} min</span></div>
<div class="foot">${paused
    ? html`<form class="inline" method="post" action="${self}/resume">${hidden(p)}<button class="primary">Resume session</button></form><p>The agent gets a refusal until you resume. Resuming clears the repeats counted so far.</p>`
    : html`<form class="inline" method="post" action="${self}/pause">${hidden(p)}<button>Pause session</button></form><p>Pausing refuses this session's next request until you resume it.${s.resumed_at ? ` Last resumed ${ago(s.resumed_at, now)}.` : ''}</p>`}</div></article>

<section aria-labelledby="tl-h"><div class="sechead"><h2 id="tl-h">Timeline</h2><span>${t.bars.length < s.requests ? `last ${int(t.bars.length)} of ${int(s.requests)} requests` : `${int(t.bars.length)} requests`}${t.first ? ` · ${hhmm(t.first)} to ${hhmm(t.last!)} UTC` : ''}</span></div>
${t.bars.length ? html`<div class="timeline"><svg viewBox="0 0 1000 88" preserveAspectRatio="none" role="img" aria-label="${int(t.bars.length)} requests, ${int(t.fails)} with a failed tool result or a refusal">${bars(t, 1000, 88, 24, t.bars.length > 100 ? 1 : 4)}</svg></div>
<div class="t-axis"><span>${hhmm(t.first!)}</span><span>${hhmm(Math.round((t.first! + t.last!) / 2))}</span><span>${hhmm(t.last!)}</span></div>
<p class="legend"><i></i>request, height is tokens<i class="fail"></i>a tool result failed, or Leash refused the request</p>` : html`<div class="empty">No requests yet.</div>`}</section>

<section aria-labelledby="rp-h"><div class="sechead"><h2 id="rp-h">Replay</h2><span>${int(steps.length)} step${steps.length === 1 ? '' : 's'} · repeats folded · previews redacted</span></div>
<div class="term"><div class="term-head"><span><b>${shortId(s.id)}</b> · oldest first</span><span>times in UTC</span></div>
${steps.length === 0 ? html`<p class="none">No tool calls yet. Plain chat requests show under Requests.</p>` : html`<ol>${steps.map((x) => html`<li class="${x.n >= 3 ? 'loop' : ''}"><span class="t">${when(x.ts).slice(11, 19)}</span><span class="tool">${x.tool}</span>
<span class="call">${x.path ? html`<strong>${x.path}</strong> ` : ''}${x.call}${x.n > 1 ? html`<span class="x">×${x.n}</span>` : ''}</span>
<span class="res${x.error ? ' err' : ''}">${x.result !== null ? html`<span class="sr">${x.error ? 'failed: ' : 'returned: '}</span>${x.error ? '✗ ' : ''}${x.result}` : ''}</span></li>`)}</ol>`}</div></section>

<section aria-labelledby="u-h"><div class="sechead"><h2 id="u-h">Usage</h2><span>measured at the gateway</span></div>
<ul class="usage"><li><span class="v">${int(tokIn)}</span><span class="l">tokens in</span></li><li><span class="v">${int(reqs.reduce((a, r) => a + r.out_tok, 0))}</span><span class="l">tokens out</span></li>
<li><span class="v">${tokIn ? `${((cacheRead / tokIn) * 100).toFixed(1)}%` : '—'}</span><span class="l">read from cache</span></li><li><span class="v">${int(median(reqs.map((r) => r.latency_ms)))} ms</span><span class="l">median response time</span></li></ul></section>

${alerts.length ? html`<section aria-labelledby="al-h"><div class="sechead"><h2 id="al-h">Alerts</h2><span>${int(alerts.length)}</span></div><ul class="ledger">${alerts.map((a) => html`<li class="${a.resolved_at ? 'done' : ''}">${state(LEVEL_STATE, a.level)}<div class="what"><div class="title">${ruleName(a.rule)}</div><p class="detail">${a.message}</p><p class="meta">${when(a.ts)}${a.resolved_at ? ' · resolved' : ''}</p></div><div class="acts">${RULE_HELP[a.rule] ? html`<a class="btn quiet sm" href="/guards#${a.rule}">About this rule</a>` : ''}</div></li>`)}</ul></section>` : ''}
<section><details class="more"${reqs.length <= 12 ? new Safe(' open') : ''}><summary>Requests (${int(reqs.length)})</summary>
${reqs.length === 0 ? html`<div class="empty">No requests.</div>` : html`<div class="scroll"><table><thead><tr><th>Time (UTC)</th><th>Model</th><th class="num">Input</th><th class="num">Cache read</th><th class="num">Output</th><th class="num">Cost</th><th class="num">Latency</th><th>Result</th></tr></thead><tbody>
${reqs.slice(-200).reverse().map((r) => html`<tr><td class="nowrap mono">${when(r.ts).slice(11, 19)}</td><td class="mono">${r.model}</td><td class="num">${int(r.in_tok + r.cache_w)}</td><td class="num">${int(r.cache_r)}</td><td class="num">${int(r.out_tok)}</td>
<td class="num">${usd(r.cost)}${r.price_known ? '' : html`<abbr title="Charged at the fail-safe rate: this model has no price">*</abbr>`}</td><td class="num nowrap">${int(r.latency_ms)} ms</td>
<td>${r.blocked ? html`<span class="tag trip">refused · ${ruleName(r.blocked)}</span>` : r.status < 400 ? html`<span class="tag">${r.status}</span>` : html`<span class="tag trip">${r.status}</span>`}${r.redactions ? html` <span class="tag box">${r.redactions} redacted</span>` : ''}</td></tr>`)}
</tbody></table></div>`}</details></section>`;
  return layout(p, s.label || 'Session', '/sessions', body, { refresh: paused ? undefined : 30 });
}

// ---------- Guard rules ----------

/** What each guard does and what to do about it. Linked from pause reasons and alerts. */
const RULE_HELP: Record<string, [string, string]> = {
  identical_failure: ['The same tool returned the same failure 3 times in a row. The agent is retrying something that is not changing.', 'Pauses the session when the key\'s loop rules are on "pause". Look at the replay, fix the cause or give the agent a hint, then resume.'],
  repeated_call: ['The same tool call, with identical arguments, appeared 3 or more times in the last 10 calls.', 'Warns at 3 and pauses at 4 when loop rules are on "pause". Resuming clears the repeats counted so far.'],
  file_reread: ['The agent read the same file 5 times without changing it, usually a sign it is lost.', 'Warns only. Nothing is stopped.'],
  spend_velocity: ['One session spent more than the velocity limit (LEASH_VELOCITY_USD, $5 by default) within 10 minutes.', 'Pauses the session when loop rules are on "pause", otherwise warns.'],
  turn_ceiling: ['A session passed the request ceiling (LEASH_TURN_CEILING, 200 by default).', 'Warns only. Very long sessions are where runaway spend hides.'],
  budget: ['A key reached its daily or monthly budget, or all keys together reached the daily cap.', 'Requests are refused until the budget resets (00:00 UTC, or the 1st of the month) or you raise it on the key\'s page.'],
  budget_80: ['A key or the daily cap for all keys passed 80% of its budget.', 'Warns only, once per budget per day.'],
  secret_redacted: ['A request contained something that looks like a secret: an API key, a token, a private key or a password assignment.', 'Leash replaced it with [REDACTED:type] before the request left. The agent keeps working.'],
  secret_blocked: ['A request contained a secret and the key is set to block requests with secrets.', 'The request was refused. Remove the secret from the agent\'s context, or switch the key to redact.'],
  secret: ['A request was refused because it contained a secret.', 'Remove the secret from the agent\'s context, or switch the key to redact.'],
  session_blocked: ['The agent sent another request while its session was paused.', 'Leash refused it. Resume the session to let it continue.'],
  unpriced_model: ['A model has no price in Leash and the provider did not report a cost.', 'It is charged at a high fail-safe rate so budgets stay safe. Set its price on the Providers page.'],
};

function guardsPage(p: Page): string {
  const body = html`<div class="head"><div><h1>How the guards work</h1><p>Every rule Leash applies between your agents and the model API, what trips it, and what to do next.</p></div></div>
<ul class="rules">${Object.entries(RULE_HELP).map(([id, [what, then]]) => html`<li id="${id}"><h2>${ruleName(id)}<code>${id}</code></h2><div><p>${what}</p><p>${then}</p></div></li>`)}</ul>
<p class="prose">Loop rules are set per key: <strong>pause</strong> stops the session, <strong>warn</strong> only alerts, <strong>off</strong> disables them. Change them on each key's page.</p>`;
  return layout(p, 'Guards', '', body);
}

function field(label: string, control: Safe, hint?: string): Safe {
  return html`<label class="field"><span>${label}</span>${control}${hint ? html`<span class="hint">${hint}</span>` : ''}</label>`;
}

function keyForm(p: Page, values: { name?: string; provider_id?: number; daily?: string; monthly?: string; models?: string; redact?: string; loop?: string }, action: string, submit: string, withProvider: boolean, plain = false): Safe {
  const providers = p.ctx.store.listProviders();
  const sel = (cur: string | undefined, v: string) => (cur === v ? new Safe(' selected') : '');
  return html`<form class="form${plain ? ' plain' : ''}" method="post" action="${action}">${hidden(p)}
${withProvider ? html`<div class="row">${field('Name', html`<input name="name" required maxlength="60" placeholder="laptop-claude-code" value="${values.name ?? ''}">`, 'Which agent or machine uses it.')}
${field('Provider', html`<select name="provider_id" required>${providers.map((pr) => html`<option value="${pr.id}"${values.provider_id === pr.id ? new Safe(' selected') : ''}>${pr.name} (${pr.kind === 'anthropic' ? 'Anthropic' : 'OpenAI-compatible'})</option>`)}</select>`)}</div>` : ''}
<div class="row">${field('Daily budget, USD', html`<input name="daily_usd" type="number" min="0" step="0.01" placeholder="No limit" value="${values.daily ?? ''}">`)}
${field('Monthly budget, USD', html`<input name="monthly_usd" type="number" min="0" step="0.01" placeholder="No limit" value="${values.monthly ?? ''}">`)}</div>
${field('Allowed models', html`<input name="model_allow" maxlength="500" placeholder="claude-sonnet-*, claude-haiku-*" value="${values.models ?? ''}">`, 'Comma-separated, * matches anything. Leave empty to allow every model.')}
<div class="row">${field('Secrets in prompts', html`<select name="redact_mode"><option value="redact"${sel(values.redact, 'redact')}>Redact before sending</option><option value="block"${sel(values.redact, 'block')}>Block the request</option><option value="log"${sel(values.redact, 'log')}>Detect and alert only</option></select>`)}
${field('Loop rules', html`<select name="loop_mode"><option value="enforce"${sel(values.loop, 'enforce')}>Pause the session</option><option value="warn"${sel(values.loop, 'warn')}>Warn only</option><option value="off"${sel(values.loop, 'off')}>Off</option></select>`, 'Repeated calls, re-reads, identical failures, fast spending.')}</div>
<div class="actions"><button class="primary">${submit}</button></div></form>`;
}

function keysPage(p: Page): string {
  const { store } = p.ctx;
  const now = Date.now();
  const keys = store.listKeys();
  const providers = store.listProviders();
  const limit = globalDailyLimit(store);
  const newKey = providers.length === 0
    ? html`<div class="empty">Add a <a href="/providers">provider</a> first. A key always sends traffic to one provider.</div>`
    : html`<details class="disclose"${keys.length === 0 ? new Safe(' open') : ''}><summary class="btn primary">New key</summary>${keyForm(p, { daily: '10', monthly: '100' }, '/keys', 'Create key', true)}</details>`;
  const body = html`<div class="head"><div><h1>Keys</h1><p>One Leash key per agent or machine. Your provider keys never leave this server.</p></div></div>
${newKey}
<section>${keys.length === 0 ? html`<div class="empty">No keys yet.</div>` : html`<div class="scroll"><table><thead><tr><th>Name</th><th>Provider</th><th>Today</th><th class="num">This month</th><th>Guards</th><th>Last used</th></tr></thead><tbody>
${keys.map((k) => html`<tr><td><a href="/keys/${k.id}">${k.name}</a><div class="mono muted">${k.prefix}…</div>${k.revoked_at ? html`<span class="tag trip">revoked</span>` : ''}</td>
<td>${k.provider_name ?? '—'}</td><td>${k.revoked_at ? html`<span class="muted">—</span>` : meter(store.keySpendSince(k.id, startOfDayUtc(now)), k.daily_usd, 'today')}</td>
<td class="num">${usd(store.keySpendSince(k.id, startOfMonthUtc(now)))}${k.monthly_usd !== null ? html`<div class="muted">of ${usd(k.monthly_usd)}</div>` : ''}</td>
<td><span class="tag">${GUARD_SECRETS[k.redact_mode] ?? k.redact_mode}</span> <span class="tag">${GUARD_LOOPS[k.loop_mode] ?? k.loop_mode}</span></td><td class="nowrap">${ago(k.last_used_at, now)}</td></tr>`)}
</tbody></table></div>`}</section>
<section id="cap"><div class="sechead"><h2>Daily cap for all keys</h2></div><p class="muted">Every key stops for the rest of the UTC day once total spend reaches this amount.</p>
<form class="inline-form" method="post" action="/settings/budget">${hidden(p)}${field('USD per day', html`<input name="global_daily_usd" type="number" min="0" step="0.01" placeholder="No limit" value="${limit ?? ''}">`)}<button>Save cap</button></form></section>`;
  return layout(p, 'Keys', '/keys', body);
}

function keyPage(p: Page, id: number): string | null {
  const { store } = p.ctx;
  const k = store.getKey(id);
  if (!k) return null;
  const now = Date.now();
  const provider = store.getProvider(k.provider_id);
  const body = html`<a class="back" href="/keys">← Keys</a>
<div class="head"><div><h1>${k.name}</h1><p class="facts"><span class="mono">${k.prefix}…</span><span class="sep">·</span>${provider?.name ?? 'deleted provider'}<span class="sep">·</span>created ${when(k.created_at).slice(0, 10)}<span class="sep">·</span>last used ${ago(k.last_used_at, now)}</p></div></div>
${k.revoked_at ? html`<div class="banner trip"><p class="msg"><strong>Revoked ${when(k.revoked_at)}.</strong> Requests with this key are refused.</p></div>` : ''}
<section><div class="sechead"><h2>Spend</h2></div><div class="meters">${meter(store.keySpendSince(k.id, startOfDayUtc(now)), k.daily_usd, 'today')}${meter(store.keySpendSince(k.id, startOfMonthUtc(now)), k.monthly_usd, 'this month')}</div></section>
${provider && !k.revoked_at ? html`<section><div class="sechead"><h2>Connect an agent</h2></div>${setupSnippets(p, provider.kind, `${k.prefix}…`, false)}</section>` : ''}
${k.revoked_at ? '' : html`<section><div class="sechead"><h2>Policy</h2></div>${keyForm(p, { daily: k.daily_usd?.toString() ?? '', monthly: k.monthly_usd?.toString() ?? '', models: k.model_allow, redact: k.redact_mode, loop: k.loop_mode }, `/keys/${k.id}/policy`, 'Save policy', false)}</section>
<section><div class="danger-zone"><div><h2>Revoke this key</h2><p class="muted">Agents using it are refused immediately. This cannot be undone; create a new key instead.</p></div>
<form method="post" action="/keys/${k.id}/revoke" data-confirm="Revoke ${k.name}? Agents using it stop working immediately.">${hidden(p)}<button class="danger">Revoke key</button></form></div></section>`}`;
  return layout(p, k.name, '/keys', body);
}

function snippet(id: string, text: string, secret = false): Safe {
  return html`<div class="snippet${secret ? ' secret' : ''}"><pre id="${id}">${text}</pre><button class="sm copy" type="button" data-copy="${id}">Copy</button></div>`;
}

function setupSnippets(p: Page, kind: ProviderKind, token: string, full: boolean): Safe {
  const base = p.ctx.cfg.publicUrl;
  const note = full ? '' : html`<p class="muted">The full key was shown once when it was created. Use that value in place of <code>${token}</code>.</p>`;
  if (kind === 'anthropic') {
    return html`<p><strong>Claude Code</strong> or any Anthropic SDK: set these before starting it.</p>
${snippet('snip-cc', `export ANTHROPIC_BASE_URL=${base}/anthropic\nexport ANTHROPIC_API_KEY=${token}`)}
<p class="muted">PowerShell: <code>$env:ANTHROPIC_BASE_URL="${base}/anthropic"; $env:ANTHROPIC_API_KEY="${token}"</code></p>${note}`;
  }
  return html`<p><strong>Codex CLI</strong>: add to <code>~/.codex/config.toml</code>, then export <code>LEASH_API_KEY</code>.</p>
${snippet('snip-codex', `model_provider = "leash"\n\n[model_providers.leash]\nname = "Leash"\nbase_url = "${base}/openai/v1"\nenv_key = "LEASH_API_KEY"\nwire_api = "responses"`)}
${snippet('snip-env', `export LEASH_API_KEY=${token}\nexport OPENAI_BASE_URL=${base}/openai/v1\nexport OPENAI_API_KEY=${token}`)}
<p class="muted">Other OpenAI-compatible clients (Cline, aider, Continue, OpenClaw, Hermes): base URL <code>${base}/openai/v1</code>, API key = your Leash key.</p>${note}`;
}

function keyCreated(p: Page, name: string, kind: ProviderKind, token: string): string {
  const body = html`<a class="back" href="/keys">← Keys</a><div class="head"><div><h1>${name} is ready</h1></div></div>
<div class="banner caution" role="status"><p class="msg"><strong>Copy this key now.</strong> Leash keeps only a hash and cannot show it again.</p></div>
${snippet('newkey', token, true)}
<section><div class="sechead"><h2>Connect an agent</h2></div>${setupSnippets(p, kind, token, true)}</section>
<p><a class="btn" href="/keys">Done</a></p>`;
  return layout(p, 'Key created', '/keys', body);
}

function providersPage(p: Page): string {
  const { store, keys } = p.ctx;
  const providers = store.listProviders();
  const prices = store.listPrices();
  const kindName = (k: string) => (k === 'anthropic' ? 'Anthropic' : 'OpenAI-compatible');
  const body = html`<div class="head"><div><h1>Providers</h1><p>Your real API keys, encrypted on this server with AES-256-GCM. Agents only ever see their Leash keys.</p></div></div>
<details class="disclose"${providers.length === 0 ? new Safe(' open') : ''}><summary class="btn primary">Add provider</summary>
<form class="form" method="post" action="/providers">${hidden(p)}
<div class="row">${field('Name', html`<input name="name" required maxlength="40" pattern="[A-Za-z0-9_-]+" placeholder="anthropic">`, 'Letters, digits, - and _.')}
${field('API format', html`<select name="kind"><option value="anthropic">Anthropic</option><option value="openai">OpenAI-compatible</option></select>`)}</div>
${field('Base URL', html`<input name="base_url" maxlength="300" placeholder="https://api.anthropic.com">`, 'Leave empty for the official API. OpenRouter: https://openrouter.ai/api (Anthropic) or https://openrouter.ai/api/v1 (OpenAI).')}
${field('API key', html`<input name="api_key" type="password" required maxlength="1000" autocomplete="off">`)}
<div class="actions"><button class="primary">Add provider</button></div></form></details>
<section>${providers.length === 0 ? html`<div class="empty">No providers yet. Leash forwards nothing until you add one.</div>` : html`<div class="scroll"><table><thead><tr><th>Name</th><th>API format</th><th>Base URL</th><th>API key</th><th></th></tr></thead><tbody>
${providers.map((pr) => {
    let shown = '••••';
    try { shown = mask(decrypt(keys, pr.enc_key)); } catch { shown = 'cannot decrypt (LEASH_SECRET changed?)'; }
    return html`<tr><td>${pr.name}</td><td>${kindName(pr.kind)}</td><td class="mono">${pr.base_url}</td><td class="mono">${shown}</td>
<td class="num"><form class="inline" method="post" action="/providers/${pr.id}/delete" data-confirm="Delete provider ${pr.name}? Keys that use it must be revoked first.">${hidden(p)}<button class="danger sm">Delete</button></form></td></tr>`;
  })}</tbody></table></div>
<details class="more"><summary>Replace a provider's API key</summary><form class="form" method="post" action="/providers/rotate">${hidden(p)}
<div class="row">${field('Provider', html`<select name="id">${providers.map((pr) => html`<option value="${pr.id}">${pr.name}</option>`)}</select>`)}
${field('New API key', html`<input name="api_key" type="password" required maxlength="1000" autocomplete="off">`)}</div><div class="actions"><button class="primary">Replace key</button></div></form></details>`}</section>
<section id="prices"><div class="sechead"><h2>Model prices</h2></div><p class="muted">USD per million tokens. Claude models are priced built in, and providers that report their own cost (OpenRouter) are billed exactly. Set a price for other models so budgets have an estimate. A prefix like <code>gpt-5</code> also covers <code>gpt-5-mini</code> unless that has its own row.</p>
${prices.length ? html`<div class="scroll"><table><thead><tr><th>Model prefix</th><th>API format</th><th class="num">Input</th><th class="num">Output</th><th class="num">Cache write</th><th class="num">Cache read</th><th></th></tr></thead><tbody>
${prices.map((pr) => html`<tr><td class="mono">${pr.model}</td><td>${kindName(pr.kind)}</td><td class="num">${pr.input}</td><td class="num">${pr.output}</td><td class="num">${pr.cache_write}</td><td class="num">${pr.cache_read}</td>
<td class="num"><form class="inline" method="post" action="/prices/delete">${hidden(p)}<input type="hidden" name="kind" value="${pr.kind}"><input type="hidden" name="model" value="${pr.model}"><button class="quiet sm">Remove</button></form></td></tr>`)}</tbody></table></div>` : ''}
<details class="more"${prices.length === 0 ? new Safe(' open') : ''}><summary>Add a price</summary><form class="form" method="post" action="/prices">${hidden(p)}<div class="row">
${field('Model prefix', html`<input name="model" required maxlength="120" placeholder="gpt-5">`)}
${field('API format', html`<select name="kind"><option value="openai">OpenAI-compatible</option><option value="anthropic">Anthropic</option></select>`)}</div><div class="row">
${field('Input', html`<input name="input" type="number" min="0" step="0.0001" required>`)}${field('Output', html`<input name="output" type="number" min="0" step="0.0001" required>`)}
${field('Cache write', html`<input name="cache_write" type="number" min="0" step="0.0001" placeholder="1.25 × input">`)}${field('Cache read', html`<input name="cache_read" type="number" min="0" step="0.0001" placeholder="0.1 × input">`)}</div>
<div class="actions"><button class="primary">Save price</button></div></form></details></section>`;
  return layout(p, 'Providers', '/providers', body);
}

function alertsPage(p: Page): string {
  const { store, alerter } = p.ctx;
  const now = Date.now();
  const all = store.listAlerts(200);
  const showAll = p.url.searchParams.get('show') === 'all';
  const open = all.filter((a) => !a.resolved_at);
  const shown = showAll ? all : open;
  const s = alerter.settings();
  const body = html`<div class="head"><div><h1>Alerts</h1><p>Every block and warning, newest first. New alerts also go to Telegram or your webhook.</p></div>
${open.length > 1 ? html`<form method="post" action="/alerts/resolve-all" data-confirm="Resolve all ${open.length} open alerts?">${hidden(p)}<button>Resolve all ${int(open.length)}</button></form>` : ''}</div>
<nav class="filters" aria-label="Filter alerts"><a href="/alerts"${showAll ? '' : new Safe(' aria-current="true"')}>Open ${int(open.length)}</a><a href="/alerts?show=all"${showAll ? new Safe(' aria-current="true"') : ''}>All ${int(all.length)}</a></nav>
${shown.length === 0 ? html`<div class="empty">${showAll ? 'No alerts yet.' : 'No open alerts. Every guard is quiet.'}</div>` : html`<ul class="ledger">${shown.map((a) => html`<li class="${a.resolved_at ? 'done' : ''}">${state(LEVEL_STATE, a.level)}<div class="what">
<div class="title">${ruleName(a.rule)}</div><p class="detail">${a.message}</p>
<p class="meta">${a.key_name ?? 'all keys'}${a.session_id ? html`<span class="sep">·</span><a href="/sessions/${encodeURIComponent(a.session_id)}">session</a>` : ''}<span class="sep">·</span><span title="${when(a.ts)}">${ago(a.ts, now)}</span>${a.resolved_at ? html`<span class="sep">·</span>resolved` : ''}</p></div>
<div class="acts">${RULE_HELP[a.rule] ? html`<a class="btn quiet sm" href="/guards#${a.rule}">About this rule</a>` : ''}${a.resolved_at ? '' : html`<form class="inline" method="post" action="/alerts/${a.id}/resolve">${hidden(p)}<button class="sm">Resolve</button></form>`}</div></li>`)}</ul>`}
<section><div class="sechead"><h2>Notifications</h2></div>
<form class="form" method="post" action="/alerts/settings">${hidden(p)}
<div class="row">${field('Telegram bot token', html`<input name="telegram_token" type="password" maxlength="200" autocomplete="off" placeholder="${s.telegramToken ? 'Saved. Leave empty to keep it' : '123456:ABC…'}">`, 'Create a bot with @BotFather.')}
${field('Telegram chat ID', html`<input name="telegram_chat" maxlength="40" value="${s.telegramChat ?? ''}" placeholder="123456789">`)}</div>
${field('Webhook URL', html`<input name="webhook_url" type="url" maxlength="500" value="${s.webhookUrl ?? ''}" placeholder="https://hooks.example.com/leash">`, 'Receives a JSON POST for each new alert.')}
${s.telegramToken ? html`<label class="check"><input type="checkbox" name="clear_telegram" value="1"> Remove the saved Telegram token</label>` : ''}
<div class="actions"><button class="primary">Save notifications</button><button formaction="/alerts/test">Send a test alert</button></div></form></section>`;
  return layout(p, 'Alerts', '/alerts', body);
}

function loginPage(error: string | null): string {
  return html`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in · Leash</title><link rel="stylesheet" href="/static/app.css?v=${V}"></head><body><main class="signin">
<span class="word">leash<span>.</span></span><h1>Sign in</h1><p>Use the admin token from your <code>LEASH_ADMIN_TOKEN</code> setting.</p>
${error ? html`<div class="banner trip" role="alert"><p class="msg">${error}</p></div>` : ''}
<form class="form plain" method="post" action="/login">${field('Admin token', html`<input name="token" type="password" required autofocus autocomplete="current-password">`)}<div class="actions"><button class="primary">Sign in</button></div></form>
</main></body></html>`.value;
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
  if (path === '/static/app.css') return void res.writeHead(200, { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'public, max-age=31536000, immutable', 'x-content-type-options': 'nosniff' }).end(CSS);
  if (path === '/static/app.js') return void res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'public, max-age=31536000, immutable', 'x-content-type-options': 'nosniff' }).end(JS);
  if (path === '/favicon.ico') return void res.writeHead(204).end();
  if (path.startsWith('/static/fonts/')) {
    const font = FONTS[path.slice('/static/fonts/'.length)];
    if (font) return void res.writeHead(200, { 'content-type': 'font/woff2', 'content-length': font.length, 'cache-control': 'public, max-age=31536000, immutable', 'x-content-type-options': 'nosniff' }).end(font);
  }

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
    if (path === '/') page = board(p);
    else if (path === '/guards') page = guardsPage(p);
    else if (path === '/sessions') page = sessionsPage(p);
    else if ((m = /^\/sessions\/([^/]+)$/.exec(path))) page = sessionPage(p, decodeURIComponent(m[1]!));
    else if (path === '/keys') page = keysPage(p);
    else if ((m = /^\/keys\/(\d+)$/.exec(path))) page = keyPage(p, Number(m[1]));
    else if (path === '/providers') page = providersPage(p);
    else if (path === '/alerts') page = alertsPage(p);
    if (page === null) return sendHtml(res, 404, layout(p, 'Not found', '', html`<h1>Not found</h1><p class="facts">Nothing lives at this address. <a href="/">Back to the board</a>.</p>`));
    return sendHtml(res, 200, page);
  }

  if (req.method !== 'POST') return sendHtml(res, 405, 'Method not allowed');
  const form = new URLSearchParams((await readBody(req, 65_536)).toString('utf8'));
  if (!ctx.auth.verifyPost(req, sid, form)) return sendHtml(res, 403, layout(p, 'Forbidden', '', html`<h1>Request rejected</h1><p class="facts">The form expired or came from another site. Reload the page and try again.</p>`));

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
    if ((m = /^\/sessions\/([^/]+)\/pause$/.exec(path))) {
      const id = decodeURIComponent(m[1]!);
      const s = store.getSession(id);
      if (!s) throw new HttpError(404, 'No such session');
      if (s.status !== 'blocked') store.setSessionStatus(id, 'blocked', 'Paused from the dashboard.');
      return redirect(res, `/sessions/${encodeURIComponent(id)}?m=session_paused`);
    }
    if ((m = /^\/sessions\/([^/]+)\/resume$/.exec(path))) {
      const id = decodeURIComponent(m[1]!);
      if (!store.getSession(id)) throw new HttpError(404, 'No such session');
      store.resumeSession(id, Date.now());
      return redirect(res, `/sessions/${encodeURIComponent(id)}?m=session_resumed`);
    }
    if ((m = /^\/alerts\/(\d+)\/resolve$/.exec(path))) {
      store.resolveAlert(Number(m[1]), Date.now());
      return redirect(res, form.get('next') === '/' ? '/?m=alert_resolved' : '/alerts?m=alert_resolved');
    }
    if (path === '/alerts/resolve-all') {
      store.resolveAllAlerts(Date.now());
      return redirect(res, '/alerts?m=alerts_resolved');
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
      return sendHtml(res, e.status, layout(p, 'Could not save', '', html`<h1>Could not save</h1><div class="banner trip" role="alert"><p class="msg">${e.message}</p></div><p>Go back to fix the form, or <a href="/">return to the board</a>.</p>`));
    }
    throw e;
  }
  return sendHtml(res, 404, layout(p, 'Not found', '', html`<h1>Not found</h1>`));
}
