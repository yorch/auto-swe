# Channel Assistant

One shared assistant that lives in a Slack channel. Anyone can `@mention` it to ask a question or
delegate work; it carries channel-scoped memory, tools, budget, and persona, and can act
proactively. It is built on the platform's existing pieces — the agent resolver, semantic memory,
MCP tool binding, the Slack app, and org/team RBAC — rather than a parallel stack.

---

## 1. Data model

| Model | Purpose |
| --- | --- |
| `SlackWorkspace` | A connected workspace (`slackTeamId`), owned by one `Organization`. Carries the per-workspace bot token (encrypted) plus `appId` / `botUserId` / `installedAt` from the OAuth install. |
| `SlackChannel` | A channel the assistant is resident in. Unique on `(workspaceId, slackChannelId)`. See the field groups below. |
| `ChannelThreadSession` | `lastAssistantAt` per `(channelId, threadTs)` — the freshness anchor for follow-up sessions. |
| `ChannelOpenItem` | A tracked open item, deduped by `sourceTs`. `ChannelOpenItemStatus` is `OPEN` → `RESOLVED` or `DISMISSED`; `lastNudgedAt` rate-limits stale-item nudges. |
| `ChannelMonthlyUsage` | Per-channel monthly cost ledger, unique on `(channelId, yearMonth)`. |
| `MemoryItem` | Gains `channelId` / `teamId` / `orgId` for channel-scoped memory. |
| `Agent` | Gains `channelId` for `CHANNEL`-scoped rows; partial-unique `(key, version, channelId) WHERE scope='CHANNEL'`. |

`SlackChannel` fields group by concern:

| Concern | Fields |
|---|---|
| Identity & routing | `agentKey` (the driving Agent), `teamId` (RBAC + team cascade tier), `orgId` (denormalized for memory and budget) |
| Proactivity | `ambientEnabled` / `ambientCron`, `reactiveEnabled` / `reactiveCron`, `lastReactiveCheckAt` / `lastReactiveAt`, `orgFlaggingEnabled` / `lastOrgFlagCheckAt` |
| Cooldown tuning | `reactiveCooldownMinutes`, `reactiveLookbackMinutes`, `orgFlagCooldownHours`, `openItemNudgeAfterHours`, `openItemNudgeCooldownHours` — all nullable; null means the worker's built-in default |
| Memory | `passiveIngestEnabled` / `passiveIngestCursor`, `consolidationEnabled` / `consolidationMinClusterSize` / `consolidationSimilarityThreshold`, `isPrivate` |
| Conversation | `personaPrompt`, `followupSessionEnabled` |
| Spend | `monthlyBudgetUsdCents` |

---

## 2. Config cascade

`ConfigScope` carries a `CHANNEL` value, giving the agent resolver five tiers:

```
WORKFLOW_TEMPLATE → CHANNEL → TEAM → ORGANIZATION → GLOBAL
```

The `CHANNEL` tier fires only when `ctx.channelId` is set, so non-Slack runs are unaffected.
Provider credentials deliberately keep `GLOBAL` / `ORGANIZATION` / `TEAM` scopes only, enforced by a
DB CHECK — there is no channel-level credential tier. `CHANNEL`-scoped agent rows are created from
the Slack admin surface rather than the generic scope dropdowns.

---

## 3. Conversation

An `@mention` starts a `ChannelAssistantWorkflow` that replies in-thread, with live progress via
`chat.update` while it works. Each turn fetches the thread's prior messages through
`conversations.replies` and prepends them as context, so a thread reads as one conversation. DMs
(`message.im`) are handled for anything a user would rather not ask in public.

**Persona.** `SlackChannel.personaPrompt` falls back to `Team.defaultPersonaPrompt` via
`resolvePersonaPrompt` — a pure synchronous cascade in `lib/channelPersona.ts`. The result is
injected at the top of the system prompt, before tool hints, across every channel LLM path.
Editable per channel at `/admin/slack-channels` and team-wide at `/teams/[id]`.

**Follow-up sessions.** With `followupSessionEnabled`, a plain reply continues a thread without a
re-`@mention` while `ChannelThreadSession.lastAssistantAt` is fresh (a 30-minute window). Follow-up
turns pass through an addressed-to-me intent gate: a turn the model judges is not directed at the
assistant returns `suppressed` and posts nothing. Steering a running task always takes precedence
over conversational follow-up.

**Injection scanning.** Channel input is scanned advisorily and surfaces as a `CHANNEL_SUSPICIOUS`
security event in `/admin/security`.

---

## 4. Autonomous task execution

Delegating with an `@mention` launches a durable, thread-bound `RunnableWorkflow`. There are two
routes:

- **Code route** — uses the team's SWE template and behaves like any engineering run.
- **General route** — runs the seeded "Channel Task" template: `plan → cond → {single | composite}`.
  A `planChannelTask` step, deliberately biased against splitting, returns 1..N subtasks. A cohesive
  task runs a single `channelAssistant` node; a splittable one runs `runChannelSubtasks`, which does
  bounded-concurrency subtask fan-in plus synthesis inside one activity. `finalizeChannelTaskRun`
  reads `nodes.composite.output.text ?? nodes.task.output.text`.

> The fan-in lives inside one activity rather than using a `fanOut` node because the interpreter
> cannot surface a branch agent's text back to a join.

**Steering.** A reply in the task's thread sends a `steer` signal to the running workflow, which
`drainSteering` picks up and `prependSteering` folds into the next agent call — mid-task hand-off
without restarting.

**Deferral.** A task given a `runAt` is wrapped in `ChannelScheduledTaskWorkflow`. The wrapper stays
alive after firing, holding the child handle so a fired deferred run remains steerable from the
thread.

---

## 5. Proactivity

Four best-effort activities ride a per-channel ambient Temporal Schedule, plus a separate reactive
schedule. All are opt-in, budget-gated, and SKIP-aware — a model reply beginning with `skip` posts
nothing.

| Mode | Trigger | Behaviour |
|---|---|---|
| **Ambient digest** | `ambientCron` | Posts a proactive channel digest |
| **Reactive interjection** | `reactiveCron` | Polls `conversations.history` from an exclusive cursor and decides whether to chime in. Four gates: new human messages since the cursor, budget, a cooldown since the last post, and SKIP |
| **Open-item tracking** | Ambient fire | `sweepChannelOpenItems` detects new open items, marks resolved ones, and nudges stale ones. Deduped by `sourceTs` |
| **Org-wide flagging** | Ambient fire | `flagOrgSignals` embeds the channel's recent memory once, searches org channels (excluding private sources), and flags cross-org signals against a high bar |

Org-wide flagging advances its 20-hour cooldown once the embedding and search have run — whether it
flagged, skipped, or found nothing, and stamped before the LLM call — so a rarely-flagging channel
does not re-pay the embedding and search on every fire. Its cost accrues with `countRun: false`.

Proactivity is conservative by default: org-wide flagging is per-channel opt-in, never reads private
channels, and is hard rate-limited, so channel isolation holds unless an admin deliberately relaxes
it.

---

## 6. Memory

Channel memory is ordinary `MemoryItem` rows scoped by `channelId` / `teamId` / `orgId`, retrieved
by the same pgvector search as everything else.

- **Retrieval** — `retrieveChannelMemory` reads the channel's own memory and sibling channels on the
  same team, auto-injected as turn context.
- **Cross-channel reads exclude private sources.** `searchTeamChannelMemory` and
  `searchOrgChannelMemory` join `slack_channels` and filter `is_private = false`. `isPrivate`
  defaults from Slack's `channel_type: 'group'` at provision and is admin-editable. A private
  channel's memory is never a source for another channel.
- **Passive ingestion** — with `passiveIngestEnabled`, `passiveIngestChannelMemory` silently
  extracts up to five salient facts from human messages on each ambient fire, advancing a
  `passiveIngestCursor` and de-duplicating at 0.85 similarity. Accrues with `countRun: false`.
- **Consolidation** — `consolidateChannelMemory` clusters and merges related items on each ambient
  fire, honouring the per-channel `consolidationEnabled` toggle and optional cluster-size and
  similarity overrides.

Admins can view, edit, and delete channel memory from the admin surface. Editing an item's text
kicks off `ReembedMemoryWorkflow` so its pgvector embedding catches up to the new text — started
best-effort, because a Temporal hiccup must not fail the synchronous edit.

Consolidation and lesson consolidation share `clusterByEmbedding` (`lib/embeddingClustering.ts`).

---

## 7. Budgets

`ChannelMonthlyUsage` mirrors `OrgMonthlyUsage` and backs `monthlyBudgetUsdCents`. Channel spend is
tracked in the channel ledger and is *not* double-counted into `OrgMonthlyUsage`.

The cap is a soft gate, not a hard reservation: pre-flight cost reservation is not achievable for
post-hoc LLM cost, so the guarantee is a Serializable-transaction read ensuring **at most one
in-flight turn can overshoot**. `isChannelOverBudgetNow` gates conversational and proactive turns;
`isChannelOverBudgetForTask` gates the heavier delegated task runs.

---

## 8. Observability & admin

Every turn and ambient digest creates a lightweight `WorkflowRun` (`startChannelRun` → turn →
`finalizeChannelRun`) under a seeded GLOBAL "Channel Assistant" template. This gives
`persistActivityTrace` a resolvable `runId`, so per-turn status, cost, tokens, and the full
`AgentTrace` stream appear in the run viewer.

The main `/runs` list default-excludes both chatter templates — "Channel Assistant" and
"Channel Task" — behind an opt-in toggle, so channel volume does not bury engineering runs.
Code-route tasks use the team's SWE template and stay visible like any engineering run.

**Audit feed.** `startChannelRun` stamps the triggering `userSlackId` and a truncated message
snapshot onto `specSnapshot.channel`. `GET /api/v1/admin/slack-channels/:id/audit` aggregates the
channel's runs into a "who asked what, when, and what it touched" feed — kind, who, when, status,
cost, tokens, run ID. The admin Audit modal renders it with a kind filter and a link through to the
full tool-call sequence. Read access uses the same `assertChannelAccess` guard as memory and open
items.

Channels are configured at `/admin/slack-channels` over
`/api/v1/admin/slack-channels` (plus `/:id/budget`, `/:id/audit`, and the memory and open-item
sub-resources); channel-scoped agents are created from the agent-library form with `CHANNEL` scope
and a channel picker.

**Schedule lifecycle.** `provisionChannel` registers a channel on first contact, defaulting
`isPrivate` from Slack's `channel_type`. Toggling ambient or reactive mode calls
`syncChannelAmbientSchedule` / `deleteChannelAmbientSchedule` on the gateway's Temporal plugin, so
the per-channel Temporal Schedule is created, retimed, or torn down to match the row.

---

## 9. Slack surface

| Surface | Detail |
|---|---|
| Install | `GET /api/v1/auth/slack/install[/callback]` → `oauth.v2.access` → an encrypted per-workspace bot token. The bot token is the only per-workspace secret; the signing secret and OAuth credentials stay singleton. "Add to Slack" lives on `/admin/integrations` |
| App Home | `app_home_opened` → `publishAppHome` → `views.publish` renders a Block Kit front door (`buildAppHomeView` is pure and unit-tested) |
| Slash | `/auto-swe` — workflow list/show and a run modal |
| Shortcuts | A global "Run a workflow" picker, and a message shortcut "Ask auto-swe about this" that starts a turn on the message with no account link required |

All Slack I/O resolves its token by channel or workspace ID via
`resolveSlackBotTokenForSlackChannel` / `resolveSlackBotTokenForWorkspace`, falling back to the
singleton config.

Thread-history context requires the `channels:history` and `groups:history` bot scopes — see
[slack-app-setup.md](./slack-app-setup.md) for reinstall instructions.

---

## 10. Known limitations

- **No hard budget cap.** See §7 — the gate allows at most one in-flight overshoot.
- **Reactive interjection posts at channel root**, not into the most relevant thread.
- **No per-stage progress posts** back into a task thread beyond the live `chat.update` on turns;
  the run itself is observable in `/runs`.
- **No single long-lived per-channel workflow.** Turns are per-mention and ambient work is
  schedule-driven. Durable mid-task hand-off is already covered by thread-bound task runs, so
  consolidating onto one signal workflow per channel remains optional.

---

## 11. Key files

| Area | Paths |
|---|---|
| Workflows | `workflows/channelAssistant.ts`, `channelScheduledTask.ts`, `channelReactive.ts`, `taskChild.ts` |
| Activities | `activities/channelAssistant.ts`, `channelReactive.ts`, `channelTask.ts`, `channelTaskPlan.ts`, `channelOpenItems.ts`, `consolidateChannelMemory.ts`, `passiveIngestChannelMemory.ts` |
| Worker libs | `lib/channelMemory.ts`, `channelPersona.ts`, `channelTurnPrompts.ts`, `embeddingClustering.ts`, `slackNotify.ts` |
| Steering | `workflows/runnable.ts` (`steer` handler), `activities/runAgentNode.ts` (`prependSteering`), `shared/workflow/interpreter.ts` (`drainSteering`) |
| Gateway | `routes/slack.ts` (events, thread-reply steering), `routes/slackChannels.ts`, `plugins/temporal.ts` (`startChannelAssistant`) |
| Web | `app/admin/slack-channels/`, `app/teams/[id]/page.tsx` (persona card), `hooks/useSlackChannels.ts` |
| Shared | `lib/channelTask.ts` (`channelTaskWorkflowId`, `CHANNEL_TASK_STEER_SIGNAL`), `lib/syncBuiltins.ts` (`channelAssistant`, `syncChannelTaskTemplate`) |
