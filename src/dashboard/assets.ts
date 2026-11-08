// Static assets served from memory. Kept in separate files so the CSP can forbid inline styles and scripts.
// Design tokens and rules are documented in DESIGN.md; they are the landing page's tokens.
import fs from 'node:fs';

// Brand fonts (SIL OFL, see fonts/OFL-*.txt), served by Leash itself so the dashboard makes no outside requests.
export const FONTS: Record<string, Buffer> = Object.fromEntries(
  ['archivo-latin', 'sourceserif4-latin', 'plexmono-400-latin', 'plexmono-500-latin'].map((n) => [`${n}.woff2`, fs.readFileSync(new URL(`./fonts/${n}.woff2`, import.meta.url))]),
);

export const CSS = `
@font-face{font-family:"Archivo";src:url(/static/fonts/archivo-latin.woff2) format("woff2");font-weight:400 900;font-stretch:62% 125%;font-display:swap}
@font-face{font-family:"Source Serif 4";src:url(/static/fonts/sourceserif4-latin.woff2) format("woff2");font-weight:400 600;font-display:swap}
@font-face{font-family:"IBM Plex Mono";src:url(/static/fonts/plexmono-400-latin.woff2) format("woff2");font-weight:400;font-display:swap}
@font-face{font-family:"IBM Plex Mono";src:url(/static/fonts/plexmono-500-latin.woff2) format("woff2");font-weight:500;font-display:swap}
:root{
  --paper:#F1F3F0;--sheet:#FAFBF9;--ink:#14171C;--muted:#5B626C;--rule:#D4D8D2;
  --box:#2E4FE0;--box-soft:rgba(46,79,224,.07);--mark:#B7410E;--mark-soft:rgba(183,65,14,.08);
  --caution:#8A5A00;--caution-soft:rgba(138,90,0,.09);--ok:#2F7D4F;--bars:#A3A9B0;
  --term:#14171C;--term-ink:#D9DDE2;--term-muted:#8A929C;--term-box:#8197FF;--term-mark:#F08A55;
  --display:"Archivo","Arial Narrow",system-ui,sans-serif;
  --body:"Source Serif 4",Georgia,"Times New Roman",serif;
  --mono:"IBM Plex Mono",ui-monospace,"Cascadia Mono",Consolas,monospace;
  color-scheme:light}
@media (prefers-color-scheme:dark){:root{
  --paper:#0F1215;--sheet:#151A1E;--ink:#E6E8EA;--muted:#98A0AA;--rule:#2A3036;
  --box:#8197FF;--box-soft:rgba(129,151,255,.09);--mark:#F08A55;--mark-soft:rgba(240,138,85,.1);
  --caution:#E2B45C;--caution-soft:rgba(226,180,92,.1);--ok:#6CC594;--bars:#59616B;--term:#0A0C0F;color-scheme:dark}}

*{box-sizing:border-box}html{-webkit-text-size-adjust:100%;overflow-x:hidden}
body{margin:0;background:var(--paper);color:var(--ink);font:15.5px/1.5 var(--body);-webkit-font-smoothing:antialiased;font-variant-numeric:tabular-nums}
a{color:inherit;text-decoration-color:var(--box);text-underline-offset:3px;text-decoration-thickness:1px}
a:hover{color:var(--box)}
:focus-visible{outline:2px solid var(--box);outline-offset:3px;border-radius:2px}
h1,h2,h3{margin:0;text-wrap:balance}
p{margin:0}
code,pre,.mono{font-family:var(--mono);font-size:13px;letter-spacing:.01em}
code{background:var(--box-soft);padding:1px 5px;border-radius:2px}
.muted{color:var(--muted)}.nowrap{white-space:nowrap}
.sep{color:var(--muted);padding:0 .4em}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}

/* ---- frame: the landing page's mono crumb bar ---- */
.bar{position:sticky;top:0;z-index:10;background:var(--paper);border-bottom:1px solid var(--rule)}
.bar>div{max-width:1180px;margin:0 auto;padding:0 clamp(16px,3vw,32px);height:54px;display:flex;align-items:center;gap:28px;font-family:var(--mono);font-size:12.5px;color:var(--muted)}
.word{font-family:var(--display);font-stretch:125%;font-weight:850;font-size:22px;letter-spacing:-.03em;color:var(--ink);text-decoration:none}
.word span{color:var(--mark)}.word:hover{color:var(--ink)}
.bar nav{display:flex;gap:20px;align-self:stretch}
.bar nav a{display:flex;align-items:center;white-space:nowrap;text-decoration:none;border-bottom:1.5px solid transparent;margin-bottom:-1px}
.bar nav a[aria-current=page]{color:var(--ink);border-bottom-color:var(--ink)}
.bar nav b{color:var(--mark);font-weight:500;margin-left:5px}
.bar .spacer{flex:1}
.bar form button{font-size:12.5px}
.page{max-width:1180px;margin:0 auto;padding:28px clamp(16px,3vw,32px) 96px}
.back,.crumbs{display:inline-block;font-family:var(--mono);font-size:12.5px;color:var(--muted);text-decoration:none;margin-bottom:16px}
.crumbs a{text-decoration:none}

/* ---- page head and section heads ---- */
.head{display:flex;align-items:flex-end;justify-content:space-between;gap:16px 24px;flex-wrap:wrap;margin-bottom:22px}
.head h1,.page>h1{font-family:var(--display);font-stretch:112%;font-weight:800;font-size:clamp(28px,3.6vw,40px);letter-spacing:-.015em;line-height:1.05;margin:0 0 8px}
.head p{font-size:18px;color:var(--muted);max-width:62ch}
.head p b{color:var(--mark);font-weight:600}
.head p.facts{font-size:15.5px;max-width:none}
section,.sec{margin-top:40px}
.sechead{display:flex;align-items:baseline;justify-content:space-between;gap:6px 16px;flex-wrap:wrap;border-bottom:1.5px solid var(--ink);padding-bottom:9px;margin-bottom:4px}
.sechead h2{font-family:var(--display);font-stretch:112%;font-weight:800;font-size:22px;letter-spacing:-.01em;line-height:1.1}
.sechead .count,.sechead>span,.sechead>a{font-family:var(--mono);font-size:12.5px;color:var(--box);font-weight:400}
.sechead .count{margin-left:10px}
.sechead .hot{color:var(--mark)}
section>p,.prose{max-width:65ch;margin:12px 0}
.find{display:flex;align-items:center;gap:8px;border:1.5px solid var(--ink);border-radius:2px;background:var(--sheet);padding:0 8px 0 12px;height:38px;min-width:300px;font-family:var(--mono);font-size:13px}
.find:focus-within{border-color:var(--box)}
.find input{border:0;background:transparent;color:var(--ink);font:inherit;flex:1;min-width:0;min-height:0;padding:0;outline:none}
kbd{font-family:var(--mono);font-size:12px;color:var(--muted);border:1px solid var(--rule);border-radius:2px;padding:0 5px}

/* ---- state words ---- */
.state{font-family:var(--mono);font-size:12px;display:inline-flex;align-items:center;gap:7px;color:var(--muted);white-space:nowrap}
.state::before{content:"";width:7px;height:7px;border-radius:50%;background:currentColor;flex:none}
.state.trip{color:var(--mark)}.state.caution{color:var(--caution)}.state.ok{color:var(--ok)}
.tag{display:inline-block;font-family:var(--mono);font-size:12px;color:var(--muted);border:1px solid var(--rule);border-radius:2px;padding:0 5px;white-space:nowrap;vertical-align:1px}
.tag.trip{color:var(--mark);border-color:currentColor}.tag.caution{color:var(--caution);border-color:currentColor}.tag.box{color:var(--box);border-color:currentColor}

/* ---- spend ---- */
.spend{padding-top:14px}
.spend-line{display:flex;align-items:baseline;gap:6px 14px;flex-wrap:wrap;margin-bottom:10px;color:var(--muted)}
.spend-line .big{font-family:var(--mono);font-weight:500;font-size:26px;color:var(--ink)}
.spend-line .mono{color:var(--ink)}
.track{display:block;width:100%;height:22px;overflow:visible}
.track .bg{fill:var(--rule)}.track .warn{stroke:var(--mark);stroke-width:1.5;stroke-dasharray:3 2;vector-effect:non-scaling-stroke}
.k0{fill:var(--box);background:var(--box)}.k1{fill:var(--muted);background:var(--muted)}.k2{fill:var(--bars);background:var(--bars)}.kcap{fill:var(--mark);background:var(--mark)}
.axis{display:flex;justify-content:space-between;font-family:var(--mono);font-size:12px;color:var(--muted);margin-top:2px}
.keys{list-style:none;margin:12px 0 0;padding:0;display:flex;flex-wrap:wrap;gap:6px 28px;font-family:var(--mono);font-size:13px}
.keys li{display:flex;align-items:center;gap:8px}.keys a{text-decoration:none}
.keys i{width:12px;height:12px;display:inline-block}
.keys .capped{color:var(--mark)}

/* ---- board ---- */
.cols{display:grid;grid-template-columns:minmax(0,1fr) 290px;gap:0 44px;align-items:start}
/* A paused session is a slip pushed out of line, the way a controller cocks a flight strip that needs attention. */
.slips{display:grid;gap:12px;padding-top:14px}
.slip{background:var(--sheet);border:1px solid var(--mark);transform:translateX(14px);margin-right:14px;display:grid;grid-template-columns:minmax(0,1fr) 168px 96px}
.slip.calm{border-color:var(--rule);transform:none;margin-right:0}
.slip>*{padding:14px 16px;min-width:0}
.slip>*+*{border-left:1px solid var(--rule)}
.slip .foot{grid-column:1/-1;border-left:0;border-top:1px solid var(--rule);display:flex;align-items:center;gap:10px;flex-wrap:wrap;background:var(--mark-soft);padding-block:10px}
.slip.calm .foot{background:none}
.slip .foot p{margin-left:6px;color:var(--muted);font-size:14.5px}
.slip.big{grid-template-columns:minmax(0,1fr) 168px}
.task{font-family:var(--display);font-weight:680;font-size:18px;line-height:1.3;margin:4px 0 2px;overflow-wrap:anywhere}
.task a{text-decoration:none}
.slip.big .task{font-stretch:112%;font-weight:800;font-size:clamp(24px,3vw,32px);letter-spacing:-.01em;line-height:1.1;margin:6px 0 6px}
.meta{font-family:var(--mono);font-size:12.5px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.meta a{text-decoration:none}
.why{margin-top:8px;color:var(--mark);font-size:16px;max-width:65ch;overflow-wrap:anywhere}
.why.caution{color:var(--caution)}
.why a{font-family:var(--mono);font-size:12px;color:var(--muted);margin-left:6px}
.slip.big .why{font-size:18px}
.tape svg{display:block;width:100%;height:34px}
.tape rect,.timeline rect{fill:var(--bars)}.tape rect.fail,.timeline rect.fail{fill:var(--mark)}
.tape small{display:block;font-family:var(--mono);font-size:12px;color:var(--muted);margin-top:6px;white-space:nowrap}
.tape small b{color:var(--mark);font-weight:500}
.fig{text-align:right}
.fig .money{display:block;font-family:var(--mono);font-weight:500;font-size:15px}
.fig .n{display:block;font-size:13px;color:var(--muted)}
.rows{list-style:none;margin:0;padding:0}
.row{display:grid;grid-template-columns:minmax(0,1fr) 168px 96px 86px;gap:0 16px;align-items:center;padding:14px 0;border-bottom:1px solid var(--rule)}
.row .task{font-size:16.5px}
.row .last{font-family:var(--mono);font-size:12.5px;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.row .last span{color:var(--muted)}
.row.done{padding:10px 0}
.row.done .task{font-weight:600;font-size:15.5px;color:var(--muted)}
.row .acts{display:flex;justify-content:flex-end}
.more-link{display:inline-block;margin-top:12px;font-family:var(--mono);font-size:12.5px}
.flags{list-style:none;margin:0;padding:0}
.flags li{padding:14px 0;border-bottom:1px solid var(--rule)}
.flags .when{font-family:var(--mono);font-size:12px;color:var(--muted)}
.flags h3{font-family:var(--display);font-weight:680;font-size:16px;margin:2px 0 4px}
.flags p{margin:0 0 6px;font-size:14.5px;color:var(--muted);overflow-wrap:anywhere}
.flags .acts{display:flex;gap:14px;align-items:center;font-family:var(--mono);font-size:12.5px}
.side-note{font-size:14px;color:var(--muted);margin-top:12px}

/* ---- session ---- */
.timeline{padding-top:18px}
.timeline svg{display:block;width:100%;height:88px}
.t-axis{display:flex;justify-content:space-between;font-family:var(--mono);font-size:12px;color:var(--muted);margin-top:6px}
.legend{font-size:14px;color:var(--muted);margin-top:10px}
.legend i{display:inline-block;width:10px;height:10px;margin:0 6px 0 14px;vertical-align:-1px;background:var(--bars)}
.legend i:first-child{margin-left:0}.legend i.fail{background:var(--mark)}
/* Replay: the landing page's gateway terminal */
.term{margin-top:14px;background:var(--term);color:var(--term-ink);border-radius:4px;overflow:hidden;font-family:var(--mono);font-size:13px;line-height:1.5}
.term-head{display:flex;justify-content:space-between;gap:12px;padding:10px 16px;border-bottom:1px solid rgba(255,255,255,.08);color:var(--term-muted);font-size:12px}
.term-head b{color:var(--term-ink);font-weight:500}
.term ol{list-style:none;margin:0;padding:8px 0 10px}
.term li{display:grid;grid-template-columns:5.6em 6em minmax(0,1fr) minmax(0,auto);gap:0 14px;padding:4px 16px}
.term .t{color:var(--term-muted)}
.term .tool{color:var(--term-box);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.term .call{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.term .call strong{font-weight:500;color:#fff}
.term .res{color:var(--term-muted);text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:36ch}
.term .res.err{color:var(--term-mark)}
.term .x{color:var(--term-mark);font-weight:500;margin-left:8px}
.term li.loop{background:rgba(240,138,85,.14)}
.term .none{padding:14px 16px;color:var(--term-muted)}
.usage{list-style:none;padding:0;margin:0;display:grid;grid-template-columns:repeat(4,minmax(0,1fr))}
.usage li{padding:16px 20px 16px 0}
.usage li+li{padding-left:20px;border-left:1px solid var(--rule)}
.usage .v{display:block;font-family:var(--mono);font-size:16px;font-weight:500}
.usage .l{display:block;margin-top:2px;color:var(--muted);font-size:14px}

/* ---- ruled lists (alerts, session alerts) ---- */
.ledger{list-style:none;margin:0;padding:0}
.ledger>li{display:grid;grid-template-columns:96px minmax(0,1fr) auto;gap:4px 16px;align-items:start;padding:14px 0;border-bottom:1px solid var(--rule)}
.ledger>li>.state{padding-top:3px}
.ledger .title{font-family:var(--display);font-weight:680;font-size:16.5px;text-decoration:none}
.ledger .detail{margin-top:2px;overflow-wrap:anywhere;max-width:62ch}
.ledger .meta{margin-top:4px;white-space:normal}
.ledger .acts{display:flex;gap:8px;align-items:center}
.ledger li.done{color:var(--muted)}.ledger li.done .title{font-weight:600}

/* ---- guard rules ---- */
.rules{list-style:none;margin:0;padding:0}
.rules li{display:grid;grid-template-columns:240px minmax(0,1fr);gap:4px 28px;padding:18px 0;border-bottom:1px solid var(--rule);scroll-margin-top:70px}
.rules li:target{background:var(--box-soft)}
.rules h2{font-family:var(--display);font-weight:720;font-size:18px;line-height:1.3}
.rules h2 code{display:block;margin-top:4px;background:none;padding:0;color:var(--muted);font-size:12px;font-weight:400}
.rules p{max-width:65ch}.rules p+p{margin-top:6px;color:var(--muted)}

/* ---- meters ---- */
.meter{display:grid;gap:4px;min-width:150px}
.meter svg{width:100%;height:8px;display:block}
.meter .track{fill:var(--rule)}.meter .fill{fill:var(--box)}
.meter.caution .fill{fill:var(--caution)}.meter.trip .fill{fill:var(--mark)}
.meter .notch{stroke:var(--mark);stroke-width:1.2;stroke-dasharray:2 1.5;vector-effect:non-scaling-stroke}
.meter .val{font-family:var(--mono);font-size:13px}.meter .of{color:var(--muted)}
.meters{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:20px 44px;padding-top:16px}

/* ---- banners ---- */
.banner{display:flex;align-items:center;justify-content:space-between;gap:12px 20px;flex-wrap:wrap;border:1px solid var(--rule);background:var(--sheet);padding:12px 16px;margin:0 0 20px}
.banner .msg{max-width:72ch}
.banner.ok{border-color:var(--ok)}.banner.ok .msg{color:var(--ok)}
.banner.trip{border-color:var(--mark);background:var(--mark-soft)}.banner.trip strong{color:var(--mark)}
.banner.caution{border-color:var(--caution);background:var(--caution-soft)}

/* ---- buttons: the landing page's .btn, dashboard sized ---- */
button,.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;font-family:var(--mono);font-size:13px;line-height:1.4;text-decoration:none;white-space:nowrap;
  padding:6px 13px;border:1.5px solid var(--ink);border-radius:2px;background:none;color:var(--ink);cursor:pointer}
button:hover,.btn:hover{border-color:var(--box);color:var(--box)}
button:active,.btn:active{transform:translateY(1px)}
.primary{background:var(--ink);color:var(--sheet)}
.primary:hover{background:var(--box);border-color:var(--box);color:#fff}
.danger{border-color:var(--mark);color:var(--mark)}
.danger:hover{background:var(--mark);border-color:var(--mark);color:var(--sheet)}
.quiet{border-color:transparent;color:var(--muted);padding-inline:6px}
.quiet:hover{border-color:transparent;color:var(--box)}
.link{border:0;padding:0;font-size:12.5px;color:inherit;text-decoration:underline;text-decoration-color:var(--box);text-underline-offset:3px}
.link:hover{color:var(--box)}
.sm{padding:3px 10px;font-size:12.5px}
form.inline{display:inline}

/* ---- tables ---- */
.scroll{overflow-x:auto;margin-top:8px}
table{width:100%;border-collapse:collapse}
th{font-family:var(--mono);font-size:12px;font-weight:400;color:var(--muted);text-align:left;padding:10px 12px 8px 0;border-bottom:1px solid var(--ink);white-space:nowrap}
td{padding:12px 12px 12px 0;border-bottom:1px solid var(--rule);vertical-align:top}
td>a{text-decoration:none;font-family:var(--display);font-weight:650}
.num{text-align:right}td.num{font-family:var(--mono);font-size:13px}
td .tag{margin:2px 4px 0 0}

/* ---- forms ---- */
.form{display:grid;gap:16px;max-width:760px;padding:20px 0 4px}
.form .row{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px}
.field{display:grid;gap:5px}
.field>span:first-child{font-family:var(--display);font-weight:650;font-size:14.5px}
.hint{font-size:14px;color:var(--muted)}
input,select{font:15px var(--body);color:var(--ink);background:var(--sheet);border:1.5px solid var(--rule);border-radius:2px;padding:7px 10px;min-height:38px;width:100%}
input:focus,select:focus{outline:none;border-color:var(--box)}
input::placeholder{color:var(--muted);opacity:.8}
.check{display:flex;gap:10px;align-items:center}.check input{width:auto;min-height:0}
.actions{display:flex;gap:10px;flex-wrap:wrap}
.inline-form{display:flex;align-items:flex-end;gap:12px;flex-wrap:wrap;margin-top:12px}.inline-form .field{min-width:220px}
details.disclose{margin:0 0 8px}
details.disclose>summary{list-style:none;display:inline-flex}
details.disclose>summary::-webkit-details-marker,details.more>summary::-webkit-details-marker{display:none}
details.disclose[open]>summary{background:none;color:var(--ink);border-color:var(--ink)}
details.more{margin-top:16px}
details.more>summary{list-style:none;cursor:pointer;font-family:var(--mono);font-size:13px;color:var(--box);display:inline-flex;gap:8px}
details.more>summary::before{content:"+"}details.more[open]>summary::before{content:"−"}
.danger-zone{display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap;border:1px solid var(--mark);padding:16px 18px}
.danger-zone h2{font-family:var(--display);font-weight:720;font-size:18px;margin-bottom:4px}
.snippet{position:relative;background:var(--term);color:var(--term-ink);border-radius:4px;margin:10px 0}
.snippet pre{margin:0;padding:14px 90px 14px 16px;overflow-x:auto;line-height:1.6}
.snippet .copy{position:absolute;top:10px;right:10px;color:var(--term-ink);border-color:rgba(255,255,255,.25);background:none}
.snippet .copy:hover{border-color:var(--term-box);color:var(--term-box)}
.snippet.secret pre{font-size:16px;padding-block:18px}
.empty{border:1px dashed var(--rule);padding:18px 20px;color:var(--muted);margin-top:14px;max-width:none}
.empty strong{color:var(--ink)}
.filters{display:flex;gap:20px;flex-wrap:wrap;border-bottom:1px solid var(--rule);margin:4px 0 0;font-family:var(--mono);font-size:13px}
.filters a{text-decoration:none;color:var(--muted);padding:8px 0;border-bottom:1.5px solid transparent;margin-bottom:-1px}
.filters a[aria-current]{color:var(--ink);border-bottom-color:var(--ink)}
abbr{text-decoration:none;cursor:help}

/* ---- sign in ---- */
.signin{max-width:440px;margin:12vh auto 0;padding:32px;background:var(--sheet);border:1px solid var(--rule)}
.signin .word{display:inline-block;font-size:30px;margin-bottom:18px}
.signin h1{font-family:var(--display);font-stretch:112%;font-weight:800;font-size:26px;margin-bottom:6px}
.signin p{color:var(--muted);margin-bottom:16px}
.signin .form{padding-top:4px}

@media (max-width:900px){
  .bar>div{gap:18px}.bar nav{gap:16px;overflow-x:auto}.bar .signout{display:none}
  .find{min-width:0;width:100%}
  .cols{grid-template-columns:minmax(0,1fr)}
  .slip,.slip.big{grid-template-columns:minmax(0,1fr) auto;transform:translateX(8px);margin-right:8px}
  .slip.calm{transform:none;margin-right:0}
  .slip>:first-child{grid-column:1/-1}
  .slip>*+*{border-left:0;border-top:1px solid var(--rule)}
  .slip>.fig{border-left:1px solid var(--rule)}
  .row,.row.done{grid-template-columns:minmax(0,1fr) auto;gap:8px 16px}
  .row>:first-child,.row .acts{grid-column:1/-1}.row .acts{justify-content:flex-start}
  .row.done .tape{display:none}
  .usage{grid-template-columns:repeat(2,minmax(0,1fr))}.usage li:nth-child(3){padding-left:0;border-left:0}
  .term li{grid-template-columns:5.6em minmax(0,1fr)}
  .term .tool,.term .call,.term .res{grid-column:2}.term .call{white-space:normal;overflow-wrap:anywhere}.term .res{text-align:left;max-width:none}
  .ledger>li{grid-template-columns:minmax(0,1fr)}
  .rules li{grid-template-columns:minmax(0,1fr)}
  th,td{padding-right:10px}
}
@media (prefers-reduced-motion:no-preference){button,.btn,a{transition:background-color 150ms,border-color 150ms,color 150ms}}
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
// "/" jumps to session search, unless the person is already typing somewhere.
document.addEventListener('keydown', function (e) {
  if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
  var t = e.target, tag = t && t.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (t && t.isContentEditable)) return;
  var f = document.getElementById('find');
  if (f) { e.preventDefault(); f.focus(); }
});
`;
