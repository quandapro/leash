// Static assets served from memory. Kept in separate files so the CSP can forbid inline styles and scripts.

export const CSS = `
:root{--bg:#f7f7f5;--panel:#fff;--ink:#1b1d1f;--muted:#62676d;--line:#e2e3e0;--accent:#2f6fde;--accent-ink:#fff;
--good:#1f8a4c;--warn:#b26b00;--bad:#c4372f;--chip:#eef0f2;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
@media (prefers-color-scheme:dark){:root{--bg:#121416;--panel:#1a1d20;--ink:#e8eaec;--muted:#9aa1a8;--line:#2b3035;--accent:#6b9bff;
--accent-ink:#0b1020;--good:#4cc283;--warn:#e0a03a;--bad:#f0766d;--chip:#24292e}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
header.top{display:flex;align-items:center;gap:24px;padding:12px 24px;border-bottom:1px solid var(--line);background:var(--panel);flex-wrap:wrap}
.brand{font-weight:700;font-size:16px;color:var(--ink);display:flex;align-items:center;gap:8px}
.brand svg{width:20px;height:20px}
nav{display:flex;gap:4px;flex-wrap:wrap}nav a{padding:6px 10px;border-radius:6px;color:var(--muted)}
nav a.on,nav a:hover{background:var(--chip);color:var(--ink);text-decoration:none}
.spacer{flex:1}
main{max-width:1120px;margin:0 auto;padding:24px 16px 64px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:28px 0 10px}
.lead{color:var(--muted);margin:0 0 20px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:16px}
.stat .label{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.04em}
.stat .value{font-size:26px;font-weight:650;margin-top:4px;font-variant-numeric:tabular-nums}
.stat .sub{color:var(--muted);font-size:12px}
table{width:100%;border-collapse:collapse;background:var(--panel);border:1px solid var(--line);border-radius:10px;overflow:hidden}
th,td{text-align:left;padding:9px 12px;border-bottom:1px solid var(--line);vertical-align:top}
th{font-size:12px;color:var(--muted);font-weight:600;background:var(--bg)}
tr:last-child td{border-bottom:0}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
.scroll{overflow-x:auto;border-radius:10px}
.mono,code,pre{font-family:var(--mono);font-size:12.5px}
pre{background:var(--chip);padding:12px;border-radius:8px;overflow-x:auto;margin:6px 0 12px;white-space:pre-wrap;word-break:break-all}
.chip{display:inline-block;padding:1px 8px;border-radius:999px;font-size:12px;background:var(--chip);color:var(--muted);white-space:nowrap}
.chip.good{color:var(--good)}.chip.warn{color:var(--warn)}.chip.bad{color:var(--bad)}
.muted{color:var(--muted)}
form.inline{display:inline}
form.stack{display:grid;gap:12px;max-width:560px}
.row{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px}
label{display:grid;gap:4px;font-size:13px;color:var(--muted)}
input,select{font:inherit;padding:8px 10px;border:1px solid var(--line);border-radius:6px;background:var(--panel);color:var(--ink);width:100%}
input:focus,select:focus{outline:2px solid var(--accent);outline-offset:-1px}
button,.btn{font:inherit;padding:8px 14px;border-radius:6px;border:1px solid var(--accent);background:var(--accent);color:var(--accent-ink);cursor:pointer;font-weight:600}
button.ghost{background:transparent;color:var(--accent)}button.danger{background:transparent;border-color:var(--bad);color:var(--bad)}
button.small{padding:3px 10px;font-size:12px}
.notice{border-left:3px solid var(--accent);background:var(--panel);padding:12px 16px;border-radius:6px;margin:0 0 16px}
.notice.warn{border-color:var(--warn)}.notice.bad{border-color:var(--bad)}.notice.good{border-color:var(--good)}
.bars{width:100%;height:120px;display:block}.bars rect{fill:var(--accent)}.bars text{fill:var(--muted);font-size:10px}
.login{max-width:380px;margin:12vh auto;padding:0 16px}
.copy{float:right;margin:-2px 0 0 8px}
.timeline td:first-child{white-space:nowrap}
.flash{margin-bottom:16px}
@media (max-width:640px){header.top{padding:10px 16px;gap:10px}main{padding:16px 16px 48px}th,td{padding:8px}}
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
