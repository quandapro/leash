# State

Last updated: 2026-11-07

## Where things stand

v0.1.0 is built, tested end to end in Docker, and committed. Repo: `D:\workspace\Quandapro\leash`, GitHub
`quandapro/leash` (private until the owner makes it public).

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

## Next steps (in order)

1. Owner action, cannot be done by the agent: join Hostinger Open-Source Partners, get the partner code, add
   `&ref=<code>` to the README Deploy button; flip the GitHub repo public. GitHub Actions on the private repo
   does not start ("recent account payments have failed or your spending limit needs to be increased",
   run 42360293356); going public gives free minutes, otherwise fix billing. Local `npm run check` and
   `npm run e2e` are the source of truth until CI runs.
   2026-11-07: tried both in the owner's Chrome (signed in to GitHub and hPanel). The agent's permission
   classifier refused flipping the repo public and opening the hPanel "List your app" form, so these stay with
   the owner. Git history was scanned for secret patterns first: clean. The hPanel listing step connects a
   public GitHub repo, so the repo must go public before listing.
2. Verify the Hostinger one-click flow (as of 2026-11-07 `hostinger.com/deploy?template=quandapro/leash` returns
   Hostinger's 404 page, expected while the repo is private and unlisted; re-check after listing) (`hostinger.com/deploy?template=quandapro/leash`) builds this compose file
   (it uses `build: .`). If Hostinger needs a prebuilt image, add a GHCR publish workflow on tags and switch
   compose to `image: ghcr.io/quandapro/leash:<version>`.
3. Test with a real Claude Code session against a real API key (needs a key; mock-only so far).
4. v0.2 MCP firewall: Streamable HTTP MCP proxy, per-server tool allowlist, injection scan of tool output,
   package-registry check for install commands.
5. v0.3: `leash connect` CLI, Postgres option, response cache. v1.0: TOTP, security audit, catalog listing.

## Known gaps

- OpenAI Responses requests using `previous_response_id` carry partial history, so loop rules see less.
- Telegram `/resume` replies are not implemented; resume is via the dashboard link in the alert.
- OpenClaw / Hermes config keys for custom base URLs not verified.
