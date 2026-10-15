# Adversarial review of the workflow node assessment

The assessment contains useful findings, but its consolidation agenda rests on several false equivalences. Its usage census counts test fixtures, its shell/container comparison misses repository persistence, and its analytics claim is wrong. Its first recommended change does not close the alleged existing gateway bypass.

I read the assessment in full and inspected the source without modifying files. This is a source review; I did not run tests or replay histories. Below, repeated claims are consolidated into one fact-check entry.

Paths beginning `shared/`, `worker/`, `gateway/`, `web/`, and `sdk/` mean `packages/<name>/src/`.

## 1. Fact check

### Inventory, usage, and use-case claims

| Claim | Result | Source evidence |
|---|---|---|
| There are 15 declarative node types. | **VERIFIED** | `shared/workflow/spec.ts:610–626` enumerates 15 members. |
| There are 45 built-in step names and 44 author-visible names. | **VERIFIED** | The list is at `shared/workflow/registry-types.ts:53–112`; `runAgentTask` is internal at `shared/workflow/stepRegistry.ts:600`; listing filters internal entries at `:765–766`. |
| Five node types are typed front ends for steps. | **WRONG** | Four are: `agent`, `eval`, `mcp`, `containerStep`. Their dispatches are at `shared/workflow/interpreter.ts:651`, `:665`, `:686`, `:702`. The assessment itself subsequently says four. |
| Those four backend names exist “only as those front-ends.” | **WRONG** | Raw `step` dispatch accepts a step name and config at `shared/workflow/interpreter.ts:716–717`; these backend names are registered and author-visible at `shared/workflow/stepRegistry.ts:567`, `:611`, `:642`, `:665`. |
| The schema locations in the inventory table identify the stated node definitions. | **VERIFIED** | Definitions start at `shared/workflow/spec.ts:215`, `:237`, `:268`, `:306`, `:324`, `:331`, `:339`, `:349`, `:391`, `:443`, `:492`, `:538`, `:560`, `:583`, `:598`. |
| `shell` has a distinct `dispatchShell` activity-dispatch method. | **VERIFIED**, narrowly | `shared/workflow/interpreter.ts:707–715`. Other dispatcher methods also exist for waits and HITL; “only type with its own dispatcher method” is too broad if read literally (`:199`, `:247`, `:268`). |
| `set`, `cond`, `signal`, `terminate`, and `fanOut` use the stated interpreter paths. | **VERIFIED** | `shared/workflow/interpreter.ts:488–524`, `:976–1008`. |
| All four human types share `runHumanNode`. | **VERIFIED** | `shared/workflow/interpreter.ts:527–538`. Shared execution does not establish semantic equivalence. |
| The catalog contains the named SWE, CI, planning, PRD, generic, knowledge, and executor steps. | **VERIFIED** | `shared/workflow/registry-types.ts:53–112` contains the names grouped in §2.2. Those group labels are editorial classifications, not registry categories. |
| Three fix activities share `runImplementerFixSession`. | **VERIFIED** | `worker/activities/ciFixLoop.ts:73`, `:120`; `worker/activities/qualityGates.ts:461`. |
| Six gate steps share an executor/activity implementation. | **VERIFIED** | Shared executor registrations: `worker/workflows/runnableSteps.ts:573–578`; proxy group: `worker/workflows/runnableActivities.ts:118–127`; implementation: `worker/activities/qualityGates.ts:262`. |
| Knowledge steps and agent tools share runtime functions. | **VERIFIED** | `worker/activities/knowledge.ts:5–7`, `:11–25`; `worker/agents/knowledgeTools.ts:5–8`, `:56`, `:75`. |
| `planChannelTask` and `runChannelSubtasks` are both “LLM decomposers.” | **WRONG** | The former plans; the latter executes subtasks and synthesizes their answers. `worker/activities/channelTaskPlan.ts:100–106`, `:114–125`, `:178`, `:217`. |
| The usage table measures shipped specs. | **WRONG** | I reproduced its numbers exactly only when including `.test.ts` files. Test-local node objects are visible at `shared/workflow/templates/authoring/common.test.ts:123–131`, `ciLoop.test.ts:15`, and `signalGate.test.ts:39`. |
| The reported literal counts are reproducible over the entire stated directory glob, including tests. | **VERIFIED** | Including tests gives exactly `117/75/57/21/8/7/5/4/4/4/4/2`. Excluding tests gives `90/59/43/15/8/7/3/4/4/3/4/2` in the assessment’s order. Neither count expands authoring helpers into instantiated templates. The helper’s conditional emission is explicit at `shared/workflow/templates/authoring/ciLoop.ts:41–83`. |
| `mcp`, `eval`, and `containerStep` have no uses in the inspected built-in/example spec sources. | **VERIFIED**, within that scope | The built-in imports are at `shared/workflow/templates/index.ts:4–31`; the corresponding schema types exist at `spec.ts:268`, `:306`, `:492`. This establishes absent built-in examples, not absent deployed usage. |
| `runTool`, `retrieveKnowledge`, and `captureLearning` have no uses in that spec census. | **VERIFIED**, within that scope | They remain registered at `shared/workflow/registry-types.ts:75–76`, `:111`; their executable entry points remain at `worker/activities/genericActions.ts:636` and `knowledge.ts:11`, `:16`. |
| `planDecomposition` and `runBuild` have “zero usage including examples.” | **WRONG** | The sentence contradicts its own parentheticals. `runBuild` is an actual example node at `shared/workflow/examples/qualityGates.spec.ts:24–27`; decomposition examples are imported for execution at `shared/workflow/fanOutSpecs.execution.test.ts:2–3`. |
| `runPerfBench` is used by example specs. | **WRONG** | The example directory mentions it in an expected-name set, not a node: `shared/workflow/examples/qualityGates.spec.test.ts:11–20`. |
| The four example files have “no importer at all.” | **WRONG** | Co-located imports include `shared/workflow/examples/qualityGates.spec.test.ts:3`; external execution-test imports include `shared/workflow/fanOutSpecs.execution.test.ts:2–3`. “No production importer” is a defensible narrower claim. |
| The examples’ only effect is to make dead steps look covered. | **WRONG** | Their execution tests check branch-output bindings and terminal behavior, not merely catalog presence: `shared/workflow/fanOutSpecs.execution.test.ts:10–15`. |
| Five workspace-provider and eight connection-type names are as listed. | **VERIFIED** | `shared/lib/workspaceProviders.ts:12–18`; `shared/lib/connectionTypes.ts:13–20`. |
| Epics use a separate orchestrator and `planEpic`. | **VERIFIED** | `worker/workflows/epicOrchestrator.ts:111`, `:157`; `worker/activities/planEpic.ts:109`. |
| There is no declarative `callWorkflow` node. | **VERIFIED** | Exhaustive union: `shared/workflow/spec.ts:610–626`. |
| The channel composite path performs fan-in inside an activity. | **VERIFIED** | `worker/activities/channelTaskPlan.ts:114–125`, `:194–225`. |
| PRD submission can start runs through a bespoke step. | **VERIFIED** | Registered step: `shared/workflow/registry-types.ts:105`; dispatcher: `worker/workflows/runnableSteps.ts:664–669`; launch/reconciliation expectations: `worker/activities/prdWorkflow.submit.test.ts:679–698`. |
| Notion, Zendesk, issue-tracker, and Slack writes have concrete generic-action handlers. | **VERIFIED** | `worker/activities/genericActions.ts:473–480`. |
| `publishOutcome` itself publishes a Zendesk reply. | **WRONG**, if the U12 mapping implies that | It resolves policy and records a decision, returning `auto` or `require_approval`; it makes no connector write. `worker/activities/publishOutcome.ts:22–63`. |
| MCP is the only way a workflow reaches an MCP server. | **WRONG** | An implementer can load MCP tools inside an activity: `worker/agents/implementer.ts:203–208`. |
| Eleven of fifteen types are exercised, while three are unused. | **WRONG** | The assessment’s own table lists twelve nonzero types. The union has fifteen members at `shared/workflow/spec.ts:610–626`. |
| Actual deployment usage, adoption, latency savings, or which use cases exercise “more than a handful” of primitives. | **UNVERIFIABLE** | Static registration and template sources establish availability, not deployed utilization. I could not verify those quantitative product conclusions. |

### Validation, UI, recording, security, and cost

| Claim | Result | Source evidence |
|---|---|---|
| Five types lack configuration forms; ten have them. | **VERIFIED** | `web/components/workflow/NodeInspector.tsx:85–101`. |
| The missing forms are `eval` and the four human types. | **VERIFIED** | `web/components/workflow/NodeInspector.tsx:89–94`, `:226–231`. |
| Authors cannot add human decision options or input fields through those inspector forms. | **VERIFIED** | Those types take the JSON-mode notice at `NodeInspector.tsx:226–231`. The statement should specify form/canvas mode: JSON mode is explicitly offered. |
| `eval` lacks the shared inputs editor. | **VERIFIED** | The inputs-editor allowlist omits it at `web/components/workflow/NodeInspector.tsx:215–224`. |
| Shell timeout, container resource/transport/sidecar controls, signal `storeAs`, and terminate result lack corresponding configuration controls. | **VERIFIED** | Shell form: `web/components/workflow/inspectorSections.tsx:233–308`; container form: `:311–359`; signal form: `:100–129`; terminate section begins at `:363`. |
| `validateSpec` has 13 distinct issue codes. | **VERIFIED** | Emission sites run from `shared/workflow/validateSpec.ts:232` through `:447`. |
| Type-specific lint covers only step, cond, and fan-out. | **WRONG**, literally | `eval.target`, `terminate.result`, and `set.values` receive type-specific binding enumeration at `shared/workflow/validateSpec.ts:82–92`. The narrower claim about dedicated semantic rules is substantially accurate. |
| Approval count is omitted from binding lint. | **VERIFIED** | Complete binding enumerator: `shared/workflow/validateSpec.ts:69–95`; runtime resolution: `interpreter.ts:1039–1042`. |
| Every other binding is checked. | **WRONG** | `from` provenance checks establish only an existing node prefix, not correctness of the full output path: `shared/workflow/validateSpec.ts:111–118`. They cannot detect `nodes.implement.ouput.x` when `implement` exists. |
| Human decision option values are unlinted bindings requiring provenance checks. | **WRONG** | They are literal strings, not bindings: `shared/workflow/spec.ts:551–555`. Duplicate-value validation is a plausible missing check; provenance is the wrong concept. |
| Review content paths and eval assert syntax lack the described static checks. | **VERIFIED** | Neither is in `shared/workflow/validateSpec.ts:69–95`; runtime assert evaluation is at `worker/activities/runEvalNode.ts:214–221`. |
| All three ignored fields are accepted by six schemas. | **WRONG** | `retry` and `startToCloseTimeout` appear in six; `heartbeatTimeout` appears in four. Shell/container definitions omit heartbeat timeout: `shared/workflow/spec.ts:443–479`, `:492–531`. |
| The legacy fields are ignored by interpreter execution. | **VERIFIED** | Compatibility intent is explicit at `shared/workflow/spec.ts:203–206`; dispatch packing does not use them at `interpreter.ts:630–717`; warning list is at `validateSpec.ts:148`. |
| Unknown node fields are silently stripped rather than rejected. | **VERIFIED** | Node schemas use ordinary `z.object` definitions, e.g. `shared/workflow/spec.ts:215`, `:443`, `:538`; tolerant compatibility is also explicit for bindings at `:86–98`. |
| `set`, `cond`, and `terminate` do not record successful executions. | **VERIFIED** | Their interpreter branches are pure at `shared/workflow/interpreter.ts:488–510`. |
| Those control types can never appear in failure-rate analytics. | **WRONG** | The interpreter records their exceptions as `FAILED`: `shared/workflow/interpreter.ts:542–551`. Analytics includes failed rows at `analytics.ts:152–162`. |
| Signals can never appear in failure-rate analytics. | **WRONG** | Received signals record `PASSED` at `shared/workflow/interpreter.ts:1007`; analytics accepts that status at `analytics.ts:153–162`. Timeout signals are excluded because they record `SKIPPED` at `interpreter.ts:1000`. |
| Analytics skips `PENDING`, `RUNNING`, and `SKIPPED`, and groups by unnormalized recording ID. | **VERIFIED** | `shared/workflow/analytics.ts:94`, `:153–162`. |
| `SELF_RECORDING_NODE_TYPES` establishes which successful nodes are recorded. | **WRONG** | It controls duplicate **failure** recording, as its comment states: `shared/workflow/interpreter.ts:734–742`, `:542–551`. |
| Three node types receive real token estimates: step, agent, eval. | **WRONG** for the built-in registry | The agent path queries `runAgentNode` metadata, but that registration has no cost hint: `shared/workflow/costEstimator.ts:123–131`; `stepRegistry.ts:567–589`. It estimates zero with the built-in registry. |
| Eval estimation charges a judge regardless of scorer kinds. | **VERIFIED** with built-in metadata | `shared/workflow/costEstimator.ts:136–144`; fixed judge hint at `stepRegistry.ts:635`. |
| Other listed types contribute zero direct token cost. | **VERIFIED** | `shared/workflow/costEstimator.ts:133–173`. Descendant costs are still traversed. |
| The authoring prompt omits policy/PII scorers and fan-out exports/pluck/failure controls. | **VERIFIED** | `shared/lib/agentPrompts.ts:625`, `:629`. |
| The prompt omits container transport entirely. | **WRONG** | It includes `"transport"?: "stdout"` at `shared/lib/agentPrompts.ts:631`; other transport modes and sidecar details are absent. |
| Authoring offers both typed nodes and raw backend steps. | **VERIFIED** | `shared/workflow/authoring.ts:77–79`; public registry filtering at `stepRegistry.ts:765–766`. |
| Gateway shell collection handles raw shell-category steps. | **VERIFIED** | `gateway/lib/specCheck.ts:29–62`. |
| Only shell-family nodes are gated by the gateway. | **WRONG** as a universal claim | Internal steps are separately rejected at `gateway/lib/specCheck.ts:242`; strict schema/version checks are at `:184–220`. Shell-specific RBAC is indeed limited to collected shell-family nodes. |
| Agent/MCP reference checks are advisory. | **VERIFIED** | `gateway/lib/specRefValidation.ts:8–20`. |
| Reference validation is MCP-only. | **WRONG** | It checks both agent and MCP references: `gateway/lib/specRefValidation.ts:49–55`. |
| Bundle template validation omits the canvas shell checks. | **VERIFIED** | `shared/bundle/index.ts:504–532`; gateway install call at `gateway/routes/bundles.ts:100–105`. |
| Bundle installation bypasses shell RBAC. | **WRONG** as an escalation claim | Both install endpoints require platform ADMIN: `gateway/routes/bundles.ts:173`, `:232`, `:256`. Platform ADMIN already passes shell authoring authorization at `gateway/lib/specCheck.ts:82–83`. |
| A bundle can persist an arbitrary-image spec without `WorkflowShellAudit`. | **VERIFIED** as a save-time consistency gap | The install path uses bundle validation, not shell collection: `shared/bundle/index.ts:504–532`; `gateway/routes/bundles.ts:100–105`. |
| That allows arbitrary-image execution. | **WRONG** | Runtime checks remain: `worker/activities/containerStep.ts:65–73`; `shellStep.ts:364–377`. |
| `shell` and `containerStep` have the same workspace behavior; container is strictly more expressive. | **WRONG** | Container uses an empty volume at `worker/activities/containerStep.ts:103–119`; shell clones a repository at `shellStep.ts:384–401` and finalizes/pushes it at `:438–449`. |
| Their outputs differ as described. | **VERIFIED**, but incomplete | Container wraps JSON under `result` at `worker/activities/containerStep.ts:129–137`; shell also exposes persistence information and records lessons at `shellStep.ts:468–489`. |
| Input/review schemas differ only by fields/content, with optional input `contextFrom`. | **WRONG** | `humanInput` has no `contextFrom`: `shared/workflow/spec.ts:583–593`. |
| Input/review have no semantic difference beyond kind/rendering. | **WRONG** | Gateway validates review as a bounded string and input as a typed field object: `gateway/lib/hitlResolve.ts:153–161`, `:184–235`. |
| Approval is merely a decision with approve/reject options. | **WRONG** as equivalence | Approval has distinct action semantics and atomic multi-approver handling: `gateway/lib/hitlResolve.ts:290–300`, `:337–429`. |
| The fix steps differ only in agent, prompt, mode, and one hook. | **WRONG** | CI has untrusted-log screening/fencing; review accepts structured rejection data and `allowedPaths`; telemetry and payloads differ. `worker/activities/ciFixLoop.ts:62–97`, `:112–135`. |
| Each configured quality gate provisions its own workspace. | **VERIFIED** | `worker/activities/qualityGates.ts:262–274`. An unconfigured gate provisions none. |
| The poll activity always re-resolves settings already resolved by the spec. | **WRONG** | Fallback resolution is conditional on missing/invalid timings: `worker/activities/waitForCiByPolling.ts:69–75`. |
| Every CI template implements the full poll-or-signal idiom. | **WRONG** | Shared authoring defaults to signal-only, conditionally adding poll routing: `shared/workflow/templates/authoring/ciLoop.ts:23`, `:41–83`. |
| CI polling uses `ciPassed` to avoid generic gate failure handling. | **VERIFIED** | `worker/activities/waitForCiByPolling.ts:49–54`; interpreter contract at `shared/workflow/interpreter.ts:840–841`. |
| Eval policy and PII are soft scorers. | **WRONG** | Both belong to the floor: `worker/lib/scorerCombination.ts:30–37`. |
| Eval gates are deterministic in the Temporal-workflow sense. | **WRONG** | They perform database reads, resolve current defaults, clone, and execute commands in an activity: `worker/activities/runEvalNode.ts:167–193`. Expression assertions are pure; shell gates are external execution. |
| Different workflow-path regexes prove a duplicate bug. | **WRONG** | One forbids changes under workflows **and actions** (`worker/activities/ciTriage.ts:664–665`, `:854`); the other validates a readable workflow YAML path (`ciVerify.ts:135–140`). They answer different questions. |
| CI triage has a local error-swallowing workflow-ID helper. | **VERIFIED** | `worker/activities/ciTriage.ts:656–662`; shared helper throws outside activity context at `worker/lib/activityContext.ts:35–39`. Whether to replace it depends on the intended failure behavior. |
| Unconfigured perf benchmarks pass. | **VERIFIED** | Default `null`: `worker/activities/qualityGates.ts:97`; no-command success: `:266–271`. |
| Fan-out signals share a bare signal name. | **VERIFIED** | `shared/workflow/interpreter.ts:996`; HITL instead qualifies recording IDs at `:1019–1027`; signal consumption is at `worker/workflows/runnable.ts:253–267`. |
| Fan-out cannot return branch data to its join. | **WRONG** | Branch results, exports, and plucked values are exposed at `shared/workflow/interpreter.ts:1367–1384`. The cited channel documentation says otherwise, but the code is authoritative. |
| Knowledge retrieval is “not authorable in practice.” | **WRONG** | It is a registered public step with an executor: `shared/workflow/registry-types.ts:75`; `worker/activities/knowledge.ts:11–13`. Missing examples affect discoverability, not authorability. |
| Node-count prose is checked. | **VERIFIED** | `scripts/check-doc-drift.mjs:123–125`; count claim at `docs/architecture.md:317`. |
| Every consolidation requires changing all four named documentation files. | **UNVERIFIABLE** as stated | Concrete count claims exist in `docs/architecture.md:317` and `docs/product-overview.md:111`. I could not verify an equivalent mandatory count edit in `docs/concepts.md`; update actual affected claims rather than assuming a fixed list. |
| Missing forms exist *because* eval combines six scorers; merges are “low/medium cost”; notifications would benefit nearly every template. | **UNVERIFIABLE** | Those are causal or effort predictions. The form classification establishes absence, not its cause (`web/components/workflow/NodeInspector.tsx:85–101`). |

The most consequential errors are the shell/container equivalence, the test-contaminated census, and the claim that raw backend steps currently bypass gateway shell gating.

## 2. Attack each recommendation

### Compatibility costs the assessment understates

These are concrete costs, not generic objections:

- Existing run snapshots are preserved across retries and returned to the workflow: `worker/activities/templates.ts:556–559`, `:648–656`. A template codemod does not rewrite historical activity results.
- Replay tests explicitly retain shell, container, eval, all four human types, signals, loops, and fan-out fixtures: `worker/workflows/runnable.replay.test.ts:75–98`.
- Adding ledger activities changes Temporal command history. Existing interpreter changes use patch guards for this reason: `shared/workflow/interpreter.ts:760–770`.
- Node-count changes affect docs checks and exhaustive UI classification: `scripts/check-doc-drift.mjs:123–125`; `web/components/workflow/NodeInspector.tsx:85`.
- Bundle/SDK compatibility is public: `sdk/index.ts:34`; bundle template validation parses those specs at `shared/bundle/index.ts:520–527`.

“Needs no schema change” does not mean “needs no compatibility work.”

### Section 5: consolidation

| Recommendation | Strongest counterargument and concrete breakage | Verdict |
|---|---|---|
| **5.1 Merge input and review** | They have different validated payloads: object fields versus editable string. Deriving kind from optional fields turns invalid configurations into runtime interpretation choices. Stored `WorkflowHumanStep.kind`, gateway validation, inbox/Slack rendering, and both replay fixtures must remain compatible. See `gateway/lib/hitlResolve.ts:153–235`, `shared/prisma/schema.prisma:2162–2169`, `worker/workflows/runnable.replay.test.ts:88–89`. Build shared form components while retaining the types. | **DISAGREE** |
| **5.2 Merge approval and decision / reduce four types to two** | Approval is a voting protocol, not a choice field. Atomic distinct-approver accumulation and action validation are material behavior (`gateway/lib/hitlResolve.ts:290–300`, `:337–429`). A generic request type would still need these variants, shifting complexity into configuration while breaking stored specs, resolution APIs, and replay fixtures. | **DISAGREE** |
| **5.3 Fold shell into container** | Shell performs repository checkout and persistence; container is stateless. An `expect: gate` output mode does not restore cloning, credential handling, commit/push, artifacts, or memory capture. Migration would break migration workflows, shell bindings, SDK expectations, and shell replay history. `worker/activities/shellStep.ts:384–401`, `:438–489`; `containerStep.ts:103–137`. | **DISAGREE** |
| **5.4 Merge fix steps; alternatively retain aliases and extract ladders** | Preserve CI log fencing, review rejection conversion, path restrictions, gate reruns, and telemetry. A unified activity name changes replay commands; even adding optional arguments can change historical command payloads. The dispatcher deliberately omits unset arguments (`worker/workflows/runnableSteps.ts:405`, `:424`). Refactor helpers only while preserving activity names and argument shapes. | **AGREE-WITH-MODIFICATION** |
| **5.5 Merge six gates; add shared-workspace execution** | Names are already thin wrappers over shared execution. Renaming chiefly breaks saved specs and catalog clients. Workspace reuse changes isolation: lint/build commands may mutate files, making later checks order-dependent. Preserve individual gate results, commands, evidence correlations, and fix-loop inputs (`worker/activities/qualityGates.ts:80–90`, `:474–480`). Prefer an optional batch step, not mandatory replacement. | **AGREE-WITH-MODIFICATION** |
| **5.6 Merge MCP and connector tool calls** | They have different input and result contracts, credential resolution, cancellation, and supported-tool behavior. `runTool` takes `inputs.tool` and nested `inputs.inputs` (`worker/workflows/runnableSteps.ts:807–813`); MCP uses node config and returns `{result}` (`worker/activities/mcpCallTool.ts:11–24`). Unifying spelling without harmonizing policy and idempotency merely conceals differences. | **AGREE-WITH-MODIFICATION** |
| **5.7 Do not merge context set and domain update** | Different persistence and side effects justify separate primitives. A shared visual bookkeeping fold is not a runtime abstraction: `shared/workflow/interpreter.ts:976–980`; `shared/workflow/registry-types.ts:55`. | **AGREE** |
| **5.8 Keep signal separate from human requests** | Human nodes require notification, stored kind-specific validation, and resolution; signals only wait and bind. `shared/workflow/interpreter.ts:987–1008`, `:1035–1074`. | **AGREE** |

### Section 6: split

| Recommendation | Strongest counterargument and concrete breakage | Verdict |
|---|---|---|
| **6.1 Split eval into gate and judge** | The proposed split misclassifies policy/PII and cannot replace per-axis combination with one boolean edge. Fixing estimation does not require new types. Splitting changes EvalResult grouping, score bindings, short-circuit behavior, stored specs, and eval replay. Floor semantics are explicit at `worker/lib/scorerCombination.ts:30–78`; outputs at `worker/activities/runEvalNode.ts:68–73`. | **DISAGREE** |
| **6.2 Separate gate identity from shared provisioning** | Sensible if batching is optional and isolation is explicit. Keep gate-addressable evidence and retry behavior; otherwise one failed activity can rerun successful commands and alter trusted evidence. `worker/activities/qualityGates.ts:80–90`, `:262–300`. | **AGREE-WITH-MODIFICATION** |
| **6.3 Refuse raw executor step names** | The claimed gateway bypass is already closed (`gateway/lib/specCheck.ts:29–62`). Cost output separates `nodeId` from `step`, so backend labels are not inherently an attribution bug (`shared/workflow/costEstimator.ts:129`). A ban also removes the currently available metadata-generated eval config form while the typed eval has none (`stepRegistry.ts:611–633`; `NodeInspector.tsx:89`). Prefer canonical guidance and warnings; migrate public specs/bundles before enforcing. | **AGREE-WITH-MODIFICATION** |
| **6.4 Do not split fan-out** | Its map, result lifting, bounded execution, and cancellation form a coherent unit. Splitting risks changing branch cancellation and replay ordering: `shared/workflow/interpreter.ts:1206–1294`, `:1367–1392`. | **AGREE** |

### Section 7: removal

| Recommendation | Strongest counterargument and concrete breakage | Verdict |
|---|---|---|
| **7.1 Remove or document `runTool`** | Built-in absence does not establish external deadness. It performs real Zendesk, Slack, and issue-tracker calls (`worker/activities/genericActions.ts:530–563`, `:647–655`). Removing it breaks authored specs and bundles. Document supported tools and govern writes first. | **AGREE-WITH-MODIFICATION** |
| **7.1 Keep exactly one knowledge front door** | Workflow authors and agents are different consumers. Sharing implementation is desirable; eliminating an interface is not. Agent tools are explicitly opt-in and schema-validated (`worker/agents/knowledgeTools.ts:17–41`, `:49–67`). Retain both, document their roles. | **DISAGREE** |
| **7.1 Wire decomposition into fan-out or remove it** | Replacing fixed roles with LLM decomposition changes reproducibility, cost, branch IDs, and merge-conflict exposure. Static tasks are explicit at `shared/workflow/templates/parallelFanOut.ts:90–108`. Add a distinct dynamic example/template rather than silently changing this one. | **AGREE-WITH-MODIFICATION** |
| **7.1 Keep build** | Build is a real configured gate and a concrete example node (`worker/activities/qualityGates.ts:94`; `shared/workflow/examples/qualityGates.spec.ts:24–27`). Removal would break authored workflows for no demonstrated gain. | **AGREE** |
| **7.1 Make unconfigured perf benchmarks fail** | Existing specs may intentionally rely on optional checks; abrupt failure changes them. Nevertheless, labeling no execution as a pass is misleading. Require configuration for newly authored benchmark nodes, and represent legacy no-op results explicitly. `worker/activities/qualityGates.ts:266–271`. | **AGREE-WITH-MODIFICATION** |
| **7.1 Delete examples or publish a cookbook** | Deletion discards execution regression coverage, including branch output binding tests (`shared/workflow/fanOutSpecs.execution.test.ts:2–15`). Publish and repair examples; do not delete them as alleged dead coverage. | **AGREE-WITH-MODIFICATION** for publication; **DISAGREE** on deletion |
| **7.2 Delete ignored fields** | They are deliberately retained for stored-spec compatibility (`shared/workflow/spec.ts:203–206`). Removing them from non-strict schemas still silently strips submitted keys; it does not solve rejection-versus-normalization. Reject them on new authoring, retain tolerant historical reads, and expose normalization. | **AGREE-WITH-MODIFICATION** |
| **7.3 Unify workflow-path regexes and workflow-ID helpers** | Unifying regexes weakens either the protected-directory rule or the readable-YAML check: `worker/activities/ciTriage.ts:665`, `ciVerify.ts:139`. The helpers also deliberately differ on outside-activity failure. Rename by purpose; reuse only genuinely identical behavior. | **DISAGREE** |
| **7.4 Keep MCP/container; add examples or extension-point docs** | They have distinct extension contracts and replay coverage (`sdk/index.ts:34`; `worker/workflows/runnable.replay.test.ts:79`, `:91`). Examples are useful, but claiming “unproven” must distinguish unit/replay coverage from real integration proof. | **AGREE** |

### Section 8: new nodes

| Recommendation | Strongest counterargument and concrete breakage | Verdict |
|---|---|---|
| **8.1 `waitForCi` / `waitForCondition`** | The idiom is already centralized as an authoring helper, not copied independently (`shared/workflow/templates/authoring/ciLoop.ts:23–84`). A new type needs signal registration, timeout/retry semantics, cancellation, pinned strategy, editor support, and replay fixtures. Keep old graphs executable; first prove a CI-specific primitive, rather than a general condition waiter. | **AGREE-WITH-MODIFICATION** |
| **8.2 `runQualityGates`** | Real provisioning savings are plausible, but gate commands may mutate their workspace and batching expands retry scope. Preserve branch selection, per-gate artifact/provenance, and selective reruns (`worker/activities/qualityGates.ts:202–255`, `:279–300`). A registered step can deliver this without enlarging the node union. | **AGREE-WITH-MODIFICATION** |
| **8.3 `callWorkflow`** | The proposed contract omits child identity, template/version pinning, repository/team access, parent-close policy, cancellation, and budget attribution. Worse, its “fire-and-forget covers epics” assertion contradicts the epic scheduler: epics await results and skip dependents after failures (`worker/workflows/epicOrchestrator.ts:157–188`). PRD launching also has reconciliation tests (`worker/activities/prdWorkflow.submit.test.ts:571–624`). Do not replace these with a bare launch node. | **AGREE-WITH-MODIFICATION** |
| **8.4 `reduce` / aggregate** | Fan-out already exposes arrays of branch results. A deterministic reducer cannot replace the channel’s LLM synthesis without changing behavior (`shared/workflow/interpreter.ts:1367–1384`; `worker/activities/channelTaskPlan.ts:207–225`). First demonstrate that an existing `terminate.result` plus `pluck` cannot express the needed result handoff. | **AGREE-WITH-MODIFICATION** |
| **8.5 Fixed `parallel`** | Removing one literal-array initializer buys little while requiring new edge semantics, validation, visualization, cancellation, estimation, and replay coverage. The existing fixed-role array conveys useful task metadata (`shared/workflow/templates/parallelFanOut.ts:90–108`). | **DISAGREE** |
| **8.6 HTTP request node** | It fills a real placeholder gap, but method/URL/headers alone ignores scoped credentials, private-network policy, redirects, retries, idempotency, payload limits, and write governance. Existing HTTP generic handlers return placeholders (`worker/activities/genericActions.ts:221–225`, `:481–484`, `:656–660`). Implement a connection-scoped activity contract first. | **AGREE-WITH-MODIFICATION** |
| **8.7 Notify node** | Slack posting is already a governed external write, not always safe to treat as best-effort notification. The seeded Slack template explicitly evaluates autonomy policy (`shared/workflow/templates/sendSlackUpdate.ts:7–13`). An email backend was not established by this proposal. A reusable governed step/template is cheaper than another type. | **AGREE-WITH-MODIFICATION** |
| **8.8 Knowledge node/example** | A new type duplicates an existing public step. An example improves discoverability without schema/replay cost (`worker/activities/knowledge.ts:11–13`). | **AGREE** on documentation/example; **DISAGREE** on a new node |
| **8.9 No loop node** | Back-edges already work and are replay-covered (`worker/workflows/runnable.replay.test.ts:78`). A bounded loop could improve UX, but no missing execution capability is demonstrated. | **AGREE** |
| **8.9 No merge node** | `mergeBranches` already exists (`shared/workflow/registry-types.ts:87`). Fix invariants in its implementation rather than adding syntax. I could not verify the assessment’s specific AGENTS §7 rationale from the supplied instructions. | **AGREE**, narrower rationale |
| **8.9 No more human types** | The existing types already lack forms; adding variants before completing those surfaces compounds the gap (`web/components/workflow/NodeInspector.tsx:91–94`). | **AGREE** |

## 3. What the assessment missed

### 3.1 A concrete example has an unreachable fix loop

The quality-gate example sends lint failures to a downstream `cond`, but lint uses `onFail: {retry: 1}`. After retries, the interpreter blocks and throws; it never reaches `checkLint`.

This is not a theoretical syntax problem: `shared/workflow/examples/qualityGates.spec.ts:43–47`, `:93–97`; blocking behavior at `shared/workflow/interpreter.ts:946–963`.

The assessment calls these examples useless coverage while missing an actual behavioral defect in one. Execution-test gate-failure paths, not just schema parsing.

### 3.2 The public container contract is inconsistent with runtime

The schema says an omitted command defaults to the image entrypoint. Runtime rejects an omitted command for stdout/NDJSON.

- Advertised contract: `shared/workflow/spec.ts:494–495`.
- Runtime rejection: `worker/activities/containerStep.ts:59–62`.
- SDK helper exposes that optional-command type: `sdk/index.ts:34`.

A bundle can therefore pass structural validation while shipping a container node that cannot run in its default transport. This is a more concrete SDK defect than reducing node counts.

### 3.3 The stateless container extension still requires repository identity

Container execution uses an empty volume but calls `requireRepoId` to resolve the governing connection/team: `worker/activities/containerStep.ts:65–73`, `:103–119`.

That creates an important seam for `document`, `record`, `issue_tracker`, and `api_only` workflows, whose provider model is explicitly broader than git (`shared/lib/workspaceProviders.ts:31–59`). I could not verify from this seam alone that every non-git connection fails. What is verified is that a supposedly stateless capability depends on repository-shaped request identity for authorization context. Audit that contract before promising horizontal bundle capabilities.

### 3.4 Autonomy enforcement depends on which write interface authors choose

`writeOutcome` checks recorded approval decisions and uses an outcome ledger. `runTool` can post Zendesk comments directly without invoking that check or accepting a ledger identity.

- Approval guard and ledger: `worker/activities/genericActions.ts:420–437`, `:464–513`.
- Direct tool write: `:549–561`.
- Tool dispatcher has no node/visit identity: `worker/workflows/runnableSteps.ts:807–813`.

Moreover, `writeOutcome` explicitly permits a run with **no** recorded policy decision (`genericActions.ts:415–427`). The policy-gated template helper is therefore an authoring convention, not a universal mutation boundary (`shared/workflow/templates/authoring/policyGatedWrite.ts:25–42`).

The assessment proposes a unified tool or HTTP node without first addressing this discrepancy. That could multiply the ungated write paths.

### 3.5 External-effect retries are a more important primitive problem than duplicate spelling

MCP execution calls an external tool directly and returns afterward; it has cancellation handling but no outcome ledger in this execution path (`worker/activities/mcpCallTool.ts:75–85`). Connector tool mutations likewise lack the `writeOutcome` ledger (`genericActions.ts:636–665` versus `:496–513`).

Inference: a successful remote mutation followed by activity failure can be repeated on retry. The remote tool may supply its own idempotency, but I could not verify that universally. New `tool`, HTTP, and notify contracts need explicit retry/idempotency semantics.

### 3.6 “Pinned” does not mean all execution settings are frozen

The interpreter pins transition and concurrency bounds (`shared/workflow/interpreter.ts:350–367`). Activities shown here still resolve current workflow defaults for branch construction:

- Gate provisioning: `worker/activities/qualityGates.ts:214–221`.
- Shell execution: `worker/activities/shellStep.ts:380–381`.
- Eval gate execution: `worker/activities/runEvalNode.ts:179–180`.

That is distinct from Temporal nondeterminism: activity results are recorded. But it can change what a later activity checks within one run. Eval also reconstructs a ticket branch rather than consuming an explicit candidate branch/SHA (`runEvalNode.ts:180–191`), unlike ordinary gates’ branch override (`qualityGates.ts:209–221`).

Prioritize explicit candidate identity and settings semantics over new vocabulary.

### 3.7 Consolidation changes the meaning of `maxTransitions`

The bound counts every visited node across nested branches (`shared/workflow/interpreter.ts:336–338`, `:457–460`). Replacing five graph nodes with one changes how much work the same limit allows. A child-workflow primitive could create further work outside that shared cursor.

This is a governance change even when outputs remain equivalent. Migration needs a work-expansion model, not merely a schema codemod.

### 3.8 Cost estimates omit expensive paths and repeated execution

The estimator:

- Charges zero for built-in declarative agents because their metadata has no hint (`shared/workflow/stepRegistry.ts:567–589`).
- Cuts graph cycles to zero at a back-edge (`shared/workflow/costEstimator.ts:83–101`).
- Uses a fixed fan-out width (`:80`, `:155–156`).
- Does not multiply node cost by `onFail.retry` (`:115–144`).

Actual agent loops can execute many calls and debit per step (`worker/activities/runAgent.ts:43–51`). Actual pricing can also record unknown models as zero dollars, making USD budgets blind to them (`worker/lib/costTracking.ts:515`).

The assessment’s “honest cost model” fix—split eval—is far too small. Separate rough estimates from enforced budgets, expose uncertainty, and account for expansion/retries.

### 3.9 Shell can report success after persistence failed

A successful command with a failed push keeps `passed=true`, surfacing the failure in summary/persistence metadata (`worker/activities/shellStep.ts:450–470`). The interpreter only blocks on top-level `passed === false` (`shared/workflow/interpreter.ts:840–841`).

Templates must distinguish command success from delivered changes. That matters directly to migration/autonomous workflows and would be lost by the proposed simplified gate contract.

### 3.10 The channel fan-in rationale has drifted

Current fan-out exports structured branch results, and `terminate.result` is an input map (`shared/workflow/interpreter.ts:1367–1384`; `spec.ts:349–351`). Yet channel documentation and activity comments say the interpreter cannot surface branch text (`docs/channel-assistant.md:107–108`; `worker/activities/channelTaskPlan.ts:119`).

The missing demonstration is an end-to-end `agent → terminate.result → fanOut.pluck → synthesis agent` spec. A reducer may help formatting, but it does not replace synthesis. The assessment repeats stale narrative instead of testing the available contract.

### 3.11 Bundle reference portability is unresolved

MCP references are deployment connection UUIDs (`shared/workflow/spec.ts:270–271`), while bundle validation checks graph/schema errors without resolving those references (`shared/bundle/index.ts:520–529`). Gateway advisory checks explicitly expect UUIDs (`gateway/lib/specRefValidation.ts:79–88`).

A signed portable bundle needs environment binding or installation-time remapping for connections. Adding a sample MCP template with a baked-in UUID does not solve that extension-contract problem.

### 3.12 Autopilot is insufficiently assessed

The assessment maps trigger surfaces to “n/a” and then proposes new action primitives. But the surfaced autonomy mechanism is policy decision → approval → mutation (`shared/workflow/templates/authoring/policyGatedWrite.ts:29–37`), and channel delegation checks budget before launching (`worker/workflows/channelAssistant.ts:316–323`).

Those launch/write controls are precisely what a generalized composition or tool node must preserve. I could not verify a separately named autopilot node/runtime in the inspected source; I will not invent one. The concrete omission is that the proposal does not carry launch admission and mutation governance into its new contracts.

## 4. Rank

### The three changes I would make

1. **Unify governance and idempotency at external mutation boundaries.**  
   Cover `writeOutcome`, mutating `runTool`, and MCP calls with explicit risk, approval, and retry contracts. The discrepancy is executable today, not hypothetical: `worker/activities/genericActions.ts:420–437`, `:549–561`, `:636–665`. This outranks syntax consolidation because it affects what autonomous workflows may actually do.

2. **Repair the authoring/runtime contract without changing node identities.**  
   Add the missing human/eval forms and lint, and reconcile optional container commands with runtime requirements. These defects block authoring or admit runnable-looking specs that fail: `web/components/workflow/NodeInspector.tsx:89–94`; `shared/workflow/validateSpec.ts:69–95`; `worker/activities/containerStep.ts:59–62`. Retaining existing types avoids unnecessary replay and bundle migration.

3. **Add optional batched quality-gate execution as a step.**  
   Keep existing gate names, preserve evidence and branch identity, and explicitly define isolation and selective retries. Current per-gate provisioning is concrete (`worker/activities/qualityGates.ts:262–274`), so this has a plausible measurable payoff. Benchmark it before making it the default.

### The three changes most likely to waste effort

1. **Merging human node types.** The actual validation protocols remain different; the work relocates complexity while consuming stored-spec, inbox, gateway, and replay compatibility effort (`gateway/lib/hitlResolve.ts:153–235`, `:337–429`).

2. **Merging shell and container steps.** The claimed equivalence is false. Repository persistence and stateless JSON capabilities warrant separate contracts (`worker/activities/shellStep.ts:384–449`; `containerStep.ts:103–137`).

3. **Adding a fixed `parallel` node.** It saves a literal-array initializer while adding another complete execution/editor/replay surface. Existing task metadata already expresses the static use case (`shared/workflow/templates/parallelFanOut.ts:90–108`; `worker/workflows/runnable.replay.test.ts:154–178`).

The assessment should be revised before driving implementation: correct the census, withdraw the false semantic equivalences, and rank execution-contract defects ahead of vocabulary reduction.