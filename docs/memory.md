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
`failureType`, a `confidence`, a 1536-dimensional `embedding` of the summary with the `embeddingModel` that produced
it, and provenance: `workflowId`, `workflowRunId`, `agentKey`, `model`, `costUsd`, `skillsActive`
and a free-form `metadata` object. `consolidatedAt` marks a row that consolidation has merged into
a newer one, and `supersededAt` / `supersededById` one a later item replaced (§2); both kinds are
kept but never recalled or consolidated again.

The embedding column carries an HNSW cosine index (`idx_memory_items_embedding`). It is created by
hand-written DDL that Prisma cannot express — see the `prisma-pgvector-hnsw` skill before touching
`schema.prisma`. Embeddings come from the `EmbeddingConfig` singleton
([model-configuration.md](./model-configuration.md)); a row is only ever compared with rows embedded
by the same model, so vectors from different models are never compared.

## 2. Writing lessons

| Writer | When | Model call |
|---|---|---|
| `commitToMemory` step | When a review loop or a CI loop runs out of attempts (`REVIEW_FAILED`, `CI_FAILED`), before the run fails, in the engineering templates that have one: `default-engineering`, `agent-reviewed-pr`, `code-and-ci`, `consensus-review`, `dependency-update` and `four-eyes`. In `default-engineering` also after the pull request is merged (`MERGED`) | Yes — the `commitToMemory` agent writes the lesson from the run's evidence |
| Merge-conflict resolver | After it resolves a conflict | No (`recordLessonBackground`) |
| Shell step | After a step that changed files and pushed them | No; the command is stored with credentials masked |

The step hands the agent the run's evidence, read from the workflow's own context and bounded
there (`lib/lessonEvidence.ts`): the outcome, the review network's last rejection (in
`consensus-review`, the last round's rejecting reviewers, joined), the tail of the last CI logs the
fix loop fetched, and the changed files with their line counts, the implementer's notes and the
test totals — never the diff itself. The user message, built in code rather than in the
agent's stored prompt, tells the agent to name a root cause only when the evidence shows one and
fences the evidence as data. The outcome is written into the lesson's `metadata.outcome` by code,
not by the model. Another template's `commitToMemory` step records `COMPLETED`.

Each lesson records where it came from. The row's `workflowRunId` names the run (whose traces hold
the rest), `agentKey` and `model` the writer, and `metadata.evidence` cites the pull requests and
head commit it was written about plus a 300-character quote of the evidence that drove it — the
start of the rejection, or the end of the failing CI log. The model-free writers record their run
and an `agentKey` of `mergeConflictResolver` or `shellStep`.

The agent also grades its confidence by how directly the evidence supports the lesson — `high`
when a rejection or CI failure states the problem, `medium` when it points to it, `low` when the
lesson rests on the ticket or the outcome alone — stored as 0.9, 0.6 or 0.3. A consolidated lesson
takes the average of its graded sources; the model-free writers leave it null. A lesson below 0.5 is
still recalled, labelled `low confidence` in the implementer's prompt.

**Newer replaces older.** After a write, every active item in the same repository (or channel) and
scope, embedded by the same model, at or above `memory.supersedeThreshold` similarity (default 0.92;
1 turns it off) is marked superseded by the new one. A lesson written from fresher evidence about
the same thing therefore replaces the old one in recall instead of sitting beside it; the old row
stays, with `supersededById` naming its replacement.

Every write goes through `insertMemoryItem` (`packages/worker/src/lib/memoryStore.ts`), which
applies the memory gate (§5) before it embeds anything.

## 3. Recalling lessons

Every agent that works on a repository recalls that repository's lessons into its system prompt,
each by the text that says what it is working on (`recallLessonsBlock`, `lib/lessonRecall.ts`):

| Agent | Recalled by |
|---|---|
| Implementer (`executeImplementation`) | The work request's description |
| CI fixer | The end of the failing CI log |
| Review fixer | The reviewers' rejection |
| Gate fixer | The gate's name and the end of its output |
| Review network (all three personas) | The implementer's notes and the changed files' paths |

Each takes unsuperseded, unconsolidated rows embedded by the current model, at or above
`lessonRetrievalThreshold` similarity, at most `lessonRetrievalLimit` of them (both on
`/govern/workflow-defaults`, default 0.7 and 5). Matches are added inside a `<recalled_memory>` fence
that marks them as reference data, each with its id, its failure type and a `low confidence` label
where it applies. Recall failing is logged and the agent runs without lessons.

The implementer and the fixers also get two read-only tools, `searchLessons` and `explainLesson`,
bound to the session's repository: one asks for lessons by the agent's own query, the other shows
where a recalled lesson came from — its run, outcome and evidence, the lessons it was merged from,
and the ones it replaced ([agents.md §3.2.1](./agents.md#321-memory-tools-searchlessons-explainlesson)).

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
marks the sources consolidated. A consolidated row keeps the provenance a written one has: its
`scope` and entity columns, the consolidating agent and model, its share of the call's cost, and
`metadata.consolidatedFrom`, the source ids — whose rows stay in the table, marked consolidated. Channel memory is
consolidated the same way on each ambient fire.

## 5. The memory gate

Memory is replayed into every later run that recalls it, so it is held to a blocking rule
(`packages/worker/src/lib/memoryGuard.ts`): a write whose text matches an `INJECTION` scanner
pattern is refused, a recalled item that matches is dropped, and a scan that fails refuses. See
[agents.md §6.4](./agents.md#64-custom-skill-security-scanning).

## 6. Administration

`/govern/lessons` lists, searches and deletes lessons and starts consolidation. Channel memory is
edited and deleted per channel ([channel-assistant.md §6](./channel-assistant.md#6-memory)).

**Deleting forgets, through every copy.** Both delete routes run `forgetMemoryItems`
(`@auto-swe/shared/lib/memoryForget`) in one transaction with the audit row:

- Every row consolidated from the deleted item is deleted too, recursively, because it carries the
  deleted content.
- A deleted item that is itself a merged row takes its sources with it, recursively — they hold the
  same content, and bringing them back would undo the delete.
- The other sources of a merged row retracted on the way up become active again, unless another
  surviving merged row still stands for them. Consolidation may merge them again later, without the
  deleted item.
- Rows the deleted items had superseded become active again.

The response and the audit row list every id deleted and restored.

**Erasing one person's channel memory.** `POST /api/v1/platform/slack-channels/memory/erase-user`
(ADMIN, body `{ "slackUserId": "U…" }`) forgets, the same way, every channel-memory item written
from that Slack user's turns (`metadata.userSlackId`) in every channel. Its audit row records the
Slack user id and how many items went and came back — never their text, which would keep what was
erased. There is no dashboard control for it; it is API-only.

After the embedding model changes, the Embeddings tab at `/studio/models` shows how many memory rows
the configured model did not embed (`GET /api/v1/platform/embedding-config/reembed`) and starts
`ReembedStaleMemoryWorkflow` (`POST` to the same path, ADMIN, audited). The workflow walks those
rows in id order, 100 per activity and four embedding calls at a time, and continues as new every
50 batches. It runs under one fixed workflow id, so a second start while one runs is refused with
`409 REEMBED_IN_PROGRESS`.

---

## Limitations

- **Not every loop that fails writes a lesson.** The release templates `canary-rollout` and
  `signal-gated-rollout` have the same review and CI loops and write none. Nor does the sign-off
  loop of `four-eyes`, when people reject the change three times: those rejections are people's,
  often without a written reason, and a `REVIEW_FAILED` lesson is written as the review network's.
  A run that times out waiting for CI or a merge writes no lesson, and neither does one that fails
  outside the review and CI loops (a security gate, an implementation error).
- **The evidence is the last attempt's.** A loop keeps only its latest rejection and CI log, so a
  lesson about a run that failed three different ways sees the third.
- **A citation is a pointer, not a proof.** `metadata.evidence` says what a lesson was written
  from; nothing checks that the lesson's text follows from it, and a consolidated row cites only
  its sources, not their evidence.
- **Supersession is similarity, not contradiction.** A newer lesson replaces an older one only when
  their summaries embed close together. Two lessons that contradict each other in different words
  both stay active, and a near-duplicate that adds a detail still replaces the original. Nothing
  un-supersedes a lesson, and lessons never expire.
- **Confidence is the writer's own grade.** It is the model's reading of a fixed rubric, not a
  measurement, and it labels a recalled lesson rather than filtering it.
- **Forgetting follows provenance links, not content.** A delete reaches the rows
  `metadata.consolidatedFrom` and `supersededById` connect to it. A separate lesson that happens to
  restate the deleted one — written by another run, never merged with it — stays.
- **Erasure reaches only what is attributed.** A turn's memory carries the asking user's
  `userSlackId`, but passive ingestion distils facts from many people's messages and records no
  author, so those facts — and anything a summary of another person's turn repeated — are not found
  by a per-user erasure. They can be deleted one by one.
- **A repository's lessons outlive its deactivation.** No route deletes a repository, so its lessons
  stay; one whose row is removed by hand keeps them, listed as "Deleted repository".
- **Changing the embedding model hides existing memory until an admin re-embeds it.** The re-embed
  is not started on save, because it is one billed call per row. A row whose re-embed fails stays
  hidden and is counted in the workflow's result; the next run retries it.
- **Scoped search depends on pgvector 0.8.** On an older pgvector the iterative scan is
  unavailable: the worker logs a warning once and searches without it, and a small repository or
  channel in a large table can get fewer matches than exist, or none. Even with it, the scan stops
  after `hnsw.max_scan_tuples` (pgvector's default, 20,000) index tuples, so a scope whose nearest
  memories lie beyond that many closer rows from other scopes is still cut short.
- **The memory tools exist only under the Mastra loop.** A session on the Claude Code harness gets
  recalled lessons in its prompt but no `searchLessons` / `explainLesson`; the harness has its own
  tool set. Eval cases and the merge-conflict resolver get neither tools nor recall, so both sides
  of an eval comparison see the same context.
- **A failed channel summary stores the raw exchange.** When the summariser fails for a reason
  other than the memory gate or a refusal to spend (a malformed answer, a provider error), the
  turn's text and reply are stored undistilled, truncated to the summary and rationale lengths.
- **Channel-memory embeddings are outside the channel's budget.** Every embedding a channel makes —
  a summary, a raw-exchange fallback, a passive fact, a consolidated row, an org-flagging query — is
  priced onto the run that made it and its trace, never onto the channel's monthly ledger or a
  turn's hold, so the cap does not bind it.
