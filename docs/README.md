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
| [mvp-architecture.md](./mvp-architecture.md)               | Phase 1 MVP architecture & component design                                    | Historical — Phase 1 shipped                                       |
| [mvp-implementation.md](./mvp-implementation.md)           | Phase 1 MVP step-by-step build guide (project structure, code, build order)    | Historical — some snippets describe pre-release Mastra APIs        |
| [data-and-infra.md](./data-and-infra.md)                   | Prisma schema, embedding pipeline, executor images, security                   | Reference — K8s/IRSA sections diverged (actual is Docker-in-Docker) |
| [gateway-and-auth.md](./gateway-and-auth.md)               | Full Gateway API spec, JWT/RBAC, Slack OAuth                                   | Reference — RS256 framing; HS256 is the Docker Compose default      |
| [workflow-and-activities.md](./workflow-and-activities.md) | Temporal workflow, agent data flow, review network, CI loop, memory commit    | Reference — workspace provisioning is DinD, not K8s Jobs            |
| [wireframes.md](./wireframes.md)                           | Web dashboard wireframes (ASCII) for every page                                | Reference — matches `packages/web/src/app/`                         |
| [configurable-workflows.md](./configurable-workflows.md)   | Roadmap for the user-configurable workflow engine (interpreter, gates, fan-out, editor, shell steps) | **Living** — phase 1 shipped (PR #13); phases 2–7 pending          |
