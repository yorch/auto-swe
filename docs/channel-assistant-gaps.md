# Channel assistant — gaps vs. Anthropic's Claude Tag

> A detailed, honest comparison of our **channel assistant** (see
> [`channel-assistant.md`](./channel-assistant.md)) against the **Claude Tag**
> product it was modeled on (see [`claude-tag-research.md`](./claude-tag-research.md)).
> Records what's at parity, what diverges by design, and what is genuinely
> missing — with severity, so we can prioritize. Gaps **#1** and **#2** below are
> now **addressed** (see [`channel-assistant-autonomy-design.md`](./channel-assistant-autonomy-design.md)
> and the "Autonomous task execution" section of `channel-assistant.md`); the rest
> are tracked for later.

Legend: **Parity** (comparable), **Divergence** (different approach, not strictly
worse), **Gap** (we're weaker/missing). Severity is our own product judgment.

---

## Gap #1 — Autonomous multi-stage task execution  ·  Severity: **High** (the core gap)  ·  **ADDRESSED**

**Claude Tag:** "Given a task, Claude breaks it into stages, works through them
independently, and delivers the result back in Slack. It can also plan tasks to
complete in the future." You delegate a real piece of work; it executes it.

**Status — addressed:** the channel assistant now carries a `delegateTask` tool.
When a mention is judged to be real work, the turn launches a durable,
thread-bound `RunnableWorkflow` run (one per thread) instead of just replying.
Two routes: a **general** "Channel Task" template (repo-less agent run) and a
**code** route that resolves the channel's `git_repo` Connection and runs the
team's full SWE workflow (implement → review → PR) in a Docker workspace. The
run's terminal result is threaded back into the originating Slack conversation,
and its cost accrues to the channel budget. See
[`channel-assistant-autonomy-design.md`](./channel-assistant-autonomy-design.md).

**Originally:** A channel `@mention` ran a single `runAgent` generate (with the
channel agent's bound tools/MCP) and posted a reply. It was a **conversational
turn**, not a task executor — it did not decompose a delegated task into stages,
run a durable multi-step job, operate in a workspace, or deliver a worked result.

**Why this is the keystone gap:** the platform *already has* a generic durable
workflow engine (`RunnableWorkflow` interpreting a `WorkflowSpec` DAG — `agent`,
`step`, `mcp`, `fanOut`, `cond`, `eval`, `signal`, HITL `humanApproval/Decision/
Input/Review`, `terminate` nodes), with planning/decomposition, quality gates,
cost tracking, and Slack-native HITL. The channel turn simply **doesn't route
into it**. Closing the gap is primarily a *connection* problem, not new
execution machinery. See the design discussion below + the implementation plan.

**Sub-gaps:**
- ✅ **Workspace-backed execution** (code tasks) from a channel — the code route
  runs the team's SWE template in the Docker workspace the implementer uses.
- Task **decomposition** from a mention is now *reachable* (the code route runs a
  full SWE template, which can include `planDecomposition` + `fanOut` nodes), but
  the general route is a single agent node — richer decomposition specs are a
  follow-up, not wired by default.
- **Future task planning / scheduling** from a mention is still open (deferred).

---

## Gap #2 — True multiplayer mid-task hand-off  ·  Severity: **High**  ·  **ADDRESSED**

**Claude Tag:** "One shared Claude per channel … pick up the conversation where
the last person left off." A half-finished *task* hands off between teammates;
everyone can see what it's working on.

**Status — addressed:** because a channel task is now a durable, thread-bound
workflow run (Gap #1), it is shared, resumable state by construction. **Any**
teammate can reply in the task's thread to steer the in-flight run: the gateway
maps the reply to the run's deterministic workflow id and sends a `steer` Temporal
signal, which the run drains into the next agent node's prompt (soft mid-flight
steering). The run is also visible to the whole channel via `/runs` (a channel run
record) — so person B picks up exactly where person A left off, on a *running*
task, not a reconstruction.

**Originally:** "Multiplayer" only in the weak sense — one shared *agent* +
shared channel memory. Work was **per-mention turns**: there was no live, shared,
in-flight task state that person B could resume mid-execution. Continuity was
reconstructed from memory + thread history, not a running task.

**The connection to #1:** a durable workflow *is* shared, resumable task state.
Once a mention launches a workflow (Gap #1), the run becomes the thing the whole
channel can observe (`/runs` + channel run records) and that **anyone** can
advance — e.g. by answering its HITL prompt in-thread, or (deeper) by steering it
with a follow-up reply. So #1 and #2 share most of a solution.

**Sub-gaps:**
- ✅ A *second* person can inject guidance into an *in-flight* task via a thread
  reply (`steer` signal → next agent node).
- Channel-visible "what it's working on right now" presence is still light — the
  run is observable in `/runs`, but per-stage progress posts back into the thread
  are minimal (a follow-up polish item, not load-bearing).

---

## Gap #3 — Ambient mode: reactive + organization-wide  ·  Severity: **Medium**

**Claude Tag:** "Proactively **jumps into chat**, flags things **from across the
organization**, and follows up on **forgotten threads or tasks**."

**Ours today:** A per-channel Temporal Schedule posts a `SKIP`-aware digest built
from that channel's recent memory.

**Gaps:**
- **Scheduled-only, not reactive** — we don't watch ongoing messages and decide
  to interject; we only act on `@mention` or cron.
- **Per-channel only** — no cross-channel / org-wide awareness or flagging.
- **No real follow-up tracking** — we summarize memory, but don't track open
  action items / threads / tasks and chase them specifically.

---

## Gap #4 — Workspace-level memory + hygiene  ·  Severity: **Medium**

**Claude Tag:** Memory is kept **per channel *and* per workspace** (cross-channel
org knowledge); admins view/edit/delete.

**Ours today:** Per-channel memory with retrieve/inject/summarize + admin
view/edit/delete. The `teamId`/`orgId` columns exist on `MemoryItem` but
**retrieval is channel-scoped only** — workspace/team-level memory is
schema-ready but not wired into the turn.

**Gaps:**
- No **cross-channel / workspace-level** memory retrieval.
- **No consolidation** of channel memory (the existing consolidation is
  repo-scoped) → risk of the "memory bloat" failure mode Claude Tag itself flags.

---

## Gap #5 — Maturity & scale  ·  Severity: **Medium** (non-technical)

**Claude Tag** is battle-tested internally (Anthropic reports ~65% of the product
team's code created via their internal version). **Ours** is newly built,
untested at scale, and CI hasn't validated it end-to-end yet.

---

## Divergences (different by design, not strictly worse)

| Area | Claude Tag | Ours |
| --- | --- | --- |
| **Budget** | Token-based plan consumption, caps per channel/org | USD `monthlyBudgetUsdCents` per-channel + per-org `OrgMonthlyUsage`; **soft** cap (Serializable-read gate — a true pre-flight hard cap isn't achievable for post-hoc LLM cost) |
| **Private channels** | "Does not report from private channels" (explicit rule) | No explicit rule; **channel-scoping** prevents cross-channel leakage instead (private-channel memory stays in that channel's scope) |
| **Distribution** | Hosted; replaces the Claude Slack app (30-day migration); fixed on Opus 4.8 | Self-hosted feature; model is DB-configurable (defaults to `anthropic/claude-opus-4-8`) |

---

## Where ours matches or exceeds

- **Per-channel scoping / tenant isolation** ("HR's assistant won't leak to
  engineering") — strong parity via the `CHANNEL` config-scope tier (per-channel
  agent / tools / MCP / credentials) + channel→team isolation.
- **DM for sensitive data** — parity (`message.im` handled).
- **Admin control + observability** — likely *more* than the hosted product
  exposes: `/admin/slack-channels` CRUD, memory view/**edit**/delete, per-channel
  usage, `/runs` per-turn traces/cost, and a `CHANNEL_SUSPICIOUS` security feed.
- **Extensibility** — self-hosted, MCP-extensible, multi-provider/DB-configurable
  models, governed by platform RBAC.

---

## Summary

| # | Capability | Status | Severity |
| --- | --- | --- | --- |
| 1 | Autonomous multi-stage task execution | **Addressed** | High |
| 2 | Multiplayer mid-task hand-off | **Addressed** | High |
| 3 | Ambient: reactive + org-wide + task follow-up | **Gap** | Medium |
| 4 | Workspace-level memory + consolidation | **Gap** | Medium |
| 5 | Maturity / scale | **Gap** | Medium |
| — | Per-channel scoping & isolation | Parity | — |
| — | Budgets (per-channel + per-org) | Parity / soft-cap divergence | — |
| — | Admin UI & observability | Parity / ahead | — |
| — | Extensibility (self-host, MCP, multi-model) | Ahead | — |

**Addressed:** #1 (route channel tasks into the workflow engine — general + code
routes) and #2 (the running workflow as shared, resumable task state, steerable
from thread replies). See [`channel-assistant-autonomy-design.md`](./channel-assistant-autonomy-design.md)
for the shipped architecture. Remaining open: #3, #4, #5 — now broken into 11
concrete, independently-shippable capabilities (with severity, effort, and a
suggested priority order) in
[`channel-assistant-remaining-gaps.md`](./channel-assistant-remaining-gaps.md).
