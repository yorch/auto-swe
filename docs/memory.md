# Agent memory

auto-swe keeps two long-lived memories in one pgvector-backed table, `memory_items`, separated by
its `scope` column:

| Memory | `scope` | Keyed by | Read by |
|---|---|---|---|
| **Lessons** | `swe-lessons` | repository (`repo_id`) | `executeImplementation`, into the implementer's system prompt |
| **Channel memory** | `channel-memory` | Slack channel (`channel_id`), with `team_id` / `org_id` | the channel assistant's turns, reactive pass, digests and org flagging |

This doc covers what both share and how lessons work end to end. Channel memory's own behaviour —
passive ingestion, cross-channel reads, privacy — is in
[channel-assistant.md §6](./channel-assistant.md#6-memory).

---

## 1. Storage

A `MemoryItem` row holds a `lessonSummary` (what is recalled), a `rationale`, an optional
`failureType`, a 1536-dimensional `embedding` of the summary with the `embeddingModel` that produced
it, and provenance: `workflowId`, `workflowRunId`, `agentKey`, `model`, `costUsd`, `skillsActive`
and a free-form `metadata` object. `consolidatedAt` marks a row that consolidation has merged into
a newer one; such rows are kept but never recalled.

The embedding column carries an HNSW cosine index (`idx_memory_items_embedding`). It is created by
hand-written DDL that Prisma cannot express — see the `prisma-pgvector-hnsw` skill before touching
`schema.prisma`. Embeddings come from the `EmbeddingConfig` singleton
([model-configuration.md](./model-configuration.md)); a row is only ever compared with rows embedded
by the same model, so vectors from different models are never compared.

## 2. Writing lessons

| Writer | When | Model call |
|---|---|---|
| `commitToMemory` step | In the default engineering template: after the pull request is merged (`MERGED`), and when the review loop or the CI loop runs out of attempts (`REVIEW_FAILED`, `CI_FAILED`) before the run fails | Yes — the `commitToMemory` agent writes the lesson from the run's evidence |
| Merge-conflict resolver | After it resolves a conflict | No (`recordLessonBackground`) |
| Shell step | After a step that changed files and pushed them | No; the command is stored with credentials masked |

The step hands the agent the run's evidence, read from the workflow's own context and bounded
there (`lib/lessonEvidence.ts`): the outcome, the review network's last rejection, the tail of the
last failing CI run's logs, and the changed files with their line counts, the implementer's notes
and the test totals — never the diff itself. The user message, built in code rather than in the
agent's stored prompt, tells the agent to name a root cause only when the evidence shows one and
fences the evidence as data. The outcome is written into the lesson's `metadata.outcome` by code,
not by the model. Another template's `commitToMemory` step records `COMPLETED`.

Every write goes through `insertMemoryItem` (`packages/worker/src/lib/memoryStore.ts`), which
applies the memory gate (§5) before it embeds anything.

## 3. Recalling lessons

`executeImplementation` embeds the work request's description and searches the repository's
lessons (`retrieveSimilarLessons`): unconsolidated rows, embedded by the current model, at or above
`lessonRetrievalThreshold` similarity, at most `lessonRetrievalLimit` of them (both on
`/govern/workflow-defaults`, default 0.7 and 5). Matches are added to the implementer's system
prompt inside a `<recalled_memory>` fence that marks them as reference data. A retrieval failure is
logged and the run continues without lessons.

Every scoped search — lessons by repository, channel memory by channel, team or organization — runs
with pgvector's iterative index scan (`SET LOCAL hnsw.iterative_scan = strict_order`, in
`scopedVectorQuery`). Without it, a plan that reads the HNSW index sees only the table-wide nearest
`hnsw.ef_search` candidates and filters them by scope afterwards, so a small repository beside a
crowded one would get nothing back. The setting needs pgvector 0.8 or later.

## 4. Consolidation

A Temporal Schedule (`consolidationCron`, default weekly) starts one `ConsolidateLessonsWorkflow`
per repository with `Connection.consolidationEnabled`. Admins can also run it from
`/govern/lessons`. It clusters the repository's active lessons by embedding similarity
(`consolidationSimilarityThreshold`, default 0.85), and for each cluster of at least
`consolidationMinClusterSize` (default 3) asks the `lessonConsolidator` agent for one or two
generalised lessons. In one transaction, under a per-repository advisory lock, it inserts those and
marks the sources consolidated; `metadata.consolidatedFrom` lists the source ids. Channel memory is
consolidated the same way on each ambient fire.

## 5. The memory gate

Memory is replayed into every later run that recalls it, so it is held to a blocking rule
(`packages/worker/src/lib/memoryGuard.ts`): a write whose text matches an `INJECTION` scanner
pattern is refused, a recalled item that matches is dropped, and a scan that fails refuses. See
[agents.md §6.4](./agents.md#64-custom-skill-security-scanning).

## 6. Administration

`/govern/lessons` lists, searches and deletes lessons and starts consolidation; deletes are audited
with the deleted content.

After the embedding model changes, the Embeddings tab at `/studio/models` shows how many memory rows
the configured model did not embed (`GET /api/v1/platform/embedding-config/reembed`) and starts
`ReembedStaleMemoryWorkflow` (`POST` to the same path, ADMIN, audited). The workflow walks those
rows in id order, 100 per activity and four embedding calls at a time, and continues as new every
50 batches. It runs under one fixed workflow id, so a second start while one runs is refused with
`409 REEMBED_IN_PROGRESS`. Channel memory is edited and deleted per channel
([channel-assistant.md §6](./channel-assistant.md#6-memory)).

---

## Limitations

- **Only the default engineering template writes failure lessons.** Other templates reach
  `commitToMemory`, if at all, on their success path; a run that times out waiting for a merge
  writes no lesson, and neither does one that fails outside the review and CI loops (a security
  gate, an implementation error).
- **The evidence is the last attempt's.** A loop keeps only its latest rejection and CI log, so a
  lesson about a run that failed three different ways sees the third.
- **A lesson cites its run, not its evidence.** There is no quote, pull-request or trace reference,
  and the model-free writers record no run or agent at all. A consolidated row keeps only
  `metadata.consolidatedFrom`; its scope columns, run, agent, model and team are not carried over.
- **Nothing supersedes a lesson.** There is no confidence score and no notion of one lesson
  replacing another, so contradictory lessons coexist until an admin deletes one. Lessons never
  expire.
- **Deleting does not cascade through consolidation.** Deleting a source leaves its content alive in
  the consolidated row built from it; deleting a consolidated row leaves its sources marked
  consolidated, so neither is recalled again.
- **Deleting a repository orphans its lessons.** `repo_id` is set null; the rows stay in
  `/govern/lessons` as "Deleted repository" until deleted by hand. There is no way to erase one Slack
  user's channel memory.
- **Changing the embedding model hides existing memory until an admin re-embeds it.** The re-embed
  is not started on save, because it is one billed call per row. A row whose re-embed fails stays
  hidden and is counted in the workflow's result; the next run retries it.
- **Scoped search depends on pgvector 0.8.** On an older pgvector the iterative scan is
  unavailable: the worker logs a warning once and searches without it, and a small repository or
  channel in a large table can get fewer matches than exist, or none. Even with it, the scan stops
  after `hnsw.max_scan_tuples` (pgvector's default, 20,000) index tuples, so a scope whose nearest
  memories lie beyond that many closer rows from other scopes is still cut short.
- **Only the implementer recalls lessons**, and only automatically: no agent can search memory or
  ask why a lesson was recalled, and the reviewer and the fixers get none.
- **A failed channel summary stores the raw exchange.** When the summariser fails for a reason
  other than the memory gate or a refusal to spend (a malformed answer, a provider error), the
  turn's text and reply are stored undistilled, and that embedding is not covered by the channel's
  budget hold.
