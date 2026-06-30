# Channel assistant — remaining capability gaps vs. Claude Tag

> A granular inventory of **what Anthropic's Claude Tag does that our channel
> assistant does not yet support**. Source material:
> [`claude-tag-research.md`](./claude-tag-research.md). Supersedes the earlier
> `channel-assistant-gaps.md` by breaking all remaining gaps into concrete,
> independently-shippable capabilities — with severity, rough effort, and how each
> fits our existing architecture.
>
> **Updated after PR #112** (Gaps D/E/F) **and PR #113** (Gaps A + C, plus passive
> memory ingestion and per-channel persona). Five rows this doc originally listed as
> Missing/Partial have since shipped: **A — reactive interjection**, **C — open-item
> follow-up**, **D — future/scheduled tasks**, **E — workspace-level memory**, and
> **F — channel-memory consolidation**. #113 also added two capabilities that were
> not originally Claude-Tag rows — **passive memory ingestion** (learn from
> non-mention messages) and a **per-channel/team persona** prompt. Shipped rows are
> kept in the scorecard (marked **Have ✅**) for continuity, and their detail
> sections record what shipped; the open analysis below is rows **B, G, H, I, J, K**.
>
> Legend — **Have**: at parity. **Partial**: a weaker form exists. **Missing**: not
> built. Effort is a rough order of magnitude (S ≈ days, M ≈ 1–2 weeks, L ≈ a phase).

---

## 1. Capability scorecard

| # | Claude Tag capability | Us | Status |
| --- | --- | --- | --- |
| A | Reactive ambient (watch messages, decide to interject) | `evaluateReactiveInterjection` + per-channel Schedule | **Have ✅ #113** |
| B | Organization-wide awareness ("flag things from across the org") | opt-in `flagOrgSignals` on the ambient fire (private sources excluded) | **Have ✅** |
| C | Follow-up on forgotten threads / open tasks | `ChannelOpenItem` + `sweepChannelOpenItems` on the ambient fire | **Have ✅ #113** |
| D | Future / scheduled task planning ("plan tasks to complete later") | `runAt` → `ChannelScheduledTaskWorkflow` | **Have ✅ #112** |
| E | Workspace-level (cross-channel) memory | `retrieveChannelMemory` searches sibling channels | **Have ✅ #112** |
| F | Memory consolidation / hygiene for channel memory | `consolidateChannelMemory` on every ambient fire | **Have ✅ #112** |
| G | "Does not report from private channels" rule | `SlackChannel.isPrivate` excludes the channel as a cross-channel source | **Have ✅** |
| H | Persistent live conversational session | reconstructed per turn | **Partial** |
| I | Packaged Slack app UX (App Home, slash commands, install) | raw Events API webhooks | **Partial** |
| J | Multiplayer auditing (who asked what, per channel) | `GET /:id/audit` + admin "Audit" modal over channel runs | **Have ✅** |
| K | Maturity / battle-testing at scale | newly built, not CI-validated | **Missing** |
| — | One shared `@assistant` per channel | shared agent + memory + steering | Have |
| — | Per-channel scoping of tools/data/memory | `CHANNEL` config tier | Have |
| — | Per-channel + per-org spend caps | `ChannelMonthlyUsage` + `OrgMonthlyUsage` | Have |
| — | Autonomous multi-stage execution | PR #110 (general + code routes) | Have |
| — | Multiplayer mid-task hand-off | thread-reply `steer` signal | Have |
| — | DM for sensitive data | `message.im` handled | Have |
| — | Admin view/edit/delete of memory | admin memory CRUD | Have |
| — | Configurable model (Opus 4.8 default) | DB-driven model config | Have / ahead |
| — | Passive memory ingestion (learn from non-mention messages) | `passiveIngestChannelMemory` (opt-in, #113) | Have |
| — | Per-channel / per-team persona | `personaPrompt` / `defaultPersonaPrompt` (#113) | Have / ahead |

The rest of this doc details the **open Partial/Missing** rows (B, G, H, I,
J, K), grouped by theme. §2 and §3–§4 record what A/C/D/E/F shipped, for continuity.

---

## 2. Ambient & proactivity (rows A, B, C)

### A. Reactive interjection — **Have ✅ · shipped #113**

Claude Tag's ambient mode does three distinct things; #113 shipped the first, A.
Rows B and C remain open.

**Shipped:** `evaluateReactiveInterjection` polls `conversations.history` at each
Schedule tick (configurable `reactiveCron` per channel), using `lastReactiveCheckAt`
as an exclusive cursor so it never re-reads the same window. Four hard gates keep it
noise-averse: (1) new-message gate — LLM fires only when there are human messages
since the cursor; (2) budget gate — `isChannelOverBudgetNow` check; (3) cooldown —
no re-interject within 10 minutes of the last post; (4) SKIP-aware — a reply
beginning with `skip` is not posted. `retrieveChannelMemory` is injected as context
(best-effort). Cost accrues to `ChannelMonthlyUsage`; `countRun` is `true` only
when a message is actually posted. The per-channel `reactiveCron` + `reactiveEnabled`
toggle are managed via the existing admin slack-channels UI. See
`channel-assistant.md` §10 and `packages/worker/src/activities/channelReactive.ts`.

**Passive memory ingestion (also shipped in #113):** `passiveIngestChannelMemory`
runs on the ambient fire when a channel opts in (`passiveIngestEnabled`, default
off). It reads recent human messages past a `passiveIngestCursor` (the Slack `ts`
of the newest message already processed, stored raw to avoid float-precision loss),
extracts salient durable facts via an LLM, and writes them to channel memory — no
`@mention` required. This is the "learns your company from ambient chatter"
behaviour. Budget-gated and best-effort like the other ambient passes.

### B. Organization-wide awareness — **Have ✅ · shipped**
**Claude Tag:** flags things *from across the organization* — it can connect a
question in one channel to activity in another, **proactively**.

**Shipped:** `flagOrgSignals`, a best-effort 5th activity on the ambient fire. When
a channel opts in (`orgFlaggingEnabled`, default off), it embeds the channel's
recent memory (its "focus") once, runs `searchOrgChannelMemory` over OTHER channels
in the same **org**, and lets the channel agent decide — high bar, SKIP-aware —
whether anything is worth flagging into this channel, naming the source channel.

Designed to respect isolation, which is the tension B always carried:
- **Opt-in + admin-granted** — `orgFlaggingEnabled` is off by default; an admin
  turns it on per channel. No org-wide visibility happens by default.
- **Private-channel exclusion (Gap G) baked in** — `searchOrgChannelMemory` JOINs
  `slack_channels` and excludes `is_private = true` (and inactive) SOURCE channels,
  so a private channel's content is never flagged elsewhere.
- **Rate-limited** — a hard `lastOrgFlagAt` cooldown (20 h) keeps org flags rare
  and signal-rich; budget-gated; cost accrues with `countRun: false`.

This shipped the *proactive* half; the *team*-scoped reactive read half was Gap E
(#112). See `packages/worker/src/activities/flagOrgSignals.ts`.

### C. Follow-up on forgotten threads / tasks — **Have ✅ · shipped #113**
**Claude Tag:** "follows up on forgotten threads or tasks."

**Shipped:** a first-class `ChannelOpenItem` model (`description`, `ownerUserId`,
`status` ∈ {OPEN, RESOLVED, DISMISSED}, `sourceTs` dedup anchor, `lastNudgedAt`)
plus `sweepChannelOpenItems`, run on every ambient fire after consolidation. Each
sweep does three things: **detect** new open items in the recent message window
(LLM, structured output) and which tracked items now read as resolved; **persist**
— insert fresh items (deduped by `sourceTs`, else by description) and flip resolved
ones to RESOLVED; **nudge** — for each still-OPEN item older than 24 h and not
nudged in the last 12 h, post a brief `<@owner> any update on …?` follow-up. The
cooldown stamp is written *before* the Slack post (at-most-once) so a transient
Slack failure can't double-nudge. Budget-gated and best-effort like the other
ambient passes; cost accrues with `countRun: false`. Admins view/dismiss items in
the `/admin/slack-channels` UI. See `packages/worker/src/activities/channelOpenItems.ts`.

---

## 3. Tasks & planning (row D) — ✅ shipped in #112

### D. Future / scheduled task planning — **Have ✅ · shipped #112**
**Claude Tag:** "can also plan tasks to complete in the future."

**Shipped:** `delegateTask` gained an optional `runAt` (ISO 8601). When the agent
defers a task, `ChannelAssistantWorkflow` starts a `ChannelScheduledTaskWorkflow`
wrapper under the same per-thread id, which `sleep()`s until `runAt`, folds any
mid-wait `steer` replies into the task, then launches the real `RunnableWorkflow`.
An invalid/past `runAt` is dropped (runs immediately). See `channel-assistant.md`
§9.

**Still open (small):** a *fired* deferred run isn't steerable after launch (it
runs under a private `<id>-run` child id); and autonomous *detection* of
follow-ups — "this thread has an open question, chase it" — is a different
capability, tracked as **C** below. D covers *explicit* "do this at time T," not
self-initiated follow-up.

---

## 4. Memory depth & hygiene (rows E, F) — ✅ shipped in #112

### E. Workspace-level (cross-channel) memory — **Have ✅ · shipped #112**
**Claude Tag:** memory is kept **per channel *and* per workspace** — org knowledge
that isn't trapped in one channel.

**Shipped:** `retrieveChannelMemory` takes an optional `teamId` and, when the
channel-scoped results leave room, runs a second pgvector search over sibling
channels in the same team (higher threshold, labelled `[from another channel]`).
The query is embedded once across both searches. See `channel-assistant.md` §9.

**Scope note:** the read deliberately stays within one *team*, not the whole org —
the org-wide *proactive flagging* half is row **B**, still open.

### F. Channel-memory consolidation — **Have ✅ · shipped #112**
**Claude Tag** explicitly flags memory going **stale/noisy/wrong** as the key risk.

**Shipped:** `consolidateChannelMemory` clusters un-consolidated channel memories
(shared `clusterByEmbedding`), synthesises each qualifying cluster into 1–2 durable
facts, and soft-deletes the sources. It runs best-effort after the digest on every
ambient fire, is budget-gated, and accrues cost with `countRun: false`.

**Still open (small):** consolidation cadence/params are not yet per-channel
configurable (built-in defaults, no opt-out) — tracked as a future refinement in
`channel-assistant.md` §11.

---

## 5. Safety, session & distribution (rows G, H, I, J)

### G. "Does not report from private channels" — **Have ✅ · shipped**
**Claude Tag** has an explicit rule: it does not surface content *from* private
channels (into ambient/org-wide reporting).

**Shipped:** a `SlackChannel.isPrivate` flag (default false). When set, the
channel's memory is never returned as a *source* in another channel's
cross-channel read — `searchTeamChannelMemory` (the team-scoped half of
`retrieveChannelMemory`) JOINs `slack_channels` and filters `sc.is_private = false`,
so a private channel's facts stay inside it even though they share a team. The
channel still uses its OWN memory normally (the `channel_id = X` query is
unaffected). The flag is auto-defaulted from Slack's `channel_type: 'group'` at
provision time (set on create only, so it never silently undoes an admin override)
and is admin-editable in `/admin/slack-channels`. The same flag is the exclusion
hook B will honour for org-wide reporting. See `packages/worker/src/lib/channelMemory.ts`.

### H. Persistent live conversational session — **Partial · Severity Medium · Effort M**
**Claude Tag** feels like a continuous teammate. **Us:** each turn is a *stateless*
workflow invocation; continuity is **reconstructed** from thread history + channel
memory, and in a channel the user must **re-`@mention` on every turn** (plain
replies only steer an active task). Fast back-and-forth feels more stateless than
the Claude app. A long-lived per-thread (or per-channel) signal workflow that
holds session state — and lets a follow-up reply continue without a re-mention —
would close this. (Noted as a future refinement in `channel-assistant.md` §10.)

### I. Packaged Slack-app UX — **Partial · Severity Low · Effort M**
**Claude Tag** ships as a first-class Slack app (replacing the old one). We drive
everything through the **Events API** with a manifest, but lack App Home, slash
commands (`/assistant …`), shortcuts, and a one-click install/onboarding flow.
Functional parity exists; the packaged-product polish does not.

### J. Multiplayer auditing — **Have ✅ · shipped**
Claude Tag's own reported concern: multiplayer makes **permissions + auditing**
harder.

**Shipped:** a per-channel **"who asked what, when, and what it touched"** audit
feed. `startChannelRun` now stamps the triggering `userSlackId` + a truncated
message snapshot onto the channel run's `specSnapshot.channel` (mention path);
`GET /api/v1/admin/slack-channels/:id/audit` aggregates the channel's `WorkflowRun`
rows (matched by the `channelId` in the Json snapshot), returning kind
(mention/ambient/reactive), who, when, status, cost, tokens, and the `runId`. The
admin "Audit" modal in `/admin/slack-channels` renders it with a kind filter and a
`trace →` link to the full `/runs/<id>` tool-call sequence ("what it touched").
Team-scoped read (same `assertChannelAccess` guard as the other channel reads).

---

## 6. Maturity (row K)

### K. Battle-testing at scale — **Missing · non-technical**
Claude Tag is validated internally (Anthropic cites ~65% of its product team's
code created via their internal version). Ours is newly built and **not yet
deployed or CI-validated** end-to-end in a live workspace. No code closes this —
it needs a real install, a pilot channel, and observation.

---

## 7. Divergences and where we already match or exceed

### 7a. Divergences (different by design, not strictly worse)

| Area | Claude Tag | Ours |
| --- | --- | --- |
| **Budget** | Token-based plan consumption, caps per channel/org | USD `monthlyBudgetUsdCents` per-channel + per-org `OrgMonthlyUsage`; **soft** cap (Serializable-read gate — a true pre-flight hard cap isn't achievable for post-hoc LLM cost) |
| **Private channels** | "Does not report from private channels" (explicit rule) | Explicit `SlackChannel.isPrivate` flag (Gap G ✅) excludes a private channel as a source in cross-channel reads + future org-wide reporting; channel-scoping still prevents leakage at the base tier |
| **Distribution** | Hosted; replaces the Claude Slack app (30-day migration); fixed on Opus 4.8 | Self-hosted feature; model is DB-configurable (defaults to `anthropic/claude-opus-4-8`) |

### 7b. Where ours matches or exceeds

Not gaps — called out so the comparison is honest:

- **Tenant isolation** via the `CHANNEL` config tier (per-channel agent / tools /
  MCP / credentials) is arguably *stronger* and more explicit than a hosted product
  exposes. ("HR's assistant won't leak to engineering.")
- **DM for sensitive data** — parity (`message.im` handled).
- **Admin control + observability** — likely *more* than the hosted product exposes:
  `/admin/slack-channels` CRUD, memory view/**edit**/delete, per-channel usage,
  `/runs` per-turn traces/cost, and a `CHANNEL_SUSPICIOUS` security feed.
- **Self-hosted + MCP-extensible + multi-provider/DB-configurable models** —
  Claude Tag is hosted and pinned to Opus 4.8.
- **Cost in real USD** per channel + per org (vs. plan-token consumption), with the
  same run-level cost/trace observability as every other workflow.
- **Governed by platform RBAC** and the workflow engine (HITL, scanners, eval
  nodes) the rest of the system already has.

---

## 8. Suggested priority order

A/C/D/E/F shipped (A + C in #113, D/E/F in #112), along with passive memory
ingestion and per-channel persona. Remaining work, re-ranked for discussion (not a
commitment):

1. **H — live session** (M), **I — app UX** (M): UX/ops polish; valuable but not
   differentiating. (**B — org-wide flagging** ✅, **G** ✅, **J — audit view** ✅
   all shipped.)
2. **F-config follow-up** (S) + **D steering follow-up** (S): small refinements —
   per-channel consolidation config; making a fired deferred run steerable.
3. **K — pilot + hardening**: cross-cutting; start a pilot channel regardless.

> Resolved (B shipped): the open question was *how aggressively* to do org-wide
> proactive visibility given it trades against per-channel isolation. The answer
> taken was **conservative**: B is **opt-in per channel** (default off, admin
> turns it on), **excludes private source channels** (Gap G baked in), and is
> **hard rate-limited** (a 20 h cooldown). So the differentiating isolation holds
> by default — org-wide flagging is a deliberate, per-channel opt-in, not a
> platform-wide posture.
