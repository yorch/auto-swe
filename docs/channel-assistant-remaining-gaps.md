# Channel assistant — remaining capability gaps vs. Claude Tag

> A granular inventory of **what Anthropic's Claude Tag does that our channel
> assistant does not yet support**, written after PR #110 closed the two
> highest-severity gaps (autonomous multi-stage execution + multiplayer mid-task
> hand-off). Source material: [`claude-tag-research.md`](./claude-tag-research.md).
> Builds on the prior [`channel-assistant-gaps.md`](./channel-assistant-gaps.md)
> (which framed the #1/#2 closure) by breaking the *remaining* gaps into concrete,
> independently-shippable capabilities — with severity, rough effort, and how each
> would fit our existing architecture.
>
> Legend — **Have**: at parity. **Partial**: a weaker form exists. **Missing**: not
> built. Effort is a rough order of magnitude (S ≈ days, M ≈ 1–2 weeks, L ≈ a phase).

---

## 1. Capability scorecard

| # | Claude Tag capability | Us | Status |
| --- | --- | --- | --- |
| A | Reactive ambient (watch messages, decide to interject) | scheduled digest only | **Partial** |
| B | Organization-wide awareness ("flag things from across the org") | strictly per-channel | **Missing** |
| C | Follow-up on forgotten threads / open tasks | memory digest, no item tracking | **Missing** |
| D | Future / scheduled task planning ("plan tasks to complete later") | tasks launch immediately | **Missing** |
| E | Workspace-level (cross-channel) memory | per-channel only (columns exist) | **Partial** |
| F | Memory consolidation / hygiene for channel memory | repo memory only | **Missing** |
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

The rest of this doc details the **Partial/Missing** rows, grouped by theme.

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
question in one channel to activity in another.

**Us:** every retrieval, memory write, and budget is **channel-scoped by design**
(that scoping is also our tenant-isolation guarantee). There is no cross-channel
read path. Closing this is in tension with isolation, so it needs an explicit,
admin-granted "org-visibility" capability rather than a default — likely a new
config scope or a memory-visibility flag, plus careful private-channel handling
(see G).

### C. Follow-up on forgotten threads / tasks — **Missing · Severity Medium · Effort M**
**Claude Tag:** "follows up on forgotten threads or tasks."

**Us:** the ambient digest *summarizes* recent memory, but we don't **track open
action items** as first-class objects with a due/stale notion, so we can't chase a
specific unanswered question or stalled task.

**Fit:** a lightweight `ChannelOpenItem` model (source message, owner, status,
lastNudgedAt) populated by the turn/ambient agent and swept by the existing
schedule. Reuses the Temporal Schedule we already run for digests.

---

## 3. Tasks & planning (row D)

### D. Future / scheduled task planning — **Missing · Severity Medium · Effort S–M**
**Claude Tag:** "can also plan tasks to complete in the future."

**Us:** `delegateTask` launches a durable run **immediately**. There is no "do this
Monday" or "remind me to…" deferral.

**Fit:** the lowest-effort remaining gap — we already create Temporal **Schedules**
for ambient/consolidation. A `delegateTask` variant that takes a `runAt` and
creates a one-shot Schedule (or a Timer) firing the same `RunnableWorkflow` covers
it. The thread-binding + reporting machinery is unchanged.

---

## 4. Memory depth & hygiene (rows E, F)

### E. Workspace-level (cross-channel) memory — **Partial · Severity Medium · Effort M**
**Claude Tag:** memory is kept **per channel *and* per workspace** — org knowledge
that isn't trapped in one channel.

**Us:** `MemoryItem` already carries `teamId`/`orgId` columns, but **retrieval is
channel-scoped only** — the workspace tier is schema-ready, not wired into the
turn. A turn could retrieve `(channel ∪ team)` memory with channel results
weighted higher. Overlaps with B (org-wide awareness) on the read path.

### F. Channel-memory consolidation — **Missing · Severity Medium · Effort M**
**Claude Tag** explicitly flags memory going **stale/noisy/wrong** as the key risk.

**Us:** we have a consolidation workflow, but it is **repo-scoped** (SWE lessons),
not channel-scoped. Channel memory grows monotonically with no dedup/summarize/
expire pass — the exact failure mode Claude Tag warns about.

**Fit:** generalize the existing `consolidateLessons` to a channel-memory variant
on the same schedule (cluster near-duplicates, summarize, age-out low-salience
items).

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

Ranked by value ÷ effort, for discussion (not a commitment):

1. **D — future/scheduled tasks** (S–M): cheapest win, reuses Schedules.
2. **A — reactive interjection** (M): the highest *product* value; turns "summon"
   into "teammate." Must ship behind a hard per-channel opt-in + rate limit.
3. **F — channel-memory consolidation** (M): protects the feature from the
   stale-memory failure mode as usage grows; generalizes existing code.
4. **C — open-item follow-up** (M): pairs naturally with A on the same schedule.
5. **E + B + G together** (L): the cross-channel/org-visibility cluster — most
   architecturally significant (cuts against isolation), so design it as one phase
   with the private-channel rule (G) baked in from the start.
6. **H — live session** (M), **J — audit view** (S–M), **I — app UX** (M): UX/ops
   polish; valuable but not differentiating.
7. **K — pilot + hardening**: cross-cutting; start a pilot channel regardless.

> Open question for discussion: how aggressively do we want **B/E (cross-channel
> visibility)**? It's the biggest lever toward "knows your company," but it
> directly trades against the per-channel isolation that is currently our strongest
> differentiator. The answer shapes whether #5 above is a near-term phase or a
> deliberate non-goal.
