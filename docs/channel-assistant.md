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

## 8. Observability & admin UI

Every channel turn + ambient digest creates a lightweight `WorkflowRun` keyed to
its Temporal workflow id (`startChannelRun` → the turn → `finalizeChannelRun`),
under a seeded GLOBAL **"Channel Assistant"** template. This fixes a silent
trace-drop (`persistActivityTrace` needs a resolvable `runId`) so per-turn
status/cost/tokens + the full `AgentTrace` stream show up in the `/runs` viewer.
The main `/runs` list **default-excludes** Channel Assistant runs (opt-in
`includeChannel` / a "Show channel-assistant runs" toggle) so channel volume
doesn't bury engineering runs. `finalizeChannelRun` writes only the run's own
denormalized cost — channel spend is still tracked in `ChannelMonthlyUsage` (no
double-count into `OrgMonthlyUsage`).

The advisory injection scan surfaces as a `CHANNEL_SUSPICIOUS` security event
(`activity_event` `toolName='channel.suspicious_input'`) in `/admin/security`.
Channel-scoped agents are created from the agent-library admin form (CHANNEL
scope + channel picker), and channels themselves (agent, ambient cron, budget,
memory) from `/admin/slack-channels`.

## 9. Future refinements (not built)

- **Long-lived per-channel workflow** (signals + continue-as-new) for true
  in-flight mid-task hand-off. The current design uses per-mention turns +
  scheduled ambient, which covers reactive + proactive needs without the
  rearchitecture.
- **A true hard budget cap** (pre-flight cost reservation) — not achievable for
  post-hoc LLM cost; the current gate is a Serializable-transaction read whose
  guarantee is "at most one in-flight turn can overshoot."

> **Thread-history context** via `conversations.replies` is now implemented
> (previously listed here as a future refinement). Each assistant turn fetches
> the current thread's prior messages and prepends them as context before the
> LLM call. Requires the `channels:history` and `groups:history` bot scopes
> (added in the manifest); see `docs/slack-app-setup.md` for reinstall
> instructions.

## 10. Key files

- Schema: `packages/shared/src/prisma/schema.prisma` (`SlackWorkspace`,
  `SlackChannel`, `ChannelMonthlyUsage`, `ConfigScope.CHANNEL`).
- Resolver: `packages/worker/src/lib/config/agentResolver.ts`, `types.ts`.
- Worker: `packages/worker/src/workflows/channelAssistant.ts`,
  `packages/worker/src/activities/channelAssistant.ts`,
  `packages/worker/src/lib/slackNotify.ts` (`postSlackThreadMessage`).
- Gateway: `packages/gateway/src/routes/slack.ts` (`/events`),
  `packages/gateway/src/routes/slackChannels.ts`,
  `packages/gateway/src/plugins/temporal.ts` (`startChannelAssistant`).
- Web: `packages/web/src/app/admin/slack-channels/`,
  `packages/web/src/hooks/useSlackChannels.ts`.
- Seed: `packages/shared/src/lib/syncBuiltins.ts` (`channelAssistant`).
