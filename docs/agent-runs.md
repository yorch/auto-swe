# Agent runs

An agent run is an ad-hoc launch of one library agent against one repository: pick an agent, give it a
prompt, and it works in a throwaway checkout. By default nothing leaves that sandbox and you get the
agent's answer and its diff back. Asked to, the platform publishes the result as a branch or a **draft**
pull request, and only after deterministic checks and the security gate have passed. Nothing is ever
merged; a human merges.

It is the way to use a library agent (`contentWriter`, `supportResponder`, a team's own) without
authoring a workflow around it.

---

## 1. Launching one

| Surface | Call |
|---|---|
| API | `POST /api/v1/agent-runs` |
| Re-run | `POST /api/v1/agent-runs/:workRequestId/rerun` |
| Dashboard | **Start work** (`/start`), then **Run an agent** (section 9) |
| CLI | `auto-swe agent run <key[@version]> "<prompt>" --repo <org/name> [--deliver none\|branch\|draft_pr] [--max-steps N] [--timeout S] [--wait]` |

Request body:

| Field | Meaning |
|---|---|
| `agent` | `key` (floats to the latest active version) or `key@version` (pins the GLOBAL version) |
| `prompt` | What to do. Up to 20,000 characters |
| `repoId` | The repository (a `git_repo` connection) |
| `deliver` | `none` (default), `branch`, or `draft_pr` |
| `maxSteps`, `maxWallClockSeconds` | Optional caps. They can only **lower** the platform ceilings (section 6) |
| `budgetTier` | `STANDARD` (default), `LARGE`, `EPIC`, as for any run |

The response carries `workRequestId`, the Temporal workflow id, and `effective` (the limits the run
will actually use). The run row appears once a worker picks the workflow up; find it with
`GET /api/v1/workflow-runs?workRequestId=…` or `auto-swe runs list --work-request-id=…`. An
`Idempotency-Key` header makes a retried launch answer `409 RUN_CONFLICT` instead of starting a second
run; the key is scoped to the caller as well as the repository, so one user's key can neither collide
with nor reveal another's run.

A re-run starts a **new execution attempt under the same request** (new ticket id, so a new branch
name) from the stored parameters, as the
person re-running it, and re-validates everything: the agent may have been deactivated, a ceiling
lowered, or the caller's access revoked since. The generic `POST /work-requests/:id/retry` refuses an
agent run (`USE_AGENT_RUN_RERUN`): agent delivery requires a fresh ticket and branch for each
attempt. The agent re-run endpoint accepts optional `instructions` (up to 4,000 characters), appends
them to the original task for that attempt, and leaves the original request unchanged.

### Who may launch, and as whom

An ENGINEER who is a member of the repository's owning team **or of a team it is shared with**, through
the same launch decision every other path takes (repository access, GitHub permission under the access
gate, the organisation's monthly cap). The run acts as its launcher: with
`github.userCredentialsEnabled` on, the launcher's own saved GitHub token stands in for the platform
credential, subject to the host allowlist, exactly as for any run they start
([user-github-credentials.md](./user-github-credentials.md)).

A member of a shared team launches against the owning team's repository, so budget and concurrency are
charged to the **owning** team, and the agent resolves at GLOBAL and ORGANIZATION scope only (section 5).

---

## 2. How a run executes

A launch is a `WorkflowRun` of a hidden GLOBAL system template, "Agent Run". Its spec is one internal
step, `runAgentTask`, then a terminate node that surfaces the step's output. Launch parameters travel in
`RunInput.payload`; there is no per-launch template version. The `ActiveWorkflow` ledger row is written
first, because the worker derives the run's team and organisation (settings, concurrency, budget) from it.

`runAgentTask` is the authority for everything an agent run may do. The gateway checks the same things
for good error messages, but the template is reachable from other launch paths
(`/workflow-templates/:id/runs`, Slack, schedules, webhooks, bundles), so the activity re-checks:

- it runs only for the system template (a dedicated `system:` origin, null team, reserved name);
- the run's ledger row names the same repository as the request;
- the payload parses (`AgentRunPayloadSchema`), the agent is not on the non-launchable list, and the
  ticket id has the `agent-<32 hex>` form, so a run can only publish under its own branch name;
- the ceilings, the kill switch and the concurrency cap (sections 6 and 7).

The activity makes a single attempt: a retry would re-spend and could re-publish. Its Temporal timeout
(6 h) is only a backstop; the real wall-clock bound is the per-run deadline inside the activity. The
timeout is the setting's hard maximum (4 h) plus 2 h of headroom for the clones, export, scan and push
around the loop, so a run at the ceiling is not killed mid-delivery.

### The hidden template

"Agent Run" is seeded with the starter content but is not starter content. It carries the reserved
`system:agent-run` origin and is:

- absent from the template list, the Slack picker, schedules and bundle exports, and `404` on every
  template route even for an ADMIN (the gateway guards the whole `/:id` route family);
- not creatable or renameable by name (`RESERVED_TEMPLATE_NAME`, case-insensitive);
- never touched by bundle install: the installer refuses its name and any `system:` source or origin
  with no flag able to lift it, because it treats any other non-null origin as bundle-owned and would
  otherwise append versions to it.

`runAgentTask` is an *internal* step. It is registered but left out of the palette and the authoring
catalog, and `validateSpec` rejects it (`INTERNAL_STEP`) in any authored, generated or bundled spec.

---

## 3. What the agent can use

The agent runs in a container cloned from the repository's default branch, using the repository's
executor image (or the configured workspace image). Its tools are the resolved agent's own, under a rule
that is deliberately stricter than the implementer's:

| `Agent.toolKeys` | Granted workspace tools |
|---|---|
| `null` (no opinion) | `readFile`, `listDirectory` |
| a list | exactly the workspace tools it names; `[]` and `["mcp"]` grant none |

A write tool is granted only when it is **named**, so `toolKeys` is an allowlist and `[]` really means no
tools. The implementer reads `null`, `[]` and "no workspace tool listed" as every tool; applied to arbitrary library agents that would hand `bash` and `writeFile`
to every agent that has no opinion about tools (`contentWriter`, `supportResponder` and the reviewer
personas all seed with `toolKeys: null`), and an agent run can publish what the agent writes.

The tool bodies are the implementer's, so the tool-level scanners apply unchanged: every `writeFile` is
checked against the sensitive-file patterns and the pre-write content rules, and every `bash` call
against the shell-command scanner. Skills are inlined into the system prompt (no `loadSkill`), and the
persona and skill fallbacks that `buildImplementerForActivity` applies to sub-role agents do not apply.

**MCP tools** bind per the agent's own configuration (`'mcp'` in `toolKeys`, or `null`/`[]`, plus an
`mcpConnectionId`), exactly as on an `agent` node. See Limitations: next to a workspace this is an
exfiltration channel.

**The loop.** The agent runs on the platform's Mastra loop unless the Agent version sets
`runtime: claude-code`; the run-wide `workspace.implementerRuntime` setting does not apply to agent
runs. On the Claude Code harness the agent runs as one harness turn inside its container, granted the
harness tools that stand in for exactly the workspace tools above (`null` → `Read`, `Glob`, `Grep`;
`[]` → none), behind the same worker-side tool policy as the implementer, and with no MCP server bound.
The choice is pinned on the run before the clone, when the step first resolves its agent (agent
runs skip the run-start snapshot other runs take), and recorded as an `agent.runtime` trace event. See
[agents.md §3.7](./agents.md#37-runtimes-mastra-and-the-claude-code-harness).

---

## 4. Delivery and the trust boundary

| `deliver` | Result |
|---|---|
| `none` | The agent's text and its diff. The workspace is destroyed. The diff is the agent's own view, read from its container, and is labelled `diffVerified: false` |
| `branch` | The change is published to `<branchPrefix>/agent-<id>` after the checks below |
| `draft_pr` | As `branch`, then a **draft** pull request is opened. A repository that cannot hold drafts fails the run with `DRAFT_PR_UNSUPPORTED` and keeps the pushed branch; a ready-for-review PR is never opened in its place |

The agent runs as root in its own container and can replace `git`, rewrite `.git/config`, add
`refs/replace/*`, set a textconv driver or mark every file `-diff`. So **nothing about what may be
published is decided in that container, and the push credential never enters it.** After the agent
finishes, a delivering run:

1. creates a **fresh** container from the same image, cloned at the exact base SHA the agent started
   from, in which no agent code ever ran;
2. freezes the agent's container (so one snapshot is taken, not a tree still being written), has the
   Docker daemon copy its working tree (never `.git`) into the fresh one, measured against a size cap on
   the host, and replaces that checkout's tree with it;
3. commits the tree there as one engine-authored commit on the base (so a secret the agent committed and
   then deleted never reaches the remote), with hooks off;
4. reads the change back there with `--text --no-textconv --no-ext-diff` and `GIT_NO_REPLACE_OBJECTS=1`;
5. runs the deterministic policy, then the gate, on **that** commit (section 4.1);
6. pushes that exact SHA (`<sha>:refs/heads/<branch>`) from that container. The push function accepts only
   a branded `GatedCommit` minted by the gate and tied to the container that holds it, so a push with no
   passing gate does not type-check.

Whatever the agent does to its own container, the worst it can change is which bytes are copied, and
exactly the bytes copied are what is scanned and pushed. If the agent changed nothing, nothing is pushed
(`gate: no_changes`).

### 4.1 The push policy and the gate

Run in this order, all failing closed and all non-retryable:

1. **Deterministic policy, no model** (`AGENT_RUN_PUSH_POLICY`). Refuses any changed path matching a
   `SENSITIVE_FILE` pattern (deletions included), symlinks, gitlinks and submodules, binary files
   (detected by a NUL byte in the content, which `.gitattributes` cannot argue with), files over 1 MB,
   more than 500 changed files, paths it cannot classify, and anything under `.github/workflows` or
   `.github/actions` unless `workspace.agentRunAllowWorkflowChanges` allows it. This keeps an agent from
   adding or editing a workflow; it does not stop a pushed branch running the repository's existing
   push-triggered workflows (see Limitations).
2. **Size bound** (`AGENT_RUN_DIFF_TOO_LARGE`). The gate reads the whole diff in one model call, so a
   diff over 300,000 characters is refused rather than truncated: a truncated scan would be a bypass.
3. **Static code scan.** Advisory, as everywhere: findings are recorded and put in the PR body.
4. **The security gate** (`securityReview`). A gate that errors is `SECURITY_GATE_UNAVAILABLE`; a
   CRITICAL finding is `SECURITY_GATE_FAILURE`, with the same message text the implementer's gate uses so
   alerts keyed on it still match.

On any failure nothing is pushed and no PR is opened; both containers are destroyed; the run is FAILED
with the message on the step row.

A run that stops at its step or time cap is still checked and, when delivery was asked for, published:
a timeout never skips the gate.

---

## 5. Which agent, at which scope

An agent run resolves its agent at GLOBAL and the repository's ORGANIZATION scope only. TEAM-, CHANNEL-
and WORKFLOW_TEMPLATE-scope overrides do not apply, so a shared-team member never reaches the owning
team's own agents (and the MCP connections they bind). `key@version` pins the GLOBAL lineage, and is
refused (`AGENT_PIN_SHADOWED`) when the repository's organization has an active override of that key,
because the worker resolves the organization row first and the pin would silently not apply. Launch
without `@version` to run the override. The
launch-time agent-version snapshot applies as for any run.

A code list, `NON_LAUNCHABLE_AGENT_KEYS` (`securityReview`, `evalJudge`, `commitToMemory`,
`validateContext`, `lessonConsolidator`, `workflowAuthor`, `workflowExplainer`,
`repoDependencyInferrer`, `channelAssistant`), names agents that back a platform mechanism with its own
contract and cannot be launched. It is checked at the gateway and again in the worker.

---

## 6. Bounds

| Setting (`/govern/platform-settings`) | Default | Meaning |
|---|---|---|
| `workspace.agentRunMaxSteps` | 50 (max 500) | Ceiling on model steps in one run |
| `workspace.agentRunMaxWallClockSeconds` | 1800 (60 to 14,400) | Ceiling on time in the agent loop |
| `workspace.agentRunMaxConcurrentGlobal` | 4 | Runs in flight across the platform; `0` disables agent runs |
| `workspace.agentRunMaxConcurrentPerTeam` | 2 | Runs in flight for the repository's owning team; `0` disables for the team |
| `workspace.agentRunAllowWorkflowChanges` | off | Whether a delivering run may change `.github/workflows` or `.github/actions` |

All are ADMIN-only and not run-pinned. A launch's caps can only **lower** the step and wall-clock
ceilings: the gateway rejects a larger value (`CAP_EXCEEDS_CEILING`) and the worker clamps again,
because a ceiling can drop between launch and start. The step and time ceilings cascade to team and
organization; the template and channel scopes are not offered, so a template cannot override a ceiling.

The diff carried in the run output is capped at 100,000 characters (`diffTruncated` says so), because it
rides in the activity result, the step output and the terminate result and Temporal rejects any payload
over 2 MB.

### Budget

Each model step is debited to the run's ledger **as it finishes**, and the budget is re-checked between
steps, so a long loop cannot overshoot its tier by an unbounded amount and a step that exhausts the
budget stops the loop with `BUDGET_EXCEEDED`. A run that hits its wall-clock deadline, is cancelled, or
fails mid-loop has already recorded every step that completed. (The generic `runAgent` call keeps its
single record at the end unless it is asked for per-step accounting, which agent runs are.)

An agent on the Claude Code harness is debited per model call instead of per step, and the budget
is re-checked after every debit, so an exhausted budget stops the run with `BUDGET_EXCEEDED` one call
late. Through the worker's model proxy every call is debited as its response ends; without it, each
call the harness streams is debited once the next call begins, and what the harness did not stream is
charged when the turn ends (see Limitations).

---

## 7. Concurrency

An agent run holds a worker activity slot and a workspace container for its whole duration, and the
worker has one small slot pool shared with every engineering run, eval and channel task, so the number
in flight is capped globally and per owning team.

The gateway answers `429 AGENT_RUN_CONCURRENCY_EXCEEDED` (or `403 AGENT_RUNS_DISABLED` for `0`). The
worker is the authority: it admits a run by deterministic **rank**, not by count-then-start. Of the runs
in flight, the oldest N (by launch time, then workflow id) are admitted and a newer one is refused with
`AGENT_RUN_CONCURRENCY_EXCEEDED` before it creates a container. Two simultaneous launches at a limit of
one cannot both proceed.

**A ledger row holds a slot only while its workflow is running in Temporal.** Both the gateway and
the worker reconcile the non-terminal rows against Temporal during an admission call. A row whose
workflow is finished or does not exist is closed (`currentStatus` set to `FAILED`, only if still
non-terminal) and stops counting. The reconciliation is lazy (it happens inside admission, with no
timer or schema), bounded (at most 8 Temporal lookups per call, each abandoned after 3 s, oldest
launch first, and a row confirmed running is not asked about again for a minute so a few long-running
runs cannot hide stale rows behind them), counts as gone only a definitively finished status
(`COMPLETED`, `FAILED`, `CANCELLED`, `TERMINATED`, `TIMED_OUT`) or a missing workflow, the same
rule on the gateway and the worker, skips the
calling run and any row launched in the last five minutes (the gateway writes the ledger row before it
starts the workflow), and fails safe: when Temporal cannot be asked, the row keeps its slot and a
warning is logged.

---

## 8. Observability

The agent loop persists its LLM trace as any agent activity does; the tool calls, the policy verdict
(`agent_run.push_policy`), the code scan and the push (`git.commit_push`) are activity events on the
same run. The run viewer shows them under the run found by `workRequestId`.

Each step is priced at the model the run resolved for the agent (the owning organization's override
or the pinned version), not at whatever the ambient context would resolve, so the run's tier budget
and the organization's usage are charged for the model that ran.

---

## 9. Relation to the channel assistant

An agent run and the channel assistant are different mechanisms that share only the model-call loop
(`runAgent`) and the Agent library.

| | Agent run | Channel assistant |
|---|---|---|
| Executes | One library agent against one `git_repo` repository, in a Docker workspace, as a single step of the hidden system template | A conversational turn (a single model call with intent-recording tools, no container), or a thread-bound `RunnableWorkflow` for a delegated task |
| Needs | A repository ledger row, an ENGINEER launcher with repository membership, and an `agent-<32hex>` ticket id | A Slack channel; no repository for a general task |
| Budget | The run's tier budget, the organization cap and admission control | The channel's monthly budget, held before a turn and settled after |
| Acts as | The launching user | The Slack user, or no one, per the channel's repository-access mode |

A channel task is not an agent run for three reasons. The general route is repo-less on purpose, and
an agent run cannot start without a repository. The code route already launches the team's
engineering template, with its TDD loop, review network and CI wait, which a one-shot agent run
does not have. And the two authorise differently: an agent run requires a linked ENGINEER, while a
mention needs no linked account when the channel's repository-access gate is off. The `channelAssistant`
agent is on `NON_LAUNCHABLE_AGENT_KEYS` for the same reason.

Launching a library agent against a repository from Slack would be a new feature, not a reuse of
either path. It needs its own identity (a linked, active user at the agent-run floor regardless of the
channel's gate), RBAC (repository reach through `validateRunConnection`), budget (whether a channel is
charged, and how admission refusals reach the thread), and security design (delivery modes, and MCP
reachable from a channel any workspace member can type into). The agent-run launch path lives in the
gateway, so the entry point would be too.

---

## 9. The dashboard

**Start work** (`/start`, ENGINEER and above) offers workflow, agent and multi-repo epic
launch paths. The `/agent-runs` URL redirects to `/start?mode=agent`. The agent path is a form over
the same `POST /api/v1/agent-runs`. A review screen shows the repository, agent, task, delivery, and
limits before launch. Returning to the inputs preserves the draft. Launching opens the request
side panel in **Requests** (`/workflows`), which groups its execution attempts.
Choosing a repository first scopes everything else to it, because the repository decides which agents
exist (its organization's overrides) and which ceilings apply (they cascade to team and organization).
Two read endpoints, both ENGINEER, serve the form:

| Call | Answers |
|---|---|
| `GET /api/v1/agent-runs/agents[?repoId=…]` | The launchable agents, resolved exactly as a launch resolves them: GLOBAL, plus the repository's ORGANIZATION when `repoId` is given, never TEAM. Per key it returns the effective name, description, scope and latest version, and `pinnableVersions` (the GLOBAL versions a `key@version` pin can select; empty while an organization override shadows the key). The non-launchable list (section 5) is excluded in the query |
| `GET /api/v1/agent-runs/limits[?repoId=…]` | The step and wall-clock ceilings with their hard bounds, the concurrency settings, and `enabled` (false when the global switch, or with a `repoId` the owning team's, is `0`). Numbers only |

A `repoId` the caller cannot reach (not a member of the owning team or a team it is shared with, or
refused by the repository access gate; a platform ADMIN reaches every active git repository) answers
`404 CONNECTION_NOT_FOUND`, the same as a repository that does not exist. That includes a caller who
is not a member of the repository's organization, because the launch refuses them too.

**Decision: ENGINEERs may read launchable agents' names and descriptions.** The agent library is
otherwise ADMIN-only. `GET /agent-runs/agents` shows any ENGINEER the key, name, description, scope and
version numbers of the agents they could launch, with or without a repository, and never a prompt,
skills, tools or model. An ENGINEER could already launch those agents by key, so this discloses the
catalog of what is launchable, not how any agent works.

The form validates the caps against the reported ceilings before sending, but the gateway and the
worker stay authoritative; a ceiling that moved since the form loaded still surfaces as
`CAP_EXCEEDS_CEILING`. A launch carries an `Idempotency-Key`, reused only when the submitted values are
identical, so a retry after a dropped connection answers `RUN_CONFLICT` ("already started") instead of
starting a second run. Launch errors are explained by code: `AGENT_RUN_CONCURRENCY_EXCEEDED` (429),
`AGENT_RUNS_DISABLED` (403), `CAP_EXCEEDS_CEILING`, `AGENT_PIN_SHADOWED`, `AGENT_NOT_LAUNCHABLE`,
`AGENT_NOT_FOUND`, `REPO_HOST_NOT_ALLOWED`, and `RUN_CONFLICT`.

### The run viewer

A run of the "Agent Run" template shows an **outcome card** in the run's side rail: the agent's text
(rendered as text), the files changed with line counts, the branch and, for `draft_pr`, the pull request
link (only an `https` URL is linked), the gate verdict (`passed`, `no_changes`, or not published), a
`diff verified` or `diff unverified` badge (section 4), and whether the run stopped at its step or time
cap. The diff is behind a disclosure and says when it was cut at 100,000 characters.

A failed run names its refusal above the generic failure card: the security gate, the gate being
unavailable, the push policy, a diff or working tree too large, an unsupported draft PR (the branch
stays pushed), a budget stop, or the concurrency limit. The interpreter records a failed step as
`<TYPE>: <message>` of the innermost failure (a failed activity otherwise reaches the workflow as a
wrapper whose message is always "Activity task failed"), and the viewer classifies on that leading
type, never on the message wording, which can quote text the agent chose.

The run detail carries `isAgentRun`, computed from the template's reserved origin; the viewer never
infers an agent run from the template's display name. **Re-run** calls
`POST /api/v1/agent-runs/:workRequestId/rerun` with a fresh `Idempotency-Key` and is offered for any
finished agent run. A re-run of a run that delivered a branch or draft pull request (or whose delivery
is not recorded) asks first and names what it will create; a `deliver: none` re-run is one click. The
hidden template's own link is not shown.

---

## Limitations

- **Only a failure with a recognised type is explained.** The viewer names a refusal when the
  recorded error starts with one of the types it knows; any other failure shows the generic failure
  card with the recorded `<TYPE>: <message>`. Runs that failed before the interpreter recorded the
  type read "Activity task failed" and are not explained.
- **The repository picker lists up to 500 connections.** It reads the first page of the repository
  listing (the listing's maximum page size) and drops non-git connections afterwards, so those count
  toward the 500; a caller who can reach more cannot pick the rest in the form, and uses the CLI or the
  API.
- **The form does not offer a budget tier,** so a dashboard launch is `STANDARD`; a re-run takes
  `STANDARD` as well.
- **A pushed branch runs the repository's existing `on: push` CI, with repository secrets, on
  agent-edited code.** Blocking changes under `.github/workflows` and `.github/actions` stops an agent
  adding or rewriting a workflow, not editing what an existing workflow executes (`package.json`
  scripts, a `Makefile`, test files, a CI shell script, a local action path elsewhere). A repository
  member with no GitHub write access can therefore get code derived from their prompt run with the
  repository's secrets, unless the repository's workflows are restricted for pushes from non-protected
  branches. The platform does not currently require the launcher to hold push permission on the
  repository when a run delivers (`deliver: branch` or `draft_pr`). `workspace.agentRunAllowWorkflowChanges` narrows this and does
  not close it. Use `deliver: none` (the default) where that matters, and restrict who may launch.
- **An agent's MCP connection is reachable across teams.** The connection an agent binds is not checked
  against the run's team: a GLOBAL (or organization-scope) agent bound to one team's MCP connection is
  usable, through a text box, by every member of every team that can launch it, with that connection's
  credentials and reach. Bind MCP only on agents meant for everyone who can launch them.
- **Usage of the step in flight at a deadline abort is unrecorded.** Each completed model step is
  debited as it lands, but when the wall-clock deadline or a cancellation aborts a step mid-flight,
  that step's tokens are not recorded, so spend can exceed the ledger by at most one step.
- **Without the model proxy, a harness agent is metered from what it streams.** A call is debited
  once the next begins, so the call in flight is charged when the turn ends. A call the harness makes
  without streaming a message (a small-model side task) is charged only with the turn's totals and
  never triggers the check; a turn stopped at the deadline has no totals, so those calls are missed.
  The harness then also holds the model credential inside the agent's container. The worker's model
  proxy (`HARNESS_MODEL_PROXY_PORT`) closes both
  ([agents.md, Limitations](./agents.md#11-limitations)).
- **MCP next to a workspace is an exfiltration channel.** An agent with an MCP connection and a
  readable repository can send source anywhere that connection reaches, steered by text in the
  repository. MCP binds per the agent's own configuration; it is not switched off for agent runs. The
  workspace itself also keeps outbound network access (git and package installs need it).
- **A write-capable agent has `bash` in a container with open egress.** The trusted-container design
  protects what is *published* and the push credential; it does not stop the agent doing anything it
  likes inside its own sandbox, including reaching the network.
- **The gate is a model reading attacker-influenced text.** Everything that must not be argued with is
  deterministic and runs first, but the secret-in-code and injection judgement itself is the
  `securityReview` model's, which a prompt-injected diff can try to talk round. The PR body, the agent's
  summary and the branch name are not scanned (the summary is redacted, truncated and has mentions
  defused; the branch name and commit message are engine-authored).
- **The delivered diff must fit the gate.** A change over 300,000 diff characters, 500 files, 1 MB per
  file, or a working tree whose archive passes 512 MB (the copy is stopped at the cap while streaming, so a sparse file cannot fill the worker disk) is refused, not split. Ignored directories (`node_modules`, build
  output) are removed from the copy by the agent's own `git clean -fdX` on a best-effort basis; if that
  fails, the size cap decides.
- **A delivering run clones the repository twice,** once for the agent and once, at the exact base SHA
  with full history, for the trusted container.
- **`deliver: none` shows an unverified diff.** It comes from the agent's own container, which the agent
  controls; it is for reading, not for trust, and is labelled so.
- **Binary and workflow files are refused outright.** There is no per-file override; the only switch is
  `workspace.agentRunAllowWorkflowChanges`, and a refused run publishes nothing, including its
  permitted files.
- **No TDD loop, lesson retrieval, CI wait or fix loop.** An agent run opens (at most) a draft PR and
  stops; it does not wait for CI or iterate on review. The draft PR is tracked as a
  `PullRequest` row on the run's own ledger row (see [work-views.md](./work-views.md)), so it appears
  on `/pull-requests` and webhooks record its CI, merge, close and edits. The run has already ended by
  then, so those events are recorded without signalling it. A failure to write the row does not fail
  the run; it appears as a `pr.record_failed` event on the run. The run's `agent-<id>` ticket id is
  generated, so no tracker sync is attempted for it; the Slack merge note and the merge evaluation row
  still run.
- **One repository per run,** and the repository must be a `git_repo` connection.
- **A dead run can still hold a slot briefly.** Reconciliation (section 7) frees a slot only for a
  workflow Temporal reports finished or missing, at most 8 rows per admission call (a stale row behind
  more than 8 live ones is reached over successive calls), and not for a row
  launched in the last five minutes; while Temporal is unreachable the slot is kept. The reconciled row's
  `WorkflowRun` is not touched: only the ledger row that admission counts is closed.
- **Platform agents are excluded by a code list,** not a column, so adding a platform-internal agent
  means adding its key to `NON_LAUNCHABLE_AGENT_KEYS`.
- **The real-Docker check is opt-in.** The trusted-container shell is exercised against real containers
  by `agentRunFinalize.docker.test.ts` only when `AGENT_RUN_DOCKER_TEST=1`; the default suite exercises
  the same code against a fake workspace.
- **A model with no known price is refused only under a USD cap.** When the run's organization has a
  monthly USD budget and the agent's model has no catalog price, the run fails before it starts (before
  the container is created) with `MODEL_UNPRICED`, naming the model and the model catalog; the run
  viewer explains it. The same refusal applies to any `agent` node in a workflow template and to the engineering steps under an organization cap. With no organization cap the run proceeds and records $0
  (`llm.cost_pricing_known=false`): the token tier budgets still bind, since they count tokens.
- **There is no Slack entry point.** An agent run is launched from the dashboard, CLI or REST API only;
  the channel assistant cannot start one and a delegated channel task is a different workflow (§9).
- **Cost estimates are absent.** The workflow cost estimator has no hint for `runAgentTask`, so an
  estimate for the system template is empty.
