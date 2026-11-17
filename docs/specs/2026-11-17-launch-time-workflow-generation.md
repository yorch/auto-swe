# Launch-time workflow generation (design)

Goal: at launch a user states what they want done; the platform proposes either an existing
template or a generated workflow (deterministic skeleton plus agentic nodes), shows the plan,
and starts the run only after the launcher approves it.

## Decisions (made with the product owner)

1. A human approves every generated plan before the run starts. No auto-start path.
2. Scope: repo-bound runs for engineering and for any launchable library agent.
3. Entry points: dashboard `/start`, REST API + CLI, Slack channel assistant.
4. Routing: a router ranks existing templates; the user chooses between them and "generate new".
5. Freedom: a policy-injected mandatory skeleton, a free middle composed from a filtered catalog.
   No shell, container or MCP nodes by default.

## Facts about the current code this design rests on

- A run launches only from an ACTIVE template version (`launchableTemplateWhere`); DRAFT is not
  launchable. `createWorkflowRun` reads `WorkflowTemplateVersion` and writes
  `WorkflowRun.specSnapshot`, `agentVersions`, `pinnedSettings`, `skillRevisions`.
- No ad-hoc spec launch exists. Every `startRunnableWorkflow` caller goes through a template row.
- `generateWorkflowSpec` returns `{ spec, summary, attempts }`; the catalog can be narrowed only
  by `teamId` and `allowShell`.
- The security gate is not a node. It runs inside `executeImplementation` and the fix steps, so
  "gate present" means "an implementation step present".
- `runAgentTask` is internal and `validateSpec` rejects it in authored specs. An `agent` node with
  `workspace: true` keeps nothing it changes.
- `estimateSpecCost` exists in shared and is called only by the web editor.
- No semantic template search exists; template search is an unranked substring match.

## Design

### 1. RunPlan entity

A `RunPlan` row holds: owner (user or service principal), team, repository, intent text, router
candidates, the generated `WorkflowSpec`, its `validateSpec` report, a cost estimate, the catalog
hash and model that produced it, a status (`PENDING`, `APPROVED`, `LAUNCHED`, `EXPIRED`,
`REJECTED`) and an expiry. A plan is bound to its owner and repository; only the owner may
approve it, and approval re-runs every check (below) against current state.

### 2. Launching an approved generated plan

On approval the gateway persists the spec as a `WorkflowTemplate` with origin `generated:plan`,
status ACTIVE, one version, scoped to the repository's owning team and excluded from the library
list, picker and schedules by default. It then launches through the existing
`launchTrackedWorkflow` path, so version pinning, budget, concurrency and provenance are
unchanged. "Save to library" clears the origin flag. Choosing an existing template skips the
persist step and launches that template as today.

### 3. Mandatory skeleton

A pure function `applySkeletonPolicy(spec, mode)` in shared both checks and injects. For a
delivering run it requires, on every path reaching a terminal node: an implementation step (which
carries the security gate), the review network, quality gates, a PR step, and the human merge
wait. For output-only library-agent runs it requires an `agent` node, a terminate node and a
human review node before any external effect. Missing mandatory nodes are inserted by the
injector; a spec that still violates the policy is refused. The policy is code, not a prompt.

### 4. Generation constraints

`generateWorkflowSpec` gains a `profile: 'run-plan'` mode: catalog restricted to a role-filtered
step and agent allowlist, shell and container off, MCP off, intent taken only from the user's
text (never from ticket or repository content), and the repair loop hard-gating on
`validateSpec` errors plus the skeleton policy. Every loop node must set `maxVisits` and
`onExhausted`.

### 5. Router

A `runPlanRouter` agent (cheap model, seeded as data) receives the intent and the names and
descriptions of launchable templates and returns a ranked list with reasons and a "none fits"
flag. It is advisory: the preview shows the top matches next to "generate new". Template text is
untrusted input to the router and its output is validated against real launchable ids.

### 6. Surfaces

- Gateway: `POST /run-plans` (intent, repo, optional agent), `GET /run-plans/:id`,
  `POST /run-plans/:id/approve` (body: chosen template id or `generated`), `POST /run-plans/:id/reject`.
  Generation runs as an async job. Each route has an `assistantPolicy` entry; approve is `confirm`.
- Web: a "Describe the goal" mode on `/start` with a plan preview (outline, cost, mandatory
  nodes marked, warnings) and an Approve button.
- CLI: `auto-swe plan create`, `plan show`, `plan approve`, and `run --describe "<goal>" --yes`.
- Slack: the channel assistant records a plan intent; fixed code creates the plan and posts it
  with an Approve button. Approval requires a linked ENGINEER with repository reach.

### 7. Library-agent delivery

Plans built on a library agent other than the implementer path are output-only: `agent` nodes keep
no changes and `runAgentTask` stays internal. Their results are text or artifacts reviewed at a
human node. Delivery of non-engineering agent changes is a separate feature, available today
through agent runs.

## Phasing

1. Shared: skeleton policy, run-plan generation profile, cost estimate endpoint, tests.
2. Gateway + worker: `RunPlan` model and migration, plan routes, generated-template persist and
   launch, approval re-validation.
3. Router agent and ranking.
4. Dashboard mode.
5. API/CLI.
6. Slack.
7. Eval set of intents with expected graph properties in the live-checks harness.

## Limitations

- A generated spec is only as safe as the skeleton policy and `validateSpec`; neither judges
  whether the middle nodes are a sensible way to do the task.
- Cost estimates use role defaults and a fan-out guess; unpriced nodes are listed, not costed.
