# State

Last updated: 2026-11-07

## Where things stand

v0.1.0 is built, tested end to end in Docker, and committed. Repo: `D:\workspace\Quandapro\leash`, GitHub
`quandapro/leash` (public since 2026-11-07). GitHub CI is green (run 42366690479: audit, typecheck, tests,
Docker e2e, 58 s).
Landing page: https://quandapro.github.io/products/leash/ (source `products/leash/index.html` in the
`quandapro/quandapro.github.io` repo, a single static file styled like the owner's portfolio; keep its claims in
sync with the README). It is also the GitHub repo homepage.

Done and verified (unit tests + `npm run e2e` in a 2 vCPU / 4 GB container):

- Proxy for Anthropic Messages (+count_tokens, models) and OpenAI Chat Completions / Responses (+models),
  streamed and non-streamed, with usage metering and cost (built-in Claude prices, admin overrides, fail-safe fallback).
- Virtual `lsh_` keys (hashed), provider keys AES-256-GCM encrypted, model allowlist, revoke.
- Budgets (key daily/monthly, global daily) with 80% warnings; loop rules (repeated call, file reread,
  identical failure), spend velocity, turn ceiling; 403 blocks; dashboard resume with offset.
- Secret redaction (user-side content only), modes redact / block / log.
- Alerts: stored, deduplicated, delivered to Telegram and webhook.
- Dashboard: overview, sessions + replay, keys + setup snippets, providers + prices, alerts + settings;
  CSRF, strict CSP, login throttling. `/api/stats` JSON, `/healthz`.
- Docker image (63 MB, ~96 MB RAM), production compose with Caddy TLS, hardened container settings.
- KB hooks (SessionStart load, Stop gate) and git pre-commit (KB gate + secret scan). CI workflow.

Measured: added latency ~0.8 ms p50 / 1.3 ms p95 at concurrency 1; at concurrency 16 in Docker ~17-19 ms p50
(single Node thread; fine for personal use).

Live-tested 2026-11-07: Claude Code 2.1.309 → Leash → OpenRouter `deepseek/deepseek-v4.1-flash-1017` (Anthropic
endpoint `https://openrouter.ai/api`). Two runs (fix tests, then a resumed follow-up), 10 requests, all 200.
Tokens and cost match OpenRouter exactly; cache hit 89% of prompt tokens (98% after the cold first request);
planted AWS key never reached the provider; Leash overhead ~5 ms median. Traces in `e2e/.tmp/live-deepseek/`
(gitignored). The run found and fixed: Claude Code 2.1 JSON session ids, `<system-reminder>` session labels,
provider-reported cost (OpenRouter `usage.cost`), null usage fields.

Dashboard redesigned 2026-11-07 (impeccable critique 22 → 28/40): status line + "Needs you", ledger rows, spend
meters, folded replay, bundled Archivo / IBM Plex Mono, light + dark. `npm run demo` serves a populated dashboard
on :8790 (token `demo-admin-token-0123456789abcdef`). PRODUCT.md / DESIGN.md hold the design context; the
impeccable skill is copied (gitignored) into `.claude/skills/impeccable/` from the owner's EasyBaby project.
Open design items: keyboard shortcuts / session search, live updates instead of timed refresh, a page explaining
each guard rule.
Fonts are binary files: `.gitattributes` marks `*.woff2 binary` so the repo-wide `eol=lf` rule never touches them.

## Next steps (in order)

1. Hostinger Open-Source Partners is not open yet; "List your app" is a waitlist. Leash was submitted to it on
   2026-11-07 from the owner's hPanel (repo URL, name, description, "under 50" self-hosters, deployed via Docker).
   Hostinger emails the hPanel account address at launch. Then: get the partner code, add `&ref=<code>` to the
   README Deploy button. The repo went public on 2026-11-07 via `gh repo edit` (history scanned for secrets
   first: clean), which also unblocked CI.
2. Verify the Hostinger one-click flow (as of 2026-11-07 `hostinger.com/deploy?template=quandapro/leash` returns
   Hostinger's 404 page, expected while the repo is private and unlisted; re-check after listing) and that it builds this compose file
   (it uses `build: .`). If Hostinger needs a prebuilt image, add a GHCR publish workflow on tags and switch
   compose to `image: ghcr.io/quandapro/leash:<version>`.
3. Real-provider tests: done for Claude Code on OpenRouter (see above). Still untested live: Anthropic direct,
   Codex / OpenAI Responses, OpenAI chat clients (Cline, aider).
4. v0.2 MCP firewall: Streamable HTTP MCP proxy, per-server tool allowlist, injection scan of tool output,
   package-registry check for install commands.
5. v0.3: `leash connect` CLI, Postgres option, response cache. v1.0: TOTP, security audit, catalog listing.

## Known gaps

- OpenAI Responses requests using `previous_response_id` carry partial history, so loop rules see less.
- Telegram `/resume` replies are not implemented; resume is via the dashboard link in the alert.
- OpenClaw / Hermes config keys for custom base URLs not verified.
