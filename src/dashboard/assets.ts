// Static assets served from memory. Kept in separate files so the CSP can forbid inline styles and scripts.
// Design tokens and rules are documented in DESIGN.md.
import fs from 'node:fs';

// Brand fonts (SIL OFL, see fonts/OFL-*.txt), served by Leash itself so the dashboard makes no outside requests.
export const FONTS: Record<string, Buffer> = Object.fromEntries(
  ['archivo-latin', 'plexmono-400-latin', 'plexmono-600-latin'].map((n) => [`${n}.woff2`, fs.readFileSync(new URL(`./fonts/${n}.woff2`, import.meta.url))]),
);

export const CSS = `
@font-face{font-family:"Archivo";src:url(/static/fonts/archivo-latin.woff2) format("woff2");font-weight:400 700;font-display:swap}
@font-face{font-family:"IBM Plex Mono";src:url(/static/fonts/plexmono-400-latin.woff2) format("woff2");font-weight:400;font-display:swap}
@font-face{font-family:"IBM Plex Mono";src:url(/static/fonts/plexmono-600-latin.woff2) format("woff2");font-weight:600;font-display:swap}
:root{
  --ground:oklch(0.975 0.004 265);--surface:oklch(1 0 0);--sunk:oklch(0.955 0.006 265);
  --ink:oklch(0.23 0.018 265);--muted:oklch(0.46 0.016 265);--faint:oklch(0.62 0.012 265);
  --rule:oklch(0.9 0.007 265);--rule-strong:oklch(0.82 0.01 265);
  --accent:oklch(0.5 0.2 268);--accent-hover:oklch(0.44 0.2 268);--on-accent:oklch(0.99 0 0);--accent-tint:oklch(0.95 0.03 268);
  --trip:oklch(0.5 0.15 42);--trip-tint:oklch(0.96 0.025 45);--trip-line:oklch(0.82 0.07 45);
  --caution:oklch(0.5 0.11 75);--caution-tint:oklch(0.965 0.035 85);--caution-line:oklch(0.83 0.08 80);
  --ok:oklch(0.5 0.1 155);--ok-tint:oklch(0.96 0.03 155);
  --sans:"Archivo",system-ui,-apple-system,"Segoe UI",sans-serif;
  --mono:"IBM Plex Mono",ui-monospace,"Cascadia Mono",Menlo,Consolas,monospace;
  --r:6px;color-scheme:light}
@media (prefers-color-scheme:dark){:root{
  --ground:oklch(0.18 0.012 265);--surface:oklch(0.215 0.014 265);--sunk:oklch(0.16 0.012 265);
  --ink:oklch(0.93 0.008 265);--muted:oklch(0.72 0.014 265);--faint:oklch(0.58 0.014 265);
  --rule:oklch(0.3 0.014 265);--rule-strong:oklch(0.38 0.016 265);
  --accent:oklch(0.72 0.14 268);--accent-hover:oklch(0.78 0.12 268);--on-accent:oklch(0.18 0.03 268);--accent-tint:oklch(0.28 0.05 268);
  --trip:oklch(0.74 0.13 45);--trip-tint:oklch(0.27 0.045 40);--trip-line:oklch(0.45 0.09 42);
  --caution:oklch(0.8 0.11 80);--caution-tint:oklch(0.27 0.04 80);--caution-line:oklch(0.46 0.08 80);
  --ok:oklch(0.75 0.11 155);--ok-tint:oklch(0.26 0.04 155);color-scheme:dark}}

*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--ground);color:var(--ink);font:14px/1.5 var(--sans);font-variant-numeric:tabular-nums}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline;text-underline-offset:2px}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:3px}
h1,h2,h3{text-wrap:balance;margin:0}
h1{font-size:24px;line-height:1.25;font-weight:650;letter-spacing:-0.01em}
h2{font-size:17px;font-weight:650}
p{margin:0}
code,pre,.mono{font-family:var(--mono);font-size:13px}
code{background:var(--sunk);padding:1px 5px;border-radius:4px}
.muted{color:var(--muted)}.nowrap{white-space:nowrap}
.sep{color:var(--faint);padding:0 .45em}

/* ---- frame ---- */
.bar{display:flex;align-items:center;gap:20px;padding:0 24px;height:52px;border-bottom:1px solid var(--rule);background:var(--surface);position:sticky;top:0;z-index:10}
.brand{display:flex;align-items:center;gap:8px;font-weight:700;font-size:17px;color:var(--ink)}
.brand:hover{text-decoration:none}.brand svg{width:18px;height:18px;color:var(--accent)}
.bar nav{display:flex;gap:2px;height:100%}
.bar nav a{display:flex;align-items:center;padding:0 10px;color:var(--muted);border-bottom:2px solid transparent;margin-bottom:-1px}
.bar nav a:hover{color:var(--ink);text-decoration:none}
.bar nav a[aria-current=page]{color:var(--ink);border-bottom-color:var(--ink);font-weight:550}
.bar .spacer{flex:1}
.page{max-width:1080px;margin:0 auto;padding:32px 24px 80px}
.page>section{margin-top:40px}
.page>section>p{max-width:65ch}
.head{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:12px}
.head p{color:var(--muted);margin-top:4px;max-width:65ch}.head p.facts{max-width:none}
.facts .sep+*,.facts>span{white-space:nowrap}
.sechead{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:10px}
.sechead .count{color:var(--faint);font-weight:400;margin-left:6px}
.back{display:inline-block;margin-bottom:12px;color:var(--muted)}
.facts{color:var(--muted);margin-top:6px}

/* ---- overview status ---- */
.status{display:flex;gap:14px;align-items:flex-start}
.status .glyph{flex:none;width:12px;height:12px;border-radius:50%;margin-top:.55em;background:var(--ok)}
.status.trip .glyph{background:var(--trip);box-shadow:0 0 0 4px var(--trip-tint)}
.status h1{font-size:30px;font-weight:600;letter-spacing:-0.015em}
.status .facts{margin-top:8px}
.spend{display:flex;align-items:flex-end;gap:10px;margin-top:20px}
.spark{width:168px;height:32px;display:block}.spark rect{fill:var(--rule-strong)}.spark rect.today{fill:var(--accent)}
.spark-label{font-size:12px;color:var(--faint)}

/* ---- ledger: rows that read as sentences, stack on phones ---- */
.ledger{list-style:none;margin:0;padding:0;border-top:1px solid var(--rule)}
.ledger>li{display:grid;grid-template-columns:96px minmax(0,1fr) auto;gap:4px 16px;align-items:start;padding:12px 0;border-bottom:1px solid var(--rule)}
.ledger .what{min-width:0}
.ledger .title{font-weight:550;color:var(--ink);overflow-wrap:anywhere}
a.title:hover{color:var(--accent)}
.ledger .detail{color:var(--ink);margin-top:2px;overflow-wrap:anywhere;max-width:65ch}
.ledger .detail::first-letter,.banner .msg::first-letter{text-transform:uppercase}
.ledger .meta{color:var(--muted);font-size:12px;margin-top:2px}
.ledger .acts{display:flex;gap:8px;align-items:center;justify-content:flex-end;flex-wrap:wrap}
.ledger>li.done{color:var(--muted)}.ledger>li.done .title,.ledger>li.done .detail{color:var(--muted);font-weight:400}
.empty{padding:20px 0;color:var(--muted);border-top:1px solid var(--rule);border-bottom:1px solid var(--rule)}
.empty strong{color:var(--ink);font-weight:550}

/* ---- state words: colour plus text, never colour alone ---- */
.state{display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:550;white-space:nowrap;color:var(--muted)}
.state::before{content:"";width:7px;height:7px;border-radius:50%;background:currentColor;flex:none}
.state.trip{color:var(--trip)}.state.caution{color:var(--caution)}.state.ok{color:var(--ok)}.state.idle{color:var(--faint)}
.tag{display:inline-block;font-size:12px;padding:0 6px;border-radius:4px;background:var(--sunk);color:var(--muted);white-space:nowrap;line-height:20px}
.tag.trip{background:var(--trip-tint);color:var(--trip)}.tag.caution{background:var(--caution-tint);color:var(--caution)}

/* ---- banners (full border, tinted) ---- */
.banner{border:1px solid var(--rule-strong);background:var(--surface);border-radius:var(--r);padding:14px 16px;display:flex;gap:16px;align-items:center;justify-content:space-between;flex-wrap:wrap;margin:16px 0}
.banner .msg{flex:1 1 320px;max-width:65ch}.banner .msg p+p{margin-top:4px}
.banner.trip{border-color:var(--trip-line);background:var(--trip-tint)}
.banner.caution{border-color:var(--caution-line);background:var(--caution-tint)}
.banner.ok{border-color:var(--rule-strong);background:var(--ok-tint)}
.banner strong{font-weight:650}

/* ---- meters: spend against a cap, with the 80% warning notch ---- */
.meter{display:grid;grid-template-columns:minmax(80px,180px) auto;gap:10px;align-items:center}
.meter svg{width:100%;height:8px;display:block;border-radius:4px;overflow:hidden}
.meter .track{fill:var(--sunk)}.meter .fill{fill:var(--accent)}.meter .notch{stroke:var(--faint);stroke-width:1;stroke-dasharray:2 2}
.meter.caution .fill{fill:var(--caution)}.meter.trip .fill{fill:var(--trip)}
.meter .val{font-size:12px;white-space:nowrap}.meter .val .of{color:var(--muted)}
.meters{display:grid;gap:10px}

/* ---- tables ---- */
.scroll{overflow-x:auto}
table{width:100%;border-collapse:collapse}
th,td{text-align:left;padding:9px 12px 9px 0;border-bottom:1px solid var(--rule);vertical-align:top}
th{font-size:12px;color:var(--muted);font-weight:550;border-bottom-color:var(--rule-strong);white-space:nowrap}
td.num,th.num{text-align:right}
td:last-child,th:last-child{padding-right:0}

/* ---- replay ---- */
.replay{list-style:none;margin:0;padding:0;border-top:1px solid var(--rule)}
.replay>li{display:grid;grid-template-columns:64px 72px minmax(0,1fr) 56px;gap:2px 14px;padding:10px 0;border-bottom:1px solid var(--rule);align-items:baseline}
.replay .t{color:var(--faint);font-size:12px}
.replay .tool{font-family:var(--mono);font-size:13px;font-weight:600}
.replay .call{font-family:var(--mono);font-size:13px;overflow-wrap:anywhere}
.replay .res{grid-column:3;font-family:var(--mono);font-size:13px;color:var(--muted);overflow-wrap:anywhere}
.replay .res.err{color:var(--trip)}
.replay .res::before{content:"\\2192\\00a0"}.replay .res.err::before{content:"\\2717\\00a0"}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
.replay .n{grid-row:1;grid-column:4;text-align:right;font-weight:650;color:var(--muted)}
.replay>li.loop{background:var(--trip-tint);box-shadow:-8px 0 0 var(--trip-tint),8px 0 0 var(--trip-tint)}
.replay>li.loop .n{color:var(--trip)}

/* ---- buttons ---- */
.btn,button{font:inherit;font-weight:550;display:inline-flex;align-items:center;gap:6px;height:32px;padding:0 12px;border-radius:var(--r);border:1px solid var(--rule-strong);background:var(--surface);color:var(--ink);cursor:pointer;white-space:nowrap;transition:background-color .15s,border-color .15s}
.btn:hover,button:hover{background:var(--sunk);text-decoration:none}
.btn:active,button:active{transform:translateY(1px)}
.btn.primary,button.primary{background:var(--accent);border-color:var(--accent);color:var(--on-accent)}
.btn.primary:hover,button.primary:hover{background:var(--accent-hover);border-color:var(--accent-hover)}
.btn.quiet,button.quiet{border-color:transparent;background:transparent;color:var(--muted)}
.btn.quiet:hover,button.quiet:hover{color:var(--ink);background:var(--sunk)}
.btn.danger,button.danger{color:var(--trip);border-color:var(--trip-line)}
.btn.danger:hover,button.danger:hover{background:var(--trip-tint)}
.btn.sm,button.sm{height:28px;padding:0 10px;font-size:12px}
form.inline{display:inline}

/* ---- disclosure: forms stay closed until asked for ---- */
details.disclose>summary{list-style:none;display:inline-flex}
details.disclose>summary::-webkit-details-marker{display:none}
details.disclose[open]>summary{margin-bottom:16px}
details.more>summary{cursor:pointer;color:var(--muted);font-weight:550;padding:6px 0}
details.more>summary:hover{color:var(--ink)}
details.more[open]>summary{margin-bottom:8px}

/* ---- forms ---- */
.form{display:grid;gap:16px;max-width:640px;background:var(--surface);border:1px solid var(--rule);border-radius:var(--r);padding:20px}
.form.plain{background:none;border:0;padding:0}
.form .row{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:16px}
.field{display:grid;gap:6px;align-content:start}
.field>span{font-weight:600}
.field .hint{color:var(--muted);font-size:12px}
.check{display:flex;gap:8px;align-items:center;font-size:12px}
.check input{width:16px;height:16px;margin:0;accent-color:var(--accent)}
input,select{font:inherit;height:34px;padding:0 10px;border:1px solid var(--rule-strong);border-radius:var(--r);background:var(--surface);color:var(--ink);width:100%}
input::placeholder{color:var(--faint)}
input:hover,select:hover{border-color:var(--faint)}
input:focus-visible,select:focus-visible{outline:2px solid var(--accent);outline-offset:0;border-color:var(--accent)}
.actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.inline-form{display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap;margin-top:12px}
.inline-form .field{width:200px}
.danger-zone{border:1px solid var(--trip-line);border-radius:var(--r);padding:16px;display:flex;gap:16px;align-items:center;justify-content:space-between;flex-wrap:wrap}

/* ---- code snippets ---- */
.snippet{position:relative;margin:8px 0 12px}
.snippet pre{margin:0;background:var(--sunk);border:1px solid var(--rule);border-radius:var(--r);padding:12px 84px 12px 14px;overflow-x:auto;white-space:pre-wrap;word-break:break-all;line-height:1.6}
.snippet .copy{position:absolute;top:8px;right:8px}
.snippet.secret pre{font-size:14px;font-weight:600}

/* ---- filters ---- */
.filters{display:flex;gap:4px;flex-wrap:wrap;margin-bottom:12px}
.filters a{padding:4px 10px;border-radius:999px;color:var(--muted);border:1px solid transparent}
.filters a:hover{color:var(--ink);text-decoration:none;border-color:var(--rule-strong)}
.filters a[aria-current=true]{color:var(--ink);background:var(--surface);border-color:var(--rule-strong);font-weight:550}

/* ---- sign in ---- */
.signin{max-width:360px;margin:0 auto;padding:18vh 24px 48px}
.signin .brand{font-size:24px;margin-bottom:24px}.signin .brand svg{width:22px;height:22px}
.signin p{color:var(--muted);margin-bottom:20px}
.signin .banner{margin:0 0 16px}

/* ---- small screens ---- */
@media (max-width:720px){
  .bar{padding:0 16px;gap:12px;height:auto;min-height:52px;flex-wrap:wrap}
  .bar nav{order:3;width:100%;overflow-x:auto;scrollbar-width:none;height:44px;margin:0 -16px;padding:0 6px;border-top:1px solid var(--rule)}
  .page{padding:24px 16px 64px}
  .status h1{font-size:24px}
  .ledger>li{grid-template-columns:minmax(0,1fr) auto}
  .ledger>li>.state{grid-column:1/-1}
  .ledger .acts{grid-column:1/-1;justify-content:flex-start}
  .replay>li{grid-template-columns:auto minmax(0,1fr) auto}
  .replay .t{grid-column:1/-1}
  .replay .tool{grid-column:1}.replay .call{grid-column:2}.replay .n{grid-row:2;grid-column:3}
  .replay .res{grid-column:1/-1}
  .meter{grid-template-columns:1fr}
  .form{padding:16px}
}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}
`;

export const JS = `
document.addEventListener('click', function (e) {
  var b = e.target.closest('[data-copy]');
  if (!b) return;
  var el = document.getElementById(b.getAttribute('data-copy'));
  if (el && navigator.clipboard) navigator.clipboard.writeText(el.textContent.trim()).then(function () {
    var t = b.textContent; b.textContent = 'Copied'; setTimeout(function () { b.textContent = t; }, 1200);
  });
});
document.addEventListener('submit', function (e) {
  var msg = e.target.getAttribute('data-confirm');
  if (msg && !window.confirm(msg)) e.preventDefault();
});
`;

export const LOGO = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6" cy="18" r="3"/><path d="M8.5 16.5 18 7"/><path d="M15 4h5v5"/></svg>`;
