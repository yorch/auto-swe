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
   the steps that could not be priced, warnings and the pinned agent versions. An agent node
   reads "runs agent X on the goal" or "on the output of Y", and a node whose output reaches the
   implementer carries the badge **Output becomes guidance for the implementer**. The CLI prints
   the same lines. The API's `nodes[]` carries, per node, `agentRef`, `inputs` (the source path of
   each input and whether it has a fallback value, never a literal or the fallback itself), `writes`, `feedsImplementer` and, when the node has one, a cleaned
   `message` of at most 500 characters.
4. **Approve or reject.** Approval re-checks everything (section 5) and starts the run. A plan that
   no longer matches the platform is refused, never regenerated: the user generates a new one.

| Surface | How |
|---|---|
| Dashboard | **Start work** (`/start`), then **Describe the goal**. `/start?mode=plan&job=<jobId>` resumes a generation job and `/start?mode=plan&plan=<planId>` opens a plan's preview |
| API | `POST /api/v1/run-plans/route`, `POST /api/v1/run-plans`, `GET /api/v1/run-plans/jobs/:jobId`, `GET /api/v1/run-plans`, `GET /api/v1/run-plans/:id`, `POST /api/v1/run-plans/:id/approve`, `POST /api/v1/run-plans/:id/reject`, `POST /api/v1/run-plans/:id/save-as-template` |
| CLI | `auto-swe plan route\|create\|wait\|show\|list\|approve\|reject\|run\|save`; `auto-swe run --describe "<goal>" --repo=<org/name> [--agent=<key>] --yes` is an alias of `plan run`. Approval needs an interactive confirmation or `--yes` |
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
edges. The validate phase is the whole of it (ticket gather, actionability stop, `validateContext`
and the success-criteria write): a plan with a lone or edited `validateContext`, or a second
validator beside the phase, is refused with `VALIDATE_PHASE_MISMATCH`. The phase's entry node
(`gatherTicket`) must dominate the rest of the phase and the implementation: a path from the plan's
entry that reaches a later phase node or `implement` without passing it is refused with
`VALIDATE_ENTRY_BYPASSED`. When the generator writes no
validation the platform attaches the shipped phase ahead of the implementation. The generator
authors only:

- a **pre-region** before `implement`, built from a code-maintained step allowlist, agent nodes
  and human nodes;
- a **post-region** after the merge wait, limited to read-only and agent nodes.

The policy (`packages/shared/src/workflow/runPlan/`) is the security boundary, not the prompt:

- Free nodes write only under `context.scratch.*`, plus one designated channel,
  `context.planNotes`, which the core binds into the implementer's guidance. The validate phase,
  which is the platform's, also writes `context.ticket` (from `gatherTicketContext`) and
  `context.successCriteria` (from `validateContext`); no model-written node may. Nothing a free node
  writes reaches the review's inputs, the success criteria, the code result or the pull request step.
- An `agent` node sets neither `userMessage` nor `systemPrompt`. Its message is its one input,
  bound by `from` to the goal (`request.description`) or to the whole output of an agent node that
  runs before it (`nodes.<agent>.output`), so every agent works from the goal or from what an
  earlier agent made of it and the preview can name the source (`AGENT_MESSAGE_AUTHORED`,
  `AGENT_INPUT_UNBOUND`). The input's name is fixed too, because the worker folds it into the
  message of an agent that reads another agent's `{ object, text }` output: it is exactly `goal` for
  the goal and exactly `prior` for an earlier agent's output (`AGENT_INPUT_KEY_INVALID`). A `step`
  node's input names come from a per-step allowlist, so no free step accepts an arbitrary name. The implementer receives `context.planNotes` under the heading "Notes from
  earlier plan steps (generated, not written by the requester)", never as the requester's guidance.
- Node ids match `^[A-Za-z][A-Za-z0-9_-]{0,63}$`, and the core's ids are reserved.
- Shell and container nodes, authored commands, MCP nodes, `fanOut` and `eval` nodes, and every
  step that pushes, posts, merges, starts runs or writes shared state are refused.
- Loops are bounded, and the worst-case number of node transitions of the free regions plus the
  core stays under the interpreter's cap.
- Free nodes may carry only an allowlisted progress `status`, so a plan cannot fake the dashboard's
  review or merge states.
- Before the policy runs and the hash is taken, the display text of free nodes is reduced to plain
  text: non-human node titles (up to 80 characters), human-node titles (up to 200), group names (up to
  40), human-node descriptions (up to 2,000), decision option labels and input field labels (up to
  100), and the message of a terminal failure shorthand (up to 2,000). Ids, edges, bindings, inputs,
  config, steps, option values and select options are not rewritten, and in a delivering plan the nodes
  of the core and the validate phase are untouched.
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
| `403` `AGENT_RUNS_DISABLED` | Agent runs are switched off, for an output-only plan |
| `409` `PLAN_LAUNCH_FAILED` | A retried approval finds that the run it started has failed |
| `409` `PLAN_LAUNCH_IN_PROGRESS` | A retried approval arrives while the plan is still approved with no run recorded, so the first request can still roll back; a retry is answered `deduplicated` only once the plan is launched or its run exists and has not failed |
| `429` `AGENT_RUN_CONCURRENCY_EXCEEDED` | Agent-run concurrency limit, for an output-only plan. Per-user quotas answer `429` on creation and ranking, not on approval |

An approved plan starts a run of the hidden **Planned Run** system template. The worker re-checks
the launcher, the policy and the agent pins, then pins the plan's spec as the run's
`specSnapshot`. No per-plan template exists, so there is nothing to re-run by id, schedule or
export; a planned run cannot be retried (`USE_PLAN_RERUN`) and the user makes a new plan. An
approval carries an `Idempotency-Key`; a retried approval of a live run answers `deduplicated`. The
CLI's `plan approve` and `plan run` accept `--idempotency-key=K` for that approval; without it a fresh
key is generated for each call.

Pull requests opened by a planned run are never auto-merged, even on a repository in `auto` mode
of [pull-request evaluation](./pr-evaluation.md): a person merges them.

### Saving a plan as a template

A plan can be saved as an ordinary workflow template, so a plan that worked can be launched again
through the template path. `POST /api/v1/run-plans/:id/save-as-template` takes an optional `name`
(1 to 120 characters; the spec's own name is the default) and answers `201` with the template id,
name, version and `status: 'DRAFT'`. The CLI form is `auto-swe plan save <planId> [--name=NAME]`, and
the dashboard preview offers **Save as workflow template** on any plan that can be saved; a person
who is not a lead and tries it sees "Only team leads can save templates."

- Only the plan's owner may save it, and only while the owner is a LEAD or ADMIN of the plan's owning
  team (a platform ADMIN may too). A service principal is refused.
- The plan must not be scrubbed (`409` `PLAN_SCRUBBED`), rejected or expired (`409`
  `PLAN_NOT_SAVEABLE`). Pending, approved and launched plans can be saved.
- A name already used in the team answers `409` `NAME_CONFLICT`; the name is never changed to
  avoid it. A reserved name answers `400` `RESERVED_TEMPLATE_NAME`.
- The draft is created in the plan's team, never as the default template, through the same
  persistence path as a generated draft, and it is marked as generated by a run plan. Someone other
  than the plan's owner must review it before it can be promoted or activated: the owner gets
  `SELF_REVIEW_FORBIDDEN` on review (a platform ADMIN is exempt from that rule), and promoting or
  activating a version with no recorded review answers `REVIEW_REQUIRED`. A schedule is refused the
  same way (`409` `REVIEW_REQUIRED` on create and on a retarget), and a fire of a schedule that
  already names such a version is refused by the worker and runs nothing. The template's workspace
  provider is `git_repo` for every plan, output-only ones included.
- The in-app assistant may save a plan only with the user's confirmation.
- The save writes the audit event `run_plan.saved_as_template`, with ids only.

---

## 6. Limits and settings

| Setting (`/admin/platform-settings`) | Default | Meaning |
|---|---|---|
| `runPlans.enabled` | on | Kill switch; the worker re-reads it at launch, so disabling it also refuses an already approved plan (`PLAN_FEATURE_DISABLED`) |
| `runPlans.createPerUserPerHour` | 10 | Plans a user may start per hour (`0` disables) |
| `runPlans.routePerUserPerHour` | 30 | Ranking requests per user per hour (`0` disables) |
| `runPlans.maxPendingPerUser` | 5 | Plans a user may hold awaiting a decision |
| `runPlans.generationMaxAttempts` | 3 | Author attempts per plan (1 to 5) |
| `runPlans.launchWindowMinutes` | 10 (1 to 240) | How long after approval a worker may still start the plan's run |
| `runPlans.launchedRetentionDays` | 90 (0 to 3650) | Days a launched plan keeps its goal and plan body before the sweep scrubs it; `0` keeps them forever |

A person's limits are the lowest value across their teams and organizations, so choosing a more
permissive team's repository does not raise them. A started generation counts against the hourly
limit whether or not it yields a plan. Pending plans expire after 30 minutes. Approval grants the
launch window, `runPlans.launchWindowMinutes` (10 minutes by default), resolved at the plan's team
and organization when the plan is approved; a plan already approved keeps the window it was given.
A scheduled sweep (`RUN_PLAN_SWEEP_ENABLED`, `RUN_PLAN_SWEEP_CRON`; every 15 minutes by default)
marks pending and unlaunched approved plans past their expiry as expired, and deletes expired and
rejected plans more than 7 days old.

### Retention of launched plans

A launched plan's goal and plan body are kept for `runPlans.launchedRetentionDays` (90 days by
default) after it was launched. The sweep then **scrubs** the plan record: the goal, the spec, the
router and summary data, the stored policy and validation reports, and the node ids inside the cost
estimate are removed, the spec and catalog hashes are set to `scrubbed`, and `scrubbedAt` is set. The row itself is not deleted. Its owner, team,
repository, mode, status, cost totals, agent pins and timestamps stay, so a run's `triggerRefId`
(the plan id) and the owner's plan list keep working. The setting is resolved per team, at most
200 plans are scrubbed per sweep in round-robin across teams, and the approval time is the launch
time. Sweeps after an upgrade scrub launched plans already older than the period, up to 200 per
sweep, until none remain.

A scrubbed plan shows "The goal and plan body were removed from this plan record after the
retention period. The run keeps its own records." in the dashboard and the CLI. Saving it as a
template answers `PLAN_SCRUBBED`, approving or rejecting it is refused because it is no longer
pending, and a run cannot be created from it: the run is refused with `PLAN_SCRUBBED`. That refusal happens only at run creation; a run already running never re-reads
its plan.

The scrub covers the plan record only. The goal also lives in the run's own records (the work request
description, the run's spec snapshot and the agent traces), which follow the platform's run
retention, not this setting.

Plan, route, approval and save events are written to the audit log with ids, mode and team only; the
goal and the spec are never logged. Saving a template writes `run_plan.saved_as_template`, and each
scrub writes `run_plan.scrubbed`.

### Agent-node ceilings

Every `agent` node of a planned run is held to the agent-run ceilings `workspace.agentRunMaxSteps` and
`workspace.agentRunMaxWallClockSeconds`, resolved at the run's team and organization. A failed read of
the settings falls back to the registry defaults, never to unlimited. This covers the free nodes of a
delivering plan and every node of an output-only plan. Ordinary templates' agent nodes are unaffected.

A node that reaches either ceiling fails with the non-retryable `AGENT_CEILING_REACHED`. Its partial
output is **not** passed to later nodes, because it would otherwise reach the implementer's guidance or
the text a human reviews. The steps it consumed are billed, and its trace records `agent.ceilings_applied`
and `agent.ceiling_reached`.

The effective wall-clock deadline is also bounded by the node's Temporal activity timeout minus 90
seconds, less the time already spent on workspace setup: about 8.5 minutes for a node without a
workspace and about 28.5 minutes with one, whatever a higher setting says. With the defaults the
activity bound applies (see Limitations).

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
| Retention scrub and expiry sweep | `packages/shared/src/lib/runPlanSweep.ts`, `packages/worker/src/activities/sweepRunPlans.ts` |
| Dashboard | `packages/web/src/components/runPlans/` |
| CLI | `packages/cli/src/commands/plan.ts` |

---

## Limitations

- **The free regions can steer the implementer.** Text from a generated agent node can reach the
  implementer's guidance through `context.planNotes`. The core, the review network, the security
  gate, CI and the human merge still run on whatever the implementer produces, but the guidance
  itself is not verified.
- **The retention scrub does not reach the run's own records.** The goal is also kept in the work
  request description, the run's spec snapshot and the agent traces. Those follow run retention, so
  a deployment that must not keep goal text anywhere also prunes those records.
- **Planned-node wall-clock is bounded by the activity timeout.** The effective deadline of an
  `agent` node is the lower of the ceiling setting and the activity bound described in
  [Agent-node ceilings](#agent-node-ceilings), so a higher `workspace.agentRunMaxWallClockSeconds`
  does not lengthen a planned node past about 8.5 minutes without a workspace or about 28.5 minutes with one.
- **`PLAN_SCRUBBED` is refused only at run creation.** A run already running never re-reads its plan,
  so a plan scrubbed while its run is in flight does not stop that run.
- **Saving as a template does not re-apply the plan-only policy.** The saved draft is an ordinary
  template: a reviewer must check it, as for any template, because the plan's policy checks are not
  run again on it.
- **The platform does not retry an approval.** An approval that fails after the plan was approved
  returns it to pending and answers an error; nothing starts the run again. The person approves
  again, and a retry with the same `Idempotency-Key` finds its own earlier approval on record
  (an approval is recorded before the run starts, so a retry that arrives while the run is starting
  answers `409` `PLAN_LAUNCH_IN_PROGRESS`, and so does one that arrives after the workflow started
  but before a worker has created the run: it is answered `deduplicated` only once the run exists).
- **A global template named `Planned Run` blocks startup.** The sync that creates the hidden
  system template refuses to start the gateway when a template of that name exists that the
  platform did not create; see [upgrade notes](./upgrade-notes.md).
- **The policy judges shape, not sense.** It does not decide whether the free nodes are a good way
  to do the task, and its transition bound over-approximates, so a fitting plan can be refused.
- **Cost estimates are floors.** They use role default prices and a fan-out guess; unpriced nodes
  are listed, not costed.
- **An approved plan expires if a worker is slow.** A worker that takes longer than the launch
  window (`runPlans.launchWindowMinutes`) to pick a run up loses the plan, and the run fails cleanly
  at its claim. Raise the window when the worker queue can be slower than the default.
- **Plan text is operator-visible.** The goal is part of the generation workflow's input and history,
  so Temporal operators can read it. Gateway logs and audit rows do not carry it.
- **A duplicate burst can answer a spurious `429`.** Requests with one `Idempotency-Key` each hold a
  quota slot while in flight; one that loses the start gives its own slot back.
- **Slack has no completion notice.** The plan row is created when the job is read, so the Slack
  message links to the job, and a goal too long for the button's 2,000-character token gets no button: the reply asks the
  person to shorten it or to use the dashboard.
- **Slack text over 32,000 characters is refused unparsed.** The goal is read from the raw message
  after a length cap of four times the goal limit, so a message that long gets the too-long reply
  even when most of it is markup that would shrink away.
- **The Slack token is single-use through Temporal, not a table.** It holds while the job's history
  exists, and the token lives 15 minutes.
- **A person in more than 50 teams and organizations** is limited by only the first 50 in a fixed order.
