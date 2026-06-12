# Docs

> Status table mirrors [`AGENTS.md` §2](../AGENTS.md#2-design-documents) — that table is canonical if the two ever diverge.

## Start here

| Doc | Status | Purpose |
|-----|--------|---------|
| **[product-overview.md](./product-overview.md)** | **Current** | Product thesis, target users, business value, capability map, primary use cases, differentiators, non-goals, maturity — start here for the "why" and "what" |
| **[architecture.md](./architecture.md)** | **Current** | System context, package map with file references, request lifecycle, workflow engine (11 node types), runtime security scanners, budget tiers, auth, data model, infra diagrams |
| **[agents.md](./agents.md)** | **Current** | All 10 agent roles, implementer tools (incl. `loadSkill`), 27 built-in skills, `AgentTracer` observability pattern, skill + tool assignment API reference |
| [deployment.md](./deployment.md) | **Living** | End-to-end "clone → deployed" runbook |
| [model-configuration.md](./model-configuration.md) | **Living** | DB-backed LLM model + provider credential config |
| [oauth-setup.md](./oauth-setup.md) | **Living** | GitHub / Google OAuth + magic-link setup |
| [slack-app-setup.md](./slack-app-setup.md) | **Living** | Slack app manifest import and admin configuration |
| [github-app-setup.md](./github-app-setup.md) | **Living** | GitHub App creation, permissions, installation ID, admin UI config, auth mode options |
| [hitl-workflows.md](./hitl-workflows.md) | **Living** | HITL node types (approval/decision/input/review), signal flow, inbox UI, API reference |

Top-level files:

- [`README.md`](../README.md) — quickstart, env vars, commands
- [`AGENTS.md`](../AGENTS.md) — current conventions, tech stack, model defaults, tool/agent rules
- [`STATUS.md`](../STATUS.md) — what shipped vs. what was planned
- [`PLAN.md`](../PLAN.md) — original v19 architectural plan (historical)

---

## Historical design documents

Preserved for design rationale; the code is the authoritative reference where they diverge.

| File                                                       | Scope                                                                          | Drift note |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------ | ---------- |
| [configurable-workflows.md](./configurable-workflows.md)   | Workflow engine roadmap + architecture decisions log                            | Completed roadmap — all 9 phases done; 39 architecture decisions preserved for rationale |
| [mvp-architecture.md](./mvp-architecture.md)               | Phase 1 MVP architecture & component design                                    | `EngineeringWorkflow` deleted (PR #13); replaced by `RunnableWorkflow` + seeded spec |
| [data-and-infra.md](./data-and-infra.md)                   | Prisma schema, embedding pipeline, executor images, security                   | Schema section outdated — actual schema is `packages/shared/src/prisma/schema.prisma` (36 models); §3.1–3.2 DinD description is accurate |
| [gateway-and-auth.md](./gateway-and-auth.md)               | Full Gateway API spec, JWT/RBAC, Slack OAuth                                   | RS256 framing; HS256 is the Docker Compose default; better-auth cookie path added post-Phase 4 |
| [workflow-and-activities.md](./workflow-and-activities.md) | Temporal workflow, agent data flow, review network, CI loop, memory commit     | K8s workspace references; `EngineeringWorkflow` pseudocode replaced by `RunnableWorkflow` |
| [wireframes.md](./wireframes.md)                           | Web dashboard wireframes (ASCII) for every page                                | Shipped UI in `packages/web/src/app/` is authoritative; "Workshop Telemetry" redesign post-Phase 4 |

---

## Research

Exploratory write-ups that informed shipped features; not maintained as references.

| File | Topic |
| ---- | ----- |
| [agent-dreaming-research.md](./agent-dreaming-research.md) | Offline lesson consolidation ("dreaming") pattern behind the lesson-consolidation feature |
| [skills-research.md](./skills-research.md) | Skill (prompt-fragment) design research behind the agent skills system |
