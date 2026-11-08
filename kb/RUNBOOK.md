# Runbook

All commands from the repo root (`D:\workspace\Quandapro\leash`). Node 22.18+ locally (22.20 installed),
Node 26 in Docker. Bash tool: Git Bash; paths like `/d/workspace/Quandapro/leash`.

| Task | Command |
| --- | --- |
| Install dev deps | `npm install` |
| Typecheck + unit + in-process e2e | `npm run check` |
| Docker e2e (prod image, 2 vCPU / 4 GB, scenario + latency) | `npm run e2e` |
| Run locally | `LEASH_ADMIN_TOKEN=... LEASH_SECRET=... npm start` (data in `./data`) |
| Browse a populated dashboard | `docker compose -f e2e/compose.yml up -d --build --wait mock leash`, run the scenario via the runner (see below), open http://localhost:18080, token `e2e-admin-token-0123456789abcdef`; stop with `docker compose -f e2e/compose.yml --profile run down -v` |
| Populate demo data | `docker compose -f e2e/compose.yml --profile run run --rm runner node --disable-warning=ExperimentalWarning -e "import('/repo/e2e/scenario.ts').then(m=>m.scenario({leash:'http://leash:8080',admin:'e2e-admin-token-0123456789abcdef',mock:'http://mock:9090',mockFromLeash:'http://mock:9090'}))"` |
| Production | `cp .env.example .env`, fill in, `docker compose up -d` |
| Live test with a real provider | See "Live tests" below |

## Live tests

Real-provider check of the whole chain, used 2026-11-07 for Claude Code on OpenRouter DeepSeek:

1. `LIVE_UPSTREAM=https://openrouter.ai/api LIVE_OUT=<dir>/upstream.jsonl node e2e/live/recorder.ts` (port 9797,
   logs every upstream exchange with keys masked).
2. Start Leash with `LEASH_ANTHROPIC_KEY=<provider key> LEASH_ANTHROPIC_BASE_URL=http://127.0.0.1:9797
   LEASH_ALLOW_HTTP_UPSTREAM=1 LEASH_DATA_DIR=<dir>/data`, sign in, set a price, create a key.
3. Run the agent headless with a clean environment (`env -i` plus system basics) so the host's Claude Code
   session variables don't leak in: `ANTHROPIC_BASE_URL=http://127.0.0.1:8787/anthropic ANTHROPIC_API_KEY=lsh_…
   ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL=<model> CLAUDE_CONFIG_DIR=<dir>/cc claude -p "…" --model <model>
   --output-format stream-json --verbose --debug-file <dir>/claude-debug.txt > <dir>/claude-run1.out`. On this
   machine the CLI is `%APPDATA%/Claude/claude-code/<version>/<hash>/claude.exe`. Plant a fake secret in a file
   the task reads to exercise redaction.
4. `node e2e/live/report.ts <dir> <dir>/data/leash.db` cross-checks agent, provider and Leash: tokens, cost,
   cache hit rate, overhead, secret leaks, session label. Exit code 1 on any problem.

Keep traces out of git (they hold full prompts): use `e2e/.tmp/` or the scratchpad.

## Layout

- `src/main.ts` server + routing; `src/config.ts` env; `src/db.ts` SQLite (migrations in `MIGRATIONS`, append only);
  `src/crypto.ts`; `src/http.ts`; `src/alerts.ts`.
- `src/proxy/handler.ts` the request pipeline (auth → redaction → session/loop → velocity → budget → forward → meter);
  `src/proxy/usage.ts` SSE parser and usage extraction.
- `src/guard/` loop rules, redaction, pricing, budgets.
- `src/dashboard/` routes (pages + form handlers), auth, escaping templates, CSS/JS assets.
- `e2e/` mock provider, shared scenario, Docker runner. `test/` unit tests + in-process scenario.
- `scripts/kb/` hooks. `.githooks/pre-commit` → `scripts/kb/pre-commit.mjs` (enabled via `git config core.hooksPath .githooks`).

## Conventions

- Fake secrets in tests are built by string concatenation (`e2e/scenario.ts` `FAKE`) so the pre-commit secret
  scan and GitHub push protection never see a secret-shaped literal.
- New guard behaviour gets a step in `e2e/scenario.ts` so both test paths cover it.
- Before adding or upgrading a dependency: check advisories (GitHub/NVD), prefer a release older than ~7 days
  unless it is a security fix, and record the decision in `kb/DECISIONS.md`.

## Design checks (impeccable)

The dashboard CSP (`script-src 'self'`) blocks impeccable's injected `detect.js`. To run the in-browser detector:
start `npm run demo`, log in with curl (`-d token=demo-admin-token-0123456789abcdef`, keep the cookie jar), save
each page, rewrite `/static/` URLs to `http://127.0.0.1:8790/static/`, serve the folder on another port, then
inject `http://localhost:8400/detect.js` (from `live-server.mjs --background`). Static check:
`node .claude/skills/impeccable/scripts/detect.mjs --json src/dashboard`. Stop both servers afterwards.
