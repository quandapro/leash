# Design

The Leash dashboard: a calm breaker panel for AI agents. Quiet until something trips, then it says exactly what
and offers the next action. Strategy and audience live in PRODUCT.md; this file is the visual system. Source of
truth for tokens: `src/dashboard/assets.ts`.

## Theme

Follows `prefers-color-scheme`. Light is the reference; dark is a full peer, not an inversion. Neutrals are tinted
toward the brand blue (hue 265), never warm or cream.

## Color

Strategy: **restrained**. Neutrals carry the page; colour only means something.

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `--ground` | oklch(0.975 0.004 265) | oklch(0.18 0.012 265) | Page background |
| `--surface` | white | oklch(0.215 0.014 265) | Top bar, forms, inputs |
| `--sunk` | oklch(0.955 0.006 265) | oklch(0.16 0.012 265) | Code, meter track, tags |
| `--ink` / `--muted` / `--faint` | 0.23 / 0.46 / 0.62 L | 0.93 / 0.72 / 0.58 L | Text tiers; muted passes 4.5:1 on ground |
| `--accent` | oklch(0.5 0.2 268) | oklch(0.72 0.14 268) | Leash blue: primary action, links, current nav, today's spend |
| `--trip` | oklch(0.5 0.15 42) | oklch(0.74 0.13 45) | Rust: paused, blocked, cap reached. The only alarming colour |
| `--caution` | oklch(0.5 0.11 75) | oklch(0.8 0.11 80) | Warnings, 80% of a cap |
| `--ok` | oklch(0.5 0.1 155) | oklch(0.75 0.11 155) | Running, in use |

Blue and rust come from the landing page (quandapro.github.io/products/leash) so product and site read as one brand.

## Typography

- **Archivo** (variable 400-700) for all UI text. **IBM Plex Mono** (400, 600) for keys, models, commands, tool
  calls. Both SIL OFL, bundled in `src/dashboard/fonts/` and served by Leash (`font-src 'self'`); no CDN.
- Fixed scale: 12 (meta, captions, state words) · 14 (body) · 17 (section heads, brand) · 24 (page title) ·
  30 (overview status line). Mono runs at 13 next to 14 sans.
- Sentence case everywhere. No uppercase tracked labels. Prose capped at 65ch.
- Tabular numerals on the whole body so money and counts line up.

## Layout

- One column, max 1080px. Sticky 52px top bar; nav marks the current page with an underline.
- **Ledger rows** instead of cards: `state word | what (title, detail, meta) | actions`, separated by hairlines.
  They stack on phones with actions under the text.
- Tables only for genuinely tabular data (keys, providers, prices, requests).
- Forms are closed by default (`<details>`), opened by the one primary button of the page.

## Signature elements

- **Status line** on the overview: one sentence ("1 session paused, 2 alerts to review." / "All quiet. Nothing
  needs you.") with a dot that turns rust only when something waits on the user. Followed by "Needs you" with
  inline Resume / Resolve / Set price.
- **Meters**: spend against a cap as an 8px bar with a dashed notch at 80%; blue, then amber past the notch, rust
  at the cap, with the exact amount in words beside it.
- **Replay**: tool calls paired with results; identical consecutive steps fold into one row with `×N`; folded
  runs of 3 or more get the rust tint.

## Components

- Buttons: 32px (28px small), 6px radius. Primary (blue, one per view), secondary (outlined), quiet (text),
  danger (rust outline). Visible `:focus-visible` ring on everything.
- State words: dot + word in the state colour ("Paused", "Blocked", "Warning", "Running"). Never colour alone.
- Banners: full 1px border with a tinted fill. Never a side stripe.
- Copy buttons sit inside snippets; secrets shown once in a larger mono snippet.

## Motion

150ms colour transitions on interactive elements; 1px press on buttons. Nothing else moves. Disabled under
`prefers-reduced-motion`.

## Don't

Side-stripe borders, KPI card rows, uppercase eyebrows, gradient text, nested cards, external fonts or scripts,
inline styles (blocked by CSP), colour as the only signal.
