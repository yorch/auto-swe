# Channel assistant — Slack channel teammate

> Status: **Foundation + Phases 0–4 + persona + passive ingestion + Gaps A/B/C/D/E/F/G/J shipped.** Living doc — code is authoritative where this diverges.

A channel-assistant-style teammate: one shared assistant that lives in a Slack
channel, that anyone can `@mention` to delegate work, with per-channel scoping of
tools/agents/memory/budget and (planned) an ambient mode that posts proactively.
Modeled on Anthropic's Claude Tag (see [`claude-tag-research.md`](./claude-tag-research.md)
for the source-product research); built on the platform's existing agent
resolver, semantic memory, MCP tool binding, Slack app, and org/team RBAC.

---

## 1. Data model

| Model | Purpose |
| --- | --- |
| `SlackWorkspace` | A connected Slack workspace (`slackTeamId` = Slack's `T…` id), owned by one `Organization`. |
| `SlackChannel` | A channel where the assistant is resident. `agentKey` selects the driving Agent; `teamId` governs RBAC + the team tier of the cascade; `orgId` is denormalized for memory + budget; `ambientEnabled`/`ambientCron` gate proactive mode; `reactiveEnabled`/`reactiveCron` gate reactive-interjection mode; `lastReactiveCheckAt`/`lastReactiveAt` track cursor + cooldown for reactive interjection (Gap A); `monthlyBudgetUsdCents` caps spend; `personaPrompt` is an optional freeform persona injected at the top of every system prompt; `passiveIngestEnabled`/`passiveIngestCursor` gate silent fact extraction (passive ingestion); `isPrivate` (Gap G) excludes the channel as a source in cross-channel memory reads + org-wide reporting; `orgFlaggingEnabled`/`lastOrgFlagAt` gate + rate-limit org-wide proactive flagging (Gap B). Unique on `(workspaceId, slackChannelId)`. |
| `ChannelMonthlyUsage` | Per-channel monthly cost ledger (`(channelId, yearMonth)` unique), mirroring `OrgMonthlyUsage`; backs the per-channel budget cap. |
| `MemoryItem` (+`channelId`/`teamId`/`orgId`) | Channel/team/org scoping columns for channel-scoped "team memory" (used from Phase 2). |
| `Agent` (+`channelId`) | `CHANNEL`-scoped agent rows carry the channel id; partial-unique `(key, version, channelId) WHERE scope='CHANNEL'`. |

Migrations: these models, the `CHANNEL` enum value, and the scoping columns are
folded into the consolidated Prisma baseline (`00000000000000_init`); the one
piece Prisma's DSL can't express — the `CHANNEL`-scoped partial unique index on
`agents` — lives in `00000000000001_custom_constraints_and_indexes`.

## 2. Config-scope cascade

`ConfigScope` gains a `CHANNEL` value. The agent resolver
(`fetchActiveAgent` / `resolveAgent`, `packages/worker/src/lib/config/agentResolver.ts`)
cascade is now:

```
WORKFLOW_TEMPLATE → CHANNEL → TEAM → ORGANIZATION → GLOBAL
```

The `CHANNEL` tier fires only when `ctx.channelId` is set, so non-Slack runs are
unchanged. `ResolveCtx` carries `channelId`. Provider credentials intentionally
keep their `GLOBAL/ORGANIZATION/TEAM`-only scopes (DB CHECK constraint) — there
is no channel-level credential tier. The generic config-scope pickers
(`CONFIG_SCOPES`) still offer the four general scopes; `CHANNEL`-scoped agent
rows are created from the Slack admin surface, not the dropdowns.

## 3. Phase 0 — conversational core (shipped)

A user `@mention`s the bot (or DMs it) → reply posted back in-thread.

- **Gateway** `POST /api/v1/auth/slack/events`: url_verification handshake,
  HMAC signature verification (before any processing), Slack-retry + bot/subtype
  guards, 200 ack within Slack's 3 s window, then out-of-band channel
  auto-provision + workflow start. Idempotent: deterministic workflow id
  `chan-<channelId>-<eventTs>` + `REJECT_DUPLICATE` reuse policy, so a
  re-delivered event can't double-reply.
- **Worker** `ChannelAssistantWorkflow` (task queue `engineering-workflow`):
  `runChannelAssistantTurn` resolves the channel's `agentKey` with `ctx.channelId`
  active and runs it via `runAgent` (cost + `AgentTrace` handled inside);
  `postChannelReply` posts threaded via `postSlackThreadMessage`. On error it
  posts a friendly fallback.
- Seeded GLOBAL `channelAssistant` Agent (`claude-opus-4-8`), a model-backed key.
- Slack app manifest subscribes to `app_mention` + `message.im`
  (`app_mentions:read`, `im:history`).

## 4. Phase 1 — per-channel scoping, admin, budgets (shipped)

- **Admin CRUD** `/api/v1/admin/slack-channels` (list/get/create/patch/delete +
  `/:id/budget`). Writes are platform-ADMIN; reads are auth-gated and filtered to
  the caller's teams. Create derives `orgId` from the team and rejects cross-org
  workspace pairing.
- **Channel-scoped agents**: the agent library accepts `CHANNEL` scope + a
  `channelId`, so admins can bind per-channel model/tool/MCP overrides that the
  resolver's CHANNEL tier picks up.
- **Budgets**: `runChannelAssistantTurn` enforces `monthlyBudgetUsdCents` as a
  **soft cap** (pre-check read + post-turn increment are not transactional, like
  the org budget) and accrues the run's authoritative `costUsd` into
  `ChannelMonthlyUsage`.
- **Admin UI**: `/admin/slack-channels` (list + create/edit/delete + budget).

## 5. Phase 2 — channel-scoped team memory (shipped)

The assistant builds context over time (`packages/worker/src/lib/channelMemory.ts`):

- `retrieveChannelMemory` — pgvector cosine similarity over `memory_items` scoped
  to `channel_id` (same embedding-space filter as `retrieveSimilarLessons`).
  Optionally also searches sibling channels in the same team (Gap E, §9).
- `writeChannelMemory` — embeds + inserts a channel-scoped row (`repo_id` NULL,
  `channel_id/team_id/org_id` set, `scope='channel-memory'`).
- `runChannelAssistantTurn` retrieves the top relevant memories and prepends a
  compact context block to the user message before the LLM call (when not over
  budget); after a non-trivial turn it best-effort writes the exchange as memory.
  Storing the raw exchange is the baseline; a summarizing pass is a future
  refinement.
- Admin surface: `GET /api/v1/admin/slack-channels/:id/memory` (team-visible) +
  `DELETE …/memory/:memoryId` (admin) + `PATCH …/memory/:memoryId` (admin —
  updates text and best-effort triggers `ReembedMemoryWorkflow` to refresh the
  pgvector embedding), surfaced in the `/admin/slack-channels` UI.

## 6. Phase 3 — ambient mode (shipped)

Proactive posting via a per-channel Temporal Schedule:

- When a channel is active with `ambientEnabled` + `ambientCron`, the gateway
  reconciles a `auto-swe-channel-ambient-<channelId>` Schedule
  (`syncChannelAmbientSchedule` / `deleteChannelAmbientSchedule` on the temporal
  decorator) on every channel create/update/delete.
- The schedule starts `ChannelAmbientWorkflow` → `runChannelAmbientDigest`:
  no-ops on a disabled/inactive channel, budget-gates, builds context from
  `recentChannelMemory`, runs the channel agent with an ambient prompt that
  replies `SKIP` when nothing's worth posting (a reply *starting* with `skip` is
  suppressed), and posts a top-level (un-threaded) digest only for substantive
  output; cost is accrued. The digest is **not** written back to channel memory
  — doing so would feed each scheduled digest its own prior output via
  `recentChannelMemory` (a compounding loop); channel memory accrues from real
  assistant turns only. It never throws (proactive ⇒ quiet on failure).
- After the digest, the same ambient fire runs three best-effort activities in
  order: `consolidateChannelMemory` (Gap F, §9) to compact accumulated channel
  memory; `sweepChannelOpenItems` (Gap C, §11) to track and nudge open items;
  and `passiveIngestChannelMemory` (passive ingestion, §9) to silently extract new facts
  from human messages.
- Scope note: ambient proactivity is delivered via Schedules (reusing the
  existing schedule machinery), not a long-lived signal-driven workflow — see
  §8.

## 7. Phase 4 — multiplayer polish (shipped)

- **Live progress (`chat.update`)**: `ChannelAssistantWorkflow` posts a
  placeholder into the thread, runs the turn, then edits that message in place
  with the reply (`updateSlackMessage`); falls back to a fresh post when no
  placeholder ts, and the error path edits the placeholder with the fallback.
- **Input safety**: `runChannelAssistantTurn` scans the untrusted user text with
  `scanSkillContent` before the LLM call — advisory (mirrors the LLM-output
  scanner): on a hit it records a `channel.suspicious_input` event and proceeds,
  wrapped so a scanner failure never aborts the turn.
- The shared per-channel agent + channel memory already make the assistant
  multiplayer (one shared assistant, shared context); this phase adds the
  live-edit UX + input safety.

## 8. Autonomous task execution + multiplayer hand-off (shipped)

Closes the autonomous-execution and multiplayer hand-off gaps (see
[`channel-assistant-remaining-gaps.md`](./channel-assistant-remaining-gaps.md) for
the full gap scorecard).
A mention that is real *work* (not a quick question) no longer just replies — it
launches a **durable, thread-bound workflow run**.

- **Launch (agent decides):** the channel agent carries a `delegateTask` tool. When
  it judges a mention to be a task, the turn returns a delegate intent
  (`{route, title, description, repoHint?}`) instead of (or alongside) a reply, and
  `ChannelAssistantWorkflow` starts a child `RunnableWorkflow`.
- **Two routes:** **general** runs the seeded GLOBAL **"Channel Task"** template
  (a repo-less `agent` node — `agentRef: 'channelAssistant'`); **code** resolves the
  channel's `git_repo` Connection (`resolveChannelRepo`: repo-hint match, else the
  team's sole repo) and runs the team's default **SWE** template (real implement →
  review → PR in a Docker workspace). The code route falls back to the general route
  when no repo resolves unambiguously.
- **Thread binding:** the run's workflow id is deterministic —
  `chantask-<channelId>-<threadTs>` (`channelTaskWorkflowId` in
  `@auto-swe/shared/lib/channelTask`, shared by worker + gateway). The id is
  **single-use** (`REJECT_DUPLICATE`): the `WorkflowRun` record is upserted by
  workflowId, so reusing the id for a second task would silently operate on the
  first (closed) run's row — instead a re-delegate is rejected and the assistant
  posts an honest "already taken on a task in this thread — reply to steer it, or
  start a new thread" note (no false ack). A reply *while* a task runs is steered by
  the gateway, never reaching a second launch.
  The `RunInput` carries `slackChannelId`/`slackMessageTs` so the run's terminal
  notification threads the result back into the originating conversation,
  `connectionId` (code route) so the run bills `OrgMonthlyUsage` + honors the org
  budget cap, and `channelId` so the run's agent nodes resolve the CHANNEL config
  tier and the cost
  accrues to the channel budget.
- **Signal-steering (multiplayer #2):** any teammate can reply in the task's thread
  to steer the in-flight run. The gateway's `/events` route detects a thread reply,
  reconstructs the run id, and sends a `steer` Temporal signal
  (`CHANNEL_TASK_STEER_SIGNAL`) carrying the reply text. `RunnableWorkflow` buffers
  steering messages; the dispatcher's `drainSteering()` hook drains the buffer into
  the **next** agent node's prompt (`prependSteering` — soft, next-step steering that
  preserves determinism). Steering takes precedence over starting a fresh
  conversational turn for that reply.
- **Budget gate:** a delegated launch is gated by the per-channel monthly budget
  (`isChannelOverBudgetForTask`) before the child run starts, and posts an
  acknowledgement so a launch is never silent.

Key files: `packages/worker/src/activities/channelTask.ts` (`createChannelTaskRun`,
`createChannelCodeTaskRun`, `resolveChannelRepo`), `channelAssistant.ts`
(`delegateTask` tool), `packages/worker/src/workflows/channelAssistant.ts` (child
launch) + `runnable.ts` (`steer` handler), `packages/shared/src/workflow/interpreter.ts`
(`drainSteering`), `packages/worker/src/activities/runAgentNode.ts` (`prependSteering`),
`packages/gateway/src/routes/slack.ts` (thread-reply → `signalWorkflow`),
`packages/shared/src/lib/channelTask.ts` + `syncBuiltins.ts` (Channel Task template).

## 9. Memory & scheduling depth — Gaps D/E/F (shipped)

Three follow-on capabilities round out memory and task execution:

- **Gap E — workspace-level (cross-channel) memory.** `retrieveChannelMemory`
  takes an optional `teamId`; when present and the channel-scoped results leave
  room under `limit`, it runs a second pgvector search over OTHER channels in the
  same team (`team_id = X AND channel_id != currentChannel`) at a higher
  similarity threshold (0.75 vs 0.65) so only strong sibling-channel matches bleed
  in. The query text is embedded ONCE (`generateEmbeddingWithSpec` →
  `QueryEmbedding`, passed as `precomputed` to both searches) — no double
  round-trip on the reply hot path. Cross-channel rows are labelled
  `crossChannel: true` and rendered `[from another channel]` in the context block.
  The two searches read disjoint rows, so no de-dup is needed.

- **Gap F — channel-memory consolidation.** `consolidateChannelMemory`
  (`packages/worker/src/activities/consolidateChannelMemory.ts`) mirrors the
  repo-scoped `consolidateLessons`: it clusters un-consolidated channel memories by
  cosine similarity (shared `clusterByEmbedding`/`vectorNorms` in
  `lib/embeddingClustering.ts`), synthesises each qualifying cluster (≥
  `minClusterSize`, default 3) into 1–2 durable facts via the `commitToMemory`
  model, and soft-deletes the sources (`consolidated_at = now()`). It honours the
  **channel budget** (same `isChannelOverBudgetNow` gate the digest uses — an
  over-budget channel skips it) and accrues its LLM cost to `ChannelMonthlyUsage`
  with `accrueChannelUsage(…, { countRun: false })` so a maintenance pass never
  inflates `runsCompleted`. It runs best-effort after the digest on every ambient
  fire (`ChannelAmbientWorkflow`); a failure never blocks the digest. Admins can
  inspect consolidated rows via `GET …/memory?includeConsolidated=true` and the
  "Show consolidated (archived) items" toggle in `/admin/slack-channels`.

- **Passive memory ingestion.** `passiveIngestChannelMemory`
  (`packages/worker/src/activities/passiveIngestChannelMemory.ts`) runs as the 4th
  best-effort activity in `ChannelAmbientWorkflow` on every ambient fire. When
  `passiveIngestEnabled` is true it silently extracts at most 5 salient facts from
  recent human messages (no `@mention` required) using the `commitToMemory` model.
  Cursor: `passiveIngestCursor` is a raw Slack `ts` string (float-format, avoids
  DateTime precision loss) — advanced to the newest message ts seen each tick so
  no window is re-read. Bot messages and empty texts are filtered before the LLM
  call. De-dup: each candidate fact is embedded and checked against existing channel
  memories at threshold 0.85; near-duplicates are skipped (the `consolidateChannelMemory`
  pass handles the rest). Budget-gated (`isChannelOverBudgetNow`) and accrued with
  `countRun: false`. Opt-in per channel; default `false`. Admin UI checkbox at
  `/admin/slack-channels`. Migration:
  Columns folded into `packages/shared/src/prisma/migrations/00000000000000_init/migration.sql`.

- **Gap D — deferred (scheduled) task execution.** The `delegateTask` tool gains
  an optional `runAt` (ISO 8601). `createChannelTaskRun` validates it — only a
  parseable, strictly-future timestamp is kept (`validFutureRunAt`); a garbled or
  past value is dropped so the task runs immediately rather than mis-scheduling.
  When deferred, `ChannelAssistantWorkflow` starts a `ChannelScheduledTaskWorkflow`
  wrapper under the SAME per-thread id (`chantask-<channelId>-<threadTs>`) with
  REJECT_DUPLICATE, so an immediate and a deferred task in one thread are mutually
  exclusive (no silent loss). The wrapper `sleep()`s until `runAt`, folds any
  mid-wait `steer` replies into the task description, then starts the real
  `RunnableWorkflow` under a private `<id>-run` child id. (Temporal SDK 1.17.2 has
  no `startDelay` for child workflows, so the sleep-wrapper is the mechanism.) The
  three child-launch call sites share one isolate-safe `startThreadTaskChild`
  helper (`workflows/taskChild.ts`) that owns the ABANDON / task-queue /
  REJECT_DUPLICATE invariants.

- **Gap G — private-channel reporting exclusion.** A `SlackChannel.isPrivate` flag
  (default false) implements Claude Tag's "does not report from private channels"
  rule. When set, the channel's memory is never surfaced as a *source* in another
  channel's cross-channel read: `searchTeamChannelMemory` (the team-scoped half of
  `retrieveChannelMemory`, Gap E) JOINs `slack_channels` and filters
  `sc.is_private = false`, so a private channel's facts stay inside it even though
  it shares a team. The reading channel's OWN memory (the `channel_id = X` query) is
  unaffected — a private channel still uses its own memory normally. The flag is
  auto-defaulted from Slack's `channel_type: 'group'` at provision time (set on
  CREATE only, so a best-effort default never silently undoes a later admin
  override) and is admin-editable in `/admin/slack-channels`. It is also the
  exclusion hook org-wide flagging (Gap B) honours.

- **Gap B — org-wide proactive flagging.** `flagOrgSignals`
  (`packages/worker/src/activities/flagOrgSignals.ts`) is a best-effort 5th activity
  on the ambient fire that surfaces notable activity from OTHER channels in the same
  org into this channel — "flags things from across the organization." Opt-in per
  channel (`orgFlaggingEnabled`, default off). It embeds the channel's recent memory
  (its focus) ONCE, runs `searchOrgChannelMemory` (org-scoped pgvector search,
  `is_private = false` + active source channels only — Gap G baked in), and lets the
  channel agent decide (high bar, SKIP-aware) whether to post a brief heads-up naming
  the source channel. Hard rate-limited by a `lastOrgFlagAt` cooldown (20 h) so flags
  stay rare; budget-gated; cost accrues with `countRun: false` only when it posts.
  The conservative opt-in + private-source exclusion is deliberate: org-wide
  visibility never happens by default, preserving per-channel isolation.

## 10. Reactive interjection — Gap A (shipped)

Beyond `@mention` (a turn) and the scheduled ambient digest, a channel can opt into
**reactive interjection**: the assistant watches the live conversation and
proactively chimes in only when it can clearly help — the difference between "a bot
you summon" and "a teammate paying attention."

Substrate (buffer + Schedule): rather than a gateway hot-path + per-message buffer
table, a per-channel **reactive Temporal Schedule** (`reactiveEnabled` +
`reactiveCron`, opt-in, default off) fires `ChannelReactiveWorkflow` →
`evaluateReactiveInterjection`, which reads recent channel history via
`conversations.history` at tick time (reusing the `channels:history` scope). No
firehose on the event path.

Cost-bounded + noise-averse (the #1 reported risk for proactive agents):
- **New-message gate** — the LLM fires ONLY when there are human messages newer
  than the channel's `lastReactiveCheckAt` cursor (advanced every tick). A quiet
  channel costs one cheap Slack read and zero tokens.
- **Budget gate** — over the monthly cap ⇒ no LLM, no post (same `isChannelOverBudgetNow`
  gate as the turn/digest).
- **Cooldown** — at most one interjection per 10-minute window (`lastReactiveAt`);
  on cooldown the LLM is skipped entirely.
- **High-bar SKIP** — the prompt instructs the agent to reply `SKIP` unless it has
  something genuinely useful (answer an unanswered question, correct a stale fact,
  surface forgotten context); a `SKIP`/empty/trivial reply is not posted.

Cost accrues to `ChannelMonthlyUsage`; `countRun` is true only when it actually
posts (a `SKIP` is a no-op evaluation, not a user-facing run). Admins toggle
reactive mode + cadence at `/admin/slack-channels`. Memory retrieval reuses the
cross-channel `retrieveChannelMemory` (Gap E). Passive memory ingestion (learning
from non-mention messages) is the natural next step on this same poll.

## 11. Open-item tracking — Gap C (shipped)

The channel assistant tracks **open items** — unanswered questions, unresolved tasks,
pending decisions — and nudges the channel when things go stale.

**How it works (rides the ambient schedule):** `ChannelAmbientWorkflow` calls
`sweepChannelOpenItems` as a best-effort third activity on every ambient fire (after the
digest and after `consolidateChannelMemory`). Three things happen per sweep:

1. **Detect** — the LLM reads the last 4 hours of channel messages and produces two
   lists: new `ChannelOpenItem` rows (description, optional `ownerUserId`, optional
   `sourceTs`) and `resolvedIds` (existing OPEN items that appear resolved in the
   recent thread).
2. **Persist** — new items are inserted; resolved IDs are `updateMany`-ed to `RESOLVED`.
   `sourceTs` (Slack message timestamp) is used as a **dedup anchor** so the same
   message never spawns two items across consecutive ambient fires. When `sourceTs`
   is absent (the LLM omitted it), a description-similarity check against existing
   `OPEN` items prevents near-duplicate entries.
3. **Nudge** — any OPEN item older than 24 hours and not nudged in the last 12 hours
   receives a polite top-level channel message: `<@USER> Just checking in — any update
   on: _description_?`. `lastNudgedAt` is advanced after each nudge; the cooldown
   prevents spam.

**Budget-gated:** same `isChannelOverBudgetNow` gate as the digest/reactive paths.
Never throws — a flaky sweep cannot crash the ambient schedule.

**Data model:** `ChannelOpenItem` (schema: `packages/shared/src/prisma/schema.prisma`),
`ChannelOpenItemStatus` enum (`OPEN` / `RESOLVED` / `DISMISSED`), composite index on
`(channel_id, status)`, `sourceTs` for dedup, `lastNudgedAt` for nudge cooldown.
Model columns folded into `packages/shared/src/prisma/migrations/00000000000000_init/migration.sql`.

**Admin API + UI:**
- `GET  /api/v1/admin/slack-channels/:id/open-items?status=OPEN|RESOLVED|DISMISSED|all`
  — ENGINEER+ authed, team-scoped, optional status filter.
- `PATCH /api/v1/admin/slack-channels/:id/open-items/:itemId` — admin-only, updates
  `status` (Resolve / Dismiss from the UI).
- `/admin/slack-channels` page gains an **"Open Items"** button per channel row →
  modal with status-filter tabs (OPEN / RESOLVED / DISMISSED / all), item list with
  description, age, owner mention, last-nudge time, and Resolve + Dismiss actions for
  OPEN items.

## 12. Per-channel personas (shipped)

Admins can give the channel assistant a **persona** — a free-form prompt fragment
(up to 2 000 chars) prepended to the top of every system prompt before any tool
hints or task-specific notes, letting different channels carry distinct voices,
domain focus, or behavioural rules.

**Resolution cascade** (`packages/worker/src/lib/channelPersona.ts`):

1. `SlackChannel.personaPrompt` — channel-specific override (highest priority).
2. `Team.defaultPersonaPrompt` — team-wide default for all channels belonging to
   that team that don't set their own.
3. `null` — no persona, system prompt is unchanged.

`resolvePersonaPrompt(channelPersonaPrompt, teamDefaultPersonaPrompt)` is a pure
synchronous function — callers include `team: { select: { defaultPersonaPrompt: true } }`
in their channel query and pass it directly, eliminating the extra DB round-trip.
`applyPersona(systemPrompt, persona)` prepends with a blank separator
(`"${persona}\n\n${systemPrompt}"`).

**Injection point:** `runChannelAgentTurn` (shared core for assistant, ambient,
and reactive paths) applies the persona to `spec.systemPrompt` immediately after
`resolveAgentSpec` and before any `promptNote` or tool hints, so tool-calling
instructions stay closest to the model's attention boundary.

**Admin surfaces:**
- `SlackChannel` create/patch: `personaPrompt` field (nullable string). Surfaced
  in the `/admin/slack-channels` modal (Textarea below the budget field) for both
  create and edit.
- `Team` default: `PATCH /api/v1/teams/:id` with `{ defaultPersonaPrompt }` (team
  LEAD or platform ADMIN). Surfaced in the `/teams/[id]` page as a "Default
  Persona" card (visible to team ADMINs and platform ADMINs).

**Scope:** persona is resolved at turn time (same activity call as model
selection), so changing it takes effect on the next LLM call without a workflow
restart.

## 13. Observability & admin UI

Every channel turn + ambient digest creates a lightweight `WorkflowRun` keyed to
its Temporal workflow id (`startChannelRun` → the turn → `finalizeChannelRun`),
under a seeded GLOBAL **"Channel Assistant"** template. This fixes a silent
trace-drop (`persistActivityTrace` needs a resolvable `runId`) so per-turn
status/cost/tokens + the full `AgentTrace` stream show up in the `/runs` viewer.
The main `/runs` list **default-excludes** both channel chatter templates —
**"Channel Assistant"** (per-turn/ambient) and the general **"Channel Task"**
(§8) — via `notIn: ['Channel Assistant', 'Channel Task']` (opt-in `includeChannel`
/ a "Show channel runs" toggle) so channel volume doesn't bury engineering runs.
The **code**-route task uses the team's SWE template and stays visible like any
engineering run. `finalizeChannelRun` writes only the run's own denormalized cost
— channel spend is still tracked in `ChannelMonthlyUsage` (no double-count into
`OrgMonthlyUsage`).

The advisory injection scan surfaces as a `CHANNEL_SUSPICIOUS` security event
(`activity_event` with `name='channel.suspicious_input'`) in `/admin/security`.
Channel-scoped agents are created from the agent-library admin form (CHANNEL
scope + channel picker), and channels themselves (agent, ambient cron, budget,
memory) from `/admin/slack-channels`.

**Per-channel audit feed (Gap J).** Building on those run records, `startChannelRun`
stamps the triggering `userSlackId` + a truncated message snapshot onto the mention
run's `specSnapshot.channel`. `GET /api/v1/admin/slack-channels/:id/audit` aggregates
the channel's `WorkflowRun` rows (matched by the `channelId` in the Json snapshot)
into a **"who asked what, when, and what it touched"** feed — kind, who, when,
status, cost, tokens, and the `runId`. The admin **"Audit"** modal in
`/admin/slack-channels` renders it with a kind filter (mention/ambient/reactive) and
a `trace →` link to the full `/runs/<id>` tool-call sequence. Team-scoped read (same
`assertChannelAccess` guard as memory/open-items).

## 14. Future refinements (not built)

- **Long-lived per-channel workflow** (signals + continue-as-new). In-flight
  mid-task hand-off is now covered for *task runs* (§8: a delegated run is durable,
  thread-bound, and steerable from replies). A single long-lived per-*channel*
  signal workflow (vs. per-mention conversational turns + scheduled ambient) remains
  a possible consolidation, but isn't required for the hand-off use case anymore.
- **Reactive interjection in a thread** — §10 posts top-level; targeting the reply
  into the most-relevant thread (rather than the channel root) is a refinement.
- **Per-stage progress posts** back into the task thread (the run is already
  observable in `/runs`; richer in-thread "working on X" updates are a polish item).
- **Richer general-route decomposition** — the general "Channel Task" template is a
  single agent node today; a `planDecomposition` + `fanOut` spec would let general
  tasks break into stages like the code route's SWE template can.
- **A true hard budget cap** (pre-flight cost reservation) — not achievable for
  post-hoc LLM cost; the current gate is a Serializable-transaction read whose
  guarantee is "at most one in-flight turn can overshoot."
- **Per-channel consolidation config** — Gap F (§9) consolidates on every ambient
  fire with built-in `minClusterSize`/`similarityThreshold` defaults and no
  per-channel opt-out. The repo-scoped sibling exposes both an admin cron
  (`resolveConsolidationConfig`) and a per-connection enable flag; a CHANNEL-scoped
  override + enable boolean would bring channel consolidation to parity. The
  current coupling is safe (budget-gated, `countRun: false`) but not yet tunable.

> **Thread-history context** via `conversations.replies` is now implemented
> (previously listed here as a future refinement). Each assistant turn fetches
> the current thread's prior messages and prepends them as context before the
> LLM call. Requires the `channels:history` and `groups:history` bot scopes
> (added in the manifest); see `docs/slack-app-setup.md` for reinstall
> instructions.

## 15. Key files

- Schema: `packages/shared/src/prisma/schema.prisma` (`SlackWorkspace`,
  `SlackChannel`, `ChannelMonthlyUsage`, `ChannelOpenItem`, `ChannelOpenItemStatus`,
  `ConfigScope.CHANNEL`); all columns folded into
  `packages/shared/src/prisma/migrations/00000000000000_init/migration.sql`.
- Resolver: `packages/worker/src/lib/config/agentResolver.ts`, `types.ts`.
- Worker: `packages/worker/src/workflows/channelAssistant.ts`,
  `packages/worker/src/workflows/channelScheduledTask.ts` (Gap D deferral, §9),
  `packages/worker/src/workflows/channelReactive.ts` (Gap A reactive, §10),
  `packages/worker/src/workflows/taskChild.ts` (`startThreadTaskChild` launch helper),
  `packages/worker/src/activities/channelAssistant.ts`,
  `packages/worker/src/activities/channelReactive.ts` (Gap A reactive, §10),
  `packages/worker/src/activities/channelTask.ts` (autonomous task launch, §8),
  `packages/worker/src/activities/channelOpenItems.ts` (Gap C open-item sweep, §11),
  `packages/worker/src/activities/consolidateChannelMemory.ts` (Gap F, §9),
  `packages/worker/src/activities/passiveIngestChannelMemory.ts` (passive ingestion, §9),
  `packages/worker/src/lib/channelMemory.ts` (Gap E cross-channel search, §9),
  `packages/worker/src/lib/embeddingClustering.ts` (shared clustering, §9),
  `packages/worker/src/workflows/runnable.ts` (`steer` handler),
  `packages/worker/src/activities/runAgentNode.ts` (`prependSteering`),
  `packages/worker/src/lib/slackNotify.ts` (`postSlackThreadMessage`, `fetchChannelHistory`).
- Gateway: `packages/gateway/src/routes/slack.ts` (`/events`, thread-reply steering),
  `packages/gateway/src/routes/slackChannels.ts`,
  `packages/gateway/src/plugins/temporal.ts` (`startChannelAssistant`).
- Web: `packages/web/src/app/admin/slack-channels/`,
  `packages/web/src/app/teams/[id]/page.tsx` (persona card),
  `packages/web/src/hooks/useSlackChannels.ts`,
  `packages/web/src/hooks/useTeams.ts` (`useUpdateTeam` with `defaultPersonaPrompt`).
- Shared: `packages/shared/src/lib/channelTask.ts` (`channelTaskWorkflowId`,
  `CHANNEL_TASK_STEER_SIGNAL`), `packages/shared/src/workflow/interpreter.ts`
  (`drainSteering`).
- Seed: `packages/shared/src/lib/syncBuiltins.ts` (`channelAssistant`,
  `syncChannelTaskTemplate`).
