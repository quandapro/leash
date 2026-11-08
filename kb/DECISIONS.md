# Decisions

Newest last. Each entry: date, decision, why, consequences.

## 2026-11-07 Product: Leash, a self-hosted gateway for AI agents
Spec: https://claude.ai/artifact/GMCcmWhRrt88fmPdMcMhZ4. Chosen over a config hub or PR checker because it
needs an always-on server (fits Hostinger's 20% Deploy-button referral program) and targets the costliest
pain points (runaway spend, secret leaks). Owner delegated all decisions to the maintainer.

## 2026-11-07 Zero runtime dependencies
Hono had ~10 CVEs in 2026 (JSX context leak, CORS ReDoS, IP-restriction bypass). Leash holds provider keys, so
the request path uses only Node built-ins: `node:http`, global `fetch`, `node:sqlite`, `node:crypto`.
Dev-only deps: `typescript` (typecheck), `@types/node`. Tests use `node:test`.

## 2026-11-07 Run TypeScript directly with Node type stripping
Node >= 22.18 strips types natively; code uses only erasable syntax (`erasableSyntaxOnly`). No build step,
no bundler. Docker image uses `node:26-alpine` (Node 26 is the current LTS as of 2026-11).

## 2026-11-07 Policy blocks return 403, not 429
Clients (Claude Code, SDKs) retry 429 and 5xx automatically, which would hammer the gateway and hide the
block. 403 `permission_error` (Anthropic) / 403 `leash_blocked` (OpenAI) is non-retryable and the client
shows our message to the user. Budget and loop blocks both use it.

## 2026-11-07 Loop rules read the request history, not stored state
Every agent request carries the full conversation, so rules run statelessly over the tool calls and results
in the history (window after `sessions.tool_offset`). This survives restarts and needs no double-count
bookkeeping. A dashboard resume sets `tool_offset` to the current tool-call count so old repetitions stop
counting. Limitation: OpenAI Responses requests that use `previous_response_id` carry partial history.

## 2026-11-07 Session identity
`X-Leash-Session` header if sent; else Claude Code's `metadata.user_id` session suffix; else
sha256(key id + first user message). Compaction may start a new session; acceptable.

## 2026-11-07 Store metadata, not prompts
Leash stores token counts, cost, tool names, argument hashes, file paths and 200-char redacted previews.
Never full prompts or responses. Keeps the database small and limits what a breach exposes.

## 2026-11-07 Pricing: built-in Claude table, admin overrides, conservative fallback
Claude prices from Anthropic's model table (2026-10). OpenAI-compatible prices change too often to hardcode;
admins set them in the dashboard. Unknown models are charged at the most expensive known price for that
provider and flagged `price_known=0`, so budgets fail safe.

## 2026-11-07 Budget pre-check uses a capped estimate
Worst case = input chars / 4 at input price + min(max_tokens, 4096) at output price. Full `max_tokens` (often
32k-128k) would block too early on small budgets. Real cost from `usage` is recorded after each response.

## 2026-11-07 Redaction skips thinking blocks and signatures
Changing signed thinking text or `signature` / `data` fields breaks Anthropic requests, so the redactor walks
only user-visible text and tool results (see "Redact only user-side content"). Replacements are deterministic, so prompt caching holds.

## 2026-11-07 Licence MIT; GitHub repo private until the owner flips it public
MIT maximises adoption, which is what earns referrals. The repo is pushed to a private GitHub repo
(quandapro/leash) so work is backed up without publishing under the owner's name; making it public is the
one step left to the owner.

## 2026-11-07 Redact only user-side content
Assistant turns and tool_use / function_call blocks are model output. Rewriting them edits history, which
preserved-thinking validation rejects (400 on Opus 5.5 / Sonnet 5.5 accounts created after 2026-08-31), and
the provider produced them anyway. Redaction covers system, user text and tool results.

## 2026-11-07 Statement cache and transactions for SQLite
Profiling showed ~19% of CPU in re-preparing statements and per-statement commits. Prepared statements are
cached per SQL string; per-request writes are grouped in one transaction; `keys.last_used_at` is updated at
most once a minute. Result: ~0.8 ms p50 added latency at concurrency 1.

## 2026-11-07 Production compose: Caddy for TLS, hardened container
Leash is never exposed on plain HTTP in the default stack; Caddy terminates TLS for `LEASH_DOMAIN`.
Container runs read-only, as `node`, no capabilities, `no-new-privileges`, limited to 2 vCPU / 4 GB.
Compose uses `build: .` until a GHCR image is published.

## 2026-11-07 CI pins actions by SHA
actions/checkout v7.0.1 and actions/setup-node v7.1.0 pinned to commit SHAs; CI runs npm audit, check and
the Docker e2e.

## 2026-11-07 Prefer the cost the provider reports
OpenRouter returns `usage.cost` (the amount it billed) on its Anthropic and OpenAI endpoints. Its prices vary by
time of day and by upstream route: in a live DeepSeek test our static table was 12-50% off. When a response
carries a finite, non-negative `usage.cost`, Leash records it and marks the price known; the price table is the
fallback and still drives the budget pre-check estimate. The provider is admin-configured, so its billing
report is trusted.

## 2026-11-07 Claude Code session id comes from JSON metadata
Claude Code 2.1+ sends `metadata.user_id` as a JSON string with `session_id` (the old
`..._session_<uuid>` form is still parsed). The id must match `[0-9a-f-]{8,64}` or it is ignored. Session labels
and the hash fallback strip `<system-reminder>` blocks, which Claude Code injects ahead of the user's prompt.

## 2026-11-07 Usage fields only overwrite with numbers
Gateways send `null` for usage fields they fill in later stream events (OpenRouter sends
`cache_read_input_tokens: null` in `message_start`). A `null` never overwrites a count already seen.

## 2026-11-07 Dashboard redesign: breaker panel, not SaaS admin
The owner called the first dashboard "AI slop". An impeccable critique scored it 22/40 (KPI card row, empty chart,
card-on-grey everywhere, side-stripe notices, forms always open). The redesign leads with a status sentence and a
"Needs you" list with inline actions, uses ledger rows instead of cards, meters for spend against caps, and a
replay that folds identical steps (×N). Re-scored 28/40. Rules in DESIGN.md, audience in PRODUCT.md.

## 2026-11-07 Bundle brand fonts instead of system UI
System UI resolved to Roboto and read as a default template. Archivo (UI) and IBM Plex Mono (data), both SIL OFL
and the landing page's brand fonts, are bundled in `src/dashboard/fonts/` (65 KB latin subsets, licences
alongside) and served from `/static/fonts/`. CSP gains `font-src 'self'` only; no third-party requests.

## 2026-11-07 Content-hashed asset URLs
`/static/app.css?v=<hash>` and `app.js?v=<hash>`, cached for a year as immutable. Without it an upgrade served the
previous version's stylesheet from cache for up to an hour.

## 2026-11-07 Owner rule beats skill interviews
impeccable's init and critique flows ask the user questions. The owner's standing rule for Leash is "do not ask",
so PRODUCT.md was written from the README, spec and KB, and the critique scope (all issues) was decided here.


## 2026-11-08 Dashboard follows the landing page, sessions shown as strips
The owner asked for the landing page's theme and a mockup first. Tokens, fonts (wide Archivo heads, Source Serif 4
prose, Plex Mono data), the ink-underlined section heads, the ink-bordered mono buttons and the dark gateway
terminal now come from quandapro.github.io/products/leash. Signature: a paused session is a slip pushed out of
line (a controller "cocking" a flight strip), every session carries a strip of its requests with failures in
rust. Sessions are named by their first prompt; the hex id is metadata. Fonts grow to ~240 KB, served once and
cached as immutable; acceptable for a self-hosted admin page.

## 2026-11-08 Pause from the dashboard, no "End session" yet
Pause reuses the existing blocked status (reason "Paused from the dashboard."), so the proxy's existing check
refuses the next request and Resume works unchanged. A permanent "End session" would need a new status and
semantics for agents that reuse the session id; left out until there is a need. No single-key "R to resume"
shortcut either: one stray keypress must not release a stopped agent.
