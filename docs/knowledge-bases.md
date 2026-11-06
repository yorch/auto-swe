# Repository-backed knowledge bases

A knowledge base (KB) connects an onboarded Git repository containing reference material to
workflow runs. Git is the source of truth: snapshots and chunks are separate from
[governed knowledge items](./knowledge.md), with no approval or publication lifecycle. A run
pins commit SHAs, mounts bounded read-only files and can search its pinned snapshots. All content
is untrusted third-party reference material, not instructions or system policy.

## Management and visibility

Open **Knowledge bases** beside Knowledge in the dashboard. An owning-team LEAD, or a platform
ADMIN, creates a KB from an active onboarded `git_repo` connection. One connection has at most
one KB. Set its display name, safe mount name, description, repository-relative path (empty for
the root), optional default ref and visibility. The owner is the connection's team.

- `TEAM`: only the owning team can attach it.
- `SHARED`: the owner and selected teams in the same organization can attach it.
- `ORG`: teams in the same organization can attach it.

Sharing a KB does not share its source connection or confer write access. Disabled KBs and
inactive connections are not attachable. Management actions are hidden from non-managers;
gateway authorization remains authoritative. Details show recent snapshots, index counts,
flagged/skipped paths and reasons, and fixed indexing errors. Reindex requests asynchronous
indexing through Temporal. Deleting a KB removes its links, snapshots and chunks.

## Attachments and resolution

Attachments combine additively in increasing specificity:

1. **TEAM** defaults, in team settings → Automation → Knowledge bases.
2. **REPO** links, from a Git connection card's Knowledge bases action.
3. **TEMPLATE** links, in the workflow template editor, including GLOBAL template links.
4. **RUN** additions/exclusions, in the workflow or agent launch picker at `/start`.

Team, repo and template links can override ref and mount name. Only TEAM links can be mandatory;
only TEMPLATE links can represent stored exclusions. Template and run exclusions cannot exclude
a mandatory team reference. GLOBAL templates can link ORG-visible KBs, with each run still
checking its own organization and team. Effective previews show source levels, mandatory flags
and entries outside the cap.

The resolver deduplicates by KB ID. The most specific link supplies ref/mount overrides;
mandatory status sticks across levels. It selects at most four KBs, ordering mandatory entries
first, then RUN, TEMPLATE, REPO and TEAM. The pin records selected and dropped entries and source
levels. More than four mandatory references still exceed the hard cap; mandatory does not remove
the cap.

Launch APIs accept this optional override; IDs name KBs, not connections:

```json
{
  "knowledgeBases": {
    "add": [{ "id": "<knowledge-base-uuid>", "ref": "release/v2" }],
    "exclude": ["<inherited-knowledge-base-uuid>"]
  }
}
```

An omitted ref follows `KnowledgeBase.defaultRef`, then the connection's default branch. A link
can instead name a branch, tag or full commit SHA. `loadRunKnowledgeBases` filters attachability,
resolves SHAs and ensures snapshots before pinning them in `WorkflowRun.knowledgeBases`, keyed by
the current Temporal execution in `knowledgeBasesFor`. An activity retry reuses that execution's
pin. Runs without a stored WorkflowRun resolve without persisting a pin. Resolution failures log
a fixed warning and omit KBs rather than fail the workflow.

## Indexing and synchronization

The worker uses the SCM provider to resolve refs, list the tree and fetch files under the KB path.
Snapshot identity is `(knowledgeBaseId, sha, path)`; a READY snapshot is reused. Supported extensions
are `.md`, `.mdx`, `.markdown`, `.txt`, `.rst`, `.adoc`, `.json`, `.yaml`, `.yml` and `.toml`.

Indexing permits at most 500 files, 100 KiB per file and 5 MiB total. Skipped files retain reasons.
A truncated tree fails closed instead of publishing a partial READY index. The existing memory
INJECTION scanner screens each indexed file; matched or incompletely scanned files are flagged
and excluded from chunks and checkout. Markdown headings and a 4,000-character bound delimit chunks.
Content digests and the configured embedding model accompany vectors. Embedding-generation failure
leaves unembedded chunks in a READY snapshot; other indexing failures record FAILED and fixed error
text, not provider error bodies.

At gateway startup, `KNOWLEDGE_BASE_SYNC_ENABLED` (default `true`) and
`KNOWLEDGE_BASE_SYNC_CRON` (default `*/30 * * * *`, UTC) synchronize the Temporal schedule
`auto-swe-knowledge-base-sync`. Restart the gateway after changing these environment variables.
The sweep indexes active KBs at their configured default ref, reusing an unchanged READY snapshot.
Verified GitHub push deliveries on the source connection's default branch or the KB default-ref
branch also request indexing, deduplicated by workflow ID. Explicit reindex and synchronous
run-start indexing remain available when the sweep is disabled. See
[configuration](./configuration.md#knowledge-base-synchronization) and [.env.example](../.env.example).

## Files, prompts and search

Agent workspaces shallow-fetch the pinned SHA before the egress lock, using sparse checkout for
a configured subdirectory. The mounted root is `/workspace/kb/<sanitized mountName>`. Checkout
deletes flagged files and symlinks, removes `.git`, isolates credentials through the existing
authenticated-git helpers and makes files read-only. A checkout over 50 MiB of logical file bytes
is removed. Individual checkout failures clean up and do not fail the run.

Implementation and fix sessions, workspace agent nodes, agent-run workspaces and the decomposition
merge-conflict resolver receive KBs. Trusted delivery containers and non-agent gate workspaces do
not. The `knowledgeBases` step boolean defaults to `true`; setting it to `false` omits the KB files
and KB search scope for that step. The prompt block lists mounted paths and owner/repo@sha7,
with a sanitized, flattened README/INDEX summary capped at 1,000 characters. Mastra and
claude-code/Pi harness prompts label these references untrusted and never to be edited.

Mastra, Claude Code and Pi automatically receive KB-only `searchKnowledge` when the step has
pinned snapshots and `knowledgeBases` is enabled. An explicit `searchKnowledge` grant additionally
permits governed KnowledgeItem results to merge, as does the `retrieveKnowledge` workflow step.
Without snapshots or a grant there is no search tool. Claude Code exposes search through a
worker-side SDK MCP server named `knowledge`, recorded in the transcript's server list; Pi uses a
worker-side AgentTool. Snapshot IDs are copied into the binding inside the activity; model input
cannot select arbitrary snapshots. Search scope survives an individual file-checkout failure.

The text-only `planDecomposition` step receives a best-effort system-prompt block without a
workspace, tools or clone credentials. It lists each pinned KB's name and owner/repo@sha7 with a
bounded indexed README/INDEX summary, then retrieves up to five chunks for one ticket/request
query. Summaries and excerpts pass recall-time injection filtering and are labelled untrusted
reference data; citations accompany the excerpts. The block is capped at 12,000 characters.
Missing or non-READY snapshots are skipped; the READY pins still supply summaries and retrieval.
`knowledgeBases: false` omits it, and any loading, summary or retrieval failure omits the whole block.

KB vector search is an exact cosine scan over the run's pinned snapshots, not an approximate HNSW
scan. The unique `(snapshotId, path, chunkIndex)` btree index supports the snapshot filter. Search
compares vectors only for the configured embedding model and falls back to bounded text matching
when query embedding/vector search fails or no compatible vectors exist. Text mode
is reported explicitly. Recall applies the same fail-closed INJECTION gate as governed knowledge,
drops unsafe chunks and counts drops. Results carry `sourceKind: knowledge_base`,
`trustLabel: UNTRUSTED_THIRD_PARTY_REFERENCE` and citations such as
`kb:acme/reference@abcdef0 docs/guide.md # Heading`. Results sort by similarity, with governed
items first on ties. KB results are capped at ten and 1,600 content characters each; the merged
title/content/citation budget is 8,000 characters. Existing governed scope and source-access gates
remain in force. [Repository dependencies](./repo-dependency-graph.md) are a different context
mechanism: KB attachment does not create dependency edges.

## API surface

All paths use `/api/v1` and require authentication:

| Routes | Access |
|---|---|
| `GET /knowledge-bases`, `GET /knowledge-bases/:id` | ENGINEER+, visibility-filtered; explicit platform-ADMIN bypass |
| `POST /knowledge-bases`, `PATCH/DELETE /knowledge-bases/:id` | Owning-team LEAD or platform ADMIN |
| `PUT /knowledge-bases/:id/shares`, `POST /knowledge-bases/:id/reindex` | Owning-team LEAD or platform ADMIN |
| `GET/POST /knowledge-base-links`, `PATCH/DELETE /knowledge-base-links/:id` | Target-team LEAD; GLOBAL template management requires ADMIN |
| `GET /repositories/:id/knowledge-bases/effective` | ENGINEER+, repository reachability |
| `GET /teams/:id/knowledge-bases/effective` | ENGINEER+, team membership; explicit platform-ADMIN bypass |

Both effective endpoints accept optional `templateId`. Mutations are audited; assistant policy
classifies reads as read-only access and management calls as confirmation-requiring actions.

## Limitations

- The text-only decomposition planner cannot browse reference files or issue follow-up searches.
  Its bounded summary uses indexed README/INDEX chunks, so unindexed or skipped summaries are absent.
- Caps can omit references and files; text matching is bounded, not exhaustive search. Unsupported
  extensions, oversized files and truncated trees are not silently treated as indexed content.
- A read-only mount and injection screening are defense in depth, not proof of trustworthy content
  or a sandbox against an agent with privileged shell access. Do not put secrets in KB repositories.
- Revocation does not recall files or content already handed to an active agent. New runs and later
  `loadRunKnowledgeBases` resolutions recheck attachability, including reused pins. Already-bound
  search closures and running workspaces are not actively cancelled or scrubbed.
- Checkout and indexing are best-effort. A mandatory reference cannot be excluded by configuration,
  but a failure, revoked access or the hard cap can still leave it unavailable.
- GitHub/provider boundaries have mock-based coverage; live authenticated GitHub checkout,
  embedding-provider calls and live vector-search integration are not verified end to end. Local
  real-git checkout tests and migration application do not establish those integrations.
- The dashboard has component interaction tests, typechecking and a production build, but no
  authenticated browser/visual verification. KB-specific CLI management commands are absent.
- Snapshot retention has no dedicated pruning sweep. READY snapshots are immutable; changing
  scanner rules protects future recall, but does not rebuild existing flagged-file metadata.
