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

A re-run starts a **new** run (new ticket id, so a new branch name) from the stored parameters, as the
person re-running it, and re-validates everything: the agent may have been deactivated, a ceiling
lowered, or the caller's access revoked since. The generic `POST /work-requests/:id/retry` refuses an
agent run (`USE_AGENT_RUN_RERUN`): it rebuilds the request without its payload and reuses the ticket
id, which would collide with the branch the first run pushed.

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
  ticket id has the `agent-<8 hex>` form, so a run can only publish under its own branch name;
- the ceilings, the kill switch and the concurrency cap (sections 6 and 7).

The activity makes a single attempt: a retry would re-spend and could re-publish. Its Temporal timeout
(5 h) is only a backstop; the real wall-clock bound is the per-run deadline inside the activity.

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
| `null`, `[]`, or a list naming no workspace tool (`["mcp"]`) | `readFile`, `listDirectory` |
| names `writeFile` and/or `bash` | exactly the workspace tools named |

A write tool is granted only when it is **named**. The implementer reads `null`, `[]` and "no workspace
tool listed" as every tool; applied to arbitrary library agents that would hand `bash` and `writeFile`
to every agent that has no opinion about tools (`contentWriter`, `supportResponder` and the reviewer
personas all seed with `toolKeys: null`), and an agent run can publish what the agent writes.

The tool bodies are the implementer's, so the tool-level scanners apply unchanged: every `writeFile` is
checked against the sensitive-file patterns and the pre-write content rules, and every `bash` call
against the shell-command scanner. Skills are inlined into the system prompt (no `loadSkill`), and the
persona and skill fallbacks that `buildImplementerForActivity` applies to sub-role agents do not apply.

**MCP tools** bind per the agent's own configuration (`'mcp'` in `toolKeys`, or `null`/`[]`, plus an
`mcpConnectionId`), exactly as on an `agent` node. See Limitations: next to a workspace this is an
exfiltration channel.

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
2. has the Docker daemon copy the agent's working tree (never `.git`) into it, measured against a size
   cap on the host, and replaces the checkout's tree with it;
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
   `.github/actions` unless `workspace.agentRunAllowWorkflowChanges` allows it (a pushed branch runs its
   push workflows with repository secrets).
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
team's own agents (and the MCP connections they bind). `key@version` pins the GLOBAL lineage. The
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

---

## 8. Observability

The agent loop persists its LLM trace as any agent activity does; the tool calls, the policy verdict
(`agent_run.push_policy`), the code scan and the push (`git.commit_push`) are activity events on the
same run. The run viewer shows them under the run found by `workRequestId`.

---

## Limitations

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
  file, or a 512 MB working tree is refused, not split. Ignored directories (`node_modules`, build
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
  stops; it does not wait for CI or iterate on review. The PR is not recorded as a tracked
  `PullRequest`, so CI webhooks do not signal the run.
- **One repository per run,** and the repository must be a `git_repo` connection.
- **A run killed without finalising can hold a concurrency slot.** Admission counts non-terminal ledger
  rows; a worker crash that leaves one non-terminal holds its slot until the row is closed.
- **Platform agents are excluded by a code list,** not a column, so adding a platform-internal agent
  means adding its key to `NON_LAUNCHABLE_AGENT_KEYS`.
- **The real-Docker check is opt-in.** The trusted-container shell is exercised against real containers
  by `agentRunFinalize.docker.test.ts` only when `AGENT_RUN_DOCKER_TEST=1`; the default suite exercises
  the same code against a fake workspace.
- **Cost estimates are absent.** The workflow cost estimator has no hint for `runAgentTask`, so an
  estimate for the system template is empty.
