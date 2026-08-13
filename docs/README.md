# Documentation

auto-swe is a durable, governed multi-agent workflow platform for software engineering teams. Its
flagship use case — ticket in, reviewed draft pull request out — is one workflow template built from
the same node types any team can author, and the Slack channel teammate is both a headline
capability and the surface teams drive the platform from.

These docs describe **how auto-swe works now**, in present tense. There is no status column here
and no roadmap: what shipped when lives in git history, and completed plans live in
[`history/`](./history/).

## Start here

| Doc | Covers |
|-----|--------|
| **[product-overview.md](./product-overview.md)** | What auto-swe is and who it is for — thesis, target users, capability map, primary use cases, differentiators, and what is deliberately out of scope |
| **[architecture.md](./architecture.md)** | How it is put together — system context, package map, run lifecycle, the workflow engine and its node types, the config cascade, auth, data model, infrastructure |
| **[agents.md](./agents.md)** | The agent layer — seeded agents and how they bind models, the review network, skills, implementer tools, MCP, and the `AgentTracer` pattern |

## Capabilities

| Doc | Covers |
|-----|--------|
| [hitl-workflows.md](./hitl-workflows.md) | Human-in-the-loop nodes (approval / decision / input / review), signal flow, the inbox, API |
| [evals.md](./evals.md) | Output-quality measurement — the `eval` node, scorers, datasets, the regression harness, canary routing |
| [channel-assistant.md](./channel-assistant.md) | The Slack channel teammate — a capability in its own right and the platform's conversational control surface; turns, ambient and reactive modes, channel memory, personas, budgets |
| [nl-workflow-authoring.md](./nl-workflow-authoring.md) | Describing an automation in natural language and getting a validated `WorkflowSpec` back |
| [figma-integration.md](./figma-integration.md) | Design context — the `design-fidelity` skill and submit-time Figma enrichment |
| [repo-dependency-graph.md](./repo-dependency-graph.md) | Directed dependency edges between git repos — the `RepoDependency` model, the cross-team edge API and management UI, and the neighbour resolver |

## Configuration & operations

| Doc | Covers |
|-----|--------|
| [configuration.md](./configuration.md) | Where every knob lives — the environment/integration/registry split, the setting registry and its cascade, who may change what, run pinning |
| [deployment.md](./deployment.md) | Production runbook — environment, database, Temporal, images, service layout, smoke test, day-2 ops, hardening |
| [model-configuration.md](./model-configuration.md) | DB-backed model selection and provider credentials — the scope cascade, encryption, day-2 operations |
| [oauth-setup.md](./oauth-setup.md) | GitHub and Google OAuth apps; magic-link email |
| [github-app-setup.md](./github-app-setup.md) | GitHub App creation, permissions, installation, auth modes |
| [slack-app-setup.md](./slack-app-setup.md) | Slack app manifest import and admin configuration |

Also here: [`slack-app-manifest.json`](./slack-app-manifest.json) and [`redesign/`](./redesign/)
(dashboard design screenshots).

## These files ship

The dashboard renders this directory at `/docs`, linked in the sidebar for every role, so a doc is
a product surface and not only a file in a checkout. Two consequences when you edit one:

- **Only the top level is served.** `history/` and `redesign/` are deliberately not published —
  frozen docs presented to a product user read as current behaviour. A link into them renders as
  plain text rather than a dead link, as does a link that leaves `docs/` (`../AGENTS.md`).
- **Cross-doc links are rewritten**, so `[agents.md](./agents.md)` works both as a file path and as
  `/docs/agents`. Write them relative, as normal; `packages/web/src/lib/docLinks.ts` handles the
  translation and is unit-tested against every shape in this tree.

Mermaid blocks render as labelled diagram source in the dashboard, not as diagrams — the renderer
is a 79-package dependency that has not been taken on.

## Where known gaps are documented

Gaps live **next to the feature they belong to**, not in a central list — a central list is what
drifted last time. Every capability doc ends with a `## Limitations` section stating what is not
built, not proven, or deliberately constrained, and `yarn docs:check` fails if one is missing.

| Scope | Where |
|---|---|
| Product-level boundaries the system will not cross | [product-overview.md §7](./product-overview.md#7-non-goals--out-of-scope) |
| Overall maturity and what is unproven | [product-overview.md §8](./product-overview.md#8-maturity) |
| A specific capability's gaps | That capability's own **Limitations** section |

So: for "what are the known gaps in X", read `docs/X.md` and jump to the end. For "what is this
system not, and what has not been proven", read `product-overview.md` §7 and §8.

## Conventions

Working in this repo? Read [`AGENTS.md`](../AGENTS.md) — conventions, critical implementation
notes, and the gotchas that cause real bugs.

Writing docs? Two rules:

1. **Present tense, current state.** No shipped-status, PR numbers, phase labels, or roadmap
   promises. That is what git history and the pull request are for.
2. **`yarn docs:check` enforces both.** It derives countable facts (node types, Prisma models,
   built-in skills, scanner patterns, seeded agents) and dependency versions from source, rejects
   the status prose rule 1 bans, requires every capability doc to carry a `## Limitations` section,
   and fails on broken relative links. It runs as its own CI job with no install step. Run it after
   changing the schema, the node-type union, the skills, the scanner patterns, the seeded agents,
   or any dependency a doc names by version.

## history/

Completed roadmaps, closed build plans, point-in-time reviews, and research write-ups. Preserved
for design rationale — **the code is authoritative wherever they diverge.** These files are frozen:
they are not maintained, not checked for drift, and should not be edited or used to learn current
behaviour.

Before freezing anything new here, sweep it for facts that are still true — open gaps, items that
never shipped, known limitations — and promote those into a living doc first. A roadmap is history;
an item on it that was never built is current state.

The original 4-phase plan and its status matrix ([`PLAN.md`](./history/PLAN.md),
[`STATUS.md`](./history/STATUS.md)), the configurable-workflow-engine and platform-pivot roadmaps
with their per-phase build plans, the evals phase plans, the 2026-06 and 2026-07 repository
reviews, and research on agent dreaming, skills, and Claude Tag all live there.
