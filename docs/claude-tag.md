# Claude Tag — Slack channel teammate

> Status: **in progress.** Foundation + Phase 0 + Phase 1 shipped; Phases 2–4 planned. Living doc — code is authoritative where this diverges.

A Claude-Tag-style teammate: one shared Claude that lives in a Slack channel,
that anyone can `@mention` to delegate work, with per-channel scoping of
tools/agents/memory/budget and (planned) an ambient mode that posts proactively.
Modeled on Anthropic's Claude Tag; built on the platform's existing agent
resolver, semantic memory, MCP tool binding, Slack app, and org/team RBAC.

---

## 1. Data model

| Model | Purpose |
| --- | --- |
| `SlackWorkspace` | A connected Slack workspace (`slackTeamId` = Slack's `T…` id), owned by one `Organization`. |
| `SlackChannel` | A channel where Claude is resident. `agentKey` selects the driving Agent; `teamId` governs RBAC + the team tier of the cascade; `orgId` is denormalized for memory + budget; `ambientEnabled`/`ambientCron` gate proactive mode; `monthlyBudgetUsdCents` caps spend. Unique on `(workspaceId, slackChannelId)`. |
| `ChannelMonthlyUsage` | Per-channel monthly cost ledger (`(channelId, yearMonth)` unique), mirroring `OrgMonthlyUsage`; backs the per-channel budget cap. |
| `MemoryItem` (+`channelId`/`teamId`/`orgId`) | Channel/team/org scoping columns for channel-scoped "team memory" (used from Phase 2). |
| `Agent` (+`channelId`) | `CHANNEL`-scoped agent rows carry the channel id; partial-unique `(key, version, channelId) WHERE scope='CHANNEL'`. |

Migrations: `00000000000002_claude_tag_channel_scope` (adds the `CHANNEL` enum
value, isolated per the Postgres same-tx rule) and `00000000000003_claude_tag_foundation`.

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

## 5. Planned

- **Phase 2 — team memory**: thread `channelId`/`teamId`/`orgId` through
  `commitToMemory` + `retrieveSimilarLessons` + consolidation; auto-inject
  retrieved memory into the channel agent's prompt; admin view/edit per channel.
- **Phase 3 — ambient mode**: a `slack-ambient` trigger + scheduled digests +
  forgotten-thread follow-ups, on a long-lived per-channel workflow
  (signals + continue-as-new), with rate-limiting + per-channel budget guards.
- **Phase 4 — multiplayer polish**: shared per-channel session state, `chat.update`
  live progress edits, mid-task hand-off, and injection scanning of ingested
  channel content.

## 6. Key files

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
