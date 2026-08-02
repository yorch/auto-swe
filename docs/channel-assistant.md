# Channel Assistant

One shared assistant that lives in a Slack channel. Anyone can `@mention` it to ask a question or
delegate work; it carries channel-scoped memory, tools, budget, and persona, and can act
proactively. It is built on the platform's existing pieces — the agent resolver, semantic memory,
MCP tool binding, the Slack app, and org/team RBAC — rather than a parallel stack.

It plays two roles at once, and both matter. It is a capability a team uses directly — answering
questions with repo and run context, summarising a thread, tracking open items — and it is the
platform's **conversational control surface**: workflows are started from a run modal or the "Run a
workflow" shortcut (§9), progress is reported in-channel, HITL gates are answered with Slack
buttons ([hitl-workflows.md](./hitl-workflows.md)), and workflow drafts are refined in a thread
([nl-workflow-authoring.md](./nl-workflow-authoring.md)). Teams manage their automation from the
channel they already work in rather than a separate console.

---

## 1. Data model

| Model | Purpose |
| --- | --- |
| `SlackWorkspace` | A connected workspace (`slackTeamId`), owned by one `Organization`. Carries the per-workspace bot token (encrypted) plus `appId` / `botUserId` / `installedAt` from the OAuth install. |
| `SlackChannel` | A channel the assistant is resident in. Unique on `(workspaceId, slackChannelId)`. See the field groups below. |
| `ChannelThreadSession` | `lastAssistantAt` per `(channelId, threadTs)` — the freshness anchor for follow-up sessions. |
| `ChannelOpenItem` | A tracked open item, deduped by `sourceTs`. `ChannelOpenItemStatus` is `OPEN` → `RESOLVED` or `DISMISSED`; `lastNudgedAt` rate-limits stale-item nudges. |
| `ChannelMonthlyUsage` | Per-channel monthly cost ledger, unique on `(channelId, yearMonth)`. |
| `ChannelBudgetHold` | One in-flight claim on that ledger — the row that makes a hold reversible when the worker holding it dies. Swept past `expiresAt`. |
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
- **Cross-channel reads are bounded twice.** `searchTeamChannelMemory` and `searchOrgChannelMemory`
  filter on the reading channel's `team_id` / `org_id`, and join `slack_channels` to exclude
  `is_private = true` sources. A private channel's memory is never a source for another channel, and
  no read crosses an org.
- **`isPrivate` comes from Slack.** At provision time the gateway calls `conversations.info` for the
  authoritative `is_private`. When Slack cannot answer — no token, no `groups:read` scope, a network
  failure — it falls back to the payload heuristic (`channel_type: 'group'` on the events path, a
  `G`-prefixed id on the shortcut path). The flag is written on CREATE only and is admin-editable
  afterwards, so neither source can undo an override.
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

A turn's real cost is only known after the model answers, so a turn takes a **hold** against the cap
before it runs and settles that hold for the true cost afterwards (`reserveChannelTurn` →
`ChannelBudgetHold.settle`). The hold is an atomic increment on the ledger row, and each turn decides
on the total *before* its own increment — so remaining headroom is a resource turns consume rather
than a number they all read, which matters because turn workflow ids are per-event and a busy channel
runs many at once. It is pinned to the month it was taken in, and scaled by the number of model calls
the held work will make — an assistant turn holds for two (the reply and the memory summarizer that
follows it, which settle against the same hold), and the passes that fan out over a batch hold for
the batch size.

**The hold is priced, not guessed at.** `estimateHoldUsd` resolves the agent the channel is bound to
and prices a nominal turn envelope (8K in / 1.5K out) through `calculateCostUsd`, the same helper the
run ledger prices real calls with — so an Opus channel holds ~$0.078 per call and a Haiku channel
~$0.016, rather than sharing one number that is ~5x wrong for one of them, and the hold cannot drift
from the cost it is netted against. `CHANNEL_TURN_RESERVATION_USD` ($0.05) survives only as the
fallback for a model with no known price, since a zero hold would bound nothing.

Every channel pass resolves its agent at the **CHANNEL tier** — `{ channelId, orgId, teamId }`
threaded explicitly into `resolveAgent`, `getModel` and `loadAgentSkills`. The ambient Temporal
context carries no `channelId`, so a pass that priced its hold at that tier and bound its model
without it would charge for a channel-scoped override it never used.

With `H` USD of headroom, at most `H / estimate` calls are admitted, and each can overshoot by however
far its real cost exceeds its hold — so the aggregate overshoot is bounded by admitted concurrency,
not unbounded by it as a plain read gate was.

**A hold is a row, not just an increment.** The increment is what bounds concurrency; the
`ChannelBudgetHold` row beside it — written in the same transaction — is what makes the claim
reversible. A worker that dies mid-turn never settles, and without the row its estimate would sit on
the ledger for the rest of the calendar month. Instead a sweep reclaims any row past `expiresAt`
(`CHANNEL_HOLD_TTL_MS`, 30 minutes), subtracting exactly what it added. Deleting the row *is* the
claim, so a sweeper and a settling turn racing the same hold cannot both refund it — and a turn whose
hold was swept settles its full cost rather than netting against a reservation that is already gone.

**The sweep runs from the refusal, not the happy path.** The accrued total a gate reads *includes*
outstanding holds, so the state the sweep exists to repair — a channel pushed over its cap by holds
nobody is spending against — is exactly the state that refuses every subsequent turn. Both
`isChannelOverBudgetNow` and `reserveChannelTurn` therefore sweep from inside their refusal branch,
and re-decide only when the sweep actually reclaimed something. A channel under its cap never pays
the extra round-trips; a channel that has genuinely spent its budget — for which refusal is the
*steady* state, not a rare path — pays one query and no re-read.

The corollary is that a channel comfortably under its cap never sweeps at all, so its abandoned holds
sit until something pushes it to the cap.
`POST /api/v1/admin/slack-channels/:id/budget/reset` clears them on demand — API-only, with no
control in the admin UI. It reports how many holds it actually released, and is deliberately not a
"zero the month" button: it subtracts exactly what the holds added and leaves real spend alone, so
recovering from a crash never doubles as disabling the cap.

**The refund protocol has one implementation**, `releaseChannelBudgetHolds` in
`@auto-swe/shared/lib/channelBudget`, shared by the sweep and the reset. One transaction per hold,
delete before decrement, credit the *hold's own* month, never touch `runsCompleted`. It lives in
`shared` because it is a data-model invariant rather than route logic: a bug there credits real spend
back and quietly loosens the cap it exists to enforce.

One path still spends on the channel ledger **without** a hold: `finalizeChannelTaskRun`. A delegated
task run spends across a whole workflow, not inside one activity, so there is nothing in-process to
hold. `isChannelOverBudgetForTask` gates its *launch* with a plain read, and its summed cost lands on
the channel ledger when the run finalizes.

`isChannelOverBudgetNow` is that read. It also runs as a cheap bail before a held path does any
prompt-building work — it decides nothing on its own there; the hold is what enforces the cap.

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
`/api/v1/admin/slack-channels` (plus `/:id/budget`, `/:id/budget/reset`, `/:id/audit`, and the
memory and open-item
sub-resources); channel-scoped agents are created from the agent-library form with `CHANNEL` scope
and a channel picker. `/:id/budget/reset` has no UI control — it is called directly, by an admin who
knows a worker crashed mid-turn.

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

**Not yet validated in a live workspace.** This is the load-bearing caveat: the capability surface
below is built and unit-tested, but it has not been run against a real Slack workspace under
sustained use. No code closes this — it needs an install, a pilot channel, and observation. Treat
the proactivity features especially (ambient digests, reactive interjection, org-wide flagging) as
unproven on real traffic, and turn them on one channel at a time.

- **The budget cap is bounded, not exact.** See §7 — the hold prices a *nominal* turn envelope
  against the bound model, so a turn with an unusually long prompt or reply overshoots by the
  difference, and the aggregate overshoot still scales with how many calls the remaining headroom
  admits. `finalizeChannelTaskRun` spends on the ledger with no hold at all. A hold lost to a worker
  crash over-counts the channel until the sweep reclaims it — which only happens once the channel
  reaches its cap, or an admin calls `/:id/budget/reset` (API-only; there is no UI control).
- **Reactive interjection posts at channel root**, not into the most relevant thread.
- **No per-stage progress posts** back into a task thread beyond the live `chat.update` on turns;
  the run itself is observable in `/runs`.
- **No single long-lived per-channel workflow.** Turns are per-mention and ambient work is
  schedule-driven. Durable mid-task hand-off is already covered by thread-bound task runs, so
  consolidating onto one signal workflow per channel remains optional.
- **Channel input scanning is non-blocking.** `scanChannelInput` runs the same `scanSkillContent`
  the implementer's output scanner uses, but a warning only records a `channel.suspicious_input`
  advisory event and the turn proceeds; the whole thing is wrapped in try/catch so a scanner
  failure cannot abort a turn. A channel is also a *lower-trust* input surface than a ticket —
  anyone in the workspace can type into it, and a delegated task turns that text into autonomous
  work. The scanner coverage gaps in [agents.md §11](./agents.md#11-limitations) apply here too:
  a `bash` call is checked only against `SHELL_COMMAND` patterns, and the write-path scanners gate
  the `writeFile` tool only.
- **`isPrivate` is captured once, at provision.** It is read from `conversations.info` when Slack
  answers, but nothing re-checks it afterwards: a channel converted to private in Slack keeps the
  value it was provisioned with, and its memory stays a cross-channel source until an admin flips
  the flag. Where Slack cannot answer, the payload heuristics still apply and neither is
  authoritative for every channel shape. Verify the flag on any channel holding sensitive
  discussion rather than trusting the default.

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
