# Adversarial review of the workflow-node fixes

> **Frozen.** The second of two adversarial passes over this work: `codex`
> (`gpt-6.1-sol`), run read-only against the `node-assessment-fixes` branch. The
> first, over the assessment itself, is
> [`workflow-nodes-assessment-adversarial-review.md`](./workflow-nodes-assessment-adversarial-review.md).
>
> **What it reviewed.** The eight commits of that branch: the shared governance
> and idempotency contract for external mutations, the four authoring/runtime
> contract corrections, and agent-node cost estimation.
>
> **What it changed.** Six of its must-fix findings were acted on before the
> branch was merged, each as its own commit:
>
> | Finding | Resolution |
> |---|---|
> | The MCP ledger changed the activity's result shape on a retry | The ledger holds the activity's result; the retry test round-trips through the mock |
> | Every MCP call was governed as a mutation, refusing reads | Classification comes from the protocol's `readOnlyHint` annotation, an unannotated tool still governed; the ledger is consulted before the approval guard |
> | The approval guard is matched to the run, not the action | Kept — it is what `writeOutcome` has always done and it is the conservative direction — but now stated in `autonomy-policies.md` §4.1 instead of implied |
> | A whitespace-only gate command still passed | Both resolvers treat whitespace-only as absent |
> | Docs promised "every mutation" and exactly-once retry deduplication | The boundary is named (an agent's own MCP calls are outside it) and the ledger described as completed-result caching, with the crash window stated |
> | "git push failed" overstated what the shell finalize reports | Reported as a finalize failure, without asserting which command failed |
>
> Plus three of its nice-to-haves: `candidateRef` is linted, the agent cost hint
> is pinned against the real registry, and the estimate's exclusions render even
> when the priced total is zero.
>
> **What was not acted on.** Its claim that the guard should identify the
> governed action explicitly is only partly addressed — the run-wide rule stays,
> because deriving a risk class from a tool call is not something the call can
> state (see `autonomy-policies.md` §4.1). The `(runId, nodeId, connectionId,
> attempt)` unique key it flags is unchanged.
>
> The review's own caveats hold: it read source without running tests, replay
> histories or gates, and it could not see the pull request body.

# Adversarial review: `node-assessment-fixes`

**Do not merge as written.** The MCP ledger changes the result shape on retry; the approval guard confuses unrelated actions; and several documentation claims promise guarantees the implementation does not provide.

This is a source review. I did not run tests, replay histories, or quality gates. No files were modified. I could not verify the PR’s actual title or body from the material available, so the breaking-change assessment below addresses the supplied description.

## 1. Must-fix findings

### 1.1 MCP retries return a different output than the original call

The first execution returns `{ result: remoteResult }`, but records only `remoteResult`. A retry reads that raw value and returns it directly as `McpCallToolResult`.

For a remote result `{ ok: 1 }`:

- First output: `{ result: { ok: 1 } }`
- Cached output: `{ ok: 1 }`

A downstream binding to `nodes.call.output.result` therefore stops resolving after a retry. Primitive results also violate the declared activity result shape.

Evidence: `packages/worker/src/activities/mcpCallTool.ts:71`, `:115`, `:117`, `:119`; `packages/worker/src/lib/externalWrite.ts:89`.

The new test hides this bug. Its mocked ledger returns an already-wrapped object that production never stores, and it does not assert the recorded `result` value. Evidence: `packages/worker/src/activities/mcpCallTool.test.ts:169`, `:184`, `:187`.

**Required fix:** store and return the same wrapper, and make the retry test read back the actual value submitted to `create`.

### 1.2 Approval is scoped to the entire run, not the action being attempted

`publishOutcome` evaluates a specific risk class and records it. `assertApprovalSatisfied` ignores that class when selecting both the policy decision and the approval.

Consequences:

1. A pending approval for one action blocks an unrelated MCP call—including a read such as `search_docs`.
2. Any later `approve` event can satisfy the guard, even when it approved a different human step.
3. A later `auto` decision for another risk class makes an earlier unsatisfied approval requirement disappear from this guard.

Evidence: `packages/worker/src/activities/publishOutcome.ts:33`, `:38`, `:53`; `packages/worker/src/lib/externalWrite.ts:55`, `:60`, `:64`. Human approval records contain run identity and payload, but this guard does not match them to a particular decision: `packages/gateway/src/lib/hitlResolve.ts:463`, `:490`.

For MCP, this check happens before connection or cache lookup. Even an already-recorded result can be refused after a subsequent unrelated policy decision. `runTool` and `writeOutcome` return their cached results before entering the approval check, so the three implementations also disagree on retry behavior. Evidence: `packages/worker/src/activities/mcpCallTool.ts:67`; `packages/worker/src/activities/genericActions.ts:477`, `:628`, `:658`.

**Required fix:** identify the governed action and its approval explicitly. A run-wide timestamp comparison is insufficient.

### 1.3 The ledger does not guarantee that retries cannot duplicate effects

The sequence is:

1. Read ledger.
2. Perform remote mutation.
3. Insert ledger row.

If the mutation succeeds and the insert fails, a retry repeats the mutation. Concurrent executions can also both observe no row and both perform the effect before either inserts.

Evidence: `packages/worker/src/activities/genericActions.ts:658`, `:662`, `:663`; `packages/worker/src/activities/mcpCallTool.ts:71`, `:115`, `:117`; `packages/worker/src/lib/externalWrite.ts:96`.

The unique constraint includes `attempt`, so different activity attempts are not mutually exclusive at the database level. Evidence: `packages/shared/src/prisma/schema.prisma:1882`.

This weakness existed in `writeOutcome`; extending it to arbitrary MCP mutations increases its scope. The new prose nevertheless describes retry deduplication as an unconditional guarantee. Evidence: `docs/autonomy-policies.md:114`; `docs/architecture.md:1253`.

**Required fix:** distinguish completed-result caching from guaranteed effect deduplication. Use provider idempotency where available; document the remaining uncertainty window rather than claiming exactly-once effects.

### 1.4 A whitespace-only standalone gate still passes without checking anything

`runGateStandalone` rejects falsy commands but accepts `'   '`. It then executes that whitespace as a shell command and treats exit zero as a pass.

The workflow gate resolver trims the step override before accepting it, but repository overrides also accept whitespace because they check only `.length`.

Evidence: `packages/worker/src/activities/standaloneGateRunner.ts:43`, `:57`, `:58`; `packages/worker/src/activities/qualityGates.ts:187`, `:196`.

Thus “fail a gate that has no command” remains bypassable with a semantically empty command, including an eval gate scorer.

**Required fix:** normalize commands consistently and test absent, empty, and whitespace-only values.

## 2. Correctness checks that did not falsify the implementation

### Connector tool classification

The complete implemented dispatch inventory is:

| Handler | Accepted tool strings | Classification |
|---|---|---|
| `gitRepoRunTool` | Every nonempty string; returns a placeholder | Only the two allowlisted names bypass governance |
| `zendeskRunTool` | `fetchTicket`, `postComment`; all others throw | Read / mutation respectively |
| `slackRunTool` | `postMessage`; all others throw | Mutation |
| `issueTrackerRunTool` | `createIssue`, `fetchIssue`; all others throw | Mutation / read respectively |
| `genericRunTool` for `http_api`, `hubspot`, `mcp`, `notion` | Every nonempty string; tool name is not passed to the handler; returns a placeholder | Two allowlisted names exempt; everything else governed |

Evidence: `packages/worker/src/activities/genericActions.ts:487`, `:508`, `:519`, `:533`, `:544`, `:556`, `:568`, `:583`, `:591`, `:594`, `:643`; input validation at `:618`.

The read allowlist is complete for the concrete read tools implemented here: `fetchTicket` and `fetchIssue`. There is no missing concrete read tool. However, classification uses only the name, not connection type, and placeholders that perform no mutation are conservatively classified as mutations. Evidence: `packages/worker/src/lib/externalWrite.ts:114`; `packages/worker/src/activities/genericActions.ts:623`.

### MCP connection identity

I found no URL-or-slug resolution path. The schema accepts a nonempty string, the interpreter passes it unchanged, the executor passes it unchanged, and `mcpUrlForConnection` queries `Connection.id`. An invalid reference returns no target before the remote tool executes.

Evidence: `packages/shared/src/workflow/spec.ts:271`; `packages/shared/src/workflow/interpreter.ts:702`; `packages/worker/src/workflows/runnableSteps.ts:271`; `packages/worker/src/lib/config/mcpConnection.ts:52`, `:106`; `packages/worker/src/activities/mcpCallTool.ts:77`.

**The premise about a Connection foreign key is incorrect:** `WorkflowOutcomeReference.connectionId` is a UUID column, but this model declares no relation to `Connection`. Its declared relation is to `WorkflowRun`. Evidence: `packages/shared/src/prisma/schema.prisma:1874`, `:1880`.

The MCP tests use `c1`, which cannot exercise the UUID-backed persistence path. Evidence: `packages/worker/src/activities/mcpCallTool.test.ts:180`.

### Second loop visits

A normal second visit does **not** collide with the first: the dispatcher supplies `node#2`. An `onFail.retry` retains the same visit identity deliberately. The schema’s unique key is `(runId, nodeId, connectionId, attempt)`, not the three-column key proposed in the question.

Evidence: `packages/worker/src/workflows/runnable.ts:210`, `:215`; `packages/shared/src/prisma/schema.prisma:1882`.

The ordinary loop-collision allegation is therefore unfounded. Concurrent attempts and the write-before-record window remain separate problems described above.

## 3. Failure semantics and consumers

### Unconfigured performance benchmarks

The new absent-command path returns `passed:false` and avoids workspace execution. Evidence: `packages/worker/src/activities/qualityGates.ts:218`, `:291`; `packages/worker/src/activities/standaloneGateRunner.ts:45`.

I found no concrete built-in/example `runPerfBench` node relying on the old pass. Its example occurrence is an expected registry-name entry, not an executable node. Evidence: `packages/shared/src/workflow/examples/qualityGates.spec.test.ts:17`.

The offline reference harness calls `runTests` with `goldenTest`, rather than an unconfigured benchmark. Evidence: `packages/worker/src/activities/evalRevalidate.ts:88`, `:92`, `:94`.

I could not verify deployed specs or external callers. The whitespace hole remains.

### Shell results

The relevant consumers are:

- Activity export and Temporal proxy: `packages/worker/src/activities/index.ts:223`; `packages/worker/src/workflows/runnableActivities.ts:100`.
- Workflow dispatch: `packages/worker/src/workflows/runnable.ts:183`.
- Generic interpreter failure policy, which detects any returned `passed:false`: `packages/shared/src/workflow/interpreter.ts:843`.
- Migration template, which uses `onFail:'warn'` and stores the summary: `packages/shared/src/workflow/templates/migration.ts:52`, `:61`.
- Shell example, which consumes `committedSha`; its `output.passed` condition belongs to `runBuild`, not the shell: `packages/shared/src/workflow/examples/shellStep.spec.ts:25`, `:29`, `:35`.
- Trace linkage maps the shell activity name; the trace UI’s explicit `output.passed` consumer is a `tdd.test_run` event, not a shell result: `packages/web/src/lib/traceLinkage.ts:27`; `packages/web/src/components/runs/TracesTab.tsx:68`.

I found no explicit shell-output condition whose meaning becomes incorrectly inverted. The intended behavior change occurs through the interpreter: finalization failure now triggers block/warn/retry handling.

**But “push failure” is too narrow.** Finalization can fail starting Docker, changing directory, sanitizing Git configuration, staging, committing, or reading metadata after a successful push. Every exception is labeled “git push failed” and becomes `persisted:false`.

Evidence: `packages/worker/src/activities/shellStep.ts:287`, `:294`, `:295`, `:302`, `:303`, `:342`, `:456`, `:478`, `:505`.

A no-change command can therefore fail because the finalization helper cannot start. A successful push can be reported as unpersisted if a subsequent command fails. Fail-closed behavior is defensible, but the asserted diagnosis is false.

Also, `onFail:'warn'` does not restore command-only `passed` semantics; it changes continuation policy. Evidence: `packages/worker/src/activities/shellStep.ts:79`; `packages/shared/src/workflow/interpreter.ts:843`.

## 4. Temporal and replay

Adding `nodeId` changes activity arguments, not activity type or command sequence. Adding an absent optional `candidateRef` likewise does not introduce an activity or timer. The replay test explicitly states that it does not compare activity arguments.

Evidence: `packages/worker/src/workflows/runnableSteps.ts:259`, `:273`, `:814`; `packages/worker/src/workflows/runnable.replay.test.ts:20`.

The recorder includes:

- An MCP node fixture: `packages/worker/scripts/recordReplayHistory.ts:385`.
- An eval fixture using an assert scorer, without `candidateRef`: `packages/worker/scripts/recordReplayHistory.ts:366`, `:374`.
- No `runTool` or `candidateRef` fixture in the recorder.

The replay suite discovers binary histories, rather than readable JSON fixtures. Evidence: `packages/worker/src/workflows/runnable.replay.test.ts:48`, `:54`.

**I could not verify the decoded contents or execution of those binary histories.** The recorder establishes intended coverage, not proof of their current contents.

A new optional data field does not inherently require a new control-flow fixture. Here the missing protection is an activity integration test proving that the resolved ref reaches workspace checkout. Re-recording existing histories would not test that argument correctly, given the suite’s stated limitation.

## 5. Test adequacy

| Change | Assessment |
|---|---|
| Missing gate command | New test detects reverting `runGate`; no corresponding standalone or whitespace regression test. `qualityGates.test.ts:112`; `standaloneGateRunner.ts:43`. |
| Agent pricing | The new test would **still pass if the production registry hint were reverted**: it supplies its own `runAgentNode` hint. `costEstimator.test.ts:41`, `:121`; production hint at `stepRegistry.ts:593`. |
| Cost exclusions | Arithmetic/exclusion tests exercise the helper, but do not verify editor rendering; zero estimates hide the entire tooltip. `costEstimator.test.ts:129`; `EditorActionBar.tsx:51`. |
| Eval candidate ref | Packing test detects reverting the interpreter change; it does not test executor forwarding or gate checkout. `interpreter.test.ts:132`; `runnableSteps.ts:259`; `runEvalNode.ts:192`. |
| Container entrypoint | Activity test and argv test detect their respective reversions. They mock execution and do not prove an actual image entrypoint runs. `containerStep.test.ts:46`; `ephemeralContainer.test.ts:59`. |
| Shell push verdict | Flipped assertions are meaningful because the mocked push actually throws. They detect reverting `passed`. They do not distinguish other finalization failures or failure after successful push. `shellStep.test.ts:124`, `:138`; `shellStep.ts:302`. |
| Tool governance | Mutation refusal/deduplication tests detect reverting governance. The new read-only test would **still pass with the old `runTool` implementation**. `genericActions.test.ts:253`, `:268`. |
| MCP ledger | New retry test fabricates a stored wrapper and misses the production mismatch. It also mocks away UUID persistence. `mcpCallTool.test.ts:169`, `:180`, `:187`. |

The candidate-ref test also leaves the new binding out of validation coverage: `nodeBindings` enumerates `eval.target` but not `eval.candidateRef`. A mistyped candidate binding passes this lint surface. Evidence: `packages/shared/src/workflow/validateSpec.ts:85`.

## 6. Documentation verification

### `docs/autonomy-policies.md` §4.1

- **Overstated:** “every step” and “cannot happen.” Agent-bound MCP tools execute through a separate wrapper without this guard or ledger. Evidence: `docs/autonomy-policies.md:103`; `packages/worker/src/agents/mcpTools.ts:233`, `:243`.
- **Correct description of the implemented guard:** latest run-wide publish decision, absent-decision exemption, two connector read exemptions. Evidence: `docs/autonomy-policies.md:107`; `packages/worker/src/lib/externalWrite.ts:55`, `:60`, `:114`.
- **Overstated retry guarantee:** the remote-effect/ledger-write gap and MCP result-shape bug contradict it. Evidence: `docs/autonomy-policies.md:114`; `mcpCallTool.ts:115`, `:117`.
- **Understates sandbox limitations:** the egress allowlist does not block direct-IP connections; wildcard entries are informational. Evidence: `docs/autonomy-policies.md:118`; `packages/worker/src/lib/ephemeralContainer.ts:152`.

### `docs/architecture.md` §10

- Successful `set`, `cond`, and `terminate` paths do not record steps: verified. `docs/architecture.md:1035`; `interpreter.ts:488`, `:507`.
- Analytics skips the stated statuses and groups by literal node ID: verified. `docs/architecture.md:1037`; `packages/shared/src/workflow/analytics.ts:94`, `:157`.
- Five types lack configuration forms: verified. But the inspector displays a notice directing users to JSON mode, not raw JSON itself. `docs/architecture.md:1040`; `NodeInspector.tsx:85`, `:226`.
- Branch recomputation is overstated as universal. Explicit branch overrides and `codeResult.branch` take precedence. A changed prefix only causes refusal if checkout fails; an existing wrong branch can still be checked. `docs/architecture.md:1045`; `qualityGates.ts:245`, `:269`; `shellStep.ts:389`; `ciVerify.ts:158`.
- The later external-mutation ledger claim has the same scope and deduplication overstatements as §4.1. `docs/architecture.md:1253`; `externalWrite.ts:96`; `agents/mcpTools.ts:243`.

### `docs/hitl-workflows.md`

- Missing approver-count lint and fallback-to-one behavior are verified, but “the one binding” is now false because `candidateRef` is also omitted. `docs/hitl-workflows.md:415`; `validateSpec.ts:85`; `interpreter.ts:36`.
- “Anything that is not a positive integer” is imprecise: numeric strings are converted with `Number`. `docs/hitl-workflows.md:417`; `interpreter.ts:37`.
- Missing human configuration forms are verified. `docs/hitl-workflows.md:421`; `NodeInspector.tsx:91`.

### `docs/bundles.md`

The save-time gap is supported: bundle template validation parses schemas and checks validation errors; canvas persistence invokes authoring/image checks and writes audit records. Runtime container image checking remains present.

Evidence: `docs/bundles.md:196`; `packages/shared/src/bundle/index.ts:520`, `:527`; `packages/gateway/src/routes/workflowTemplates.ts:187`, `:752`; `packages/worker/src/activities/containerStep.ts:73`. Platform-admin restriction is defined at `packages/gateway/src/routes/bundles.ts:173`.

### `docs/evals.md`

- Default branch and candidate binding behavior: verified. `docs/evals.md:77`; `interpreter.ts:683`; `runEvalNode.ts:192`.
- **Wrong:** naming `baseBranch` does not generally change the implementation’s destination branch. It changes the base from which that work branch is created. `docs/evals.md:90`; `executeImplementation.ts:133`, `:141`, `:145`.
- **Wrong guarantee:** scoring the wrong branch does not necessarily fail. If that branch exists and its tests pass, the scorer passes while verifying unrelated code. `docs/evals.md:91`; `runEvalNode.ts:195`, `:208`.

## 7. Breaking-change accounting

The four runtime contract corrections appear to be missing-command gates, candidate branch selection, commandless containers, and shell persistence verdicts. The **additional behavior change is governance of mutating `runTool` and every MCP call**, including MCP reads and cached reads.

Evidence: `externalWrite.ts:114`; `genericActions.ts:629`; `mcpCallTool.ts:67`.

Candidate-ref support is additive: an existing spec without the field retains its prior default branch selection. It is not intrinsically a breaking behavior change. Evidence: `interpreter.ts:683`; `runEvalNode.ts:192`.

Shell behavior changes on **all finalization exceptions**, not merely failed pushes. That broader scope must be disclosed. Evidence: `shellStep.ts:456`, `:505`.

I could not verify whether the actual PR body already includes these distinctions.

## Ranked required fixes

**Must-fix before merge**

1. **Preserve the MCP result wrapper across retries and test actual ledger round-tripping.** `packages/worker/src/activities/mcpCallTool.ts:117`; `mcpCallTool.test.ts:169`.
2. **Scope policy decisions and approvals to the governed action; cover unrelated risk classes, unrelated approvals, and cached MCP results.** `packages/worker/src/lib/externalWrite.ts:55`, `:64`; `mcpCallTool.ts:67`.
3. **Reject whitespace-only gate commands consistently.** `packages/worker/src/activities/standaloneGateRunner.ts:43`; `qualityGates.ts:196`.
4. **Remove unconditional “every mutation” and retry-deduplication guarantees, or implement the promised coverage and guarantees.** `docs/autonomy-policies.md:103`, `:114`; `packages/worker/src/agents/mcpTools.ts:243`; `externalWrite.ts:96`.
5. **Correct the eval documentation’s base-branch and wrong-branch claims.** `docs/evals.md:90`; `packages/worker/src/activities/executeImplementation.ts:133`; `runEvalNode.ts:208`.
6. **Report finalization failures accurately and disclose their full behavior-change scope.** `packages/worker/src/activities/shellStep.ts:456`, `:478`.

**Nice-to-have**

7. Add candidate-ref binding lint and an activity test asserting the checkout branch. `packages/shared/src/workflow/validateSpec.ts:85`; `packages/worker/src/activities/runEvalNode.ts:192`.
8. Test the real registry cost hint; always disclose retry exclusions; show exclusions when the priced total is zero. `costEstimator.test.ts:41`; `costEstimator.ts:240`; `EditorActionBar.tsx:51`.
9. Replace “upper-bound” and “each agent’s model price” with an honest proxy-estimate description. `packages/shared/src/workflow/stepRegistry.ts:587`; `packages/web/src/components/workflow/templateEditor/EditorActionBar.tsx:56`.