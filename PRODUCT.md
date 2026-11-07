# Product

## Register

product

## Users

Developers who run AI coding agents (Claude Code, Codex, Cline, aider, OpenClaw, Hermes) on their own API keys and
self-host Leash on a small VPS. Usually one person, sometimes a small team sharing one gateway. They meet the
dashboard in two situations:

- **After a ping.** A Telegram or webhook alert says a session was paused or a budget is close. Often on a phone,
  often away from the desk. The job: understand what happened in seconds and decide whether to resume.
- **At the desk.** Checking what the agents spent today, setting up a provider or a new agent key, tuning a budget.
  An IDE and terminal are open next to it.

## Product Purpose

Leash sits between agents and model APIs and says no at the moment it matters: spending caps, a loop kill switch,
secret redaction and per-agent keys. The dashboard is where a person sees what the guards did and decides what
happens next. Success: a paused session is understood and resolved in under a minute, and on a quiet day the
dashboard confirms "nothing needs you" at a glance.

## Brand Personality

Watchful, plain-spoken, exact. Like a well-labelled breaker panel: calm until something trips, then it tells you
precisely which circuit and why. Copy states facts in the user's terms ("npm test failed 3 times in a row"),
never alarmist, never cute. Money is shown to the cent and never rounded for effect.

## Anti-references

- Generic SaaS admin templates: a row of four KPI cards, a bar chart, then tables, all in the same white card.
- LLM observability suites (dense trace waterfalls, token heatmaps, purple-gradient "AI" branding).
- Grafana-style walls of panels where nothing says what to do.
- Neon-on-black "hacker" dashboards.

## Design Principles

1. **Lead with what needs a decision.** A paused session or a budget at its limit outranks every chart.
2. **Show the evidence.** Every block links to the exact repeated calls or the request that tripped it.
3. **Quiet when nothing is wrong.** No alarms, badges or colour when every agent is fine.
4. **Exact numbers.** Real cents, real token counts, timestamps in UTC with relative time beside them.
5. **Works from a phone after an alert.** The path from notification to "resume" fits a small screen.

## Accessibility & Inclusion

WCAG 2.2 AA. Status is never carried by colour alone (always a word or symbol too). Full keyboard use with
visible focus. Respects prefers-color-scheme and prefers-reduced-motion. No external fonts or scripts (the
dashboard runs under a strict CSP on the user's own server).
