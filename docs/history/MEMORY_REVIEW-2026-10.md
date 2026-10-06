# auto-swe — Memory System Review

> **Point-in-time snapshot (frozen).** An assessment of auto-swe's agent memory — SWE lessons and
> Slack channel memory — written on 2026-10-06 against commit `8f3fb3c`, using Meta's Muse agent
> memory as an external reference design. Every finding carries a `file:line` verified against that
> tree. This is a historical review artifact, not a live issue tracker: verify against current code
> before acting, and read [`../channel-assistant.md`](../channel-assistant.md),
> [`../agents.md`](../agents.md) and [`../architecture.md`](../architecture.md) for how memory works
> now. It is a sibling to [`agent-dreaming-research.md`](./agent-dreaming-research.md) (2026-06-03),
> which surveys offline consolidation in the research literature.

---

## 1. Executive summary

auto-swe has **one memory table, `memory_items`, holding two unrelated memories**, separated by a
`scope` column:

- **SWE lessons** (`swe-lessons`), keyed by repository. Written after a merged engineering run,
  consolidated weekly, and recalled by vector similarity into the implementer's system prompt.
- **Channel memory** (`channel-memory`), keyed by Slack channel and team. Written after each
  assistant turn and by opt-in passive ingest, consolidated on every ambient fire, and prepended to
  the channel assistant's user message.

The plumbing is sound: pgvector with an HNSW cosine index, an embedding-space guard so vectors from
different models are never compared, advisory-locked consolidation that soft-deletes its sources,
and admin edit/delete for channel memory with audit.

Measured against a claim-based design such as Muse's, the gaps are in **grounding, provenance,
safety and forgetting**, not in storage:

1. **Memory is unscanned and trusted.** Nothing that enters `memory_items` passes a content scanner,
   and lessons are appended to the implementer's *system prompt* with no untrusted-data framing.
   Passive ingest stores raw Slack messages. This is a persistent prompt-injection path.
2. **A shell step can write a secret into memory.** The shell-step lesson embeds the raw command
   text, unredacted, which is then recalled into later implementer prompts.
3. **Lessons are weakly grounded.** The lesson writer is asked for root causes but is shown only the
   ticket description and PR status — no CI logs, review verdicts, diff or traces — and lessons are
   written only after a merge, so failed runs teach nothing.
4. **Provenance is thin and consolidation erases it.** A lesson cites its run, not its evidence; a
   consolidated lesson keeps only `consolidatedFrom`.
5. **Forgetting does not cascade.** Deleting a source leaves its content alive in the consolidated
   row; deleting a consolidated row leaves its sources soft-deleted forever.
6. **Several correctness bugs** — a likely crash on `/govern/lessons`, an unaudited delete route that
   reaches channel memory, a setting whose upper range does nothing, an agent row the code never
   reads, and overstated consolidation counts.

---

## 2. Reference design: Meta Muse memory

### 2.1 Provenance of what is known

Muse is the personal agent from Meta Superintelligence Labs, built on the Muse Spark model. Meta
has published no design document for its memory. What is known comes from a **runtime export**: a
user asked Muse for its filesystem and inspected the 6.8 GB it returned
([mouse.dev](https://mouse.dev/blog/muse-runtime-export), summarised on
[daily.dev](https://daily.dev/posts/i-asked-meta-s-muse-for-its-filesystem-and-it-sent-me-6-8-gb-vdevyqj0t)).
A widely shared infographic ("How Muse memory works") is drawn from those findings. Treat every
detail below as *observed in one environment*, not as specification.

### 2.2 The observed pipeline

| Stage | Observed | Status |
|---|---|---|
| **Live memory files** | `~/MEMORY.md` — curated facts, preferences, commitments. `~/memory/YYYY-MM-DD.md` — dated daily logs. The live agent can write both during a conversation | Confirmed |
| **Hourly consolidation** | Runs when there is new signal. Checks extracted claims against chat messages; records a quote, message IDs, kind and salience; promotes durable details to the curated file and leaves the rest in the daily log; newer claims supersede older ones | Confirmed |
| **Derived memory** | `~/memory/bank/` — `world.md`, `experience.md`, `opinions.md`, `reflections.md`, each line citing a source file and line. `~/memory/people/` and `~/memory/groups/` maintained by relationship jobs | Bank confirmed; people/groups and the four-file split from the infographic only |
| **Postgres index** | `memory.entries` (chunks, `memory://` URIs, line citations, privacy class); `memory.embeddings` (384-dimensional vectors); `memory.claims` (evidence, confidence, status, `supersedes_claim_id`) | Confirmed |
| **Recall** | `memory_search` returns results with claim IDs; `memory_explain` returns the evidence and source citations behind a result | Confirmed |
| **Nightly dreams** | `~/dreams/YYYY-MM-DD.md` — prose review of recent interactions. `ALIGNMENT_SYNTHESIS.md` turns it into standing guidance (preferences, boundaries, friction, how to respond). Dream files carry `prompt_hoisted: false`: the prose is not injected; only the synthesis is read | Dreams and synthesis confirmed |
| **Alignment companions** | `ALIGNMENT_STATE.yaml`, `REPAIR_THREADS.yaml`, `PROGRESSION_HISTORY.yaml` | **Not observed** by the export's author; infographic only |
| **Forgetting** | Remove the source lines → stage claim IDs in `workspace/memory/forget/pending.json` → retract claims, banks, people pages, dreams, synthesis and staging → rebuild the index so later jobs cannot restore removed facts | Confirmed in outline |
| **Other background work** | Studying, ideas and skill review use the same stored context; run receipts at `workspace/self_improvement/objectives/<name>/CURRENT.md` | Infographic only |

Adaptation is entirely through files, records and instructions; the model's weights are unchanged.

### 2.3 Related designs

- **Hindsight** ([paper](https://arxiv.org/html/2512.12818v1), ACL 2026 demo) organises agent memory
  into four networks — world facts, agent experiences, entity observations and evolving opinions —
  with `retain` / `recall` / `reflect` operations. Muse's bank names (`world`, `experience`,
  `opinions`, `reflections`) mirror it closely, and Muse can attach Hindsight banks over MCP
  ([Hindsight blog](https://hindsight.vectorize.io/blog/2026/09/28/meta-muse-agent-memory)).
- **Offline "dream" consolidation** is now common: [Mem0 Dream](https://mem0.ai/blog/dream-background-memory-consolidation-for-ai-agents),
  [OpenClaw dreaming](https://docs.openclaw.ai/concepts/dreaming), and Cognition's git-based
  [Devin memory spec](https://www.explainx.ai/blog/cognition-devin-dreaming-memory-agent-memory-repo-open-spec-2026).
  See [`agent-dreaming-research.md`](./agent-dreaming-research.md) for the academic lineage.

### 2.4 Design principles worth taking

| # | Principle | Why it matters |
|---|---|---|
| P1 | **Every claim cites evidence** (quote + source IDs) | Memory can be audited, explained and retracted |
| P2 | **Verify against the source before promoting** | Hallucinated or misattributed "facts" do not become durable |
| P3 | **Curated tier separate from raw log** | What is injected is small and high-signal |
| P4 | **Supersession, not overwrite** | Contradictions resolve to the newer claim with history kept |
| P5 | **Reflection kept out of prompts until synthesised** | Speculative prose never steers the agent directly |
| P6 | **Forgetting retracts derivatives** and rebuilds the index | A deleted fact cannot be resurrected by a later job |
| P7 | **Recall is explainable** (`memory_explain`) | The agent and the operator can see why something was recalled |
| P8 | **Typed memory** (world / experience / opinion) | Facts are distinguishable from beliefs |

---

## 3. auto-swe memory as it stood at `8f3fb3c`

### 3.1 Data model

`MemoryItem` — `packages/shared/src/prisma/schema.prisma:146-204`, table `memory_items`.

| Group | Fields |
|---|---|
| Partition | `scope` (default `swe-lessons`; channel flow writes `channel-memory`) |
| Scope keys | `workflowId`, `repoId`, `channelId` (all `SetNull`); `teamId`, `orgId` (`Cascade`) |
| Generic entity | `entityType` / `entityId` (derived from `repoId`/`channelId` when not passed) |
| Provenance | `workflowRunId`, `agentKey`, `model`, `costUsd`, `embeddingModel`, `skillsActive[]`, `metadata` |
| Content | `rationale`, `lessonSummary`, `failureType` |
| Vector | `embedding vector(1536)` — HNSW `vector_cosine_ops`, `m = 16`, `ef_construction = 200` (`migrations/00000000000001_custom_constraints_and_indexes/migration.sql:17-19`) |
| Lifecycle | `consolidatedAt` (soft delete when merged). **No** TTL, confidence, supersession pointer, revision history, approval status, privacy class or `updatedAt` |

Related configuration:

- `EmbeddingConfig` singleton (`schema.prisma:1957-1967`), seeded `openai/text-embedding-3-large`.
- `WorkflowDefaults`: `consolidationEnabled`, `consolidationCron = "0 3 * * 0"`,
  `consolidationMinClusterSize = 3`, `consolidationSimilarityThreshold = 0.85` (2166-2169);
  `lessonRetrievalLimit = 5`, `lessonRetrievalThreshold = 0.7` (2212-2213).
- `Connection.consolidationEnabled` (321) — per-repo opt-in to the schedule.
- `SlackChannel`: `passiveIngestEnabled/Cursor`, `isPrivate`, `orgFlaggingEnabled`, and per-channel
  consolidation overrides (888-925).
- Registry (`packages/shared/src/config/registry.ts`): `channel.memoryContextItems` (5),
  `channel.memoryDedupThreshold` (0.85), `channel.passiveIngestLimit` (50),
  `memory.orgSimilarityThreshold` (0.7).

### 3.2 Write paths

| Writer | Where | When | Notes |
|---|---|---|---|
| `commitToMemory` activity | `worker/src/activities/commitToMemory.ts:69-210` | Template step; in the default engineering spec only after `humanMergeSignal`, `onError: 'continue'` (`shared/src/workflow/defaultEngineeringSpec.ts:62-85`) | LLM sees ticket description, ticket id, PR `{ciStatus, prNumber, status}`, workflow status/ids only (119-130). No dedup, approval or scan |
| Direct lesson (no LLM) | `commitToMemory.ts:219-273` (`recordLessonDirectly` / `recordLessonBackground`) | Merge-conflict resolver (`decomposition.ts:312-330`); shell step that changed files and pushed (`shellStep.ts:456-474`) | No `workflowRunId`, `agentKey` or `teamId` |
| Lesson consolidation | `worker/src/activities/consolidateLessons.ts` | Temporal Schedule (`gateway/src/plugins/temporal.ts:912-923`) → `ScheduledConsolidationWorkflow` → one child per opted-in repo; or `POST /api/v1/lessons/consolidate` | Greedy single-linkage clustering (`lib/embeddingClustering.ts`), one LLM call per cluster ≥ min size at concurrency 3, advisory lock + re-check, inserts 1-2 rows with `{clusterSize, consolidatedFrom}`, soft-deletes sources |
| Channel turn summary | `channelAssistant.ts:1092-1161` | After each assistant reply longer than 40 chars | Summarised with the `commitToMemory` role; on any failure stores the raw exchange |
| Passive ingest | `activities/passiveIngestChannelMemory.ts` | Ambient schedule, opt-in per channel | ≤ 5 extracted facts; skips near-duplicates (≥ `channel.memoryDedupThreshold`) |
| Channel consolidation | `activities/consolidateChannelMemory.ts` | Every ambient fire (`workflows/channelAmbient.ts:123`) | Same algorithm as lessons, with budget holds |
| Re-embed after edit | `workflows/reembedMemory.ts` → `lib/memoryStore.ts:251-276` | After an admin edits channel memory | — |

The shared insert is `insertMemoryItem` (`worker/src/lib/memoryStore.ts:171-232`).

### 3.3 Read paths

| Reader | Query | Injection |
|---|---|---|
| `executeImplementation` (`:194-219`) via `retrieveSimilarLessons` → `searchMemoryItemsByVector` (`memoryStore.ts:67-109`) | `repo_id = $repo AND consolidated_at IS NULL AND embedding_model ∈ {current, NULL} AND similarity ≥ threshold ORDER BY distance LIMIT n`; query text is the request description | Appended to the **system prompt** as `## Lessons from Previous Workflows` / `- [TYPE] summary` (`:294-295`). No IDs, no framing, failures swallowed |
| Channel assistant (`channelAssistant.ts:885-929`), reactive mode (`channelReactive.ts:225-240`) via `retrieveChannelMemory` (`lib/channelMemory.ts:36-91`) | Channel search (limit 5, ≥ 0.65) plus same-team cross-channel (≥ 0.75, excluding `is_private` sources) | Prepended to the user message by `formatMemoryContext`; the prompt-injection scan deliberately skips it (`:936-939`) |
| Digests, org flagging | `recentChannelMemory` (recency); `searchOrgChannelMemory` (`flagOrgSignals.ts:167-182`, crosses teams within an org) | — |

No agent has a memory tool; the MCP server exposes none; Mastra Memory is not used. The reviewer,
planner, fixers and agent runs receive no lessons. `searchMemoryItemsByEntity`
(`memoryStore.ts:121-156`) is called only by tests.

Gateway: `routes/lessons.ts` (`GET /`, `GET /search` — a text `ILIKE`, not semantic —,
`POST /consolidate`, `GET /stats`, `DELETE /:id`) and `routes/slackChannels.ts` (`GET/PATCH/DELETE`
channel memory, audited). Web: `/govern/lessons` (list, stats, delete, run consolidation; no edit)
and the channel `ChannelMemoryTab` (list, edit, delete).

### 3.4 Muse vs auto-swe

| Principle | Muse | auto-swe at `8f3fb3c` |
|---|---|---|
| P1 Evidence | Quote + message IDs per claim | Run id, model, cost. No quote, PR, trace or evidence |
| P2 Verify before promote | Hourly check against messages | None; the writer never sees the evidence |
| P3 Curated vs raw | `MEMORY.md` vs daily logs | One flat tier |
| P4 Supersession | `supersedes_claim_id` | Consolidation only (`consolidatedFrom`); contradictions coexist |
| P5 Reflection out of prompts | `prompt_hoisted: false` | No reflection layer; raw lessons go straight to the system prompt |
| P6 Cascading forget | Retract claims and derivatives, rebuild index | Hard delete of one row; derivatives survive |
| P7 Explainable recall | `memory_explain` | No tool; recalled lessons carry no id |
| P8 Typed memory | world / experience / opinion | `failureType` only |

---

## 4. Findings

Severity: **High** — exploitable or data-exposing; **Medium** — wrong behaviour an operator would
notice or rely on; **Low** — cosmetic, misleading or bounded.

### 4.1 Security

**M-1 (High) — Shell-step lessons store the raw command.**
`worker/src/activities/shellStep.ts:463` writes
`` `Shell step modified … on branch ${branch}: ${input.command.slice(0, 200)}` `` as the lesson
summary. Output is redacted a few lines earlier; the command is not. A token in the command is
embedded, stored, shown in `/govern/lessons`, and recalled into future implementer system prompts.

**M-2 (High) — Memory is never scanned and is injected as trusted text.**
No write path runs `scanSkillContent` (or any scanner) on memory content: ticket-derived lessons,
shell commands, raw Slack messages from passive ingest, assistant replies, the raw-exchange
fallback, consolidator output and admin edits all land unscanned. Lessons are appended to the
implementer's *system prompt* (`executeImplementation.ts:294-295`) with no untrusted-data framing;
`channelAssistant.ts:936-939` skips scanning prepended memory on the stated assumption that it
"originated from prior, already-scanned input", which passive ingest falsifies. A message planted
in a channel, or a ticket description, can become a standing instruction to every later run.

**M-3 (Medium) — `DELETE /api/v1/lessons/:id` is unaudited and not scope-restricted.**
`gateway/src/routes/lessons.ts:270-292` hard-deletes any `MemoryItem` by id with no `AuditLog`
entry. Channel memory can be deleted through it, bypassing the audited channel route.

**M-4 (Medium) — The admin lesson list is not restricted to lessons.**
For ADMIN, `GET /api/v1/lessons` uses `accessFilter = {}` (`lessons.ts:48-51`) and no `scope`
filter, so channel memory — private channels included — appears in the lessons view and stats.

### 4.2 Correctness

**M-5 (Medium) — `/govern/lessons` dereferences a nullable repository.**
`web/src/app/govern/lessons/page.tsx:264` renders `lesson.repository.organizationName`; the
`Lesson` type marks `repository` non-null (`web/src/hooks/useLessons.ts:24`). Channel-memory rows
(M-4) and lessons orphaned by a connection delete (`repoId` is `SetNull`) have no repository, so the
"All repositories" view throws.

**M-6 (Medium) — The seeded `lessonConsolidator` agent is never read.**
`consolidateLessons.ts:131-137` uses the hard-coded `LESSON_CONSOLIDATOR_PROMPT` and
`getModel('commitToMemory')`. The `lessonConsolidator` Agent seeded by `syncBuiltins.ts:655-660`
and documented in `docs/agents.md` as driving consolidation has no effect when edited.

**M-7 (Low) — `channel.memoryContextItems` above 5 does nothing.**
`retrieveChannelMemory` is called without a `limit` (`channelAssistant.ts:887`) and defaults to 5;
the setting (max 50) only truncates afterwards.

**M-8 (Low) — Consolidation counts are overstated.**
Both consolidators discard the transaction's `{ consolidated: 0 }` early return
(`consolidateLessons.ts:203-246`, `consolidateChannelMemory.ts:275-319`) and report
`cluster.length`, so a concurrently-skipped cluster is counted as consolidated.

**M-9 (Low) — `skillsActive` records the memory agent's skills.**
`commitToMemory.ts:185` stores `skills.map(s => s.name)` — the `commitToMemory` agent's own skills —
while `docs/agents.md` describes the field as the skills active during the run.

**M-10 (Low) — Raw exchange stored after a refused summary.**
When the summarizer fails for any reason — including a USD-cap refusal — the raw user text and
reply are stored (`channelAssistant.ts:1139-1159`), and the embedding is not covered by the
channel's budget hold.

**M-11 (Low) — Uneven consolidation bounds.**
The channel consolidator runs clusters through an unbounded `Promise.all`
(`consolidateChannelMemory.ts:222`); the lesson consolidator checks only
`assertRolePricedForUsdCap` (`consolidateLessons.ts:161`), not the budget.

**M-12 (Medium, unverified) — Filtered HNSW search can under-return.**
Every vector query combines the ANN `ORDER BY` with a selective `WHERE` on `repo_id`, `channel_id`
or `team_id` and a similarity threshold. Nothing sets `hnsw.ef_search` or `hnsw.iterative_scan`, so
under pgvector's default `ef_search = 40` a small repository in a large table may get few or no
results. Inferred from pgvector's documented filtering behaviour; not reproduced.

### 4.3 Design gaps (against §2.4)

| ID | Gap | Principle |
|---|---|---|
| G-1 | The lesson writer is shown no evidence (no CI failure, review verdict, diff summary or trace) | P1, P2 |
| G-2 | LLM lessons are written only after a human merge; failed, rejected and timed-out runs produce none | P2 |
| G-3 | Direct writes lack run/agent/team; consolidated rows drop `scope`, entity, run, agent, model, cost, skills and team | P1 |
| G-4 | No supersession, confidence, TTL or decay; contradictory lessons coexist indefinitely | P4 |
| G-5 | Deletion does not cascade through `consolidatedFrom`; deleting a consolidated row strands its sources | P6 |
| G-6 | No recall/explain tool; only the implementer receives lessons; recalled lessons carry no id | P7 |
| G-7 | An embedding-model switch silently drops all prior memory from recall; no re-embed-all tooling | — |
| G-8 | Connection delete orphans lessons (`repo_id` NULL, `entity_id` still set); team/org delete does not cascade to lessons because they carry neither | P6 |
| G-9 | No user-level erasure (e.g. by `metadata.userSlackId`) | P6 |
| G-10 | No typed memory beyond `failureType` | P8 |

### 4.4 Documentation drift

| Doc | Claim | Code |
|---|---|---|
| `product-overview.md` | Every run writes a semantic `MemoryItem`; the context validator searches it; browsable at `/lessons` | Only merged runs plus two direct hooks write; retrieval is in `executeImplementation`; `/lessons` is admin-only via redirect |
| `agents.md` | `lessonConsolidator` drives `consolidateLessons` | Unused (M-6) |
| `agents.md` | `skillsActive` = skills active during the run | Memory agent's skills (M-9) |
| `architecture.md` | `memory_items` supports generic entity scoping | Nothing reads it; consolidated rows lack it |
| `channel-assistant.md` | No read crosses an org | True, but org flagging crosses teams within an org and is not called out |

No `## Limitations` section mentions M-2, G-4, G-5 or M-12.

### 4.5 Test coverage

Unit tests with mocked Prisma and embeddings exist for `memoryStore`, `lessonRetrieval`,
`embeddings`, `embeddingClustering`, `channelMemory`, both consolidators, passive ingest and the
lessons routes. Missing: a `commitToMemory` activity test; the re-embed workflow;
`ScheduledConsolidationWorkflow`; any `*.pg.test.ts` exercising the pgvector SQL or HNSW
behaviour; the concurrent-skip path's counts; and a web test for a lesson with no repository.

---

## 5. Remediation plan

Ordered by risk, then by size. The first two tiers are small, local fixes; the third is design work
that warrants its own review.

**Tier 1 — security (small).**
1. M-1: redact the shell-step command before it is stored (reuse the step's existing redaction).
2. M-2: scan memory text at every write path with the existing advisory scanner and record the
   result; wrap recalled lessons and channel memory in an explicit untrusted-data block, and stop
   exempting prepended channel memory from the injection scan.
3. M-3 / M-4: restrict the lessons routes to `scope = 'swe-lessons'` and audit the delete.

**Tier 2 — correctness (small).**
4. M-5: render lessons without a repository.
5. M-6: drive consolidation through `resolveAgentSpec('lessonConsolidator')`.
6. M-7: pass the configured limit into `retrieveChannelMemory`.
7. M-8: return the transaction's real outcome.
8. M-9: correct the documentation of `skillsActive` (or record the run's skills).
9. M-11: bound channel-consolidation concurrency.

**Tier 3 — design (follow-ups, each its own change).**
10. G-1 / G-2: give the lesson writer evidence (CI failure summary, review verdicts, diff stat) and
    write lessons from failed runs.
11. G-3 / P1: carry provenance through consolidation; cite PR and trace ids.
12. G-4: `supersededById` plus a confidence score; contradiction check at consolidation.
13. G-5 / G-8 / G-9: cascading retraction through `consolidatedFrom`, connection-delete cleanup,
    per-user erasure.
14. G-6: read-only `searchLessons` / `explainLesson` tools; consider lessons for reviewer and fixers.
15. M-12: set `hnsw.iterative_scan = relaxed_order` (pgvector ≥ 0.8) or raise `ef_search` per
    query, with a `*.pg.test.ts` proving recall on a small scope in a large table.
16. G-7: a re-embed-all workflow for embedding-model changes.

---

## 6. Sources

- mouse.dev — Muse runtime export: <https://mouse.dev/blog/muse-runtime-export>
- daily.dev — "I asked Meta's Muse for its filesystem and it sent me 6.8 GB":
  <https://daily.dev/posts/i-asked-meta-s-muse-for-its-filesystem-and-it-sent-me-6-8-gb-vdevyqj0t>
- Latimer et al., *Hindsight is 20/20: Building Agent Memory that Retains, Recalls, and Reflects*:
  <https://arxiv.org/html/2512.12818v1>
- Hindsight × Muse: <https://hindsight.vectorize.io/blog/2026/09/28/meta-muse-agent-memory>
- Mem0 Dream: <https://mem0.ai/blog/dream-background-memory-consolidation-for-ai-agents>
- OpenClaw dreaming: <https://docs.openclaw.ai/concepts/dreaming>
- Devin dreaming memory spec:
  <https://www.explainx.ai/blog/cognition-devin-dreaming-memory-agent-memory-repo-open-spec-2026>
- Meta Muse overview: <https://vajiramandravi.com/current-affairs/meta-muse-ai-agent/>
