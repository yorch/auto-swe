# Workflow node assessment

> **Frozen.** Written 2026-10-14 against `b3ea227f`, and kept for the reasoning rather than as a
> description of the system: `docs/history/` is never updated, so **read the code for current
> behaviour and the living docs for current limitations**.
>
> Its adversarial review is kept beside it at
> [`workflow-nodes-assessment-adversarial-review.md`](./workflow-nodes-assessment-adversarial-review.md).
> That review falsified several v1 claims; §1 records the corrections, and the withdrawn
> recommendations are marked as such in §6.
>
> **What landed.** Three of §8's ten steps shipped in the same change set, as its own commits: the
> shared governance + idempotency contract for external mutations (§8 step 1), the four
> authoring/runtime contract defects (§8 step 2), and agent-node cost estimation with the estimate's
> exclusions surfaced (§8 step 3). The still-true limitations among the remaining steps were
> promoted into the living docs — `architecture.md` §10, `hitl-workflows.md` §Limitations,
> `bundles.md` §Limitations. Steps 4–10 are **not** implemented: the missing HITL/eval editor forms,
> control-flow recording and fan-out analytics, the duplicate step-name spelling, `runQualityGates`,
> `waitForCi`, `callWorkflow`/`httpRequest`/`notify`, and the fate of the unexercised steps.
>
> **What this cannot tell you.** Every usage figure is static. "Unused" means unused by shipped
> content, not unused by deployments (§9).

Point-in-time review of the workflow node surface: what should be consolidated, split, removed, or
added.

**This is v2.** v1 was put through an adversarial review (`codex`, `gpt-6.1-sol`, run read-only
against this worktree); the review is kept verbatim beside this file. It falsified several claims in
v1, and the corrections are consequential enough that v1's rankings do not survive. §1 records what
changed and why, so the numbers here can be trusted and the withdrawn claims are not resurrected.

---

## 1. What v1 got wrong

| v1 claim | Reality | Effect |
|---|---|---|
| `shell` and `containerStep` are the same primitive, container being more expressive | **False.** `shell` checks out the run's repository, commits, pushes, records lessons (`worker/src/activities/shellStep.ts:384-401`, `:438-489`). `containerStep` runs against a throwaway empty volume (`worker/src/activities/containerStep.ts:103-137`). | The v1 §5.3 consolidation is **withdrawn**. |
| Five node types are typed front-ends for a step | Four (`agent`, `eval`, `mcp`, `containerStep`). `shell` has its own `Dispatcher.dispatchShell` method and an activity that is not a registered step name. | Corrected in §2. |
| `set`/`cond`/`terminate` and `signal` can never appear in failure-rate analytics | **False.** The walk catch records their exceptions as `FAILED` (`interpreter.ts:542-551`), and received signals record `PASSED` (`:1007`). Only *successful* control-flow nodes and *timed-out* signals are absent. | Reframed in §4. |
| The usage census | **Contaminated.** v1's glob swept `.test.ts` files. Test-excluded counts are materially lower (§3). | Counts corrected. |
| The `examples/` specs have no importer | **False** — `shared/src/workflow/fanOutSpecs.execution.test.ts` imports two of them and asserts branch-output binding. "No production importer" is the defensible claim. | §6.3 softened. |
| `agent` nodes are priced as `runAgentNode` | The lookup happens, but `runAgentNode` has **no `costHint`** (`stepRegistry.ts:567-589`) — so every declarative `agent` node estimates **$0**. | New finding, §5.1. |
| `specRefValidation` is MCP-only | It checks `agent` refs and `mcp` refs (`gateway/src/lib/specRefValidation.ts:46-55`). | Corrected. |
| MCP is "the only way a workflow reaches an MCP server" | An implementer agent can bind MCP tools too (`worker/src/agents/implementer.ts:203-208`). | Corrected. |
| Refusing raw executor step names closes a gateway shell-gate bypass | The gate is already closed: `collectShellNodes` explicitly covers `step` with `category === 'shell'` (`gateway/src/lib/specCheck.ts:29-62`). | Reframed as hygiene, not security, in §6.4. |
| `policy`/`pii` eval scorers are "soft" | They are **floor** (`worker/src/lib/scorerCombination.ts:30-37`, `FLOOR_KINDS = {gate, assert, policy, pii}`). | v1's eval split was mis-drawn; **withdrawn** (§6.6). |
| `humanInput` has an optional `contextFrom` | It does not (`spec.ts:583-593`); `humanReview` has a **required** `contentFrom` (`:598-608`). The gateway validates the two payload shapes differently (`gateway/src/lib/hitlResolve.ts:153-235`). | v1 §5.1 withdrawn as a *type merge*; see §6.5 for what survives. |
| Unifying the two `WORKFLOW_PATH_RE` regexes is "a straight bug" | They answer different questions: one guards the whole `.github/workflows|actions` directory, the other validates a readable workflow YAML path. | **Withdrawn** (§6.7). |
| "Eleven of fifteen types are exercised" | Twelve (`step`, `set`, `cond`, `terminate`, `humanApproval`, `humanDecision`, `humanInput`, `humanReview`, `agent`, `signal`, `fanOut`, `shell`); three have no shipped spec (`mcp`, `eval`, `containerStep`). | Corrected. |
| `publishOutcome` publishes the Zendesk reply | It resolves the autonomy policy and writes an `AutonomyDecision` row; it makes no connector write (`worker/src/activities/publishOutcome.ts:22-63`). The Zendesk template is a single `agent` node. | Use-case table corrected. |
| Every changed node count needs edits to four named docs | Only `docs/architecture.md` and `docs/product-overview.md` carry the numeric claim; `docs/concepts.md` describes types without counting. | §7 corrected. |

I also accept the review's substantive additions, which are folded in as §5 (execution-contract
defects) and §5.6 (bundle portability) — they outrank everything v1 proposed.

**What survived unchanged:** the inventory, the "three node types have zero shipped usage" finding,
the shell-family gateway gating as the only per-type gate, the ignored-field asymmetry, the missing
editor forms, the fan-out signal-name bug, and the `waitForCi` idiom.

---

## 2. Inventory

Two things are called a "node", and both are in scope:

| Layer | Definition | Count |
|---|---|---|
| **Declarative node type** | A member of the `NodeSchema` discriminated union, `shared/src/workflow/spec.ts:610-626` | 15 |
| **Step** | A name in `BUILTIN_STEPS`, `shared/src/workflow/registry-types.ts:53-112`, selected by a `step` node's `step` field | 45 registered, 44 author-visible (`runAgentTask` is `internal: true`) |

### 2.1 The 15 types

| Type | Schema | Dispatch | Nature |
|---|---|---|---|
| `step` | `spec.ts:215` | `dispatchStep(node.step, node.config)` | the activity primitive |
| `agent` | `spec.ts:237` | `dispatchStep('runAgentNode')` | typed front-end over a step |
| `mcp` | `spec.ts:268` | `dispatchStep('mcpCallTool')` | typed front-end over a step |
| `eval` | `spec.ts:306` | `dispatchStep('runEvalNode')` | typed front-end over a step |
| `containerStep` | `spec.ts:492` | `dispatchStep('runContainerStep')` | typed front-end over a step |
| `shell` | `spec.ts:443` | **`dispatchShell`** | its own dispatcher method + activity, *not* a registered step |
| `set` | `spec.ts:324` | `runSet`, in-isolate | context write |
| `cond` | `spec.ts:331` | `runCond`, in-isolate | 2-way branch |
| `signal` | `spec.ts:339` | `waitSignal` + `recordStep` | external wait |
| `terminate` | `spec.ts:349` | `runTerminate`, in-isolate | run exit |
| `fanOut` | `spec.ts:391` | recursive `walk` | parallel map over a subgraph |
| `humanApproval` | `spec.ts:538` | `runHumanNode` | N-of-M vote |
| `humanDecision` | `spec.ts:560` | `runHumanNode` | N-way choice |
| `humanInput` | `spec.ts:583` | `runHumanNode` | typed form |
| `humanReview` | `spec.ts:598` | `runHumanNode` | content review |

Structural vocabulary: **one dispatch primitive, one sandbox primitive, five control-flow
primitives, four human primitives** — plus four typed sugar types over `step` and one (`shell`) that
is a second, method-level dispatch path.

### 2.2 The 45 steps

| Group | Steps |
|---|---|
| Core SWE | `validateContext`, `executeImplementation`, `runReviewNetwork`, `createOrUpdatePullRequest`, `commitToMemory`, `updateDomainState` |
| Fix loop | `executeReviewFixImplementation`, `executeCIFixImplementation`, `executeGateFixImplementation` — three adapters over `runImplementerFixSession` (`worker/src/activities/implementerSession.ts:134`) |
| Quality gates | `runLint`, `runTypecheck`, `runTests`, `runBuild`, `runVulnScan`, `runPerfBench` — six names over one `runGate` (`worker/src/activities/qualityGates.ts:262`) |
| CI triage | `triageCiFailure`, `reportCiTriage`, `pushCiFixToPullRequest`, `finishCiFixPush`, `verifyCiFix` |
| CI wait | `resolveCiWaitConfig`, `waitForCiByPolling` |
| Branch merging | `mergeBranches`, `resolveMergeConflict` |
| Planning | `planDecomposition`, `planChannelTask`, `runChannelSubtasks` |
| PRD | `analyzePrd`, `decomposePrd`, `createTrackerItems`, `submitPrdWorkRequests` |
| Generic non-SWE | `resolveWorkspace`, `readSource`, `writeOutcome`, `publishOutcome`, `runTool` |
| Knowledge | `retrieveKnowledge`, `captureLearning` (same `lib/knowledgeRuntime` as the agent tools `searchKnowledge`/`submitLearning`) |
| Helpers | `listProviderModels`, `fetchCILogs` |
| Node back-ends | `runAgentNode`, `runEvalNode`, `mcpCallTool`, `runContainerStep` — also authorable as raw `step` names |
| Internal | `runAgentTask` |

---

## 3. Usage census (test files excluded)

Over `shared/src/workflow/templates/**` (including the authoring helpers that expand into nodes),
`defaultEngineeringSpec.ts`, and `examples/**`, excluding `*.test.ts`:

| Type | Nodes | Notes |
|---|---|---|
| `step` | 90 | the workhorse |
| `set` | 59 | |
| `cond` | 43 | |
| `terminate` | 15 | |
| `humanApproval` | 8 | four-eyes, full-supervised, migration, pr-approval-gate, tiered-escalation |
| `agent` | 7 | create-issue-from-brief, notion-content-draft/brand-review, product-prd-draft, zendesk-ticket-reply |
| `fanOut` | 4 | parallel-fan-out, consensus-review, examples |
| `humanDecision` | 4 | full-supervised, human-code-review, security-triage, tiered-escalation |
| `humanReview` | 4 | full-supervised, human-code-review, prd-decomposition ×2 |
| `signal` | 3 | `default-engineering` (`humanMergeSignal`), canary + signal-gated rollout |
| `humanInput` | 3 | four-eyes, full-supervised, scope-clarification |
| `shell` | 2 | migration (built-in), `examples/shellStep.spec.ts` |
| **`mcp`** | **0** | |
| **`eval`** | **0** | |
| **`containerStep`** | **0** | |

Steps with no node in any spec: `runTool`, `retrieveKnowledge`, `captureLearning`. `planDecomposition`
and `runPerfBench` appear only in `examples/` **test expectations**, not as nodes; `runBuild` appears
as a real node in two example specs. The `examples/` specs *are* imported — by
`shared/src/workflow/fanOutSpecs.execution.test.ts` and their own co-located tests — which is what
keeps them (and the steps above) looking covered.

**The headline: 15 types, 12 with shipped usage, 3 with none; 45 steps, at least 4 with no node
anywhere.** Absence here means *unproven in shipped content*, not *unnecessary* — but it is the
reason the vocabulary feels larger than the behaviour behind it.

---

## 4. Use cases, mapped

From `docs/product-overview.md` §5 and `BUILTIN_TEMPLATES` (`shared/src/workflow/templates/index.ts`).
Workspace providers: `git_repo`, `document`, `issue_tracker`, `record`, `api_only`
(`shared/src/lib/workspaceProviders.ts:12`). Connection types: `git_repo`, `issue_tracker`, `notion`,
`zendesk`, `hubspot`, `slack_workspace`, `http_api`, `mcp` (`shared/src/lib/connectionTypes.ts:13`).

| # | Use case | Nodes used | State |
|---|---|---|---|
| U1 | Ticket → reviewed PR (`default-engineering`) | step, set, cond, signal, terminate | proven path |
| U2 | Multi-repo epic | `EpicOrchestratorWorkflow` + `planEpic` activity — **not** a spec | no composition node |
| U3 | HITL gates | all four human types | 5 of 15 types have no editor form |
| U4 | CI self-healing | `signal` or `waitForCiByPolling` + `cond` + `set` + triage steps | 5-node idiom for one concept |
| U5 | Semantic memory | `commitToMemory`; knowledge steps unused | authorable, unexercised |
| U6 | Template authoring / versioning / A-B | platform surface | — |
| U7 | Scheduled requests | trigger | — |
| U8 | Channel teammate | `CHANNEL_TASK_SPEC`: `planChannelTask` → `cond` → `runChannelSubtasks` | fan-in inside one activity |
| U9 | Quality gates | 6 gate steps | one workspace provisioned **per gate** |
| U10 | Dependency sweep / model catalog refresh | `listProviderModels` + step/cond | — |
| U11 | Notion content + brand review | `agent` + `readSource`/`writeOutcome` | seeded, not proven |
| U12 | Zendesk ticket reply | one `agent` node; `publishOutcome` → `writeOutcome` where governance is wanted | seeded, not proven |
| U13 | Issue tracker create | `agent` + `runTool`/`writeOutcome` | seeded, not proven |
| U14 | PRD → tracker items → runs | `analyzePrd`, `decomposePrd`, `createTrackerItems`, `submitPrdWorkRequests` | bespoke child-run launch |
| U15 | Slack update | `writeOutcome` / `runTool` (governed by the autonomy policy) | seeded |
| U16 | Evals | `eval` | no template, no form |
| U17 | Bundle coded capabilities | `containerStep` | the SDK extension point, no template |
| U18 | MCP-driven automation | `mcp` node, or an agent with MCP tools | no template |
| U19 | Operational shell steps | `shell` | one template |

---

## 5. Execution-contract defects (ranked above every vocabulary question)

These are the findings I would act on first: each is an executable discrepancy today, not a
structural preference.

### 5.1 A declarative `agent` node estimates $0

`costEstimator` prices `agent` via `stepLookup('runAgentNode')` (`costEstimator.ts:123-131`), but
`runAgentNode` is registered with **no `costHint`** (`stepRegistry.ts:567-589`). Built-in agent nodes
therefore contribute zero to a template's estimated cost — while an actual agent node can loop over
many LLM calls (`worker/src/activities/runAgent.ts:43-51`). The estimator also cuts cycles at a
back-edge (`costEstimator.ts:83-101`), uses a fixed fan-out width of 4 (`:80`, `:155-156`), and never
multiplies by `onFail.retry` (`:115-144`), so retry-heavy specs under-report too. Separately, unknown
models are priced at $0 (`worker/src/lib/costTracking.ts:515`), so USD budgets are blind to them.

Fix: give `runAgentNode` a cost hint (or price `agent` from the resolved `AgentRef`'s model where the
scope allows), and state plainly in the editor that the estimate excludes retries, cycles and
container time. Splitting a node type changes none of this.

### 5.2 Governance is not a property of "write to an external system" — it depends which step you pick

`writeOutcome` checks recorded approval decisions and uses an outcome ledger
(`worker/src/activities/genericActions.ts:420-437`, `:464-513`). `runTool` can post to Zendesk
directly without that check and without a ledger identity (`:549-561`), and its dispatcher supplies
no node/visit identity (`worker/src/workflows/runnableSteps.ts:807-813`). `writeOutcome` also permits
a run with **no** recorded policy decision at all (`:415-427`) — so the policy-gated write is an
authoring convention (`templates/authoring/policyGatedWrite.ts:25-42`), not a universal mutation
boundary.

This is the single most important node-surface defect: **whether an autonomous run's external write
is governed depends on which step the author chose.** Any new outbound node (`tool`, `httpRequest`,
`notify`) multiplies it unless the contract is fixed first.

### 5.3 External-effect retries have no idempotency contract

`mcpCallTool` performs a remote mutation and returns; it has cancellation handling but no outcome
ledger (`worker/src/activities/mcpCallTool.ts:75-85`). Connector-tool mutations are in the same
position (`genericActions.ts:636-665`). A successful remote write followed by an activity failure can
therefore be repeated on retry. The remote system may supply its own idempotency; nothing enforces or
documents that. New node contracts must state retry/idempotency semantics explicitly.

### 5.4 `containerStep`'s published contract contradicts its runtime in two ways

- **`command` is optional in the schema** ("defaults to the image entrypoint", `spec.ts:494-495`) but
  **required at runtime** for `stdout`/`ndjson` (`containerStep.ts:59-62`). The SDK helper
  `defineContainerStep` (`packages/sdk/src/index.ts:34`) exposes that optional type, so a bundle can
  pass structural validation while shipping a node that cannot run in its default transport.
- **A stateless capability still requires a repository identity**: `requireRepoId(input.request,
  'containerStep')` (`containerStep.ts:65-73`) resolves the governing connection/team. For a
  `document`, `record`, `issue_tracker` or `api_only` workspace (`workspaceProviders.ts:31-59`), a
  container step may have no repo id at all. I have not proven every non-git case fails, but the seam
  is repository-shaped, and it is the extension point the horizontal verticals are supposed to use.

### 5.5 `shell` can report `passed: true` after its push failed

`passed` is `exitCode === 0 && !signal` (`shellStep.ts:425`); finalize errors are swallowed and
reported in the summary while `passed` stays true (`:82`, `:96`, `:453`). The interpreter only blocks
on top-level `passed === false` (`interpreter.ts:840-841`). A template that treats `passed` as
"the change landed" is wrong — and this is precisely the migration/autonomous case where it matters.

### 5.6 An unconfigured `runPerfBench` passes

`DEFAULT_COMMANDS.runPerfBench = null` (`qualityGates.ts:97`) and the no-command path returns
`passed: true` (`:266-271`). A gate that cannot fail is worse than no gate.

### 5.7 The quality-gate example's fix loop is unreachable

`examples/qualityGates.spec.ts:94-96` gives `runLint` `next: 'checkLint'` **and**
`onFail: { retry: 1 }`. With a `retry` mode the interpreter takes `terminalBlock` after the attempts
are exhausted and **throws** (`interpreter.ts:946-963`), so `checkLint` is never reached. The
example's own header comment says the opposite. The example contributes to test coverage while
encoding a routing pattern that cannot work.

### 5.8 Control-flow nodes are under-recorded, and fan-out splits one node's rate

`set`, `cond` and `terminate` write a `workflow_steps` row only when they throw
(`interpreter.ts:542-551`; `SELF_RECORDING_NODE_TYPES` at `:739-742` governs duplicate *failure*
recording, not success recording). Combined with analytics skipping `PENDING`/`RUNNING`/`SKIPPED`
(`analytics.ts:94`, `:153-162`), the nodes that decide a run's shape are largely absent from the
per-step table. Fan-out compounds it: branches record `fan[0]/impl`, `fan[1]/impl` as distinct
node ids, splitting one node's failure rate across branches. This is a recording/analytics fix, not a
node-type one.

### 5.9 `humanApproval.approverCount` is the one unlinted binding

`nodeBindings` enumerates `inputs`, `set.values`, `eval.target`, `fanOut.over`, `terminate.result`
(`validateSpec.ts:69-95`) — not `approverCount` (`spec.ts:540`). A typo'd path silently resolves to
`undefined`, and `normalizeApproverCount` turns that into **1 approver** (`interpreter.ts:36-42`), so
a four-eyes gate silently becomes a one-approver gate. `humanReview.contentFrom` and
`eval.scorers[].assert.expr` (same grammar as `cond`) are also never syntax-checked.

### 5.10 Bundle portability for node references is unresolved

`mcp` nodes reference a deployment connection UUID (`spec.ts:270-271`) and `agent` nodes a
scope-relative key. Bundle validation parses the graph but does not resolve or remap those references
(`shared/src/bundle/index.ts:504-532`; advisory UUID checks at `gateway/src/lib/specRefValidation.ts:79-88`).
A signed portable bundle therefore cannot carry a working `mcp` node across deployments. Adding a
sample MCP template would not fix that; environment binding or install-time remapping would.

### 5.11 The recording gates that *do* exist

Worth stating so §5 is not read as "nothing is governed": the shell family is gated on authoring RBAC
**and** image allowlist **and** audit, and the raw-`step` spelling is covered
(`gateway/src/lib/specCheck.ts:29-62`, `:73-111`, `:113-150`); `runAgentTask` is refused everywhere
but the system template (`:242-254`); and a bundle install requires platform ADMIN
(`gateway/src/routes/bundles.ts:173`, `:232`). The bundle gap is that install validates with
`validateBundleTemplates` and never calls `collectShellNodes`, so a bundle can persist a shell-family
spec with no `WorkflowShellAudit` row — a save-time consistency gap, not an escalation, since runtime
still re-checks the image (`shellStep.ts:364-377`, `containerStep.ts:65-73`).

---

## 6. Structural recommendations — what survives scrutiny

### 6.1 Keep the 15 types. The cost of a type is not its definition; it is its overlap set.

The reason node count feels high is three types with zero shipped usage and four sugar types over
`step` — not that any type is redundant. Every merge candidate examined in v1 turned out to carry a
real semantic difference (@§1, and the review's verdicts at
[`workflow-nodes-assessment-adversarial-review.md`](./workflow-nodes-assessment-adversarial-review.md) §2). The
work that is genuinely worth doing at the *type* level is narrow and is listed below; everything else
belongs in contracts and tooling.

### 6.2 Batched quality-gate execution — as a **step**, not a node type (agree, modified)

Real and measurable: each configured gate provisions and destroys its own workspace
(`qualityGates.ts:262-274`), so lint + typecheck + tests clones three times. But the review is right
that batching changes isolation (lint/build commands may mutate the tree, making later checks
order-dependent) and widens retry scope (one failed activity re-runs the successful commands,
altering trusted evidence).

Do this as an **optional step** — `runQualityGates` with `gates: [{name, command?, timeoutMs?}]`,
`isolation: 'shared' | 'per-gate'` defaulting to `per-gate` — so no stored spec changes, per-gate
results stay addressable, and the payoff can be measured before it becomes the default. It does not
enlarge the node union.

### 6.3 Decide the fate of the unexercised steps, with the examples published rather than deleted

| Step | Finding | Recommendation |
|---|---|---|
| `runBuild` | real node in two example specs | keep |
| `runPerfBench` | never a node; only an expected-name string; **and** passes when unconfigured | keep the name, fix §5.6, require configuration for newly authored nodes, represent legacy no-op results explicitly |
| `planDecomposition` | never a node; `parallel-fan-out` hardcodes three subtasks instead (`templates/parallelFanOut.ts:90-108`) | do **not** silently swap the fixed roles for an LLM decomposition (it changes reproducibility, cost, branch ids and merge-conflict exposure). Add a separate dynamic example, or remove it and `agents/decomposer.ts` |
| `retrieveKnowledge` / `captureLearning` | never a node; the same runtime is behind two opt-in agent tools | keep **both** front doors — workflow authors and agents are different consumers — and document when to use which |
| `runTool` | never a node, but it performs real Zendesk/Slack/issue-tracker calls | keep; document its supported tools **and** close §5.2 first, or it is the ungated write path |
| `examples/*.spec.ts` | imported by `fanOutSpecs.execution.test.ts`; one contains an unreachable loop (§5.7) | publish them as a cookbook the docs site renders, and fix §5.7 — deleting them discards real branch-binding coverage |

### 6.4 Close the duplicate spelling to authors, as guidance rather than a ban (agree, modified)

`runAgentNode`, `runEvalNode`, `mcpCallTool` and `runContainerStep` are each reachable as a typed node
*and* as a raw `step`. The interpreter must keep accepting both — it dispatches through those names.
For authors, the OAuth-style pattern applies: one canonical spelling, with a `validateSpec` warning
(not an error, and not enforcement) pointing at the typed node. Two reasons not to make it an error:
the shell gate already covers the dangerous case (`specCheck.ts:29-62`), and the raw `step` form is
today the only way to get a metadata-driven config form for eval — removing it before the typed
`eval` node has a form would remove the only way to configure the node.

### 6.5 Do not merge the human node types; do build their missing forms once

The interpreter shares one code path (`runHumanNode`), but the **resolution protocols are genuinely
different** and live in the gateway: `REVIEW` takes a bounded string, `INPUT` takes an object keyed by
the configured field keys, `DECISION` takes one of the configured option values, and `APPROVAL` has
atomic distinct-approver accumulation (`gateway/src/lib/hitlResolve.ts:153-235`, `:290-300`,
`:337-429`). Stored `WorkflowHumanStep.kind`, the inbox, Slack rendering and the replay fixtures all
key on the kind. Merging the types would relocate that complexity into configuration while breaking
all four.

What is actually wrong is that **none of the four has an editor form** (`NodeInspector.tsx:85-101`),
so a decision option or an input field cannot be added from the canvas at all. Build *one* shared
HITL inspector section that renders per-kind fields, keep the four types, and add the missing lint
(§5.9).

### 6.6 Do not split `eval`; fix its cost and its form

`FLOOR_KINDS = {gate, assert, policy, pii}` and the soft axes are `trajectory`/`judge`, combined by
`combineScores` (`worker/src/lib/scorerCombination.ts:30-78`); the per-axis rows are the system of
record and the aggregate is explicitly a branch convenience (`worker/activities/runEvalNode.ts:68-73`).
Splitting the node would cut across that design, change `EvalResult` grouping and short-circuit
semantics, and touch stored specs and eval replay fixtures. The two real defects are narrower: the
estimate charges a judge call unconditionally (`costEstimator.ts:136-144`; §5.1), and the node has no
form. Fix those.

### 6.7 Keep `signal`, keep `fanOut` whole, keep `set` and `updateDomainState` apart

- `signal` vs the human nodes is layering, not duplication (wait-and-bind vs notify-validate-resolve).
- `fanOut`'s map + result lifting + bounded pool + cancellation is one coherent unit; its branch
  results, `exports` and `pluck` are already exposed at the join (`interpreter.ts:1367-1384`), so the
  "the interpreter cannot surface branch text" narrative in `docs/channel-assistant.md:107` is **stale**
  and should be corrected in the docs (see §6.8).
- `set` writes run context; `updateDomainState` writes the domain-visible `ActiveWorkflow.currentStatus`.
  A shared *visual* bookkeeping fold is not a runtime abstraction.
- The two `WORKFLOW_PATH_RE` definitions guard different things; rename them by purpose rather than
  unifying them.

### 6.8 Correct the drifted rationale, and note that consolidation changes `maxTransitions`

`interpreter.ts:336-338` counts every visited node across nested branches. Replacing five graph nodes
with one node changes how much work the same pinned limit permits, so **any consolidation in this
document is a governance change, not only a schema change**, and needs a work-expansion argument
alongside its codemod. Two smaller items in the same family: pinned settings cover transitions and
fan-out concurrency only (`interpreter.ts:350-367`) while activities still resolve current
`WorkflowDefaults` (e.g. `qualityGates.ts:214-221`, `shellStep.ts:380-381`), and `runEvalNode`
reconstructs a ticket branch rather than accepting an explicit candidate branch/SHA
(`runEvalNode.ts:180-191`) unlike ordinary gates (`qualityGates.ts:209-221`).

---

## 7. New primitives — needed, but with contracts, not just schemas

Each of these fills a real gap; each also needs the §5 governance and idempotency contract decided
first, or it becomes another ungated write path.

| # | Primitive | Why | Contract it must carry |
|---|---|---|---|
| 1 | **`waitForCi` / `waitForCondition`** | the poll-or-signal idiom is four nodes plus a `set` remap, and the poll activity returns `ciPassed` rather than `passed` precisely to dodge the interpreter's gate branch (`waitForCiByPolling.ts:49-54`). Note the review's correction: the idiom is already centralized as an authoring helper (`templates/authoring/ciLoop.ts:23-84`), so the gain is in the *stored spec* and the editor, not in removing copy-paste | signal registration, timeout, cancellation, and the CI-vs-generic question answered (prove a CI-specific primitive first) |
| 2 | **`runQualityGates`** (step) | §6.2 | isolation mode, per-gate evidence/branch identity, selective re-run semantics |
| 3 | **`callWorkflow`** | three bespoke child-launch mechanisms exist: `submitPrdWorkRequests`, the channel's `delegateTask` intent → `startChild`, and `EpicOrchestratorWorkflow` | child identity, template/version pinning, repo + team access checks, parent-close policy, cancellation, budget attribution. A fire-and-forget node does **not** cover epics — epics await results and skip dependents after failure (`worker/workflows/epicOrchestrator.ts:157-188`) |
| 4 | **`httpRequest`** | the `http_api` connection type is not usable from a spec without a shell node; existing generic handlers return placeholders (`genericActions.ts:221-225`, `:481-484`) | scoped credentials, private-network policy, redirect policy, retries, idempotency, payload limits, write governance (go through `createGuardedFetch`) |
| 5 | **`notify`** | no first-class way to tell a thread a run is parked | must respect the autonomy policy — Slack posting is a governed external write, not a free notification (`templates/sendSlackUpdate.ts:7-13`) |
| 6 | **`reduce` / aggregate** | only if a spec proves it: `fanOut.pluck` + `terminate.result` can already hand branch results forward, and the channel's synthesis is an LLM call a deterministic reducer cannot replace | — |
| 7 | **`parallel` (fixed branch set)** | **not recommended.** It saves a literal-array initializer while adding a full execution/editor/replay surface, and the fabricated array carries useful task metadata (`templates/parallelFanOut.ts:90-108`) |

Not recommended at all: a `loop`/`while` node (back-edges are replay-covered), a `merge` node
(`mergeBranches` exists), and more human node types.

---

## 8. What I would actually do, in order

| # | Change | Kind | Why first |
|---|---|---|---|
| 1 | Governance + idempotency contract for every external mutation (`writeOutcome`, `runTool`, `mcpCallTool`) | contract | §5.2/§5.3 decide what an autonomous run may do; every new primitive multiplies the problem while it is open |
| 2 | Fix the authoring/runtime contract defects: `containerStep.command` (schema vs runtime), `runPerfBench` passing unconfigured, `shellStep` `passed` after a failed push, `runEvalNode` explicit candidate SHA | correctness | §5.4-§5.7 are executable contradictions; none needs a schema-version bump |
| 3 | `agent`-node cost estimation + expose what the estimate excludes | correctness | §5.1 — templates are currently costed as if agents were free |
| 4 | Missing HITL/eval editor forms (shared per-kind section), plus the missing lint (`approverCount`, `contentFrom`, eval `assert.expr`) | tooling | §5.9/§6.5 — the surface cannot be authored from the canvas today |
| 5 | Recording + analytics: record successful `set`/`cond`/`terminate`, normalize fan-out branch prefixes | observability | §5.8 |
| 6 | `step`-name guidance warning for the four executor back-ends | hygiene | §6.4 — cheap, no enforcement |
| 7 | Optional `runQualityGates` step with explicit isolation | capability | §6.2 — measurable payoff, no spec change |
| 8 | `waitForCi` node | capability | §7.1 |
| 9 | `callWorkflow`, then `httpRequest` + `notify` as the first non-SWE vertical is actually proven | capability | §7.3, §7.4, §7.5 |
| 10 | Decide fate of `planDecomposition`, `runTool`, the knowledge steps; publish `examples/` as a cookbook | content | §6.3 |

Three changes I would explicitly **not** make: merging the human node types, merging `shell` into
`containerStep`, and adding a fixed `parallel` node. Each relocates complexity, breaks stored specs
and replay fixtures, and buys less than the contract work above.

**Any change that alters the node union or a node id changes `maxTransitions` semantics (§6.8),
`docs/architecture.md`'s "15 node types" plus `docs/product-overview.md`'s "15 node types"
(`scripts/check-doc-drift.mjs:123-125`), the editor's exhaustive `Record<SpecNode['type'], …>` maps,
the replay fixtures in `runnable.replay.test.ts:75-98`, and the bundle/SDK contracts — in the same
change, or the gates will not be green.**

---

## 9. Questions this analysis cannot answer from the source

1. **Deployed usage vs registration.** Every usage figure here is static. Nothing in the repo says
   which node types and steps real teams actually author, so "unused" means "unused by shipped
   content". A quick query over `workflow_template_versions` specs would settle §3 and decide §6.3.
2. **Which vertical is next.** §7's ordering (3, 4, 5) depends on whether `document`, `record` or
   `issue_tracker` gets a proven flow first — that determines whether `httpRequest` or `callWorkflow`
   is the higher-value primitive.
3. **Whether the estimate is ever used as a budget.** If it is advisory only, §5.1 is a display fix;
   if anything enforces it, the `agent`-node zero is a correctness bug.
4. **Whether `containerStep` is expected to work outside `git_repo` workspaces.** If yes, §5.4's
   `requireRepoId` is a blocker for the horizontal story; if no, the limitation belongs in
   `docs/bundles.md`.
