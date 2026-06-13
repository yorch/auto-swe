# Platform pivot — UI mocks

Vision-pitch HTML mockups for the platform pivot described in
[`docs/platform-pivot.md`](../docs/platform-pivot.md). Static, self-contained,
no build step — open `index.html` in a browser.

> **Working name "Conductor" is a placeholder** for the generic platform identity. The
> mocks use a fresh design system (not the current dashboard's look) to explore the
> platform direction visually.

## Pages

A marketing-style **overview** landing plus a full **app shell** (shared left sidebar,
injected by `assets/app.js`) covering every major feature.

| File | Surface | RFC mapping |
|---|---|---|
| `index.html` | Narrative overview — thesis, moat, four-tier extension model, pack model, capability gallery, roadmap | whole RFC |
| `dashboard.html` | Operational home — KPIs, active/recent runs, needs-attention queue, budget, surfaces | — |
| `runs.html` | Runs list across all packs, with filters | — |
| `run.html` | Run viewer — live execution graph, agent traces, timeline, security, diff, cost | P1–P2 |
| `inbox.html` | HITL inbox — approval / decision / input / review gates | governance |
| `templates.html` | Templates list, version history, v→v diff, A/B experiment config | — |
| `canvas.html` | Workflow editor — `agent` / `mcp` / `plugin` node palette + `AgentSpec` inspector | P1–P2 |
| `packs.html` | Pack install/browse/detail + dynamic roles & models | P0–P1 |
| `connections.html` | Typed Connections (replaces Repositories), inputSchema-driven run submit, triggers | P3 |
| `analytics.html` | Success / latency / $-per-run, per-step failure, A/B winner + significance | — |
| `memory.html` | Semantic memory browser — scoped/tagged pgvector lessons + search | P3 |
| `security.html` | Six runtime scanners, event feed, patterns | — |
| `admin.html` | Integrations, models & credentials, teams & budget | — |

Shared design system in `assets/app.css`; shell injection + tabs + canvas node
selection in `assets/app.js`.

## Screenshots

Rendered full-resolution previews live in [`shots/`](./shots) (2× DPI).

Regenerate with a headless Chrome:

```bash
cd mocks
npm i puppeteer-core --no-save
node render.mjs   # update the CHROME path in render.mjs to your local chrome
```

## Status

Illustrative only — `pack-swe` is the only pack that exists today; other packs,
plugins (Tier 4), and the SDK are shown to convey the model, not as shipped features.
