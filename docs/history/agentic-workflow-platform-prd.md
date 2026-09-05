# Product Requirements Document — auto-swe as an Agentic Workflow Platform

> Status: direction document, not yet implemented. Captures the reframed product thesis, target users, core concepts, gap analysis, and roadmap agreed in 2026-08-27. For the current system see [architecture.md](../architecture.md), [product-overview.md](../product-overview.md), and [agents.md](../agents.md).

---

## 1. Problem statement

Teams across an organization run repeatable, judgement-intensive work that sits between a pure SaaS automation and a fully human process:

- A support team drafts hundreds of ticket replies per day, each needing tone checks, policy compliance, and occasional escalation.
- A product team turns PRDs into stories, acceptance criteria, and implementation queue items.
- A content team drafts, reviews, and publishes updates across Notion, Confluence, Slack, and email.
- An engineering team turns tickets into reviewed pull requests.

These workflows share the same underlying pattern: **receive a request, gather context, produce a draft outcome, validate it against success criteria, publish or hand off, and learn from the result.** Existing tools either force this into rigid BPM forms, expose only raw LLM chat, or automate one vertical well without governance. auto-swe already has the durable execution, governance, and agent infrastructure to support all of them; it is currently packaged and seeded as a software-engineering tool.

This PRD reframes auto-swe as a **horizontal agentic workflow platform** where the engineering use case is one important vertical, not the product boundary.

---

## 2. Product thesis

**auto-swe is a programmable, governed multi-agent workflow platform for teams.**

A workflow is a versioned JSON DAG executed on Temporal, with agents running inside isolated workspaces, human approval gates wherever a team wants them, and cost, security, and observability applied to every run. The flagship mental model is:

```
request → workspace → work → quality gate → publish outcome → external signal → memory
```

In the engineering vertical this becomes **ticket → reviewed pull request**. In other domains it becomes **ticket → drafted reply**, **PRD → stories**, **brief → published doc**, or **alert → reconciled report**. The same engine, governance model, and authoring surfaces serve all of them.

---

## 3. Target users

| Persona | What they need | Primary surfaces |
|---|---|---|
| **Platform / workflow builder** | Build reusable, governed workflows for their domain; configure agents, skills, integrations, and policies. | Admin console, agent library, model config, scanner patterns, template editor, bundles. |
| **Domain operator** | Run a workflow against a specific request, review outputs, and approve external-facing actions. | Dashboard submit flow, run viewer, inbox, Slack. |
| **Business user / mixed-sophistication team member** | Start from a template gallery or describe what they want in natural language; customize without writing code. | NL authoring, template gallery, form-driven wizards. |
| **Power user / engineer** | Drop to code bundles, custom `containerStep` nodes, and MCP tools for advanced cases. | CLI, SDK, bundle registry. |

The Slack channel teammate is the default conversational surface across all personas and domains.

---

## 4. Core concepts

### 4.1 Request → validated outcome

Every workflow run starts with a **request** and ends with an **outcome**. The engine guarantees that the outcome has passed whatever validation the workflow declares, including automatic checks, agent reviews, and human gates.

### 4.2 Workspace provider

The workspace is the container in which the agent performs work. It is a role, not a git repository:

- `gitRepoWorkspace` — clone a branch, run tests and builds.
- `documentWorkspace` — load source documents, draft and review content.
- `recordWorkspace` — fetch and mutate records in a CRM, ticketing, or HR system.
- `apiOnly` — no persistent local container; the agent calls APIs and returns a structured result.

The workspace provider is selected by the workflow template and configured through a `Connection`.

### 4.3 Outcome publisher

The publisher materializes the validated outcome into the world:

- `openPullRequest`
- `createOrUpdateDocument`
- `updateRecord`
- `sendMessage`
- `createTrackerItem`
- `queueForApproval` — external-facing actions that require explicit human sign-off before publishing.

Publishers respect the **autonomy policy** configured on the template or team.

### 4.4 Autonomy policy

The platform supports **conditional autonomy**, not a blanket "auto-merge" or "human-in-the-loop-for-everything" rule:

- Internal drafts, summaries, and status updates may run autonomously.
- External-facing or regulated actions (public replies, published documents, customer record changes) require human approval.
- High-risk or mass actions may require dual approval.

The policy is data-driven and overridable per workflow template, team, channel, or organization.

### 4.5 Quality gates

Quality is domain-specific. The `eval` node and a generic `qualityGate` step run:

- automatic scorers (factual checks, policy regex, output schema validation);
- agent reviewers (security, domain logic, performance, brand voice, compliance);
- human review, approval, decision, or input nodes.

All gates must pass before a publisher runs.

### 4.6 Memory

Every completed run writes a structured `MemoryItem` with an embedding. Retrieval keys off the workflow's `scope` and the entity it touched (`repoId`, `documentId`, `ticketId`, `channelId`, `projectId`, etc.) so future runs on similar work receive relevant lessons.

---

## 5. Priority domains

The platform is horizontal, but the first three verticals are, in order:

1. **Support / Ops** — ticket triage, draft responses, escalation, internal status updates.
2. **Product** — PRD analysis, story decomposition, roadmap updates, acceptance criteria.
3. **Content / Comms** — draft and review documents, publish to Notion/Confluence, send Slack updates and emails.

The existing **software engineering** vertical remains fully supported and is expected to be the most mature reference implementation.

Other domains (Legal, Finance, HR, IT, Data) are out of the initial scope but must not be architecturally precluded.

---

## 6. Success metrics

Priority order:

1. **Time saved** — estimated human hours removed per completed workflow.
2. **Error rate vs. human baseline** — mistakes or regressions compared to the manual process the workflow replaces.
3. **Cost per outcome** — compute, LLM, and storage spend divided by completed workflows, by domain.
4. **Autonomy rate** — share of workflows that complete end-to-end without human escalation, segmented by action risk class.

Secondary metrics: number of teams/workflows onboarded, human acceptance rate, and cycle time from request to outcome.

---

## 7. Non-goals and boundaries

auto-swe is **not**:

- A no-code automation tool like Zapier or Make. It is programmable; templates and skills are authored, versioned, and governed.
- An enterprise BPM / BPA replacement like ServiceNow or Camunda. It does not replace formal process modeling; it augments execution with agents.
- An RPA / screen-scraping tool. It acts through APIs, connectors, and MCP servers, not by driving third-party UIs.
- A chatbot platform. Conversations (especially Slack) are a control surface, not the primary product.
- A personal coding assistant like Copilot or Cursor. It is a team/organization platform for repeatable workflows.

Other boundaries:

- No autonomous external-facing action without policy check and, when required, human approval.
- Workspace isolation uses Docker-in-Docker in the near term. Kubernetes-based isolation is a possible future expansion route for scale or multi-tenant deployments, not current scope.
- No IP-level egress filtering for shell steps; DNS-based filtering only.
- No multi-arm A/B tests; exactly two arms per template experiment.
- No localization of the interface; English-only UI and notifications.

---

## 8. Current state assessment

### 8.1 What already supports the reframe

The engine, orchestration, and governance layers are largely domain-agnostic:

- `WorkflowSpec` already supports 15 node types including generic control flow, `agent`, `mcp`, `shell`, `containerStep`, `eval`, and four human-in-the-loop nodes.
- The interpreter is a pure functional DAG walker; only the activity dispatcher is worker-specific.
- Temporal provides durable execution, signals, and replay for multi-day workflows.
- The five-scope configuration cascade (`WORKFLOW_TEMPLATE → CHANNEL → TEAM → ORGANIZATION → GLOBAL`) works for any domain.
- The `Connection` model is generic: a string `type` plus a JSON `config` bag.
- The `mcp` node and MCP tool binding allow new integrations to be added without worker code changes.
- Natural-language workflow generation (`generateWorkflowSpec`) already exists with a validation/repair loop.
- The Slack channel assistant already supports general task decomposition (`planChannelTask`, `runChannelSubtasks`).

### 8.2 What is SWE-biased and must generalize

- **Activity catalog.** Most registered steps (`executeImplementation`, `runLint`, `runTypecheck`, `runTests`, `runBuild`, `runVulnScan`, `createOrUpdatePullRequest`, `fetchCILogs`, `waitForCiByPolling`, `resolveMergeConflict`) assume code repositories and CI pipelines.
- **Skill catalog.** The built-in skill catalog includes the original 28 engineering prompts (test-first, async safety, migration safety, PR description quality, etc.) plus the Phase 2 support and product packs, for a current count of 35.
- **Agent roster.** All 22 seeded agents are SWE roles.
- **Workspace model.** `executeImplementation` assumes a git clone into a Docker container with build/test tools.
- **Output model.** The default template terminates with `prNumber` and `prUrl`; there is no generic publisher abstraction.
- **Request intake.** `RepoWorkRequest` and `validateContext` expect ticket/repo-shaped input.
- **Memory retrieval.** `MemoryItem` carries `repoId`, `failureType`, and `lessonSummary`; retrieval logic is repo-centric.
- **Quality gates.** The named gate activities are lint/typecheck/tests/build/vulnerability/performance.
- **Run viewer.** Built around a code-diff and CI-status mental model.

### 8.3 Overall readiness

| Layer | Readiness |
|---|---|
| Engine / orchestration / governance | High |
| Extensibility abstractions (connections, MCP, eval) | Medium-High |
| Domain content (skills, agents, activities, outputs) | Low |
| UX / authoring / run viewer for non-engineers | Low-Medium |

---

## 9. Flagship flow: generic request → validated outcome

The default template should be reframed as a generic pattern. Each domain provides concrete bindings for the same stages.

```text
start
  │
  ▼
validateContext          ← extract success criteria and confirm inputs
  │
  ▼
resolveWorkspace         ← materialize the work container (git repo, docs, records, none)
  │
  ▼
executeWork              ← agent + tools produce a draft outcome
  │
  ▼
qualityGate              ← eval + agent review + human gate
  │
  ├─ failed ─► fix loop ─┐
  │                      │
  └─ passed ─► publishOutcome
                 │
                 ▼
         waitForExternalSignal  ← CI result, approval, merge, etc.
                 │
                 ▼
          commitToMemory
                 │
                 ▼
               done
```

### Engineering binding

| Generic stage | SWE binding |
|---|---|
| `validateContext` | Extract success criteria from ticket description and repo context. |
| `resolveWorkspace` | `gitRepoWorkspace` — clone repo, checkout branch. |
| `executeWork` | `executeImplementation` with TDD loop. |
| `qualityGate` | `runReviewNetwork` + `runLint`/`runTypecheck`/`runTests`/`runBuild`/`runVulnScan`. |
| `publishOutcome` | `createOrUpdatePullRequest`. |
| `waitForExternalSignal` | CI webhook + human merge webhook. |
| `commitToMemory` | `commitToMemory` scoped to repo. |

### Support binding

| Generic stage | Support binding |
|---|---|
| `validateContext` | Extract intent, urgency, and policy constraints from ticket. |
| `resolveWorkspace` | `recordWorkspace` — fetch ticket and related history from Zendesk/HubSpot. |
| `executeWork` | `supportTriager` + `supportResponder` draft a reply and classification. |
| `qualityGate` | Tone/policy check + `humanReview` for public replies. |
| `publishOutcome` | `postInternalComment` autonomously; `postPublicReply` only after approval. |
| `waitForExternalSignal` | Approval signal or ticket-update signal. |
| `commitToMemory` | Scope to ticket + channel. |

### Product binding

| Generic stage | Product binding |
|---|---|
| `validateContext` | Extract PRD readiness criteria and constraints. |
| `resolveWorkspace` | `documentWorkspace` — load PRD and related docs. |
| `executeWork` | `productAnalyst` + `prdWriter` produce stories and acceptance criteria. |
| `qualityGate` | PRD readiness eval + human review. |
| `publishOutcome` | `createTrackerItems` in Jira/Linear and update roadmap doc. |
| `waitForExternalSignal` | Optional PM approval signal. |
| `commitToMemory` | Scope to project. |

---

## 10. Roadmap

### Phase 0 — Reframe the foundation (4–6 weeks)

- Reposition docs, UI labels, and seeded template names from ticket/repo/PR language to request/outcome language where the surface is meant to be generic.
- Introduce `WorkspaceProvider` and `OutcomePublisher` abstractions in `packages/shared`.
- Generalize `MemoryItem` retrieval to use `scope` + `entityType` + `entityId` rather than repo only.
- Add a typed connection-type registry (`git_repo`, `notion`, `zendesk`, `hubspot`, `slack_workspace`, `http_api`, `mcp`).
- Make `RunInput` payload generic; `RepoWorkRequest` becomes one validated schema among many.

**Exit criteria:** a new support or product workflow can be authored without touching git/Docker code paths; all existing tests pass.

### Phase 1 — Generic request intake + workspace model (6–8 weeks)

- Promote generic workflow trigger endpoints to first-class paths.
- Implement workspace providers: `gitRepoWorkspace`, `documentWorkspace`, `recordWorkspace`, `apiOnly`.
- Add OAuth/API credential flows for Notion, Zendesk, HubSpot, and a generic `http_api` connection.
- Add generic activities: `readSource`, `writeOutcome`, `runTool`, parameterized by connection type.
- Refactor `validateContext` to accept a schema-driven payload and produce domain-agnostic success criteria.

**Exit criteria:** a workflow reads a Notion page, drafts content, and writes it back with no git step; a workflow fetches a Zendesk ticket and posts a comment.

### Phase 2 — Domain activity packs (8–10 weeks)

Ship three packs in priority order:

**Support / Ops pack**

- Activities: `fetchTicket`, `classifyTicket`, `draftResponse`, `postInternalComment`, `postPublicReply`, `escalateTicket`.
- Agents: `supportTriager`, `supportResponder`.
- Skills: ticket tone guidelines, KB retrieval, escalation policy, response templates.

**Product pack**

- Extend existing PRD activities: `researchMarketContext`, `draftAcceptanceCriteria`, `updateRoadmapDoc`.
- Agents: `productAnalyst`, `prdWriter`.
- Skills: PRD readiness check, story decomposition, acceptance criteria first.

**Content / Comms pack**

- Activities: `loadSourceDocs`, `draftContent`, `checkBrandVoice`, `publishToNotion`, `publishToConfluence`, `sendSlackUpdate`, `sendEmail`.
- Agents: `contentWriter`, `brandReviewer`.
- Skills: brand voice, plain language, source citation, audience tailoring.

**Exit criteria:** each pack ships with one starter template and a working end-to-end demo.

### Phase 3 — Conditional autonomy + governance (6–8 weeks)

- Add an `autonomyPolicy` model attached to templates and teams.
- Implement `publishOutcome` activity that checks the policy and either publishes or creates an approval step.
- Add generic policy evaluators: `policyCheck`, `brandCheck`, `factualCheck`, `piiCheck`.
- Extend the `eval` node with rubric refs that can point to team policies and documents.
- Audit trail: log every publish, approval, and rejection with the exact content version.

**Exit criteria:** a team can configure "drafts are auto, public replies require one approval, mass emails require two"; the run viewer shows the autonomy decision path.

### Phase 4 — NL-first authoring + template gallery (6–8 weeks)

- Make `generateWorkflowSpec` the default entry point for new templates.
- Build a template gallery with domain starters.
- Add a form-driven wizard that generates a spec from answers rather than free text.
- Add a human-in-the-loop spec review step before a generated template is activated.
- Allow refinement of generated templates in the visual editor.

**Exit criteria:** a non-engineer can create and run a new workflow from a sentence in under 5 minutes; generated specs pass validation on the first attempt more than 80% of the time.

### Phase 5 — Success metrics + analytics (4–6 weeks)

- Track `estimatedHumanTimeSaved` per run and per template.
- Track `humanReviewRate` and `autonomyRate` by action risk class.
- Track `errorRateVsHuman` by domain.
- Extend cost-per-outcome dashboards by outcome type (PRs, documents, records, messages).

**Exit criteria:** dashboard shows time saved, autonomy rate, and cost per outcome by domain; teams can A/B templates with the same infrastructure.

### Phase 6 — Ecosystem + scale (ongoing)

- Connector marketplace / bundle registry for community connectors.
- Additional integrations: Salesforce, Workday, Confluence, Google Docs, Intercom.
- Enterprise features: SSO scoping, data residency controls, retention policies.
- Kubernetes-based workspace isolation as an alternative to Docker-in-Docker for scale or multi-tenant deployments.
- Channel assistant as a primary workflow launcher for non-engineering domains.

---

## 11. Dependencies and sequencing

- Phase 0 and Phase 1 can run in parallel, but Phase 2 packs depend on the workspace abstractions in Phase 1.
- Phase 3 governance should be designed during Phase 0/1 so domain packs do not hardcode HITL rules that later need migration.
- Phase 4 NL authoring depends on the generic activity catalog built in Phase 1.
- Phase 5 metrics should be instrumented from Phase 1 onward so data exists by the time dashboards ship.
- The Slack channel assistant already supports general task decomposition; its UI and prompts should be updated as part of Phase 2 and Phase 4.

---

## 12. Open questions and limitations

- The exact list of first-class connectors beyond Notion, Zendesk, HubSpot, Slack, and Jira/Linear is not finalized and should be validated with the first design partners.
- The `documentWorkspace` implementation details — whether to mount remote docs via API, cache them locally, or use a headless editor — are not specified here.
- How `estimatedHumanTimeSaved` is calibrated per domain is left to Phase 5; initial values will be self-reported template metadata.
- The run viewer redesign for non-code outputs (rendering documents, record diffs, messages) is scoped but not detailed.
- Whether the generic workflow engine should also support a simpler linear/case-management execution mode, in addition to the DAG, is an open UX question for Phase 4.
- This PRD intentionally does not prescribe specific LLM models or providers; model selection remains DB-driven through the existing cascade.
- The engineering vertical is the only one that currently has a complete, tested end-to-end flow. Other domains will need real integration testing and partner feedback before they reach equivalent maturity.

---

## 13. Affected files and areas

- `packages/shared/src/workflow/spec.ts` — node types (mostly stable, may add generic quality/publisher nodes).
- `packages/shared/src/workflow/defaultEngineeringSpec.ts` — reframe as one binding of the generic flagship.
- `packages/shared/src/workflow/stepRegistry.ts` — add generic workspace, publisher, and quality activities.
- `packages/worker/src/activities/` — new domain packs and generic abstractions.
- `packages/shared/src/skills/` — new skill packs for support, product, content.
- `packages/shared/src/prisma/schema.prisma` — `Connection.type` registry, `WorkspaceProvider`, `OutcomePublisher`, generalized `MemoryItem` indexes, `autonomyPolicy`.
- `packages/web/src/app/` — template gallery, NL authoring default, run viewer for non-code outcomes.
- `packages/cli/` and `packages/sdk/` — generic workflow authoring and bundle submission.
- `docs/product-overview.md`, `docs/architecture.md` — update to reflect the reframed positioning once implementation begins.
