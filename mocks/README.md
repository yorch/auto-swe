# Platform pivot — UI mocks

Vision-pitch HTML mockups for the platform pivot described in
[`docs/platform-pivot.md`](../docs/platform-pivot.md). Static, self-contained,
no build step — open `index.html` in a browser.

> **Working name "Conductor" is a placeholder** for the generic platform identity. The
> mocks use a fresh design system (not the current dashboard's look) to explore the
> platform direction visually.

## Pages

| File | Surface | RFC mapping |
|---|---|---|
| `index.html` | Narrative overview — thesis, moat, four-tier extension model, pack model, roadmap | whole RFC |
| `canvas.html` | Workflow canvas with the new `agent` / `mcp` / `plugin` node palette + `AgentSpec` inspector | P1–P2 |
| `packs.html` | Pack install/browse/detail + dynamic roles & models table | P0–P1 |
| `connections.html` | Typed Connections (replaces Repositories), inputSchema-driven run submit, triggers | P3 |

Shared design system in `assets/app.css`; light interactivity (tabs, canvas node
selection) in `assets/app.js`.

## Status

Illustrative only — `pack-swe` is the only pack that exists today; other packs,
plugins (Tier 4), and the SDK are shown to convey the model, not as shipped features.
