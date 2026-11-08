# Design

The Leash dashboard: a board of agent sessions, in the same theme as the landing page
(quandapro.github.io/products/leash) so product and site read as one brand. Quiet until something trips, then it
says exactly what and offers the next action. Strategy and audience live in PRODUCT.md; this file is the visual
system. Source of truth for tokens: `src/dashboard/assets.ts`.

## Theme

Follows `prefers-color-scheme`. Light is the reference ("paper"); dark is a full peer. Values are the landing
page's, copied exactly.

## Color

Strategy: **restrained**. Paper and ink carry the page; colour only means something.

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `--paper` | #F1F3F0 | #0F1215 | Page background |
| `--sheet` | #FAFBF9 | #151A1E | Slips, inputs, sign-in |
| `--ink` / `--muted` | #14171C / #5B626C | #E6E8EA / #98A0AA | Text; ink also draws section rules and buttons |
| `--rule` | #D4D8D2 | #2A3036 | Hairlines, meter tracks |
| `--box` | #2E4FE0 | #8197FF | Leash blue: links, focus, the first key's spend |
| `--mark` | #B7410E | #F08A55 | Rust: paused, refused, failed, cap reached. The only alarming colour |
| `--caution` | #8A5A00 | #E2B45C | Warnings |
| `--ok` | #2F7D4F | #6CC594 | Running |
| `--bars` | #A3A9B0 | #59616B | Ordinary requests in activity strips |
| `--term` | #14171C | #0A0C0F | Replay and snippets (the landing page's gateway terminal) |

## Typography

- **Archivo** (variable, width 62-125, weight 400-900) for headings and titles: page titles and section heads at
  width 112 / weight 800, the wordmark at width 125 / 850, session titles at normal width / 680.
- **Source Serif 4** (400-600) for prose: status sentences, pause reasons, alert text, hints.
- **IBM Plex Mono** (400, 500) for navigation, buttons, state words, ids, models, money, captions.
- All three SIL OFL, bundled in `src/dashboard/fonts/` and served by Leash (`font-src 'self'`); no CDN.
- Smallest text 12px. Prose capped near 62-65ch. Tabular numerals everywhere.

## Layout

- One column up to 1180px. Sticky 54px mono bar with the `leash.` wordmark; the current page is underlined.
- Page head: wide title, one muted sentence, search box on the right.
- Section heads: wide Archivo with a 1.5px ink rule underneath and a mono note in blue on the right.
- Board: spend bar, then a main column (Paused, Running, Finished today) and a 290px side column (Also flagged).
- Ruled rows on paper for lists; tables only for genuinely tabular data (keys, providers, prices, requests).
- Forms stay closed (`<details>`) until the page's primary button opens them.

## Signature elements

- **Slips**: a paused session is a sheet with a rust border pushed 14px out of line, the way an air-traffic
  controller cocks a flight strip that needs attention. Its foot holds Resume and says what Resume does.
- **Activity strips**: every session row carries one bar per request, height by tokens; a bar turns rust when a
  tool result in it failed or Leash refused it. The session page draws the same thing large as a timeline.
- **Spend bar**: today's spend for all keys as one bar split by key, with a dashed rust line at 80% of the cap.
- **Terminal replay**: tool calls paired with results in the landing page's dark log style; identical
  consecutive steps fold into one row with `×N`, runs of 3 or more get a rust tint.

## Components

- Buttons: mono 13px, 1.5px ink border, 2px radius. Primary is ink-filled and turns blue on hover; danger is rust.
  One primary per view.
- State words: dot + mono word in the state colour ("Paused 4m ago", "Running", "Warned"). Never colour alone.
- Banners: full 1px border, tinted fill for trip and caution. Never a side stripe.
- Meters (key pages): 8px bar with a dashed notch at 80%, exact amount beside it.

## Motion

150ms colour transitions on interactive elements; 1px press on buttons. Nothing else moves. Disabled under
`prefers-reduced-motion`.

## Don't

Side-stripe borders, cards inside cards, KPI card rows, uppercase eyebrows, gradient text, external fonts or
scripts, inline styles (blocked by CSP; use SVG attributes for data-driven sizes), colour as the only signal.
