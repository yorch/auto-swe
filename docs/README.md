# Documentation

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
| [channel-assistant.md](./channel-assistant.md) | The Slack channel teammate — turns, ambient and reactive modes, channel memory, personas, budgets |
| [nl-workflow-authoring.md](./nl-workflow-authoring.md) | Describing an automation in natural language and getting a validated `WorkflowSpec` back |
| [figma-integration.md](./figma-integration.md) | Design context — the `design-fidelity` skill and submit-time Figma enrichment |

## Configuration & operations

| Doc | Covers |
|-----|--------|
| [deployment.md](./deployment.md) | Production runbook — environment, database, Temporal, images, service layout, smoke test, day-2 ops, hardening |
| [model-configuration.md](./model-configuration.md) | DB-backed model selection and provider credentials — the scope cascade, encryption, day-2 operations |
| [oauth-setup.md](./oauth-setup.md) | GitHub and Google OAuth apps; magic-link email |
| [github-app-setup.md](./github-app-setup.md) | GitHub App creation, permissions, installation, auth modes |
| [slack-app-setup.md](./slack-app-setup.md) | Slack app manifest import and admin configuration |

Also here: [`slack-app-manifest.json`](./slack-app-manifest.json) and [`redesign/`](./redesign/)
(dashboard design screenshots).

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

1. **Present tense, current state.** No shipped-status, PR numbers, phase labels, or "now shipped"
   narration. That is what git history is for.
2. **Countable claims are enforced.** `yarn docs:check` derives facts (node types, Prisma models,
   built-in skills, scanner patterns, seeded agents) from source and fails CI on any living doc
   that disagrees. Run it after changing the schema, the node-type union, the skills, the scanner
   patterns, or the seeded agents.

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
