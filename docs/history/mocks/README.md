# Platform pivot — UI mocks

Vision-pitch HTML mockups for the platform pivot described in
[`docs/history/platform-pivot.md`](../platform-pivot.md). Static, self-contained,
no build step — open `index.html` in a browser.

> Frozen alongside the RFC they illustrate: these are point-in-time artefacts, not a description of
> the shipped UI. For the current dashboard see [`docs/redesign/`](../../redesign/README.md).

> **Working name "Conductor" is a placeholder** for the generic platform identity. The
> mocks use a fresh design system (not the current dashboard's look) to explore the
> platform direction visually.

## Pages

A marketing-style **overview** landing plus a full **app shell** (shared left sidebar,
injected by `assets/app.js`) covering every major feature.

| File | Surface | RFC mapping |
|---|---|---|
| `index.html` | Narrative overview — thesis, moat, four-tier extension model, reusable libraries, capability gallery, roadmap | whole RFC |
| `dashboard.html` | Operational home — KPIs, active/recent runs, needs-attention queue, budget, surfaces | — |
| `runs.html` | Runs list across every workflow, with filters | — |
| `run.html` | Run viewer — live execution graph, agent traces, timeline, security, diff, cost | P1–P2 |
| `inbox.html` | HITL inbox — approval / decision / input / review gates | governance |
| `templates.html` | Templates list, version history, v→v diff, A/B experiment config | — |
| `canvas.html` | Workflow editor — `agent` / `mcp` / plugin node palette + `AgentSpec` inspector | P1–P2 |
| `agents.html` | **Agent library** — reusable Agents, override cascade, versioning (the rev. 2 centerpiece) | P0–P1 |
| `skills.html` | Skill library — reusable prompt fragments + scanner status | P0–P1 |
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

Illustrative only — SWE (`swe-starter`) is the only seeded use case today. Other use
cases, coded plugins (Tier 4), and the distribution layer are shown to convey the model
(rev. 2, libraries-first), not as shipped features.
