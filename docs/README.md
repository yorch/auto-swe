# Documentation

auto-swe is a durable, governed multi-agent workflow platform for software engineering teams. Its
flagship use case — ticket in, reviewed pull request out — is one workflow template built from
the same node types any team can author, and the Slack channel teammate is both a headline
capability and the surface teams drive the platform from.

These docs describe **how auto-swe works now**, in present tense. There is no status column here
and no roadmap: what shipped when lives in git history, and completed plans live in
[`history/`](./history/).

## Start here

| Doc | Covers |
|-----|--------|
| **[quickstart.md](./quickstart.md)** | Run auto-swe locally, from a clean checkout to a first run you can watch |
| **[concepts.md](./concepts.md)** | The vocabulary — runs, templates, versions, nodes, gates, agents, skills, scopes, connections |
| **[product-overview.md](./product-overview.md)** | What auto-swe is and who it is for — thesis, target users, capability map, primary use cases, differentiators, and what is deliberately out of scope |
| **[architecture.md](./architecture.md)** | How it is put together — system context, package map, run lifecycle, the workflow engine and its node types, the config cascade, auth, data model, infrastructure |
| **[workflow-nodes.md](./workflow-nodes.md)** | Writing a workflow spec by hand — every node type's fields, edges, output, failure handling and pitfalls, with a complete example of each, plus the run context, bindings and the expression language |
| **[workflow-inventory.md](./workflow-inventory.md)** | Generated from the code — every node type with its family, edges and executor step, every registered step with its config fields, and which built-in templates use each |
| **[agents.md](./agents.md)** | The agent layer — seeded agents and how they bind models, the review network, skills, implementer tools, MCP, and the `AgentTracer` pattern |

## Capabilities

| Doc | Covers |
|-----|--------|
| [hitl-workflows.md](./hitl-workflows.md) | Human-in-the-loop nodes (approval / decision / input / review), signal flow, the inbox, API |
| [autonomy-policies.md](./autonomy-policies.md) | When a run may act alone and when it must ask — risk classes, the scope cascade, failing closed, the decision log |
| [evals.md](./evals.md) | Output-quality measurement — the `eval` node, scorers, datasets, the regression harness, canary routing |
| [agent-runs.md](./agent-runs.md) | Running one library agent against a repository on demand — the throwaway workspace, delivery as a branch or draft PR through a trusted container and a deterministic push policy, the tool-grant rule, bounds and concurrency |
| [run-callbacks.md](./run-callbacks.md) | Telling the service that started a run how it went — team-registered callback endpoints, the `callback` field on agent runs, template runs and template webhooks, signed deliveries from a transactional outbox, retries, redelivery |
| [automations.md](./automations.md) | What starts runs without a person: event automations on a repository or a team (a source, its filters, a template and its options, limits), the decision ledger every event automation writes and who owns its rows, how to add an event source, and the other kinds |
| [inbound-events.md](./inbound-events.md) | Signed events from other services: a team's event endpoints (the URL, the three verification schemes, CloudEvents), JSON Pointers into the event, the `inbound.event` automation source that decides what an event starts, and the security model for event text |
| [ci-failure-triggers.md](./ci-failure-triggers.md) | A failed GitHub Actions run diagnosed from its logs and, when code can fix it, a draft fix into the branch that failed — the `ci-triage-and-fix` template, what it refuses to act on, and how untrusted log text is contained |
| [pr-evaluation.md](./pr-evaluation.md) | Judging the risk of a pull request the platform opened — the three classes and how each is decided, the reviewer brief, the `auto-swe/pr-evaluation` commit status, the in-repo `.auto-swe/pr-policy.yml`, the opt-in `auto` mode that asks GitHub to auto-merge a low-risk change, and its limits |
| [channel-assistant.md](./channel-assistant.md) | The Slack channel teammate — a capability in its own right and the platform's conversational control surface; turns, ambient and reactive modes, channel memory, personas, budgets |
| [memory.md](./memory.md) | Agent memory — lessons and channel memory in pgvector, how they are written, recalled, consolidated and gated |
| [nl-workflow-authoring.md](./nl-workflow-authoring.md) | Describing an automation in natural language and getting a validated `WorkflowSpec` back |
| [figma-integration.md](./figma-integration.md) | Design context — the `design-fidelity` skill and submit-time Figma enrichment |
| [knowledge.md](./knowledge.md) | Governed reusable knowledge — local capture, evidence, review/publication scopes, retrieval and trust boundaries |
| [repo-dependency-graph.md](./repo-dependency-graph.md) | Directed dependency edges between git repos — the `RepoDependency` model, the cross-team edge API and management UI, and the neighbour resolver |
| [bundles.md](./bundles.md) | Signed, versioned distribution of reusable agents, skills, scanner patterns, and templates across deployments |
| [qodo.md](./qodo.md) | Reading Qodo's review of a pull request through a team's read-only Qodo MCP connection — setup, output screening, the shared findings client and the `qodo.enabled` switch |
| [transcripts.md](./transcripts.md) | Full-fidelity agent model-call capture: recording, normalized reads, integrity hashes, retention and legal holds |
| [run-activity.md](./run-activity.md) | Unified run history — worker HTTP capture, audited container egress, execution events, activity APIs and dashboard export |
| [repo-access-gating.md](./repo-access-gating.md) | Making repository access agree with GitHub — the permission projection, the sweep and webhook refresh, and the advisory-then-enforce rollout |
| [repositories.md](./repositories.md) | What identifies a repository (host, owner, name), which hosts its URLs may point at, and sharing it with other teams |
- [`package-registries.md`](./package-registries.md) — admin-managed npm registries fronted by a worker-side proxy; the upstream credential never enters the workspace.
| [service-principals.md](./service-principals.md) | Team-owned machine identities that start and follow runs with scoped tokens of their own — the routes that accept them, what a launch checks, granting repositories as a lead's launch decision, attribution, token rotation |
| [user-github-credentials.md](./user-github-credentials.md) | A user's own GitHub or GitHub Enterprise token for a repository — used only for runs they launch, the host allowlist, and how the access gate judges it |
| [work-views.md](./work-views.md) | The pull-request and ticket views — the recorded PR lifecycle and its webhook events, the two list APIs, and how visibility is applied to every row and aggregate |
| [reporting.md](./reporting.md) | Delivery, quality, budget, automation, and approval reports — cohorts, calculations, bounds, and limitations |

## Configuration & operations

| Doc | Covers |
|-----|--------|
| [configuration.md](./configuration.md) | Where every knob lives — the environment/integration/registry split, the setting registry and its cascade, who may change what, run pinning |
| [deployment.md](./deployment.md) | Production runbook — environment, database, Temporal, images, service layout, smoke test, day-2 ops, hardening |
| [upgrade-notes.md](./upgrade-notes.md) | What an operator does on a deployment that ran earlier code — fixed defects that exposed a credential, keyed by the condition and the fixing commit: who is affected, what was exposed and for how long, what to rotate or purge, how to verify the fix |
| [user-activity.md](./user-activity.md) | First-party activity events — authenticated denials, sensitive reads and exports, and opt-in page views; what is recorded, retention, and the privacy stance |
| [audit-log.md](./audit-log.md) | The append-only audit log — what is recorded, the `context` that says how a request arrived (credential path, truncated address, assistant or MCP client), launch and sign-in rows, and privacy |
| [model-configuration.md](./model-configuration.md) | DB-backed model selection and provider credentials — the scope cascade, encryption, day-2 operations |
| [oauth-setup.md](./oauth-setup.md) | GitHub, Google, and Okta sign-in; magic-link email |
| [mcp-server.md](./mcp-server.md) | The MCP endpoint — Streamable HTTP transport, how a bearer token is verified on every request, protected resource metadata, the `mcp.*` switches |
| [local-agents.md](./local-agents.md) | Claude Code CLI/Desktop and Codex setup, delegation skills, OAuth consent, polling and local review |
| [github-app-setup.md](./github-app-setup.md) | GitHub App creation, permissions, installation, auth modes |
| [slack-app-setup.md](./slack-app-setup.md) | Slack app manifest import and admin configuration |
| [packages/cli/README.md](../packages/cli/README.md) | `auto-swe` CLI — work requests, runs, workflow templates, tokens, bundles |

Also here: [`slack-app-manifest.json`](./slack-app-manifest.json).

## These files ship

Two surfaces render this directory, so a doc is a product surface and not only a file in a
checkout:

| Surface | Where | Audience |
|---|---|---|
| The dashboard, at `/docs` | `packages/web/src/app/docs/` | Operators signed in to a deployment |
| The public site | `site/`, published to GitHub Pages | Anyone evaluating the project |

Neither owns these files. The dashboard reads them at build time; the site copies them into its
own content collection, gitignored and rebuilt from scratch on every run. Write markdown for a
checkout, as normal, and keep three things in mind:

- **Only the top level is published**, by both. `history/` is deliberately left out — frozen docs
  presented as current behaviour are worse than no docs.
- **Cross-doc links are rewritten**, so `[agents.md](./agents.md)` works as a file path, as
  `/docs/agents`, and as a page on the site. Write them relative and let each surface translate.
- **A link the surface cannot serve is handled differently by each, on purpose.** The dashboard
  degrades it to plain text, because bouncing an operator out of the product is worse than a
  dead-looking word. The site sends it to the file on GitHub, because a public reader is already
  on the open web. `packages/web/src/lib/docLinks.ts` and `site/scripts/docLinks.mjs` each own one
  half of that, and both are unit-tested against every link shape in this tree.

Mermaid blocks render as diagrams on the public site. In the dashboard they render as labelled
diagram source — the renderer is a 79-package dependency that has not been taken on there, and a
static build can pay that cost once where a shipped application would pay it on every load.

A new doc must also be placed in the site's sidebar (`site/scripts/manifest.mjs`). The build fails
if it is not: an unplaced doc still resolves by URL, so nothing else would notice that no reader
can find it.

## Where known gaps are documented

Gaps live **next to the feature they belong to**, not in a central list — a central list is what
drifted last time. Every capability doc ends with a `## Limitations` section stating what is not
built, not proven, or deliberately constrained, and `yarn docs:check` fails if one is missing.

| Scope | Where |
|---|---|
| Product-level boundaries the system will not cross | [product-overview.md §7](./product-overview.md#7-non-goals--out-of-scope) |
| Overall maturity and what is unproven | [product-overview.md §8](./product-overview.md#8-maturity) |
| A specific capability's gaps | That capability's own **Limitations** section |

So: for "what are the known gaps in X", open that capability’s own doc and jump to the end. For "what is this
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
   rejects a setting key no longer defined in the registry, and fails on broken relative links. It
   runs as its own CI job with no install step. Run it after changing the schema, the node-type
   union, the skills, the scanner patterns, the seeded agents, a setting key, or any dependency a
   doc names by version.

## history/

Completed roadmaps, closed build plans, point-in-time reviews, and research write-ups. Preserved
for design rationale — **the code is authoritative wherever they diverge.** These files are frozen:
they are not maintained, not checked for drift, and should not be edited or used to learn current
behaviour.

Before freezing anything new here, sweep it for facts that are still true — open gaps, items that
never shipped, known limitations — and promote those into a living doc first. A roadmap is history;
an item on it that was never built is current state.

The original 4-phase plan and its status matrix ([`PLAN.md`](./history/PLAN.md),
[`STATUS.md`](./history/STATUS.md)), the horizontal-platform PRD
([`agentic-workflow-platform-prd.md`](./history/agentic-workflow-platform-prd.md)) and the
configurable-workflow-engine and platform-pivot roadmaps that carried it out, with their per-phase
build plans, the evals phase plans, the 2026-06 and 2026-07 repository
reviews, the decision logs of finished features (in-app assistant, GitHub Enterprise sign-in,
Jira filter polling, Qodo follow-ups, author identity and support info), and research on agent dreaming, skills, Claude Tag, and LangChain Deep Agents all live
there.
