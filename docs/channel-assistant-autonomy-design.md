# Design — channel-assistant autonomous execution + multiplayer hand-off

> Addresses gaps **#1** (autonomous multi-stage task execution) and **#2**
> (multiplayer mid-task hand-off) from [`channel-assistant-gaps.md`](./channel-assistant-gaps.md).
> Locked decisions: **both task routes** (general agentic + SWE code, agent
> picks) · **full signal-steering** (thread replies steer an in-flight run) ·
> **agent-decides launch** (a delegate tool).

## Thesis

A channel `@mention` that is a *task* (not a quick question) launches a
**durable workflow run bound to the Slack thread**. That single move delivers
both gaps:

- **#1** — the run executes the task in stages on the existing engine
  (`RunnableWorkflow` / `runSpec`): plan → act with tools/MCP → (review) →
  deliver, parking on HITL when it needs input.
- **#2** — the run *is* shared, durable, resumable task state: the whole channel
  can observe it, anyone can answer its in-thread HITL prompts, and follow-up
  thread replies **signal** it to steer mid-flight.

The conversational turn stays per-mention; only the *task run* is long-lived.

## Components

### 1. Launch (agent-decides)
`runChannelAssistantTurn` exposes a `delegateTask` tool to the channel agent.
When the agent judges the request a task, it calls the tool with
`{ route: 'general' | 'code', title, description, repoHint? }`; the tool records
the intent (the agent still writes a short "on it — I'll post updates here"
reply). The activity returns `{ reply, delegate? }`. `ChannelAssistantWorkflow`,
seeing `delegate`, starts a **child task workflow** (workflow-layer start =
deterministic). Quick questions take the existing inline path unchanged.

### 2. Routing (both)
The task is always a `RunnableWorkflow` run; the route selects the template +
input:
- **general** → a seeded GLOBAL **"Channel Task"** template: a capable `agent`
  node (channel-scoped tools/MCP) doing tool-driven multi-step work, with HITL
  nodes for input and a `terminate { result }` deliver. (Decomposition via
  `planDecomposition`+`fanOut` is a later enhancement.)
- **code** → the existing **SWE default template** (`RunnableWorkflow` with a
  `RepoWorkRequest`), when the channel resolves to a repo. Channel→repo: the
  agent picks from the team's `git_repo` Connections (optionally a
  `SlackChannel.defaultConnectionId` default). A synthetic work request is
  created (`externalTicketId = slack-<channel>-<ts>`).

### 3. Thread binding + reporting
The run's `RunInput` carries `slackChannelId` + `slackMessageTs` (the thread).
Existing `slackNotify` already threads step-failure / PR-ready / HITL-pending /
run-complete to that thread, and HITL → Slack interactive buttons already
resolve from any linked user. We add lightweight per-stage progress posts.
Run cost accrues to the channel budget (`ChannelMonthlyUsage`), not just
`OrgMonthlyUsage`.

### 4. Signal-steering (#2, full)
- **Thread → run lookup:** an in-flight task run is found by
  `(slackChannelId, slackMessageTs=thread root, status=RUNNING)`.
- **Gateway:** in the Slack Events handler, a non-mention reply *in a thread that
  has an in-flight bound run* is routed as a **Temporal signal** to that run
  (`steer` signal with the new user text) instead of starting a fresh turn.
- **Workflow:** `RunnableWorkflow` registers a `steer` signal handler that
  appends guidance to a steering buffer in `context`; `agent`-node execution
  includes any pending steering in its next prompt and clears it. Semantics are
  **soft** — steering is applied at the next agent step, not preempting the
  current one. This is the contained "long-lived signal workflow" — only task
  runs are steerable; conversational turns are untouched.
- **Hand-off:** because HITL prompts post in-thread and any linked channel member
  can resolve them, "pick up where the last person left off" works out of the box
  once the run exists.

## Data model
- Reuse `RunInput.slackChannelId` / `slackMessageTs` for thread binding (exist).
- Optional `SlackChannel.defaultConnectionId` (nullable FK) for the code route's
  default repo (additive migration).
- No new run model — task runs are ordinary `WorkflowRun`s (visible in `/runs`,
  default-excluded like the Channel Assistant template runs; we add the "Channel
  Task" template to that exclusion).

## Phasing (commits within this PR)
- **A — General task launch:** `delegateTask` tool + delegate intent + child run;
  seed "Channel Task" template; thread binding + result/HITL reporting; budget.
- **B — Code route:** channel→repo resolution + SWE `RunnableWorkflow` launch.
- **C — Signal-steering (#2):** `steer` signal on `RunnableWorkflow` + agent-node
  consumption; gateway thread-reply → signal routing; thread→run lookup.
- **D — Polish/observability:** per-stage progress posts; `/runs` exclusion for
  the Channel Task template; docs.

## Risks / guards
- **Runaway cost** — delegated runs can be expensive; gated by the per-channel
  budget (checked before launch) + the run's own budget tier. Launch posts an
  acknowledgement so it's never silent.
- **Steering semantics** — soft (next-agent-step) to keep determinism; documented.
- **Security** — delegated tasks run with the channel's *scoped* tools/MCP only
  (the `CHANNEL` config tier already enforces this); the code route inherits the
  SWE workspace sandbox + scanners.
- **Concurrency** — one in-flight task run per thread (a second delegate in the
  same thread either steers the existing run or starts a sibling — start with:
  one active run per thread, extra delegations steer it).
