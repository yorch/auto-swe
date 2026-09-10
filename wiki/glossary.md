# Glossary

> Indexed at commit `b1d8930` on 2026-09-08 · [view on GitHub](https://github.com/yorch/auto-swe/tree/b1d8930)

## Relevant source files

- [packages/shared/src/workflow/spec.ts](https://github.com/yorch/auto-swe/blob/b1d8930/packages/shared/src/workflow/spec.ts)
- [packages/shared/src/workflow/interpreter.ts](https://github.com/yorch/auto-swe/blob/b1d8930/packages/shared/src/workflow/interpreter.ts)
- [packages/shared/src/workflow/expr.ts](https://github.com/yorch/auto-swe/blob/b1d8930/packages/shared/src/workflow/expr.ts)
- [packages/shared/src/workflow/registry-types.ts](https://github.com/yorch/auto-swe/blob/b1d8930/packages/shared/src/workflow/registry-types.ts)
- [packages/shared/src/workflow/stepRegistry.ts](https://github.com/yorch/auto-swe/blob/b1d8930/packages/shared/src/workflow/stepRegistry.ts)
- [packages/shared/src/types/workflow.ts](https://github.com/yorch/auto-swe/blob/b1d8930/packages/shared/src/types/workflow.ts)
- [packages/shared/src/prisma/schema.prisma](https://github.com/yorch/auto-swe/blob/b1d8930/packages/shared/src/prisma/schema.prisma)
- [packages/shared/src/config/registry.ts](https://github.com/yorch/auto-swe/blob/b1d8930/packages/shared/src/config/registry.ts)
- [packages/shared/src/config/types.ts](https://github.com/yorch/auto-swe/blob/b1d8930/packages/shared/src/config/types.ts)
- [packages/shared/src/agentKeys.ts](https://github.com/yorch/auto-swe/blob/b1d8930/packages/shared/src/agentKeys.ts)
- [packages/shared/src/skills/index.ts](https://github.com/yorch/auto-swe/blob/b1d8930/packages/shared/src/skills/index.ts)
- [packages/shared/src/scannerPatterns/index.ts](https://github.com/yorch/auto-swe/blob/b1d8930/packages/shared/src/scannerPatterns/index.ts)
- [packages/shared/src/bundle/index.ts](https://github.com/yorch/auto-swe/blob/b1d8930/packages/shared/src/bundle/index.ts)
- [packages/shared/src/lib/workspaceProviders.ts](https://github.com/yorch/auto-swe/blob/b1d8930/packages/shared/src/lib/workspaceProviders.ts)
- [packages/shared/src/lib/workflowId.ts](https://github.com/yorch/auto-swe/blob/b1d8930/packages/shared/src/lib/workflowId.ts)
- [packages/worker/src/workflows/runnable.ts](https://github.com/yorch/auto-swe/blob/b1d8930/packages/worker/src/workflows/runnable.ts)
- [packages/worker/src/workflows/epicOrchestrator.ts](https://github.com/yorch/auto-swe/blob/b1d8930/packages/worker/src/workflows/epicOrchestrator.ts)
- [packages/worker/src/activities/index.ts](https://github.com/yorch/auto-swe/blob/b1d8930/packages/worker/src/activities/index.ts)
- [packages/worker/src/activities/qualityGates.ts](https://github.com/yorch/auto-swe/blob/b1d8930/packages/worker/src/activities/qualityGates.ts)
- [packages/worker/src/activities/workspace.ts](https://github.com/yorch/auto-swe/blob/b1d8930/packages/worker/src/activities/workspace.ts)
- [packages/worker/src/agents/reviewNetwork.ts](https://github.com/yorch/auto-swe/blob/b1d8930/packages/worker/src/agents/reviewNetwork.ts)
- [packages/worker/src/agents/implementer.ts](https://github.com/yorch/auto-swe/blob/b1d8930/packages/worker/src/agents/implementer.ts)
- [packages/worker/src/lib/costTracking.ts](https://github.com/yorch/auto-swe/blob/b1d8930/packages/worker/src/lib/costTracking.ts)
- [packages/worker/src/lib/config/agentRef.ts](https://github.com/yorch/auto-swe/blob/b1d8930/packages/worker/src/lib/config/agentRef.ts)

## About this glossary

Every term below is defined by something that exists in source at the indexed commit: a Prisma model, a Zod schema, a TypeScript union, or an exported constant. Terms are ordered alphabetically and grouped by initial letter, with one `Sources:` footer per group.

## A

**Activity** — A Temporal activity: the deterministic boundary between the replaying workflow isolate and the non-deterministic outside world (LLM calls, Docker, the GitHub API, the database). Every activity the worker registers is re-exported from a single barrel, and the interpreter reaches them through the `STEP_EXECUTORS` map keyed by step name. Workflow code may only `import type` from outside `@temporalio/workflow`, so all real I/O lives behind this boundary.

**Agent** — A first-class, versioned database row that carries an agent's identity plus optional overrides for model, system prompt, skills, and tools. It is the single source of truth for per-key configuration; a null override field means "inherit from the next scope up". Agents are scoped through the same cascade as every other config table, and partial unique indexes per scope mean writes use `findFirst` plus a conditional create rather than `upsert`.

**Agent key** — The free-form camelCase string that identifies an agent, such as `implementer` or `securityReviewer`. There is deliberately no database enum for it, so a new agent ships as seed data rather than a migration. `MODEL_BACKED_AGENT_KEYS` lists only the narrow set of agents that carry their own `modelSpec`, drive cost pricing, and get a label in the model-config UI; it is not the universe of agents.

**Agent node** — A workflow node type that runs a library Agent by reference and records its output at `nodes.<id>.output` like any step. Its `agentRef` is either a bare key (float to the latest active version) or `key@version` (pinned). A per-node `systemPrompt` overrides the Agent's own prompt, and `userMessage` supplies the literal prompt payload.

**Agent version** — The integer `version` column on an Agent row, bumped on every base edit; the active row at a scope is the highest version still marked active. At run start the resolved versions are snapshotted into `WorkflowRun.agentVersions`, so editing an Agent mid-flight cannot change a run already in progress. A node can also pin a version explicitly through the `key@version` form of an agent reference.

**AgentTrace** — One recorded tool call, LLM response, or activity event captured during an agent activity. Rows carry the Temporal activity type as `nodeId`, the agent key, and the Temporal attempt number, so the run viewer can group a retry's traces separately. Persistence is best-effort: failures are swallowed so tracing never breaks a run.

**Autonomy policy** — A governance row holding JSON rules keyed by risk class that decide whether an outcome publishes automatically or pauses for human approval. Resolution walks template-specific policy, then team default, then the seeded global default. Decisions taken under a policy are recorded as `AutonomyDecision` rows against the run.

Sources: [packages/shared/src/prisma/schema.prisma:L2071-L2142](https://github.com/yorch/auto-swe/blob/b1d8930/packages/shared/src/prisma/schema.prisma#L2071-L2142) [packages/shared/src/agentKeys.ts:L1-L29](https://github.com/yorch/auto-swe/blob/b1d8930/packages/shared/src/agentKeys.ts#L1-L29) [packages/shared/src/workflow/spec.ts:L98-L120](https://github.com/yorch/auto-swe/blob/b1d8930/packages/shared/src/workflow/spec.ts#L98-L120) [packages/worker/src/lib/config/agentRef.ts:L1-L41](https://github.com/yorch/auto-swe/blob/b1d8930/packages/worker/src/lib/config/agentRef.ts#L1-L41) [packages/shared/src/prisma/schema.prisma:L1273-L1316](https://github.com/yorch/auto-swe/blob/b1d8930/packages/shared/src/prisma/schema.prisma#L1273-L1316) [packages/shared/src/prisma/schema.prisma:L1442-L1463](https://github.com/yorch/auto-swe/blob/b1d8930/packages/shared/src/prisma/schema.prisma#L1442-L1463) [packages/worker/src/workflows/runnable.ts:L528](https://github.com/yorch/auto-swe/blob/b1d8930/packages/worker/src/workflows/runnable.ts#L528) [packages/worker/src/activities/index.ts:L1-L211](https://github.com/yorch/auto-swe/blob/b1d8930/packages/worker/src/activities/index.ts#L1-L211)

## B

**Binding** — The unit that reads a value into a node's inputs. Exactly one of three forms is used: `from` reads a dot-path out of the run context with an optional default, `literal` supplies a constant, and `expr` evaluates an expression capped at 2,000 characters. The union is deliberately non-strict so specs stored with incidental extra keys still parse when re-read at run time.

**Budget tier** — One of `STANDARD`, `LARGE`, or `EPIC`, attached to a run and used to cap token spend. The built-in ceilings run from 2M input and 500K output tokens at standard up to 20M and 5M at epic. An operator can override the six numbers on the workflow-defaults singleton; with no override the resolver returns exactly the built-in constants.

**Bundle** — A versioned, self-describing export of a tagged set of library content: agents, skills, scanner patterns, and templates. Connection instances never travel in a bundle because they hold URLs and credentials; a bundle only declares the connection types its content requires. Schema version 2 hashes the whole manifest minus the three self-referential metadata fields, so a bundle's name and version are covered by its signature.

Sources: [packages/shared/src/workflow/spec.ts:L39-L54](https://github.com/yorch/auto-swe/blob/b1d8930/packages/shared/src/workflow/spec.ts#L39-L54) [packages/shared/src/types/workflow.ts:L283-L286](https://github.com/yorch/auto-swe/blob/b1d8930/packages/shared/src/types/workflow.ts#L283-L286) [packages/worker/src/lib/costTracking.ts:L127-L150](https://github.com/yorch/auto-swe/blob/b1d8930/packages/worker/src/lib/costTracking.ts#L127-L150) [packages/shared/src/bundle/index.ts:L20-L49](https://github.com/yorch/auto-swe/blob/b1d8930/packages/shared/src/bundle/index.ts#L20-L49) [packages/shared/src/bundle/index.ts:L143-L177](https://github.com/yorch/auto-swe/blob/b1d8930/packages/shared/src/bundle/index.ts#L143-L177) [packages/shared/src/prisma/schema.prisma:L2183-L2200](https://github.com/yorch/auto-swe/blob/b1d8930/packages/shared/src/prisma/schema.prisma#L2183-L2200)

## C

**cond node** — A branching node that evaluates an expression and transitions to `onTrue` or `onFalse`. Because a `cond` edge may point backwards, the workflow graph is intentionally not acyclic and can express retry loops. The transition ceiling is what stops a back-edge from looping forever.

**Connection** — The generic integration target, replacing what used to be a repository-specific model. Its `type` discriminator defaults to `git_repo`; other types such as `mcp`, `http_api`, and `notion` stash their specifics in an opaque `config` JSON bag. Git-repository fields stay as typed columns, and a token-based connection stores its credential as an AES-256-GCM ciphertext with nonce and auth tag.

**containerStep node** — A node that runs an image under the same locked-down ephemeral container as a shell node, but with a structured JSON contract: resolved inputs arrive on the `CONTAINER_STEP_INPUT` environment variable and the container's JSON output binds at `nodes.<id>.output.result`. Three transports exist — a single stdout object, a newline-delimited event stream, or a detached loopback HTTP sidecar. It is how a bundle ships coded capabilities without untrusted code entering the worker process.

**Context snapshot** — A per-work-request row capturing raw ticket data, raw documentation, an optional Figma design summary, and the extracted success criteria. It is seeded server-side at submission time by the tracker, knowledge-base, and Figma connectors. Population is best-effort, so a connector failure never blocks a submission.

Sources: [packages/shared/src/workflow/spec.ts:L1-L26](https://github.com/yorch/auto-swe/blob/b1d8930/packages/shared/src/workflow/spec.ts#L1-L26) [packages/shared/src/workflow/spec.ts:L188-L193](https://github.com/yorch/auto-swe/blob/b1d8930/packages/shared/src/workflow/spec.ts#L188-L193) [packages/shared/src/prisma/schema.prisma:L255-L330](https://github.com/yorch/auto-swe/blob/b1d8930/packages/shared/src/prisma/schema.prisma#L255-L330) [packages/shared/src/workflow/spec.ts:L326-L375](https://github.com/yorch/auto-swe/blob/b1d8930/packages/shared/src/workflow/spec.ts#L326-L375) [packages/shared/src/prisma/schema.prisma:L197-L210](https://github.com/yorch/auto-swe/blob/b1d8930/packages/shared/src/prisma/schema.prisma#L197-L210)

## D

**Dataset** — An `EvalDataset` row: a frozen benchmark collection of eval cases, scoped through the same cascade as an Agent and resolved in code by scope match. A dataset is addressed by slug rather than id in scheduled runs, so the schedule survives re-seeding. Each dataset owns its cases and the harness runs scored against it.

Sources: [packages/shared/src/prisma/schema.prisma:L1175-L1194](https://github.com/yorch/auto-swe/blob/b1d8930/packages/shared/src/prisma/schema.prisma#L1175-L1194) [packages/shared/src/types/workflow.ts:L318-L328](https://github.com/yorch/auto-swe/blob/b1d8930/packages/shared/src/types/workflow.ts#L318-L328)

## E

**Epic** — A cross-repository request fanned out into one child workflow per repository, with a dependency graph between them. Each `EpicRepoEntry` names the repositories that must complete before it starts, and the orchestrator collects a per-repository `WorkflowResult` into `EpicResult.childResults`. When the entry list is empty the planner activity proposes repositories from the candidate ids.

**Eval case** — One frozen benchmark case: a pinned fixture repository at an exact commit, the input payload the candidate agent runs on, and the in-scope golden test command used as the execution floor. `flakeScreened` gates promotion, requiring the reference to pass consistently. A case that stops passing against current repository state is quarantined and excluded from the gate rather than counted as an agent failure.

**Eval run** — One harness run: a candidate agent, model, or prompt reference scored against a baseline over a dataset, with the paired-statistics verdict stored in `summary`. Its status is one of `RUNNING`, `SUCCESS`, `FAILED`, or `REGRESSION`. Individual scores land as `EvalResult` rows linked back to the run and the case.

**Eval scorer** — One entry in an eval node's scorer list. Six kinds exist: `gate` and `assert` are floor scorers that run first and short-circuit the rest on failure, while `trajectory`, `judge`, `policy`, and `pii` are the remaining kinds, with judge and trajectory advisory by default. The recorded signal source enum is broader still, adding review, merge, and human-audit origins for scores captured outside a node.

**Expression** — The tiny grammar evaluated on `cond` nodes and `expr` bindings, over the run context. Source length is capped at 2,000 characters because a binding that long is a payload rather than a condition. `evalBoolean` is the entry point the interpreter uses for branching.

Sources: [packages/shared/src/types/workflow.ts:L212-L233](https://github.com/yorch/auto-swe/blob/b1d8930/packages/shared/src/types/workflow.ts#L212-L233) [packages/worker/src/workflows/epicOrchestrator.ts:L1-L45](https://github.com/yorch/auto-swe/blob/b1d8930/packages/worker/src/workflows/epicOrchestrator.ts#L1-L45) [packages/shared/src/prisma/schema.prisma:L1196-L1251](https://github.com/yorch/auto-swe/blob/b1d8930/packages/shared/src/prisma/schema.prisma#L1196-L1251) [packages/shared/src/workflow/spec.ts:L144-L180](https://github.com/yorch/auto-swe/blob/b1d8930/packages/shared/src/workflow/spec.ts#L144-L180) [packages/shared/src/prisma/schema.prisma:L82-L98](https://github.com/yorch/auto-swe/blob/b1d8930/packages/shared/src/prisma/schema.prisma#L82-L98) [packages/shared/src/workflow/expr.ts:L81-L89](https://github.com/yorch/auto-swe/blob/b1d8930/packages/shared/src/workflow/expr.ts#L81-L89)

## F

**fanOut node** — A node that evaluates `over` to an array and runs a named subgraph once per element, then resumes at `join`. Each branch executes in a sealed child context: the parent's request and workflow pass by reference, `context` is shallow-cloned so branch mutations stay local, and `nodes` is reinitialized empty. Branches run through a concurrency-bounded pool, defaulting to four and capped at twenty, and `onBranchFail` decides whether one failed branch blocks the parent.

Sources: [packages/shared/src/workflow/spec.ts:L213-L264](https://github.com/yorch/auto-swe/blob/b1d8930/packages/shared/src/workflow/spec.ts#L213-L264) [packages/shared/src/workflow/interpreter.ts:L239-L251](https://github.com/yorch/auto-swe/blob/b1d8930/packages/shared/src/workflow/interpreter.ts#L239-L251)

## H

**HITL node kinds** — The four human-in-the-loop node types that pause a run: `humanApproval` (approve or reject), `humanDecision` (pick one of two to ten options), `humanInput` (submit a structured form of up to twenty fields), and `humanReview` (read and optionally edit content). Each maps to a `HumanStepKind` database enum value of `APPROVAL`, `DECISION`, `INPUT`, or `REVIEW`, and each has a fixed set of valid response actions. Reaching one creates a `WorkflowHumanStep` row; the run stays `RUNNING` while the workflow waits on a Temporal signal named `hitl_<nodeId>`.

Sources: [packages/shared/src/workflow/spec.ts:L377-L447](https://github.com/yorch/auto-swe/blob/b1d8930/packages/shared/src/workflow/spec.ts#L377-L447) [packages/shared/src/workflow/interpreter.ts:L216-L237](https://github.com/yorch/auto-swe/blob/b1d8930/packages/shared/src/workflow/interpreter.ts#L216-L237) [packages/shared/src/prisma/schema.prisma:L1336-L1375](https://github.com/yorch/auto-swe/blob/b1d8930/packages/shared/src/prisma/schema.prisma#L1336-L1375)

## I

**Interpreter** — The spec walker that executes a workflow spec inside the Temporal isolate, returning a status, a result map, a transition count, and the final context. It caps total node transitions at 500 by default so a spec with back-edges cannot loop forever. It runs the same way in the worker and in unit tests, because its dispatcher is an interface rather than a direct activity call.

Sources: [packages/shared/src/workflow/interpreter.ts:L207-L214](https://github.com/yorch/auto-swe/blob/b1d8930/packages/shared/src/workflow/interpreter.ts#L207-L214) [packages/shared/src/workflow/interpreter.ts:L97-L205](https://github.com/yorch/auto-swe/blob/b1d8930/packages/shared/src/workflow/interpreter.ts#L97-L205)

## L

**Lesson** — A memory item in the `swe-lessons` scope, holding a rationale and a `lessonSummary` alongside its embedding, and optionally a failure type of `CI_FAILURE`, `REVIEW_REJECTION`, `SECURITY_VIOLATION`, or `MERGE_CONFLICT`. Retrieval returns a `LessonSummary` carrying the id, summary, failure type, and cosine similarity. Consolidation clusters near-duplicate lessons and soft-deletes the originals by setting `consolidatedAt`, so an active lesson is always one with that column null.

Sources: [packages/shared/src/prisma/schema.prisma:L131-L195](https://github.com/yorch/auto-swe/blob/b1d8930/packages/shared/src/prisma/schema.prisma#L131-L195) [packages/shared/src/types/workflow.ts:L165-L178](https://github.com/yorch/auto-swe/blob/b1d8930/packages/shared/src/types/workflow.ts#L165-L178) [packages/shared/src/types/workflow.ts:L288-L303](https://github.com/yorch/auto-swe/blob/b1d8930/packages/shared/src/types/workflow.ts#L288-L303)

## M

**MCP node** — A node that calls one tool on a Model Context Protocol (MCP) connection as a workflow step. `connectionRef` names an `mcp`-type Connection, `tool` names the tool on that server, and the node's inputs map to the tool's arguments. The tool result binds at `nodes.<id>.output.result` like any other step output.

**Memory item** — The generic semantic-memory row, carrying a 1536-dimension pgvector embedding plus scope, entity, channel, team, and organization keys for retrieval. `scope` is the partition key, so one domain's memories stay isolated from another's. The vector dimension is fixed in the column, so an embedding model returning a different shape is rejected rather than stored.

**Model spec** — The `<provider>/<model-id>` string that binds an agent to a model, stored in `Agent.modelSpec`. When it is null and `inheritsModelFrom` names a parent agent key, the model resolves from that parent instead, which is how sub-role personas avoid needing their own model row. Provider names outside the built-in set route through the OpenAI-compatible adapter and require an `apiBase` on the credential.

Sources: [packages/shared/src/workflow/spec.ts:L122-L142](https://github.com/yorch/auto-swe/blob/b1d8930/packages/shared/src/workflow/spec.ts#L122-L142) [packages/shared/src/prisma/schema.prisma:L131-L195](https://github.com/yorch/auto-swe/blob/b1d8930/packages/shared/src/prisma/schema.prisma#L131-L195) [packages/shared/src/prisma/schema.prisma:L2099-L2112](https://github.com/yorch/auto-swe/blob/b1d8930/packages/shared/src/prisma/schema.prisma#L2099-L2112) [packages/shared/src/prisma/schema.prisma:L1492-L1527](https://github.com/yorch/auto-swe/blob/b1d8930/packages/shared/src/prisma/schema.prisma#L1492-L1527)

## N

**Node type** — One of the fifteen members of the discriminated union a workflow spec's nodes may take: `step`, `agent`, `mcp`, `eval`, `set`, `cond`, `signal`, `terminate`, `fanOut`, `shell`, `containerStep`, `humanApproval`, `humanDecision`, `humanInput`, and `humanReview`. Each variant's outgoing edges are enumerated once in `nodeEdges`, which the schema's reference validation and the reachability analysis both consume. A variant missing from that switch fails the build through an exhaustiveness sentinel rather than silently reporting no edges.

Sources: [packages/shared/src/workflow/spec.ts:L449-L482](https://github.com/yorch/auto-swe/blob/b1d8930/packages/shared/src/workflow/spec.ts#L449-L482) [packages/shared/src/workflow/spec.ts:L514-L579](https://github.com/yorch/auto-swe/blob/b1d8930/packages/shared/src/workflow/spec.ts#L514-L579)

## O

**onFail** — The per-step workflow-level failure policy, distinct from activity-level retry. `block` terminates the run as failed and is the default, `warn` records the failure and continues to `next`, and `{ retry: N }` re-runs the step up to N more times before falling back to block semantics. Activity-level retry on the `retry` field remains for transient infrastructure errors.

**Organization** — The outermost tenant. Every team nests under exactly one organization, and an organization may carry a monthly spend cap in USD cents plus a warning threshold percentage. It owns agents, provider credentials, skills, memory items, config settings, and permission grants at the `ORGANIZATION` scope.

Sources: [packages/shared/src/workflow/spec.ts:L68-L83](https://github.com/yorch/auto-swe/blob/b1d8930/packages/shared/src/workflow/spec.ts#L68-L83) [packages/shared/src/prisma/schema.prisma:L375-L402](https://github.com/yorch/auto-swe/blob/b1d8930/packages/shared/src/prisma/schema.prisma#L375-L402)

## P

**Personal access token** — A long-lived API token for command-line and CI use, issued once in plaintext as `ats_<random>` with only its SHA-256 hash stored. A non-secret twelve-character prefix is retained so the admin interface can disambiguate listed tokens without re-issuing them. `lastUsedAt` updates best-effort on each successful authentication so stale tokens can be pruned.

**Provider credential** — An AES-256-GCM encrypted API key for one large-language-model provider, scoped `GLOBAL`, `ORGANIZATION`, or `TEAM` and resolved team-first. Template scope is deliberately unsupported: a template may reference an existing credential but cannot create its own. `lastFour` holds the trailing plaintext characters for display only, and `keyVersion` supports rotation.

Sources: [packages/shared/src/prisma/schema.prisma:L232-L253](https://github.com/yorch/auto-swe/blob/b1d8930/packages/shared/src/prisma/schema.prisma#L232-L253) [packages/shared/src/prisma/schema.prisma:L1492-L1527](https://github.com/yorch/auto-swe/blob/b1d8930/packages/shared/src/prisma/schema.prisma#L1492-L1527)

## Q

**Quality gate** — One of six commands run inside the work-request workspace: `runLint`, `runTypecheck`, `runTests`, `runBuild`, `runVulnScan`, and `runPerfBench`. Each captures stdout, stderr, and exit code without throwing, stores the full output as a workflow artifact, and returns a small `{ passed, summary, exitCode, artifactId? }` payload. Command resolution takes the first match of step config, then the connection's `gateCommands` override, then the built-in default, and never merges them.

Sources: [packages/worker/src/activities/qualityGates.ts:L1-L68](https://github.com/yorch/auto-swe/blob/b1d8930/packages/worker/src/activities/qualityGates.ts#L1-L68) [packages/shared/src/prisma/schema.prisma:L292-L295](https://github.com/yorch/auto-swe/blob/b1d8930/packages/shared/src/prisma/schema.prisma#L292-L295)

## R

**Review network** — Three reviewer personas — security, domain logic, and performance — each given the whole diff and each returning a structured verdict with an approval flag, a severity of `PASS`, `INFO`, `WARNING`, or `CRITICAL`, and a list of findings. The verdicts aggregate into an `AggregatedReviewResult` that fixed workflow code branches on. This is distinct from the post-diff security gate, which scans the diff alone and fails the activity outright.

**Run context** — The mutable record the interpreter walks with, seeded with four top-level keys: `request` (the run request), `workflow` (the Temporal workflow id), `context` (writable scratch, pre-populated with the resolved workspace), and `nodes` (per-node outputs). Bindings read dot-paths out of it and `set` nodes write into it. A fan-out branch gets a sealed child copy so its writes do not leak back to the parent.

**Run pinning** — Freezing a value into `WorkflowRun.pinnedSettings` at run start so a mid-run configuration change cannot make the second half of a run disagree with the first. A setting declares this with `runPinned: true`; it is used for structural decisions such as fan-out width and the transition ceiling, which the workflow isolate cannot read from the database anyway. Everything not pinned re-resolves per call, which is what lets a model or credential edit land inside an in-flight workflow.

Sources: [packages/worker/src/agents/reviewNetwork.ts:L22-L72](https://github.com/yorch/auto-swe/blob/b1d8930/packages/worker/src/agents/reviewNetwork.ts#L22-L72) [packages/shared/src/types/workflow.ts:L141-L163](https://github.com/yorch/auto-swe/blob/b1d8930/packages/shared/src/types/workflow.ts#L141-L163) [packages/shared/src/workflow/expr.ts:L20-L51](https://github.com/yorch/auto-swe/blob/b1d8930/packages/shared/src/workflow/expr.ts#L20-L51) [packages/worker/src/workflows/runnable.ts:L377-L388](https://github.com/yorch/auto-swe/blob/b1d8930/packages/worker/src/workflows/runnable.ts#L377-L388) [packages/shared/src/config/types.ts:L62-L68](https://github.com/yorch/auto-swe/blob/b1d8930/packages/shared/src/config/types.ts#L62-L68) [packages/shared/src/prisma/schema.prisma:L1024-L1031](https://github.com/yorch/auto-swe/blob/b1d8930/packages/shared/src/prisma/schema.prisma#L1024-L1031) [packages/shared/src/workflow/interpreter.ts:L267-L300](https://github.com/yorch/auto-swe/blob/b1d8930/packages/shared/src/workflow/interpreter.ts#L267-L300)

## S

**Scanner pattern** — A labeled regular expression row with a type of `INJECTION`, `EXFILTRATION`, `SHELL_COMMAND`, `CODE_SECURITY`, `SENSITIVE_FILE`, or `PII`. Sixty-two built-in patterns ship in source and sync idempotently at gateway startup; admins add more through the scanner admin page. Patterns are data whose execution is bounded rather than analysed, so they run in a pooled worker thread under a wall-clock budget.

**Scope cascade** — The five configuration levels, most specific first: `WORKFLOW_TEMPLATE`, `CHANNEL`, `TEAM`, `ORGANIZATION`, `GLOBAL`. Channel applies only to channel-resident runs and organization only when the run's team belongs to one, so a deployment using neither behaves like a three-level cascade. Agent and credential resolution stops at the first match and has no fallback past global.

**set node** — A node that writes a map of bindings into the run context and continues to `next`. It is the shaping primitive: it is how a spec moves a value from one node's output into the position a later node's binding expects.

**Setting registry** — One declaration per operator-tunable knob, carrying its Zod schema, default, the scopes it may be overridden at, the required role, and whether it pins to a run. That single declaration validates a write, resolves a read, drives the admin form, and gates permission, so adding a knob is a definition rather than a migration plus a route plus a form field. A setting's identity is the property name it is stored under, and its default is always the constant it replaced, so an unconfigured deployment behaves as it did before the knob existed.

**shell node** — A node that runs an author-supplied command in an ephemeral, locked-down container separate from the long-lived workspace. The image must be on the team's effective allowlist, networking is `none` unless the node opts into `egress`, and the container is read-only with a tmpfs, a process limit, and memory and CPU caps. Authoring one requires a team-admin permission and every save is recorded in a shell audit row.

**signal node** — A node that waits for a named Temporal signal with a timeout, transitioning to `onReceive` or `onTimeout` and optionally storing the payload under `storeAs`. It is the generic wait primitive; the human-in-the-loop node types are the specialized forms.

**Skill** — A named prompt fragment injected into an agent's system message; it controls how an agent reasons, not what it can do. Thirty-five built-ins ship one per file and seed as built-in and verified, while custom skills seed unverified and reset to unverified whenever their prompt text is edited. Custom text is scanned for injection and exfiltration patterns on save, advisory rather than blocking.

**Step key** — The `step` string on a step node, naming an entry in the built-in step catalog. Thirty-six step names are registered, spanning agent, gate, control, version-control, and shell categories. The worker asserts at boot that every catalog name has an executor, so a step missing from either list fails before it ships.

**Subtask** — A feature-level unit produced by decomposition, carrying a stable kebab-case slug of at most forty characters, a title, a description, and optional file-scope hints. Each subtask is implemented in its own workspace and branch, and the resulting branches merge into the work-request branch before the pull request opens. The decomposer is prompted to generate the slug and the activity validates it.

Sources: [packages/shared/src/prisma/schema.prisma:L2046-L2069](https://github.com/yorch/auto-swe/blob/b1d8930/packages/shared/src/prisma/schema.prisma#L2046-L2069) [packages/shared/src/scannerPatterns/index.ts:L59-L538](https://github.com/yorch/auto-swe/blob/b1d8930/packages/shared/src/scannerPatterns/index.ts#L59-L538) [packages/shared/src/prisma/schema.prisma:L46-L55](https://github.com/yorch/auto-swe/blob/b1d8930/packages/shared/src/prisma/schema.prisma#L46-L55) [packages/shared/src/config/types.ts:L1-L31](https://github.com/yorch/auto-swe/blob/b1d8930/packages/shared/src/config/types.ts#L1-L31) [packages/shared/src/config/types.ts:L33-L81](https://github.com/yorch/auto-swe/blob/b1d8930/packages/shared/src/config/types.ts#L33-L81) [packages/shared/src/config/registry.ts:L1-L46](https://github.com/yorch/auto-swe/blob/b1d8930/packages/shared/src/config/registry.ts#L1-L46) [packages/shared/src/workflow/spec.ts:L182-L202](https://github.com/yorch/auto-swe/blob/b1d8930/packages/shared/src/workflow/spec.ts#L182-L202) [packages/shared/src/workflow/spec.ts:L266-L324](https://github.com/yorch/auto-swe/blob/b1d8930/packages/shared/src/workflow/spec.ts#L266-L324) [packages/shared/src/prisma/schema.prisma:L2015-L2044](https://github.com/yorch/auto-swe/blob/b1d8930/packages/shared/src/prisma/schema.prisma#L2015-L2044) [packages/shared/src/skills/index.ts:L37-L126](https://github.com/yorch/auto-swe/blob/b1d8930/packages/shared/src/skills/index.ts#L37-L126) [packages/shared/src/workflow/registry-types.ts:L46-L95](https://github.com/yorch/auto-swe/blob/b1d8930/packages/shared/src/workflow/registry-types.ts#L46-L95) [packages/shared/src/types/workflow.ts:L257-L281](https://github.com/yorch/auto-swe/blob/b1d8930/packages/shared/src/types/workflow.ts#L257-L281)

## T

**Team** — The tenancy unit that owns connections, workflow templates, agents, credentials, skills, and configuration overrides. It carries a slug, per-team additions to the shell-step image allowlist and the egress allowlist, and optional Slack notification settings. Every team nests under exactly one organization, with the foreign key set to restrict so an organization holding teams cannot be deleted out from under them.

**terminate node** — A node that ends a run with a status of `SUCCESS`, `FAILED`, `TIMED_OUT`, or `SKIPPED`, optionally binding a result map. `CANCELLED` is deliberately absent: Temporal sets it out of band on a cancellation signal, so a spec can never declare it. Inside a fan-out branch, reaching a terminate node ends that branch rather than the whole run.

**Tool** — An executable Mastra tool function, as opposed to a skill's prompt text. The implementer has four configurable workspace tools — read file, write file, list directory, and run a shell command — gated by the resolved agent's `toolKeys`, where null means all four. A fifth skill-loading tool is added automatically when skills are present and is not configurable, and an `mcp` pseudo-key gates binding an MCP server's tools at run time.

Sources: [packages/shared/src/prisma/schema.prisma:L404-L450](https://github.com/yorch/auto-swe/blob/b1d8930/packages/shared/src/prisma/schema.prisma#L404-L450) [packages/shared/src/workflow/spec.ts:L204-L211](https://github.com/yorch/auto-swe/blob/b1d8930/packages/shared/src/workflow/spec.ts#L204-L211) [packages/shared/src/workflow/stepRegistry.ts:L37-L52](https://github.com/yorch/auto-swe/blob/b1d8930/packages/shared/src/workflow/stepRegistry.ts#L37-L52) [packages/worker/src/agents/implementer.ts:L111-L360](https://github.com/yorch/auto-swe/blob/b1d8930/packages/worker/src/agents/implementer.ts#L111-L360)

## W

**Work request** — The submitted unit of work, stored in the `run_inputs` table as a `RunInput` row. It carries a correlation key, a description, an optional structured payload validated against the template's input schema, an optional target connection, and an optional template and version override snapshotted at run start. The relation field names on related models remain `workRequest` across the model rename, so the public API shape does not churn.

**Workflow ID** — The deterministic Temporal workflow identifier, formed as `eng-<organization>-<repo>-<ticketId>`. Including the organization name prevents collisions between identically named repositories in different organizations. The matching branch name is `<prefix>/<ticketId>`, where the prefix defaults to `auto`.

**Workflow run** — One execution of a template. It stores the parsed spec as `specSnapshot`, the resolved agent versions, and the pinned settings at start time, so live edits to the template or its agents do not affect the run. It also denormalizes the run's total cost and input and output token counts at finalization, so analytics need not re-join through the work-request graph.

**Workflow spec** — The serializable, versioned graph the interpreter executes, stored as JSON on a template version. It holds a name, a description, an entry node id, and a node map, at schema version 1. The schema validates that the entry node exists and that every outgoing edge on every node points at a node that exists, so a dangling reference is a parse error rather than a run-time surprise.

**Workflow step** — A per-node execution record for a run, holding the node id, the attempt number, a status of `PENDING`, `RUNNING`, `PASSED`, `FAILED`, or `SKIPPED`, plus inputs, outputs, and any error. It is unique on run, node, and attempt, so a retry produces a new row rather than overwriting the first.

**Workflow template** — A named, team-owned container for spec versions, carrying an optional declarative input schema, a workspace provider, a status of `DRAFT`, `ACTIVE`, or `ARCHIVED`, and pointers to the active version. It supports an A/B experiment by routing a percentage of incoming requests to an alternate version, and an optional webhook token for public triggering. Template names are unique per team.

**Workflow template version** — An immutable snapshot of a template's spec at version N, validated against the spec schema on insert. A version produced by the workflow-author agent records that provenance in `generatedBy` and must carry a human review timestamp and reviewer before it can be promoted to active. Shell nodes introduced in a version are recorded as audit rows against it.

**Workspace container** — The long-lived Docker container an agent works in, named `workspace-<random-hex>`. It exposes exec, capturing exec, stdin-streaming exec, and an authenticated git helper that injects the clone credential per call rather than persisting it in the repository's git config. Unlike the ephemeral shell-node runner it keeps default bridge networking and a writable layer, because the implementer needs outbound git and package installs, but it still drops all Linux capabilities and bounds memory, CPU, and process count.

**Workspace provider** — The registry entry naming what kind of context a run works in: `git_repo`, `document`, `issue_tracker`, `record`, or `api_only`. Each provider declares the connection types it can consume. A template names the provider it expects; a null value falls back to `git_repo`.

Sources: [packages/shared/src/prisma/schema.prisma:L888-L933](https://github.com/yorch/auto-swe/blob/b1d8930/packages/shared/src/prisma/schema.prisma#L888-L933) [packages/shared/src/lib/workflowId.ts:L1-L22](https://github.com/yorch/auto-swe/blob/b1d8930/packages/shared/src/lib/workflowId.ts#L1-L22) [packages/shared/src/prisma/schema.prisma:L1006-L1079](https://github.com/yorch/auto-swe/blob/b1d8930/packages/shared/src/prisma/schema.prisma#L1006-L1079) [packages/shared/src/workflow/spec.ts:L484-L512](https://github.com/yorch/auto-swe/blob/b1d8930/packages/shared/src/workflow/spec.ts#L484-L512) [packages/shared/src/prisma/schema.prisma:L1317-L1334](https://github.com/yorch/auto-swe/blob/b1d8930/packages/shared/src/prisma/schema.prisma#L1317-L1334) [packages/shared/src/prisma/schema.prisma:L1394-L1440](https://github.com/yorch/auto-swe/blob/b1d8930/packages/shared/src/prisma/schema.prisma#L1394-L1440) [packages/shared/src/prisma/schema.prisma:L1465-L1490](https://github.com/yorch/auto-swe/blob/b1d8930/packages/shared/src/prisma/schema.prisma#L1465-L1490) [packages/worker/src/activities/workspace.ts:L16-L45](https://github.com/yorch/auto-swe/blob/b1d8930/packages/worker/src/activities/workspace.ts#L16-L45) [packages/worker/src/activities/workspace.ts:L355-L380](https://github.com/yorch/auto-swe/blob/b1d8930/packages/worker/src/activities/workspace.ts#L355-L380) [packages/shared/src/lib/workspaceProviders.ts:L1-L28](https://github.com/yorch/auto-swe/blob/b1d8930/packages/shared/src/lib/workspaceProviders.ts#L1-L28)

## Related Pages

- Overview: [auto-swe Wiki](./README.md)
- Shared library: [@auto-swe/shared](./2-shared-library.md)
- Data model: [Data Model](./2.1-data-model.md)
- Workflow engine: [Workflow Spec and Interpreter](./2.2-workflow-spec-and-interpreter.md)
- Configuration: [Configuration and Settings](./2.3-configuration-and-settings.md)
- Agents: [Agent Layer](./4.3-agent-layer.md)
