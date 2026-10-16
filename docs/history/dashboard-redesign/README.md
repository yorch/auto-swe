# Web dashboard redesign — Workshop Telemetry

Reference screenshots of the web dashboard after the design-system refresh.

| Screen | Image |
| ------ | ----- |
| Login (split-pane editorial) | `01-login.jpg` |
| Dashboard (numbered sections, KPI row, dark charts) | `02-dashboard.jpg` |
| Repositories (inherited system, no page-level redesign) | `03-repositories.jpg` |
| Workflow Templates (inherited system) | `04-templates.jpg` |

## Design system at a glance

- **Surface**: deep ink (`--color-ink-900` `#0B0E13`) with warm cream text, faint
  ember atmospheric glow, and a subtle SVG noise overlay.
- **Accent**: single confident terracotta (`--color-ember-400` `#E26B3C`).
  Status colors are muted moss / amber / brick / dust / violet.
- **Typography**: `Fraunces` (variable serif, display) × `IBM Plex Sans` (body)
  × `JetBrains Mono` (data / micro-labels). Loaded via `next/font/google`.
- **Structure**: numbered chapter headers (`§ Dashboard`, `01 — Telemetry`),
  1-px rule dividers in place of card-everywhere, tabular numerics throughout.
- **Motion**: page-enter stagger fade-up, sidebar accent rule slides in on
  hover/active, pulsing dot for live status.

All tokens live in `packages/web/src/app/globals.css` via Tailwind v4's
`@theme` block. Pages and primitives inherit them through CSS variables, so
interior pages picked up the new look without explicit per-page edits.
