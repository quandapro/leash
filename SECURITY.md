# Security

Leash holds your provider API keys, so it is built to be the hardest part of your agent setup to break.

## Reporting a vulnerability

Open a private security advisory on GitHub (Security → Report a vulnerability). Please do not open a public
issue. You will get a reply within 7 days.

## What Leash protects

| Asset | Protection |
| --- | --- |
| Provider API keys | AES-256-GCM at rest, key derived from `LEASH_SECRET` with HKDF. Shown masked in the dashboard. Injected only into upstream requests; never logged. |
| Virtual keys | Stored as SHA-256 hashes; shown once at creation. Client-supplied provider keys are rejected, never forwarded. |
| Dashboard | Admin token compared in constant time; 10 failures per IP lock sign-in for 15 minutes. Server-side sessions (only a hash is stored), `HttpOnly; SameSite=Strict; Secure` cookies, CSRF token plus same-origin check on every POST, strict CSP with no inline scripts or styles, `X-Frame-Options: DENY`. |
| Prompts | Secrets redacted before leaving the server. Only metadata and 200-character redacted previews are stored. |
| Upstream calls | HTTPS required for provider base URLs; redirects are never followed while carrying a key; only listed endpoints are proxied. |
| Container | Runs as the unprivileged `node` user, read-only root filesystem, all capabilities dropped, `no-new-privileges`. |
| Supply chain | Zero runtime dependencies. CI pins GitHub Actions by commit SHA and runs `npm audit`. |

## Limits

- Secret redaction is pattern based. It catches common credential formats and high-entropy `key=value`
  assignments, not every possible secret.
- Leash only sees traffic routed through it. An agent running shell commands on your machine is outside its
  view; use your agent's own permission controls for that.
- Model output is never rewritten (editing earlier assistant turns breaks providers' thinking validation),
  so a secret the model already saw before Leash was in place can still appear in its replies.
- Anyone with `LEASH_ADMIN_TOKEN` controls the gateway. Use a long random value and keep the dashboard on HTTPS.
