# Channel assistant — remaining capability gaps vs. Claude Tag

> A granular inventory of **what Anthropic's Claude Tag does that our channel
> assistant does not yet support**. Source material:
> [`claude-tag-research.md`](./claude-tag-research.md). Builds on the prior
> [`channel-assistant-gaps.md`](./channel-assistant-gaps.md) by breaking the
> *remaining* gaps into concrete, independently-shippable capabilities — with
> severity, rough effort, and how each would fit our existing architecture.
>
> **Updated after PR #112** (Gaps D/E/F). Three of the rows this doc originally
> listed as Missing/Partial have since shipped: **D — future/scheduled tasks**,
> **E — workspace-level memory**, and **F — channel-memory consolidation**. They
> are kept in the scorecard (marked **Have ✅ #112**) for continuity, and their
> detail sections now record what shipped; the open analysis below is rows **A,
> B, C, G, H, I, J, K**.
>
> Legend — **Have**: at parity. **Partial**: a weaker form exists. **Missing**: not
> built. Effort is a rough order of magnitude (S ≈ days, M ≈ 1–2 weeks, L ≈ a phase).

---

## 1. Capability scorecard

| # | Claude Tag capability | Us | Status |
| --- | --- | --- | --- |
| A | Reactive ambient (watch messages, decide to interject) | scheduled digest only | **Partial** |
| B | Organization-wide awareness ("flag things from across the org") | per-channel; cross-channel *memory* only | **Missing** |
| C | Follow-up on forgotten threads / open tasks | memory digest, no item tracking | **Missing** |
| D | Future / scheduled task planning ("plan tasks to complete later") | `runAt` → `ChannelScheduledTaskWorkflow` | **Have ✅ #112** |
| E | Workspace-level (cross-channel) memory | `retrieveChannelMemory` searches sibling channels | **Have ✅ #112** |
| F | Memory consolidation / hygiene for channel memory | `consolidateChannelMemory` on every ambient fire | **Have ✅ #112** |
| G | "Does not report from private channels" rule | no explicit rule | **Missing** |
| H | Persistent live conversational session | reconstructed per turn | **Partial** |
| I | Packaged Slack app UX (App Home, slash commands, install) | raw Events API webhooks | **Partial** |
| J | Multiplayer auditing (who asked what, per channel) | `/runs` + security events | **Partial** |
| K | Maturity / battle-testing at scale | newly built, not CI-validated | **Missing** |
| — | One shared `@assistant` per channel | shared agent + memory + steering | Have |
| — | Per-channel scoping of tools/data/memory | `CHANNEL` config tier | Have |
| — | Per-channel + per-org spend caps | `ChannelMonthlyUsage` + `OrgMonthlyUsage` | Have |
| — | Autonomous multi-stage execution | PR #110 (general + code routes) | Have |
| — | Multiplayer mid-task hand-off | thread-reply `steer` signal | Have |
| — | DM for sensitive data | `message.im` handled | Have |
| — | Admin view/edit/delete of memory | admin memory CRUD | Have |
| — | Configurable model (Opus 4.8 default) | DB-driven model config | Have / ahead |

The rest of this doc details the **open Partial/Missing** rows (A, B, C, G, H, I,
J, K), grouped by theme. §3–§4 record what D/E/F shipped, for continuity.

---

## 2. Ambient & proactivity (rows A, B, C)

Claude Tag's ambient mode does three distinct things; we only do the first, and
only on a timer.

### A. Reactive interjection — **Partial · Severity High · Effort M**
**Claude Tag:** watches ongoing conversation and *decides* to jump in (answer a
question nobody tagged it on, correct a stale fact, surface a relevant doc).

**Us:** a per-channel Temporal **Schedule** fires `ChannelAmbientWorkflow` to post
a digest from channel memory. It never reacts to a specific live message — it's a
cron, not a listener.

**Fit:** we already ingest `message.channels` events (the steering path). The
missing piece is a cheap **"should I interject?" classifier** on non-mention
messages, gated hard (rate-limited, confidence-thresholded, opt-in per channel) to
avoid the firehose Claude Tag itself warns about. Highest-value remaining gap —
it's the difference between "a bot you summon" and "a teammate that's paying
attention."

### B. Organization-wide awareness — **Missing · Severity Medium · Effort L**
**Claude Tag:** flags things *from across the organization* — it can connect a
question in one channel to activity in another, **proactively**.

**Us:** #112 added a cross-channel **read** path on the *reactive* side —
`retrieveChannelMemory` now also searches sibling channels in the same team (Gap
E). But the **proactive** half is still missing: the ambient digest
(`ChannelAmbientWorkflow`) is per-channel and never flags activity from *other*
channels into a channel. There is no org-level ambient workflow that watches the
whole org and surfaces cross-channel signals. This is the part of B that remains,
and it is the one in real tension with isolation — it needs an explicit,
admin-granted "org-visibility" capability rather than a default (a new config
scope or memory-visibility flag), plus the private-channel exclusion in G baked
in. (The E read path deliberately stays within one *team*, which is why it didn't
require G.)

### C. Follow-up on forgotten threads / tasks — **Missing · Severity Medium · Effort M**
**Claude Tag:** "follows up on forgotten threads or tasks."

**Us:** the ambient digest *summarizes* recent memory, but we don't **track open
action items** as first-class objects with a due/stale notion, so we can't chase a
specific unanswered question or stalled task.

**Fit:** a lightweight `ChannelOpenItem` model (source message, owner, status,
lastNudgedAt) populated by the turn/ambient agent and swept by the existing
schedule. Reuses the Temporal Schedule we already run for digests.

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

### G. "Does not report from private channels" — **Missing · Severity Medium · Effort S**
**Claude Tag** has an explicit rule: it does not surface content *from* private
channels (into ambient/org-wide reporting). Our channel-scoping prevents
cross-channel leakage today, but once we add B/E (cross-channel reads), we need an
explicit private-channel exclusion or we recreate the leak. Cheap to add now as a
flag on `SlackChannel`; load-bearing once cross-channel reads exist.

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

### J. Multiplayer auditing — **Partial · Severity Low–Med · Effort S–M**
Claude Tag's own reported concern: multiplayer makes **permissions + auditing**
harder. We have `/runs` traces + a `CHANNEL_SUSPICIOUS` security feed, but no
per-channel **"who asked what, when, and what did it touch"** audit view. Mostly an
aggregation over data we already persist (`WorkflowRun` + `AgentTrace` + the run's
`userSlackId`).

---

## 6. Maturity (row K)

### K. Battle-testing at scale — **Missing · non-technical**
Claude Tag is validated internally (Anthropic cites ~65% of its product team's
code created via their internal version). Ours is newly built and **not yet
deployed or CI-validated** end-to-end in a live workspace. No code closes this —
it needs a real install, a pilot channel, and observation.

---

## 7. Where we already match or exceed

Not gaps — called out so the comparison is honest:

- **Tenant isolation** via the `CHANNEL` config tier (per-channel agent / tools /
  MCP / credentials) is arguably *stronger* and more explicit than a hosted
  product exposes.
- **Self-hosted + MCP-extensible + multi-provider/DB-configurable models** —
  Claude Tag is hosted and pinned to Opus 4.8.
- **Cost in real USD** per channel + per org (vs. plan-token consumption), with the
  same run-level cost/trace observability as every other workflow.
- **Governed by platform RBAC** and the workflow engine (HITL, scanners, eval
  nodes) the rest of the system already has.

---

## 8. Suggested priority order

D/E/F shipped in #112 (the bottom of the original "value ÷ effort" list cleared).
Remaining work, re-ranked for discussion (not a commitment):

1. **A — reactive interjection** (M): now the highest *product* value remaining;
   turns "summon" into "teammate that's paying attention." Must ship behind a hard
   per-channel opt-in + rate limit + confidence threshold to avoid the firehose
   Claude Tag itself warns about. The message-stream subscription it needs is also
   the foundation for **passive memory ingestion** (learn from non-mention
   messages, not just turns — the "learns your company one message at a time"
   behavior we don't yet have).
2. **C — open-item follow-up** (M): pairs naturally with A on the existing ambient
   schedule; a lightweight `ChannelOpenItem` model swept each fire. Complements the
   *explicit* scheduling that D shipped with *autonomous* follow-up detection.
3. **B + G together** (L): the org-wide proactive-flagging cluster — the most
   architecturally significant remaining gap (cuts against per-channel isolation),
   so design it as one phase with the private-channel rule (G) baked in from the
   start. (E already shipped the *team*-scoped read half.)
4. **H — live session** (M), **J — audit view** (S–M), **I — app UX** (M): UX/ops
   polish; valuable but not differentiating.
5. **F-config follow-up** (S) + **D steering follow-up** (S): small refinements to
   the #112 work — per-channel consolidation config, and making a fired deferred
   run steerable.
6. **K — pilot + hardening**: cross-cutting; start a pilot channel regardless.

> Open question for discussion: how aggressively do we want **B (org-wide
> proactive visibility)**? It's the biggest remaining lever toward "knows your
> company," but it directly trades against the per-channel isolation that is
> currently our strongest differentiator. #112's E read path stayed *within a
> team* precisely to avoid that tension; B crosses it. The answer shapes whether #3
> above is a near-term phase or a deliberate non-goal.
