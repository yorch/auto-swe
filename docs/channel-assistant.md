# Channel assistant — Slack channel teammate

> Status: **Foundation + Phases 0–4 shipped.** Living doc — code is authoritative where this diverges.

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
| `SlackChannel` | A channel where the assistant is resident. `agentKey` selects the driving Agent; `teamId` governs RBAC + the team tier of the cascade; `orgId` is denormalized for memory + budget; `ambientEnabled`/`ambientCron` gate proactive mode; `monthlyBudgetUsdCents` caps spend. Unique on `(workspaceId, slackChannelId)`. |
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
- `writeChannelMemory` — embeds + inserts a channel-scoped row (`repo_id` NULL,
  `channel_id/team_id/org_id` set, `scope='channel-memory'`).
- `runChannelAssistantTurn` retrieves the top relevant memories and prepends a
  compact context block to the user message before the LLM call (when not over
  budget); after a non-trivial turn it best-effort writes the exchange as memory.
  Storing the raw exchange is the baseline; a summarizing pass is a future
  refinement.
- Admin surface: `GET /api/v1/admin/slack-channels/:id/memory` (team-visible) +
  `DELETE …/memory/:memoryId` (admin), surfaced in the `/admin/slack-channels`
  UI. No edit endpoint — editing the text would strand the pgvector embedding
  (re-embed is a worker concern), so view + delete is the deliberate surface.

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

Closes gaps **#1** and **#2** from [`channel-assistant-gaps.md`](./channel-assistant-gaps.md)
(full design in [`channel-assistant-autonomy-design.md`](./channel-assistant-autonomy-design.md)).
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
  `@auto-swe/shared/lib/channelTask`, shared by worker + gateway). One task run per
  thread; a re-delegate in the same thread is rejected (reuse policy), not clobbered.
  The `RunInput` carries `slackChannelId`/`slackMessageTs` so the run's terminal
  notification threads the result back into the originating conversation, and
  `channelId` so the run's agent nodes resolve the CHANNEL config tier and the cost
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

## 9. Observability & admin UI

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
(`activity_event` `toolName='channel.suspicious_input'`) in `/admin/security`.
Channel-scoped agents are created from the agent-library admin form (CHANNEL
scope + channel picker), and channels themselves (agent, ambient cron, budget,
memory) from `/admin/slack-channels`.

## 10. Future refinements (not built)

- **Long-lived per-channel workflow** (signals + continue-as-new). In-flight
  mid-task hand-off is now covered for *task runs* (§8: a delegated run is durable,
  thread-bound, and steerable from replies). A single long-lived per-*channel*
  signal workflow (vs. per-mention conversational turns + scheduled ambient) remains
  a possible consolidation, but isn't required for the hand-off use case anymore.
- **Per-stage progress posts** back into the task thread (the run is already
  observable in `/runs`; richer in-thread "working on X" updates are a polish item).
- **Richer general-route decomposition** — the general "Channel Task" template is a
  single agent node today; a `planDecomposition` + `fanOut` spec would let general
  tasks break into stages like the code route's SWE template can.
- **A true hard budget cap** (pre-flight cost reservation) — not achievable for
  post-hoc LLM cost; the current gate is a Serializable-transaction read whose
  guarantee is "at most one in-flight turn can overshoot."

> **Thread-history context** via `conversations.replies` is now implemented
> (previously listed here as a future refinement). Each assistant turn fetches
> the current thread's prior messages and prepends them as context before the
> LLM call. Requires the `channels:history` and `groups:history` bot scopes
> (added in the manifest); see `docs/slack-app-setup.md` for reinstall
> instructions.

## 11. Key files

- Schema: `packages/shared/src/prisma/schema.prisma` (`SlackWorkspace`,
  `SlackChannel`, `ChannelMonthlyUsage`, `ConfigScope.CHANNEL`).
- Resolver: `packages/worker/src/lib/config/agentResolver.ts`, `types.ts`.
- Worker: `packages/worker/src/workflows/channelAssistant.ts`,
  `packages/worker/src/activities/channelAssistant.ts`,
  `packages/worker/src/activities/channelTask.ts` (autonomous task launch, §8),
  `packages/worker/src/workflows/runnable.ts` (`steer` handler),
  `packages/worker/src/activities/runAgentNode.ts` (`prependSteering`),
  `packages/worker/src/lib/slackNotify.ts` (`postSlackThreadMessage`).
- Gateway: `packages/gateway/src/routes/slack.ts` (`/events`, thread-reply steering),
  `packages/gateway/src/routes/slackChannels.ts`,
  `packages/gateway/src/plugins/temporal.ts` (`startChannelAssistant`).
- Web: `packages/web/src/app/admin/slack-channels/`,
  `packages/web/src/hooks/useSlackChannels.ts`.
- Shared: `packages/shared/src/lib/channelTask.ts` (`channelTaskWorkflowId`,
  `CHANNEL_TASK_STEER_SIGNAL`), `packages/shared/src/workflow/interpreter.ts`
  (`drainSteering`).
- Seed: `packages/shared/src/lib/syncBuiltins.ts` (`channelAssistant`,
  `syncChannelTaskTemplate`).
