# Channel assistant — gaps vs. Anthropic's Claude Tag

> A detailed, honest comparison of our **channel assistant** (see
> [`channel-assistant.md`](./channel-assistant.md)) against the **Claude Tag**
> product it was modeled on (see [`claude-tag-research.md`](./claude-tag-research.md)).
> Records what's at parity, what diverges by design, and what is genuinely
> missing — with severity, so we can prioritize. Gaps **#1** and **#2** below are
> being addressed; the rest are tracked for later.

Legend: **Parity** (comparable), **Divergence** (different approach, not strictly
worse), **Gap** (we're weaker/missing). Severity is our own product judgment.

---

## Gap #1 — Autonomous multi-stage task execution  ·  Severity: **High** (the core gap)

**Claude Tag:** "Given a task, Claude breaks it into stages, works through them
independently, and delivers the result back in Slack. It can also plan tasks to
complete in the future." You delegate a real piece of work; it executes it.

**Ours today:** A channel `@mention` runs a single `runAgent` generate (with the
channel agent's bound tools/MCP) and posts a reply. It is a **conversational
turn**, not a task executor — it does not decompose a delegated task into stages,
run a durable multi-step job, operate in a workspace, or deliver a worked result.

**Why this is the keystone gap:** the platform *already has* a generic durable
workflow engine (`RunnableWorkflow` interpreting a `WorkflowSpec` DAG — `agent`,
`step`, `mcp`, `fanOut`, `cond`, `eval`, `signal`, HITL `humanApproval/Decision/
Input/Review`, `terminate` nodes), with planning/decomposition, quality gates,
cost tracking, and Slack-native HITL. The channel turn simply **doesn't route
into it**. Closing the gap is primarily a *connection* problem, not new
execution machinery. See the design discussion below + the implementation plan.

**Sub-gaps:**
- No task **decomposition** from a mention (the `planDecomposition` + `fanOut`
  path exists but isn't reachable from a channel).
- No **future task planning / scheduling** from a mention.
- No **workspace-backed execution** (code tasks) from a channel — channel turns
  run without the Docker workspace the SWE implementer uses.

---

## Gap #2 — True multiplayer mid-task hand-off  ·  Severity: **High**

**Claude Tag:** "One shared Claude per channel … pick up the conversation where
the last person left off." A half-finished *task* hands off between teammates;
everyone can see what it's working on.

**Ours today:** "Multiplayer" only in the weak sense — one shared *agent* +
shared channel memory. But work is **per-mention turns**: there is no live,
shared, in-flight task state that person B can resume mid-execution. Continuity
is reconstructed from memory + thread history, not a running task.

**The connection to #1:** a durable workflow *is* shared, resumable task state.
Once a mention launches a workflow (Gap #1), the run becomes the thing the whole
channel can observe (`/runs` + channel run records) and that **anyone** can
advance — e.g. by answering its HITL prompt in-thread, or (deeper) by steering it
with a follow-up reply. So #1 and #2 share most of a solution.

**Sub-gaps:**
- No "what it's working on right now" channel-visible presence beyond the
  in-thread placeholder/reply.
- No mechanism for a *second* person to inject guidance into an *in-flight* task.

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
| 1 | Autonomous multi-stage task execution | **Gap** | High |
| 2 | Multiplayer mid-task hand-off | **Gap** | High |
| 3 | Ambient: reactive + org-wide + task follow-up | **Gap** | Medium |
| 4 | Workspace-level memory + consolidation | **Gap** | Medium |
| 5 | Maturity / scale | **Gap** | Medium |
| — | Per-channel scoping & isolation | Parity | — |
| — | Budgets (per-channel + per-org) | Parity / soft-cap divergence | — |
| — | Admin UI & observability | Parity / ahead | — |
| — | Extensibility (self-host, MCP, multi-model) | Ahead | — |

**Being addressed now:** #1 (route channel tasks into the workflow engine) and
#2 (the running workflow as shared, resumable task state). See the design
discussion in the PR / the implementation plan that follows.
