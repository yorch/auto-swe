# Orchestrated agent runs

Jira: N/A
Date: 2026-11-17
Status: Approved
Last reviewed: 2026-11-17

## Problem

An agent run is one library agent, against one repository, in one container, for one prompt. A person
cannot say "investigate this, split the work, change these three areas in parallel, and tell me what
you found" and watch it happen, the way they can in a local harness such as Claude Code or OpenCode.
Five gaps follow.

1. **Nothing can start another agent.** Fan-out exists (review network, channel subtasks, epics,
   campaigns), but every shape is fixed in code or in a template. No run can decide, from the user's
   intent, to start one more agent.
2. **Nothing reaches a running agent.** `runAgentTask` is one activity with a single attempt and up
   to a 4 h deadline. Its only inbound path is cancel. A `steer` signal exists for channel tasks, but
   it is drained between workflow nodes, never inside an activity. `AskUserQuestion` is a turn
   boundary: the turn ends and a new session resumes.
3. **There is no run tree.** `WorkflowRun` has no parent, `AgentTrace` has no agent-instance identity,
   and the run viewer shows one run. Runs are grouped only by `workRequestId`.
4. **There is no conversation.** The in-app assistant has a durable signal-queue conversation, but it
   records intents for the platform's own routes. It cannot hold a task open and drive agents.
5. **Composition has no safety model.** One agent has at most one MCP connection, so a single agent
   cannot read a private source and write to an outbound one. Several agents under one orchestrator
   can, which is a confused-deputy path no current control covers.

## Approach

Add an **orchestration**: a durable, conversational workflow in which an `orchestrator` agent turns
the user's intent into **sub-agents**, each of which is an ordinary agent run. The orchestrator never
touches a workspace or the platform directly. Its tools only **record intents**, as `delegateTask`
does for the channel assistant. Fixed code validates every intent and applies it through the same
launch path a person would use. This keeps the standing rule in `CLAUDE.md` §6: sub-agents are
stateless and return exactly one structured result, and no sub-agent transcript flows into the
orchestrator's context.

Decisions taken, with the alternatives discarded:

| Decision | Chosen | Discarded |
|---|---|---|
| Where the loop lives | A new Temporal workflow shaped like `AssistantConversationWorkflow`: a signal queue, one turn activity per event, `continueAsNew`. | Claude Code's `Agent` tool inside one container (weak visibility, shared policy, no per-agent budget). A node type in the interpreter (the fan-out is dynamic). |
| How a child starts | The worker calls the gateway as the launcher with a scoped orchestration token, and the gateway runs the agent-run launch path. | A Temporal `startChild` of the hidden template from the worker. It would duplicate admission, idempotency, GitHub permission, user-credential and organisation-cap logic outside the gateway. |
| Child completion | A signal from run finalization, with a polling backstop that reconciles missed signals. | Awaiting a child handle (the child is not a Temporal child). Signal alone (a lost signal strands the orchestrator). |
| Who the orchestrator is | A seeded, model-backed `orchestrator` Agent with no workspace and no repository tools. | Giving the orchestrator `readFile` or `bash`. Repository knowledge comes from read-only child agents. |
| Parallel writers | One branch and draft pull request per writer child, each gated independently. Each writer declares path scopes at spawn; the deterministic push policy refuses any path outside them; sibling scopes must be disjoint. | A shared integration branch (new trust path, patch conflicts, combined diff over the gate cap). Sequential writers only. |
| Human steering | A human-originated message to the orchestrator or to a child is allowed. A child still returns one structured result. | Steering only through the orchestrator. Resumable, conversational children. |
| Spawnable agents | A per-orchestration allowlist of agent keys, enforced in fixed code. | Any launchable agent. A team-wide allowlist setting. |
| Repository | Optional. A repo-less orchestration is read-only by construction. The agent may request a repository from a closed set; only a human confirmation attaches it. One repository, attached at most once. | Repo required. Multi-repository orchestrations. The agent choosing a repository itself. |
| MCP | Several connections allowed. The set is fixed at launch and team-owned only. Result screening is forced on. Every MCP tool call that is not provably read-only waits for the launcher's approval. | One connection only. Acknowledgment without per-call approval. |
| Attach and ownership | Split ownership: the orchestrator's pins and spend stay with the named team; children spawned after attach pin and bill under the repository's owning team. | Same team only. Re-pinning the orchestrator on attach. |
| Identity | Everything acts as the launcher. Only the launcher steers, attaches a repository and approves. Others with visibility can watch. | Identity following the attacher or the message author. |
| Push permission | A writer child requires the launcher to hold GitHub push permission at each spawn. Direct agent runs are unchanged. | No check. The same check for direct agent runs. |

## Concepts

- **Orchestration.** One conversation and its children. Workflow id `orch-<orchestrationId>`.
- **Orchestrator.** The model-backed agent that talks to the user and records intents.
- **Child.** One agent run started by an intent. It has a role and a status.
  - `reader`: `deliver: none`, no write tools, no path scopes.
  - `writer`: `deliver: branch` or `draft_pr`, with one or more path scopes. Only on an orchestration
    that has a repository.
- **Intent.** A validated request recorded by an orchestrator tool: `spawnAgent`, `messageAgent`,
  `cancelAgent`, `requestRepo`.
- **Event.** What wakes the orchestrator: a user message, a child finishing, an approval resolving, a
  repository attach resolving. Events arriving together are batched into one turn.

## 1. Data model

New models, all with `@@map` snake_case names:

| Model | Purpose |
|---|---|
| `Orchestration` | `id`, `teamId` and `orgId` (the named team), `launchedById`, nullable `repoId`, `repoAttachedAt`, nullable `serviceId`, `status`, `title`, `allowlist` (agent keys), `connectionIds` (the fixed MCP set), `budgetTier`, `workRequestId` (the work-request row that carries the ledger identity), timestamps. |
| `OrchestrationChild` | `orchestrationId`, `workRequestId` and nullable `runId` of the child, `agentKey`, `role`, `label`, `pathScopes` (text array, empty for readers), `status`, `resultJson`, `costUsd`, timestamps. Unique on `(orchestrationId, workRequestId)`. |
| `OrchestrationMessage` | The chat transcript: `orchestrationId`, `role` (`USER`, `ORCHESTRATOR`, `SYSTEM`), nullable `childId` (set for a message addressed to a child), `authorId`, `body`, `kind` (`TEXT`, `ATTACH_REQUEST`, `APPROVAL_REQUEST`, `CHILD_RESULT`, `NOTICE`), a JSON `payload`, `createdAt`. |
| `OrchestrationApproval` | A pending, approved, denied or expired MCP write: `orchestrationId`, nullable `childId`, `connectionId`, `toolName`, redacted `argumentsDigest`, `status`, `decidedById`, `expiresAt`. |
| `RunSteeringMessage` | A message to a running agent: `runId`, `authorId`, `body`, `createdAt`, nullable `deliveredAt`. The agent loop drains it at step boundaries. |

`WorkflowRun` gains a nullable `orchestrationId` and `ActiveWorkflow.parentWorkflowId` carries the
orchestrator's workflow id for children. `AgentTrace` is attributed to a child through its `runId`;
orchestrator turns are runless traces keyed by `workflowId`, the way assistant turns are. The
migration is hand-written DDL appended after the existing ones. Read the `prisma-pgvector-hnsw` skill
before running any `prisma migrate` command.

Enums `OrchestrationStatus` (`ACTIVE`, `WAITING`, `COMPLETED`, `CANCELLED`, `FAILED`),
`OrchestrationChildRole` (`READER`, `WRITER`), `OrchestrationMessageRole`,
`OrchestrationMessageKind`, `OrchestrationApprovalStatus` (`PENDING`, `APPROVED`, `DENIED`,
`EXPIRED`).

## 2. The orchestrator

A seeded `orchestrator` Agent: model-backed, default `anthropic/claude-opus-5-5`, no workspace tools,
no MCP binding of its own, on `NON_LAUNCHABLE_AGENT_KEYS` (it is platform machinery with its own
contract). Adding it means: the `SWE_AGENTS` entry in `syncBuiltins`, an entry in
`MODEL_BACKED_AGENT_KEYS`, a `BUILTIN_MODELS` price check, and the agent rosters in `AGENTS.md`,
`CLAUDE.md` §6 and `docs/agents.md`, which `yarn docs:check` verifies.

Its tools (`createTool`, each with an `outputSchema`) validate shape only and record the intent:

| Tool | Records |
|---|---|
| `spawnAgent({ agent, task, label, role, deliver?, pathScopes?, maxSteps? })` | A child to start. `agent` is a key from the orchestration's allowlist. `role: "writer"` needs `deliver` and at least one path scope. |
| `messageAgent({ childId, message })` | A steering message for a running child. |
| `cancelAgent({ childId })` | A cancel for a running child. |
| `requestRepo({ reason, candidate? })` | A request for a repository. |

A turn ends when the model stops calling tools. Its text is posted as an `ORCHESTRATOR` message.
Fixed workflow code then applies the recorded intents in order and waits for the next event.

The orchestrator's context holds: its system prompt, the launcher's task and messages, its own prior
turns, and each child's **final structured result** (section 4) as fenced quoted data. It never holds
a child's tool calls, retries or reasoning.

## 3. Launch and authorization

`POST /api/v1/orchestrations` (ENGINEER and above). Body: `task`, optional `repoId`, `teamId`
(required without a repository), `allowlist`, optional `connectionIds`, `budgetTier`,
`deliveryDefault`, optional `Idempotency-Key`.

| Mode | Authority |
|---|---|
| Repository-bound | The agent-run launch decision, unchanged: repository membership (owning team or a shared team), GitHub permission under the access gate, the organisation's monthly cap, the agent-run kill switch and concurrency. The named team is the repository's owning team. |
| Repo-less | The launcher is a member of `teamId`. The allowlist is checked against the readers-only rule below. The named team's organisation cap applies. |

Rules that hold in both modes:

- **Allowlist.** Every key must pass `isLaunchableAgentKey` and exist at GLOBAL or the organisation
  scope. The default allowlist is a small curated set. An empty allowlist is refused.
- **Repo-less is read-only.** A repo-less orchestration has no workspace and no delivery. A writer
  spawn is refused, in fixed code. Its children are repo-less readers whose tools are limited to MCP,
  knowledge search and the browser, as their agent definitions grant.
- **Connections.** `connectionIds` is the complete MCP set. A child may bind only a connection in the
  set, and each must be owned by the named team. The launch review screen lists every connection the
  allowlisted agents can reach.
- **Service principals.** A principal with the `runs:agent` scope may launch a repository-bound
  orchestration. It acts as no one, so it cannot attach or approve; any MCP write is denied, never
  waiting for a human. An orchestration launched by a principal is read-only for MCP writes.
- **Kill switch and caps.** `orchestration.enabled` (default off). The registry settings listed in
  section 10 bound turns, children, concurrency and wall clock.

The gateway writes a work-request row and an `ActiveWorkflow` ledger row for the orchestrator's own
workflow id first, because the worker derives the team, organisation, budget tier and spend from it,
and then starts the workflow with `signalWithStart` under `orch-<orchestrationId>`.

Identity: the orchestration's `launchedById` is the launcher. Children set `launchedById` to the
launcher. `RunInput.requestedById` is never used to pick a credential.

## 4. Children

### 4.1 Starting a child

The worker's apply activity calls `POST /api/v1/orchestrations/:id/children` on the gateway with a
short-lived **orchestration token**, minted at launch the way the assistant token is and valid only
for that orchestration's child, message, cancel and attach-status routes. The gateway is the
authority and validates, in this order:

1. The orchestration is `ACTIVE` or `WAITING`, and the kill switch is on.
2. `agent` is on the allowlist and still launchable; an organisation override and a `key@version` pin
   behave as for an agent run.
3. Width and depth: at most `orchestration.maxChildren` children in total and
   `orchestration.maxConcurrentChildren` running at once. A child cannot start an orchestration
   (depth one); `orchestrator` is not launchable.
4. Role rules: a reader is `deliver: none` with no path scopes. A writer needs a repository, a
   `deliver` of `branch` or `draft_pr`, and valid path scopes (section 4.3).
5. The launcher's access is re-checked as for a re-run: repository membership, org cap, and for a
   writer **GitHub push permission** through the repository permission lookup.
6. Admission: the agent-run concurrency decision, charged to the **repository's owning team** when a
   repository is attached, otherwise to the named team.
7. The connection rule: the agent's MCP connection, if any, is in `connectionIds`.

A refusal returns a coded error (`CHILD_NOT_ALLOWED`, `CHILD_LIMIT`, `SCOPE_OVERLAP`,
`PUSH_PERMISSION_REQUIRED`, `REPO_REQUIRED`, `CONNECTION_NOT_IN_SET`, `AGENT_RUN_CONCURRENCY_EXCEEDED`,
and so on). The worker turns it into a `SYSTEM` message the next orchestrator turn sees, and never
retries it silently.

On success the gateway runs the agent-run launch path for the child: an `Agent Run` workflow whose
payload carries the new `orchestrationId` and `pathScopes`, and records an `OrchestrationChild`.

### 4.2 The result contract

A finished child yields one `ChildResult`: `status`, a redacted and truncated `summary` (the agent's
final text), `filesChanged` (path and line counts), `branch`, `prUrl`, the gate verdict,
`stoppedReason`, `costUsd`. It is stored on the `OrchestrationChild`, and entered into the
orchestrator's context only as a fenced block:

```text
<child-result id="…" agent="…" status="…">
…quoted data, never instructions…
</child-result>
```

The text is scanned with the injection patterns the memory guard uses and, whatever the connection's
own setting, with MCP result screening. A finding drops the offending lines and writes a `NOTICE`.

### 4.3 Path scopes and writers

A writer's `pathScopes` use a deliberately small grammar, validated by one pure function in
`@auto-swe/shared`:

- `dir/**` (a directory subtree), `dir/*.ext` (a single directory), or an exact file path;
- no `..`, no absolute path, no `**` in the middle, at most 20 scopes, each at most 200 characters;
- lock files, `package.json` at the root and generated barrels are **refused in a scope unless
  exactly one writer in the orchestration owns them**, so the common collision points have a single
  owner.

Overlap is decided conservatively: two scopes overlap if one's directory is a prefix of the other's, or
if either cannot be classified. An overlapping spawn is refused (`SCOPE_OVERLAP`). The orchestrator
then re-plans, narrows the scope or waits for the other writer to finish.

The deterministic push policy (`AGENT_RUN_PUSH_POLICY`, `agentRunFinalize.ts`) gains one rule, run
before the gate: any changed path outside the run's `pathScopes` fails the run with
`AGENT_RUN_PATH_OUT_OF_SCOPE`, deletions and renames included, and nothing is pushed. A run with no
`pathScopes` is unaffected, so direct agent runs behave as they do today.

Each writer is an ordinary delivering agent run: its own ticket id, branch `<prefix>/agent-<id>`,
gate, push and draft pull request. The orchestration shows its pull requests as one **group**. The
platform never merges them, and conflicts between sibling pull requests are for humans.

## 5. Steering

Everything below is a human-originated or orchestrator-originated message. Only the launcher may send
a human message, and every message is recorded in `OrchestrationMessage`.

| Target | Path | Delivery point |
|---|---|---|
| Orchestrator | `POST /orchestrations/:id/messages` signals the workflow's `userMessage` signal. | The next turn. A message arriving during a turn is queued behind it. |
| Child, by the launcher | `POST /orchestrations/:id/children/:childId/messages` writes a `RunSteeringMessage`. | The agent's next step boundary. |
| Child, by the orchestrator | `messageAgent` applies the same write through the gateway. | The agent's next step boundary. |

On the Mastra loop the step hook drains undelivered messages, appends them to the message history as a
labelled steering block, marks them delivered, and records an `agent.steered` event on the trace. A
child on a harness loop (Claude Code, Pi) is one turn and cannot take a message mid-turn: its messages
stay queued and are shown as not delivered, and the launcher can cancel the child. The orchestrator
is told when the launcher steers a child, so its picture stays coherent.

## 6. Repository requests

`requestRepo` records an intent. Fixed code validates `candidate` against the repositories the
launcher can reach (the same reachability that gates `repoId`) and drops anything else with the same
response as a nonexistent repository. Valid or not, at most one request is pending at a time.

The orchestrator posts an `ATTACH_REQUEST` message. The dashboard renders a confirmation card that
shows the fully qualified repository, that writers and delivery become available, that new children
bill the repository's owning team, and the delivery default. `POST /orchestrations/:id/attach` with
`{ repoId }` is the only thing that attaches, is launcher-only, never callable by the in-app
assistant, and runs the full agent-run launch authorization at that moment. It sets `repoId` and
`repoAttachedAt` once; a second attach is refused. The workflow learns the outcome from an activity
result recorded in history, so replay is deterministic.

Split ownership applies from that point: the orchestrator's pins and spend stay with the named
team; every child spawned afterwards pins its settings, and bills and counts toward concurrency,
under the repository's owning team.

## 7. MCP write approval

Every MCP tool call made by an orchestration's agents (children and orchestrator) is classified
before it runs. A call is **read-only** only when the tool's annotations declare `readOnlyHint: true`
on a connection in the fixed set. Anything else, including a missing annotation, is a write.

A write does not run until it is approved:

1. The tool wrapper writes an `OrchestrationApproval` (`PENDING`, with a redacted digest of the
   arguments, never the values) and an `APPROVAL_REQUEST` message.
2. It waits, heartbeating, for a decision or `orchestration.approvalTimeoutSeconds`.
3. The launcher approves or denies with `POST /orchestrations/:id/approvals/:approvalId`, which is
   launcher-only and never callable by the in-app assistant. A timeout is a denial.
4. A denial or expiry returns a tool error to the agent. It never runs the call.

An approval covers the one call it names. A retry of the activity never re-executes an approved call:
the recorded decision is read, the call's outcome is recorded with it, and a second attempt returns the
recorded result. An orchestration launched by a service principal has no approver, so every write is
denied.

## 8. Visibility

- **API.** `GET /orchestrations` and `/:id` (the orchestration, children, status, spend), `GET
  /:id/messages?after=` (the transcript), `GET /:id/events` (a server-sent stream of the same
  records, falling back to polling). Visibility is the named team's members, the launcher and ADMIN;
  once a repository is attached, children are also visible under the normal run-visibility rules.
- **Run tree.** Each child's own run viewer is unchanged. The orchestration page lists children as
  lanes with live status, elapsed time, spend and the latest tool call, read from the existing trace
  polling endpoints.
- **Spend.** The orchestrator's spend rolls up by team as for any runless traces. An orchestration view
  sums its own spend with its children's, and states which team each part bills.
- **Transcripts.** The existing transcript routes serve each child. The orchestrator's turns are
  transcripts with no run, ADMIN-only as runless transcripts are today.

## 9. User interface

`/orchestrations` lists orchestrations; **Start work** (`/start?mode=orchestrate`) launches one.
`/orchestrations/[id]` has two columns on a wide screen and tabs on a narrow one.

- **Conversation.** The chat with the orchestrator, with its text, the launcher's messages, notices,
  and inline cards for an attach request, an MCP write approval, and the pull request group.
- **Agents.** One lane per child: agent, role badge (reader or writer with its path scopes), status,
  elapsed, spend, the latest tool call, a message box, cancel, and a link to the child's run. Pull
  requests appear as a group with combined CI status.
- **Header.** Repository state (none, requested, attached), the connection set, total spend and
  remaining budget, and a cancel for the whole orchestration.

Only the launcher sees the message box, attach confirmation and approval buttons; everyone else sees
the same page read-only. The page works at phone width, uses the dashboard's existing components and
tokens, and every control is keyboard reachable with a visible label.

## 10. Settings

Registry settings (ADMIN-only, global, not run-pinned unless stated), each defined once in
`config/registry.ts`:

| Key | Default | Meaning |
|---|---|---|
| `orchestration.enabled` | off | Kill switch for launching and for spawning. |
| `orchestration.maxChildren` | 12 | Children per orchestration. |
| `orchestration.maxConcurrentChildren` | 4 | Children running at once. |
| `orchestration.maxTurns` | 200 | Orchestrator turns per orchestration. |
| `orchestration.maxWallClockSeconds` | 14,400 | Lifetime of one orchestration. |
| `orchestration.approvalTimeoutSeconds` | 600 | How long a write waits for the launcher. |
| `orchestration.maxWriterChildren` | 4 | Writer children per orchestration. |

The workflow's own bounds are run-pinned at launch so a replay never takes a different path.

## 11. Security

- **Capability attenuation in code.** A child's tools, MCP connection, delivery mode and path scopes
  come from its agent definition and the validated intent; no argument widens them.
- **No agent-chosen authority.** The agent can neither pick a repository nor approve a write nor
  change an allowlist. Those are launcher acts on routes the in-app assistant cannot call.
- **Intent-only tools.** The orchestrator's tools perform nothing. They have no network or database
  access and receive no credentials.
- **Injection boundary.** Child results are the only data from children entering the orchestrator,
  fenced and screened (section 4.2).
- **Fail closed.** An unclassifiable path scope, an unannotated MCP tool, an unreachable permission
  lookup and an unavailable Temporal lookup all refuse rather than allow.
- **Audit.** Launch, spawn, refusal, steer, attach, approval and cancel each write an audit-log entry
  with the actor, as other launcher acts do.

## 12. Failure and lifecycle

- A child that fails, is cancelled or times out is a normal result the orchestrator sees. It is not an
  orchestration failure.
- The orchestration completes when the launcher ends it or the orchestrator ends a turn with no
  children running and no event for 30 minutes. A later message starts it again, as for the
  assistant. `continueAsNew` runs every 50 turns.
- Cancelling the orchestration cancels running children, with a refusal-safe cleanup that leaves
  pushed branches in place.
- A worker restart resumes from history. The polling backstop reconciles child states that a lost
  signal left stale.
- A turn activity is not retried (it streams into its reply), as for the assistant.

## 13. Delivery stages

Each stage lands as its own commits and passes every quality gate before the next.

| Stage | Content |
|---|---|
| 1. Contracts | Shared types, intent and result schemas, the pure scope and spawn validators, settings, Prisma models and migration, the `orchestrator` Agent seed and rosters. |
| 2. Gateway | Orchestration routes, the child launch route and orchestration token, attach and approval routes, steering writes, run-finalization signal, assistant policy entries, audit entries. |
| 3. Worker | `OrchestrationWorkflow`, turn and apply activities, polling backstop, step-boundary steering for the Mastra loop, workflow and replay tests. |
| 4. Delivery guard | `pathScopes` in the push policy, `AGENT_RUN_PATH_OUT_OF_SCOPE`, push-permission check, pull request grouping. |
| 5. MCP approvals | Read-only classification, the approval wrapper for agent tools, expiry. |
| 6. Dashboard | Pages, lanes, cards, hooks, launch form. |
| 7. CLI and MCP | `auto-swe orchestrate` commands and the MCP follow, launch and message tools. |
| 8. Documentation | `docs/orchestrations.md`, the `CLAUDE.md` §6 note, the stale harness sub-agent statement in `docs/agents.md`, site manifest and sidebar, docs index. |

## Out of scope

- Merging pull requests, and combining writer diffs into one branch.
- Several repositories in one orchestration.
- Mid-turn steering of harness-runtime children.
- Resumable, conversational children.
- Letting a child start an orchestration.
- Transfer of control to another user.
