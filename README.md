# Leash

**A self-hosted gateway that keeps AI agents on a leash: spending caps, loop kill switch, secret redaction.**

Point Claude Code, Codex, Cline, aider, OpenClaw or Hermes at Leash instead of the model API. Every request
passes four checks before it reaches the provider, and every response feeds a loop detector:

| Guard | What it does |
| --- | --- |
| **Budgets** | Daily and monthly caps per key, plus a global daily cap. Checked *before* each request with a worst-case estimate. |
| **Loop kill switch** | Stops a session when it repeats the same tool call 4 times, hits the same failure 3 times in a row, or burns $5 in 10 minutes. |
| **Secret redaction** | AWS, GitHub, Anthropic, OpenAI, Stripe, Slack and Google keys, private keys, JWTs, connection strings and `password=…` style assignments are replaced before the prompt leaves your server. |
| **Virtual keys** | Agents get `lsh_…` keys. Your real provider keys stay on the server, encrypted with AES-256-GCM. Revoke one agent without touching the others. |
| **Model allowlist** | Per key, e.g. `claude-sonnet-*, claude-haiku-*`. |
| **Alerts** | Telegram and webhook, with a link to the session replay. |

Blocks return a non-retryable `403` with a plain-English reason, so the agent stops and shows you why
instead of retrying. Resume a blocked session from the dashboard with one click.

[![Deploy on Hostinger](https://assets.hostinger.com/vps/deploy.svg)](https://www.hostinger.com/deploy?template=quandapro/leash)

## Why

AI agents spend money and take actions faster than people watch them. Agent loops re-read files and re-run
failing tests until a quota or a credit card runs out, and prompt-injected tools have exfiltrated `.env`
files and SSH keys. Provider dashboards tell you afterwards; Leash says no at the moment it matters.

- **Zero runtime dependencies.** Only Node.js built-ins (`node:http`, `fetch`, `node:sqlite`, `node:crypto`).
  Nothing third-party sits between your agent and your API key.
- **Small.** 63 MB image, about 100 MB RAM, ~1 ms added latency per request.
- **Private by design.** Leash stores token counts, costs, tool names and short redacted previews.
  Never full prompts or responses.

## Quick start

### One click on Hostinger

Click **Deploy on Hostinger** above, then set `LEASH_ADMIN_TOKEN`, `LEASH_SECRET` and `LEASH_DOMAIN`.
Point your domain's A record at the VPS; Caddy gets a TLS certificate automatically.

### Any server with Docker

```bash
git clone https://github.com/quandapro/leash && cd leash
cp .env.example .env
```

Fill in `.env` (generate secrets with `openssl rand -hex 24` and `openssl rand -hex 32`), then:

```bash
docker compose up -d
```

Open `https://<your domain>`, sign in with `LEASH_ADMIN_TOKEN`, add a provider (or set
`LEASH_ANTHROPIC_KEY` / `LEASH_OPENAI_KEY` in `.env`), and create a key for each agent.

## Connect your agents

**Claude Code** (API-key mode):

```bash
export ANTHROPIC_BASE_URL=https://leash.example.com/anthropic
export ANTHROPIC_API_KEY=lsh_your_leash_key
```

**Codex CLI** (`~/.codex/config.toml`, then `export LEASH_API_KEY=lsh_…`):

```toml
model_provider = "leash"

[model_providers.leash]
name = "Leash"
base_url = "https://leash.example.com/openai/v1"
env_key = "LEASH_API_KEY"
wire_api = "responses"
```

**Anything OpenAI-compatible** (Cline, aider, Continue, OpenClaw, Hermes, OpenRouter clients): base URL
`https://leash.example.com/openai/v1`, API key = your Leash key. Add the provider with its own base URL
(for example `https://openrouter.ai/api/v1`) and set model prices on the Providers page.

Proxied endpoints: `POST /anthropic/v1/messages`, `POST /anthropic/v1/messages/count_tokens`,
`GET /anthropic/v1/models`, `POST /openai/v1/chat/completions`, `POST /openai/v1/responses`,
`GET /openai/v1/models`. Everything else is refused.

Known gaps: subscription logins (Claude Pro/Max, ChatGPT Plus) cannot be proxied; Cursor sends most
traffic through its own servers.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `LEASH_ADMIN_TOKEN` | required, ≥ 24 chars | Dashboard sign-in |
| `LEASH_SECRET` | required, ≥ 32 chars | Encrypts provider keys and signs CSRF tokens. Changing it makes stored provider keys unreadable. |
| `LEASH_PUBLIC_URL` | `http://localhost:8080` | Used in links and setup snippets (compose sets it from `LEASH_DOMAIN`) |
| `LEASH_ANTHROPIC_KEY`, `LEASH_OPENAI_KEY` | — | Seed or update the `anthropic` / `openai` providers on start |
| `LEASH_OPENAI_BASE_URL` | `https://api.openai.com/v1` | Any OpenAI-compatible API |
| `LEASH_RETENTION_DAYS` | `30` | Requests, tool events and alerts older than this are deleted |
| `LEASH_MAX_BODY_MB` | `32` | Largest request accepted |
| `LEASH_VELOCITY_USD` | `5` | Per-session spend in 10 minutes that triggers a block (`0` disables) |
| `LEASH_TURN_CEILING` | `200` | Requests per session before a warning |
| `LEASH_TRUST_PROXY` | `0` (`1` in compose) | Trust `X-Forwarded-For` / `-Proto` from the reverse proxy |
| `LEASH_DATA_DIR` | `./data` (`/data` in Docker) | SQLite database location |

## Monitoring API

`GET /api/stats` (signed-in dashboard session) returns spend, keys, sessions and alerts as JSON.
`GET /healthz` is public and returns `{"ok":true}`.

## Development

Requires Node.js 22.18+ (TypeScript runs directly through Node's type stripping, no build step).

```bash
npm install
npm run check
npm run e2e
```

`npm run check` runs the typecheck and unit tests, including an in-process end-to-end scenario.
`npm run e2e` builds the production image, runs it limited to 2 vCPU / 4 GB next to a mock provider, and
runs the same scenario plus a latency test from a third container.

## Security

See [SECURITY.md](SECURITY.md) for the threat model and how to report a vulnerability.

## License

MIT
