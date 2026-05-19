# Docs

Most files in this folder are **historical design documents** — the design rationale that drove each phase of the build, preserved for context. The exception is [`configurable-workflows.md`](./configurable-workflows.md), which is a **living roadmap** updated as phases ship.

For day-to-day work, prefer the top-level docs:

- [`README.md`](../README.md) — quickstart, env vars, commands
- [`AGENTS.md`](../AGENTS.md) — current conventions, tech stack, model defaults, tool/agent rules
- [`STATUS.md`](../STATUS.md) — what shipped vs. what was planned
- [`PLAN.md`](../PLAN.md) — original v19 architectural plan (historical)

## Files

| File                                                       | Scope                                                                          | Status                                                             |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| [mvp-architecture.md](./mvp-architecture.md)               | Phase 1 MVP architecture & component design                                    | Historical — Phase 1 shipped; the hardcoded `EngineeringWorkflow` it describes was later deleted by the configurable-workflow engine (PR #13) |
| [data-and-infra.md](./data-and-infra.md)                   | Prisma schema, embedding pipeline, executor images, security                   | Reference — §3.1–3.2 describe the shipped DinD model; older sections may still diverge |
| [gateway-and-auth.md](./gateway-and-auth.md)               | Full Gateway API spec, JWT/RBAC, Slack OAuth                                   | Reference — RS256 framing; HS256 is the Docker Compose default      |
| [workflow-and-activities.md](./workflow-and-activities.md) | Temporal workflow, agent data flow, review network, CI loop, memory commit    | Reference — workspace provisioning is DinD; `EngineeringWorkflow` pseudocode replaced by `RunnableWorkflow` + the seeded `default-engineering@v1` spec |
| [wireframes.md](./wireframes.md)                           | Web dashboard wireframes (ASCII) for every page                                | Historical — see "Status note" at the top; shipped UI in `packages/web/src/app/` is authoritative where they diverge |
| [configurable-workflows.md](./configurable-workflows.md)   | Roadmap for the user-configurable workflow engine (interpreter, gates, fan-out, editor, versioning, shell steps, Slack/CLI, ergonomics, analytics) | **Living** — all phases 1–9 shipped |
| [oauth-setup.md](./oauth-setup.md)                         | Step-by-step for registering GitHub and Google OAuth apps and wiring them into the gateway. Magic-link works without setup. | **Living** — better-auth providers |
| [deployment.md](./deployment.md)                           | End-to-end "clone → deployed" runbook: pre-flight, env vars, DB + Temporal setup, image build, service layout, smoke test, day-2 ops, backup, hardening checklist | **Living** — production deployment |
