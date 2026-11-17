# Run plans

A run plan turns a stated goal into a workflow for one run. The launcher describes what they want;
the platform proposes existing templates that fit and can generate a new plan: a platform-enforced
core with model-authored steps around it. The launcher reviews the whole plan and approves it, and
only then does a run start, pinned to exactly the plan they approved.

A plan is a proposal, never a run. Nothing executes, and no pull request opens, until a person
approves it on the full preview.

---

## 1. The flow

1. **Route.** The goal and a repository go to the router, which ranks the templates the caller may
   launch. The user chooses an existing template (launched through the ordinary path) or asks for a
   new plan.
2. **Generate.** An asynchronous job authors the plan and returns a job id. The job result is the
   plan, persisted once, for its owner only.
3. **Preview.** The owner sees the stated goal, the node outline with each node marked as
   platform-enforced, added by the platform or generated for this request, the cost estimate with
   the steps that could not be priced, warnings and the pinned agent versions.
4. **Approve or reject.** Approval re-checks everything (section 5) and starts the run. A plan that
   no longer matches the platform is refused, never regenerated: the user generates a new one.

| Surface | How |
|---|---|
| Dashboard | **Start work** (`/start`), then **Describe the goal**. `/start?mode=plan&job=<jobId>` resumes a generation job and `/start?mode=plan&plan=<planId>` opens a plan's preview |
| API | `POST /api/v1/run-plans/route`, `POST /api/v1/run-plans`, `GET /api/v1/run-plans/jobs/:jobId`, `GET /api/v1/run-plans`, `GET /api/v1/run-plans/:id`, `POST /api/v1/run-plans/:id/approve`, `POST /api/v1/run-plans/:id/reject` |
| CLI | `auto-swe plan route\|create\|wait\|show\|list\|approve\|reject\|run`; approval needs an interactive confirmation or `--yes` |
| Slack | The channel assistant's `proposeRun` tool offers a **Generate plan** button to the person who asked; the plan is previewed and approved on the dashboard (section 7) |

Every route requires an ENGINEER and is refused for service principals. A plan is visible to its
owner only; anyone else gets `404`. The in-app assistant may create a plan with the user's
confirmation and may never approve one.

---

## 2. Two kinds of plan

| Mode | Built from | What it can do |
|---|---|---|
| `delivering` | The platform's engineering core | Implements, reviews, opens a draft pull request and waits for a human merge. Chosen when no agent is named |
| `output-only` | One launchable library agent | Produces text or artifacts that a person reviews. Delivers no branch and no pull request. Chosen when an agent is named |

Delivery of changes by non-engineering library agents is the separate [agent run](./agent-runs.md)
feature.

---

## 3. What the model may write

The plan's mandatory region is not model output. For a delivering plan the validate phase and the
engineering core (implementation, review loop, pull request, CI loop, human merge wait) must equal
the shipped `ticket-to-merge` template's nodes exactly: same ids, steps, configuration, inputs and
edges. The generator authors only:

- a **pre-region** before `implement`, built from a code-maintained step allowlist, agent nodes
  and human nodes;
- a **post-region** after the merge wait, limited to read-only and agent nodes.

The policy (`packages/shared/src/workflow/runPlan/`) is the security boundary, not the prompt:

- Free nodes write only under `context.scratch.*`, plus one designated channel,
  `context.planNotes`, which the core binds into the implementer's guidance. Nothing a free node
  writes reaches the review's inputs, the success criteria, the code result or the pull request step.
- Node ids match `^[A-Za-z][A-Za-z0-9_-]{0,63}$`, and the core's ids are reserved.
- Shell and container nodes, authored commands, MCP nodes, `fanOut` and `eval` nodes, and every
  step that pushes, posts, merges, starts runs or writes shared state are refused.
- Loops are bounded, and the worst-case number of node transitions of the free regions plus the
  core stays under the interpreter's cap.
- Free nodes may carry only an allowlisted progress `status`, so a plan cannot fake the dashboard's
  review or merge states.
- An output-only plan must show the exact output that its terminate step returns to a reviewing
  human, and no agent may run after the last review.

`checkSkeletonPolicy` and `validateSpec` run at generation, at approval and again in the worker when
the run starts. A spec is returned from generation only when all of them pass.

---

## 4. Generation

The `workflowAuthor` agent resolves with a run-plan prompt and a catalog restricted to the
allowlisted steps, the agents the requester may launch (never the platform agents) and no MCP
connections. The model sees only the requester's own text, wrapped in delimiters; repository, ticket
and template content never reach the author. A goal over 8,000 characters, or one containing the
wrapper's own tag, is refused rather than cut.

A bounded repair loop feeds policy errors back to the model. The attempt cap is the registry
setting `runPlans.generationMaxAttempts`. The platform injects the validate phase and the core, so
the model's output is never run as written.

The `runPlanRouter` agent ranks candidate templates. It sees template names and descriptions as
untrusted data, its output is intersected with the ids the gateway supplied, and reasons are
reduced to plain text.

---

## 5. Approval and launch

A plan stores its spec hash, the catalog hash, the resolved version of every agent it relies on
(including agents reached through steps such as the implementer and reviewer), the settings it was
made under, its owner and its repository. Approval is an atomic status change and refuses with a
named reason when any of these no longer holds:

| Refusal | Cause |
|---|---|
| `404` | Not the owner, or no such plan |
| `403` | Role below ENGINEER, repository reach lost, feature disabled |
| `409` with `details.drift` | Agents, settings, catalog, repository or spec changed since generation |
| `409` | The plan is not pending, or has expired |
| `422` | The stored spec fails the policy |
| `429` | Quota, or agent-run admission for an output-only plan |

An approved plan starts a run of the hidden **Planned Run** system template. The worker re-checks
the launcher, the policy and the agent pins, then pins the plan's spec as the run's
`specSnapshot`. No per-plan template exists, so there is nothing to re-run by id, schedule or
export; a planned run cannot be retried (`USE_PLAN_RERUN`) and the user makes a new plan. An
approval carries an `Idempotency-Key`; a retried approval of a live run answers `deduplicated`.

Pull requests opened by a planned run are never auto-merged, even on a repository in `auto` mode
of [pull-request evaluation](./pr-evaluation.md): a person merges them.

---

## 6. Limits and settings

| Setting (`/admin/platform-settings`) | Default | Meaning |
|---|---|---|
| `runPlans.enabled` | on | Kill switch |
| `runPlans.createPerUserPerHour` | 10 | Plans a user may start per hour (`0` disables) |
| `runPlans.routePerUserPerHour` | 30 | Ranking requests per user per hour (`0` disables) |
| `runPlans.maxPendingPerUser` | 5 | Plans a user may hold awaiting a decision |
| `runPlans.generationMaxAttempts` | 3 | Author attempts per plan (1 to 5) |

A person's limits are the lowest value across their teams and organizations, so choosing a more
permissive team's repository does not raise them. A started generation counts against the hourly
limit whether or not it yields a plan. Pending plans expire after 30 minutes; approval grants a
10-minute launch window. A scheduled sweep (`RUN_PLAN_SWEEP_ENABLED`, `RUN_PLAN_SWEEP_CRON`; every
15 minutes by default) expires and deletes plans that were never launched.

Plan, route and approval events are written to the audit log with ids, mode and team only; the goal
and the spec are never logged.

---

## 7. Slack

`proposeRun` records an intent and carries no goal text: the goal is the invoking person's own
message, taken verbatim by fixed code. The reply quotes it, names the repository and offers a
**Generate plan** button. A signed, expiring token binds the Slack user, channel, thread, goal and
repository; only that person may click, they must be a linked, active ENGINEER with repository
reach, and a replay is refused. A click starts generation and links to the dashboard. Slack never
approves a plan or starts a run.

---

## Key files

| Concern | File |
|---|---|
| Policy, allowlist, canonical core | `packages/shared/src/workflow/runPlan/` |
| Generation and router activities | `packages/worker/src/activities/generateRunPlanSpec.ts`, `routeRunPlan.ts`, `specAuthorLoop.ts` |
| Worker pin of the approved spec | `packages/worker/src/lib/plannedRunPin.ts` |
| Plan service, routes, quotas | `packages/gateway/src/lib/runPlanService.ts`, `routes/runPlans.ts`, `lib/runPlanQuotas.ts` |
| Dashboard | `packages/web/src/components/runPlans/` |
| CLI | `packages/cli/src/commands/plan.ts` |

---

## Limitations

- **The free regions can steer the implementer.** Text from a generated agent node can reach the
  implementer's guidance through `context.planNotes`. The core, the review network, the security
  gate, CI and the human merge still run on whatever the implementer produces, but the guidance
  itself is not verified.
- **Output-only plans have no step or wall-clock ceiling.** An `agent` node has no such fields, so
  library-agent plans are bounded by the team budget, agent-run concurrency admission and the
  transition cap, not by the agent-run ceilings.
- **The policy judges shape, not sense.** It does not decide whether the free nodes are a good way
  to do the task, and its transition bound over-approximates, so a fitting plan can be refused.
- **Cost estimates are floors.** They use role default prices and a fan-out guess; unpriced nodes
  are listed, not costed.
- **An approved plan expires if a worker is slow.** A worker that takes longer than the launch
  window to pick a run up loses the plan, and the run fails cleanly at its claim.
- **Plan text is operator-visible.** The goal is part of the generation workflow's input and history,
  so Temporal operators can read it. Gateway logs and audit rows do not carry it.
- **Only some model text is cleaned.** The summary, name and description are reduced to plain text;
  node titles and messages inside the spec are shown as text by the dashboard but are not rewritten.
- **A duplicate burst can answer a spurious `429`.** Requests with one `Idempotency-Key` each hold a
  quota slot while in flight; one that loses the start gives its own slot back.
- **Slack has no completion notice.** The plan row is created when the job is read, so the Slack
  message links to the job, and a goal over about 1,100 characters is sent to the dashboard instead.
- **The Slack token is single-use through Temporal, not a table.** It holds while the job's history
  exists, and the token lives 15 minutes.
- **A person in more than 50 teams and organizations** is limited by only the first 50 in a fixed order.
- **No "save to library" action.** A plan's spec is not exportable as a template from the preview.
- **CLI.** `plan run` always sends a fresh approval key.
