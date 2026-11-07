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
