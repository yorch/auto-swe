# Workflow inventory

A catalog of the building blocks of a workflow spec: the node types the schema accepts, the
steps the step registry holds, and which built-in templates use each. It lists what exists;
[workflow-nodes.md](./workflow-nodes.md) explains how to use it. This page is generated from
the code by `yarn docs:inventory`, and a test fails when it no longer matches.

There are 15 node types, 57 registered steps (1 of them internal) and 30 built-in templates.

## Node types

Each type links to its section of [workflow-nodes.md](./workflow-nodes.md), which documents
its fields, output and failure handling. Families are the groups of the editor’s node
palette. The two Advanced types, `shell` and `containerStep`, run a container, so saving a
spec that has one needs the container-authoring permission: the team-admin role on the
template’s team, or platform admin for a global template. Outgoing edges are the fields that
name another node; a `?` marks an optional one. An executor step is the registered step a
node dispatches through — the same step a `step` node may name directly.

| Type | Family | Outgoing edges | Executor step | Built-in templates |
|---|---|---|---|---|
| [`agent`](./workflow-nodes.md#agent) | Execution | `next?` | `runAgentNode` | 8 nodes in 6 templates: `create-issue-from-brief`, `issue-to-confluence-page`, `notion-content-brand-review`, `notion-content-draft`, `product-prd-draft`, `zendesk-ticket-reply` |
| [`eval`](./workflow-nodes.md#eval) | Execution | `next?` | `runEvalNode` | — |
| [`mcp`](./workflow-nodes.md#mcp) | Execution | `next?` | `mcpCallTool` | — |
| [`step`](./workflow-nodes.md#step) | Execution | `next?` | — | 293 nodes in all 30 templates |
| [`cond`](./workflow-nodes.md#cond) | Control flow | `onFalse`, `onTrue` | — | 100 nodes in 24 templates: `address-pr-feedback`, `agent-reviewed-pr`, `approve-before-pr`, `ci-triage-and-fix`, `code-and-ci`, `consensus-review`, `create-issue`, `create-issue-from-brief`, `dependency-update`, `external-approval-gate`, `four-eyes`, `fully-supervised`, `issue-to-confluence-page`, `model-catalog-refresh`, `notion-content-brand-review`, `notion-content-draft`, `parallel-fan-out`, `product-prd-draft`, `scope-clarification`, `send-slack-update`, `staged-deploy-signals`, `ticket-to-merge`, `ticket-to-merge-qodo`, `zendesk-ticket-reply` |
| [`fanOut`](./workflow-nodes.md#fanout) | Control flow | `join`, `subgraph` | — | 2 nodes in 2 templates: `consensus-review`, `parallel-fan-out` |
| [`set`](./workflow-nodes.md#set) | Control flow | `next?` | — | 160 nodes in 22 templates: `address-pr-feedback`, `agent-reviewed-pr`, `approve-before-pr`, `ci-triage-and-fix`, `code-and-ci`, `consensus-review`, `db-migration-dry-run`, `dependency-update`, `external-approval-gate`, `four-eyes`, `fully-supervised`, `hotfix`, `human-code-review`, `model-catalog-refresh`, `parallel-fan-out`, `prd-decomposition`, `scope-clarification`, `security-triage`, `staged-deploy-signals`, `ticket-to-merge`, `ticket-to-merge-qodo`, `tiered-escalation` |
| [`signal`](./workflow-nodes.md#signal) | Control flow | `onReceive`, `onTimeout` | — | 16 nodes in 11 templates: `agent-reviewed-pr`, `approve-before-pr`, `ci-triage-and-fix`, `code-and-ci`, `consensus-review`, `dependency-update`, `external-approval-gate`, `four-eyes`, `staged-deploy-signals`, `ticket-to-merge`, `ticket-to-merge-qodo` |
| [`terminate`](./workflow-nodes.md#terminate) | Control flow | — | — | 110 nodes in all 30 templates |
| [`humanApproval`](./workflow-nodes.md#humanapproval) | Human-in-loop | `onApprove`, `onReject`, `onRequestChanges?`, `onTimeout` | — | 15 nodes in 13 templates: `approve-before-pr`, `create-issue`, `create-issue-from-brief`, `db-migration-dry-run`, `four-eyes`, `fully-supervised`, `issue-to-confluence-page`, `notion-content-brand-review`, `notion-content-draft`, `product-prd-draft`, `send-slack-update`, `tiered-escalation`, `zendesk-ticket-reply` |
| [`humanDecision`](./workflow-nodes.md#humandecision) | Human-in-loop | `onTimeout`, `options[].next` | — | 5 nodes in 5 templates: `fully-supervised`, `human-code-review`, `security-triage`, `ticket-to-merge-qodo`, `tiered-escalation` |
| [`humanInput`](./workflow-nodes.md#humaninput) | Human-in-loop | `onSubmit`, `onTimeout` | — | 2 nodes in 2 templates: `fully-supervised`, `scope-clarification` |
| [`humanReview`](./workflow-nodes.md#humanreview) | Human-in-loop | `onSubmit`, `onTimeout` | — | 4 nodes in 3 templates: `fully-supervised`, `human-code-review`, `prd-decomposition` |
| [`containerStep`](./workflow-nodes.md#containerstep) | Advanced | `next?` | `runContainerStep` | — |
| [`shell`](./workflow-nodes.md#shell) | Advanced | `next?` | — | 1 node in 1 template: `db-migration-dry-run` |

## Registered steps

The steps a `step` node can name, grouped by category. Config fields are the `config` keys
the editor’s form offers for the step, as its registry entry declares them; an executor may
read others. The agent role is the model-backed agent whose price the cost estimator uses for
the step. An internal step is refused in any template other than the system template that
owns it, and is left out of the editor’s palette. A step’s built-in template usage counts
`step` nodes naming it and, for an executor step, nodes of the type it backs.

### Agent steps

| Step | Label | Description | Config fields | Agent role | Built-in templates |
|---|---|---|---|---|---|
| `analyzePrd` | Analyse PRD | Analyse a PRD document for engineering readiness: gaps, ambiguities, missing NFRs. Returns { summary, readiness, gaps }. | `systemPrompt` | `planner` | 1 node in 1 template: `prd-decomposition` |
| `commitToMemory` | Commit to memory | Summarize the run and store a lesson in pgvector memory. | `systemPrompt` | `commitToMemory` | 16 nodes in 7 templates: `agent-reviewed-pr`, `code-and-ci`, `consensus-review`, `dependency-update`, `four-eyes`, `ticket-to-merge`, `ticket-to-merge-qodo` |
| `decomposePrd` | Decompose PRD | Decompose a PRD (plus optional PM feedback) into epics and stories with acceptance criteria. Returns { rationale, epics }. | `systemPrompt` | `planner` | 1 node in 1 template: `prd-decomposition` |
| `executeCIFixImplementation` | Apply CI fix | Re-run the implementer with CI failure logs as context. | `systemPrompt`, `tools` | `implementer` | 12 nodes in 11 templates: `address-pr-feedback`, `agent-reviewed-pr`, `ci-triage-and-fix`, `code-and-ci`, `consensus-review`, `dependency-update`, `external-approval-gate`, `four-eyes`, `staged-deploy-signals`, `ticket-to-merge`, `ticket-to-merge-qodo` |
| `executeGateFixImplementation` | Apply gate fix | Re-run the implementer with a failed gate output as context. | `systemPrompt`, `tools` | `implementer` | 1 node in 1 template: `security-triage` |
| `executeImplementation` | Execute implementation | Run the implementer agent inside a fresh Docker workspace. | `allowedPaths`, `crossRepoCheckout`, `crossRepoContext`, `systemPrompt`, `tools` | `implementer` | 20 nodes in 20 templates: `agent-reviewed-pr`, `approve-before-pr`, `ci-triage-and-fix`, `code-and-ci`, `consensus-review`, `db-migration-dry-run`, `dependency-update`, `external-approval-gate`, `four-eyes`, `fully-supervised`, `hotfix`, `human-code-review`, `model-catalog-refresh`, `parallel-fan-out`, `scope-clarification`, `security-triage`, `staged-deploy-signals`, `ticket-to-merge`, `ticket-to-merge-qodo`, `tiered-escalation` |
| `executePrFeedbackImplementation` | Address pull-request feedback | Re-run the implementer with the fenced feedback brief as context. | `systemPrompt` | `implementer` | 1 node in 1 template: `address-pr-feedback` |
| `executeReviewFixImplementation` | Apply review fix | Re-run the implementer with reviewer rejection feedback. | `allowedPaths`, `systemPrompt`, `tools` | `implementer` | 14 nodes in 12 templates: `agent-reviewed-pr`, `approve-before-pr`, `consensus-review`, `external-approval-gate`, `four-eyes`, `fully-supervised`, `human-code-review`, `model-catalog-refresh`, `scope-clarification`, `staged-deploy-signals`, `ticket-to-merge`, `ticket-to-merge-qodo` |
| `gatherTicketContext` | Gather ticket context | Read the run's tracker ticket, with its newest comments and its parent issue, and digest it into one typed result (summary, requirements, acceptance criteria, constraints, open questions). Output: `available`, `digested`, `text`, `unavailableReason`; later steps take `text`. A run with no ticket returns `available: false` without a model call, and `unavailableReason` names why the ticket could not be read (a fixed class such as `forbidden` or `not_found`, never tracker text; empty when it was read). | `systemPrompt` | `planner` | 2 nodes in 2 templates: `ticket-to-merge`, `ticket-to-merge-qodo` |
| `planChannelTask` | Plan channel task | Decompose a general channel task into 1..N independent subtasks. Returns { subtasks, subtaskCount }; returns a single subtask (the whole task) for cohesive work. | `systemPrompt` | `reviewer` | — |
| `planDecomposition` | Plan decomposition | Split a work request into feature-level subtasks (one subagent per subtask). Returns { subtasks: Subtask[] }. | `systemPrompt` | `planner` | — |
| `resolveMergeConflict` | Resolve merge conflict | Run the implementer agent against conflict markers to resolve a failed merge in-place, then push. | `maxAttemptsPerBranch`, `mergeMessagePrefix`, `systemPrompt`, `tools` | `implementer` | 1 node in 1 template: `parallel-fan-out` |
| `respondToPrFeedback` | Respond to pull-request feedback | Report a feedback round on the pull request: one marked summary comment it edits, and a reply on each answered thread. Best-effort; a skip mode posts only the reason. | `systemPrompt` | `planner` | 9 nodes in 1 template: `address-pr-feedback` |
| `runAgentNode` (backs [`agent`](./workflow-nodes.md#agent)) | Run agent | Run a library Agent by reference (the declarative agent node). Prefer the typed node: its fields are checked and it has an inspector form. | `agentRef` (required), `systemPrompt`, `userMessage` | `implementer` | 8 nodes in 6 templates: `create-issue-from-brief`, `issue-to-confluence-page`, `notion-content-brand-review`, `notion-content-draft`, `product-prd-draft`, `zendesk-ticket-reply` |
| `runAgentPrFeedbackTask` | Agent-run feedback task | Follow up on a pull request an agent run opened, with the same agent: the original task plus the fenced brief (and fenced CI logs on a follow-up) as the prompt, a fresh trusted container to commit and gate, and a non-force push to the work branch. | `systemPrompt` | `implementer` | 2 nodes in 1 template: `address-pr-feedback` |
| `runAgentTask` (internal) | Agent run (system) | Run a library agent against a repository in a throwaway workspace and optionally publish what it wrote. System template only. | — | — | — |
| `runChannelSubtasks` | Run channel subtasks | Run each planned subtask through the channel assistant (bounded concurrency) and synthesize the partial answers into one reply. Returns { text }. | `systemPrompt` | `reviewer` | — |
| `runReviewNetwork` | Run review network | Run the security / domain / performance reviewer agents in parallel. | `crossRepoContext`, `systemPrompt` | `reviewer` | 9 nodes in 9 templates: `agent-reviewed-pr`, `consensus-review`, `external-approval-gate`, `four-eyes`, `model-catalog-refresh`, `scope-clarification`, `staged-deploy-signals`, `ticket-to-merge`, `ticket-to-merge-qodo` |
| `triageCiFailure` | Triage a CI failure | Read a failed GitHub Actions run by id (payload.githubRunId / runAttempt) from the run's own repository, check the platform may act on it (not a fork, a branch, the open PR), and have the ciTriager agent classify the failure from its logs. Code decides output.decision: fix, report or skip. | `systemPrompt` | — | 1 node in 1 template: `ci-triage-and-fix` |
| `validateContext` | Validate context | Extract success criteria from the work request payload. Output: `successCriteria`, `actionable` (false when every criterion is an `AMBIGUOUS:` entry, or a successful extraction found none), `ambiguities`. | `systemPrompt` | `validateContext` | 17 nodes in 17 templates: `agent-reviewed-pr`, `approve-before-pr`, `code-and-ci`, `consensus-review`, `db-migration-dry-run`, `dependency-update`, `external-approval-gate`, `four-eyes`, `hotfix`, `human-code-review`, `parallel-fan-out`, `scope-clarification`, `security-triage`, `staged-deploy-signals`, `ticket-to-merge`, `ticket-to-merge-qodo`, `tiered-escalation` |

### Gate steps

| Step | Label | Description | Config fields | Agent role | Built-in templates |
|---|---|---|---|---|---|
| `runBuild` | Run build | Run the build command (e.g. yarn build) in the workspace. | `command`, `timeoutMs` | — | — |
| `runEvalNode` (backs [`eval`](./workflow-nodes.md#eval)) | Run eval | Run eval scorers against a value and bind an aggregate score. The judge scorer is one evalJudge LLM call. Prefer the typed node: its fields are checked and it has an inspector form. | `judgeAdvisory`, `scorers` (required), `targetValue` | `evalJudge` | — |
| `runLint` | Run lint | Run the repo lint command in the workspace and surface pass/fail. | `command`, `timeoutMs` | — | 5 nodes in 5 templates: `address-pr-feedback`, `ci-triage-and-fix`, `code-and-ci`, `hotfix`, `human-code-review` |
| `runPerfBench` | Run perf bench | Run an operator-provided performance benchmark. No default command: a node with no `command` fails rather than passing, so give it one or set `onFail: 'warn'` to make it optional. | `command`, `timeoutMs` | — | — |
| `runQualityGates` | Run quality gates | Run several quality gates, provisioning one workspace for all of them. Results are per-gate at output.gates.&lt;name&gt;; output.passed is true only when every gate ran and passed. | `gates` (required), `isolation`, `stopOnFailure` | — | — |
| `runTests` | Run tests | Run the full test suite as a hard gate (separate from implementer TDD). | `command`, `timeoutMs` | — | 6 nodes in 6 templates: `address-pr-feedback`, `approve-before-pr`, `ci-triage-and-fix`, `code-and-ci`, `dependency-update`, `model-catalog-refresh` |
| `runTypecheck` | Run typecheck | Run the repo typecheck command in the workspace. | `command`, `timeoutMs` | — | 5 nodes in 5 templates: `address-pr-feedback`, `ci-triage-and-fix`, `code-and-ci`, `hotfix`, `human-code-review` |
| `runVulnScan` | Run vuln scan | Run a vulnerability scan against the workspace dependencies. | `command`, `timeoutMs` | — | 1 node in 1 template: `security-triage` |
| `uiVerify` | Verify UI | Run the repository app preview smoke checks and configured end-to-end tests. | `branch`, `failOnConsoleErrors`, `mode`, `recordVideo`, `timeoutMs` | — | 2 nodes in 2 templates: `ticket-to-merge`, `ticket-to-merge-qodo` |
| `verifyCiFix` | Verify a CI fix | Run the command the CI triager says reproduces the failure on the failing branch, then on the fix, in a fresh workspace. Only the whole run: of a step the host reports as failed, read from the workflow file, and that the shell scanner clears is run. output.verification.status is verified, not_reproduced, still_failing or unverified; output.codeResult carries it in its notes for the pull request. Never fails the run. | — | — | 1 node in 1 template: `ci-triage-and-fix` |
| `waitForCiByPolling` | Wait for CI (polling) | Poll GitHub for the CI result of a ref instead of waiting for a webhook signal. Returns the same { passed, ... } payload the ciPipelineSignal carries. | `deadlineSec`, `graceSec`, `intervalSec`, `ref` | — | 6 nodes in 4 templates: `address-pr-feedback`, `ci-triage-and-fix`, `ticket-to-merge`, `ticket-to-merge-qodo` |

### Version-control steps

| Step | Label | Description | Config fields | Agent role | Built-in templates |
|---|---|---|---|---|---|
| `awaitQodoReview` | Wait for Qodo review | Wait for and read Qodo's review of the pull request this run opened (inputs: prUrl, headSha), so a later condition can route on its severity. Reads the review Qodo's own PR bot produces; it cannot start one. Never fails the run. | `minActionLevel`, `waitSeconds` | — | 1 node in 1 template: `ticket-to-merge-qodo` |
| `checkPriceListNotes` | Check price-list notes | Compare the pushed model catalog file with the one the change started from, and find every added or repriced row whose figure differs from the community price list (models.priceListUrl) without a "// price list says" comment. output.ok is false with output.summary as a finding for the fixer. Passes, saying why, when the list is off or unreadable. | — | — | 1 node in 1 template: `model-catalog-refresh` |
| `createOrUpdatePullRequest` | Create or update PR | Create or update the PR for this work request. | `draft` | — | 28 nodes in 20 templates: `agent-reviewed-pr`, `approve-before-pr`, `ci-triage-and-fix`, `code-and-ci`, `consensus-review`, `db-migration-dry-run`, `dependency-update`, `external-approval-gate`, `four-eyes`, `fully-supervised`, `hotfix`, `human-code-review`, `model-catalog-refresh`, `parallel-fan-out`, `scope-clarification`, `security-triage`, `staged-deploy-signals`, `ticket-to-merge`, `ticket-to-merge-qodo`, `tiered-escalation` |
| `finishCiFixPush` | Finish a pushed CI fix | Delete the run's own work branch once a fix pushed onto a pull request's branch is done with. The pull request branch itself is never touched. | — | — | 2 nodes in 1 template: `ci-triage-and-fix` |
| `finishPrFeedbackPush` | Finish a feedback round | Delete a feedback round's work branch once the round is done with it: after a push its head is the pushed commit; after a refused push or a dead end it is still the pull request's head. Anything else keeps it. The pull request's branch is never touched. | — | — | 5 nodes in 1 template: `address-pr-feedback` |
| `listProviderModels` | List provider models | List the models each provider offers through the GLOBAL provider credentials, inside the worker, and return a markdown list of ids as guidance for an implementation step. Keys never leave the worker. Fails fast if the repository does not hold the catalog file (packages/shared/src/lib/builtinModels.ts), and reports a previous refresh still open (its branch or pull request) so the run can stop before any cost. | — | — | 1 node in 1 template: `model-catalog-refresh` |
| `mergeBranches` | Merge branches | Merge N subtask branches into the parent feature branch. Aborts on conflict and reports which branch failed. | `mergeMessagePrefix` | — | 1 node in 1 template: `parallel-fan-out` |
| `pushCiFixToPullRequest` | Push a CI fix to the pull request | Push a CI fix onto the failing pull request's own branch as a fast-forward, instead of a draft pull request. Only for a run a CI-failure trigger started with the built-in template, where the trigger asks for it and an admin allows it, onto a branch that is not the default, protected or listed; output.pushed is false with the reason otherwise, for a fallback. | — | — | 2 nodes in 1 template: `ci-triage-and-fix` |
| `pushPrFeedbackToPullRequest` | Push a feedback fix to the pull request | Push a feedback fix onto the pull request's own branch as a fast-forward. Only for a run the feedback automation started with the built-in template, onto a branch that is not the default, protected or listed; output.pushed is false with the reason otherwise. | `keepWorkBranch` | — | 2 nodes in 1 template: `address-pr-feedback` |
| `reportCiTriage` | Report a CI triage | Post the CI triage diagnosis (and the fix PR, if any) on the failing pull request as one comment it edits on later failures. Best-effort; only when the payload asks for it. | — | — | 5 nodes in 1 template: `ci-triage-and-fix` |

### Control steps

| Step | Label | Description | Config fields | Agent role | Built-in templates |
|---|---|---|---|---|---|
| `captureLearning` | Capture learning | Capture a locally scoped unreviewed learning from persisted run evidence. | `content` (required), `evidence` (required), `idempotencyKey` (required), `nodeId` (required), `title` (required) | — | — |
| `createTrackerItems` | Create tracker items | Best-effort creation of epics and stories in the configured tracker (Jira / Linear / GitHub Issues). Uses onFail: warn so a tracker outage never blocks the implementation queue. | — | — | 1 node in 1 template: `prd-decomposition` |
| `fetchCILogs` | Fetch CI logs | Fetch and truncate CI logs from the given URL. | — | — | 12 nodes in 11 templates: `address-pr-feedback`, `agent-reviewed-pr`, `ci-triage-and-fix`, `code-and-ci`, `consensus-review`, `dependency-update`, `external-approval-gate`, `four-eyes`, `staged-deploy-signals`, `ticket-to-merge`, `ticket-to-merge-qodo` |
| `gatherPrFeedback` | Gather pull-request feedback | Gather one round of pull-request feedback: re-read the trigger and the pull request from the host by id, re-derive the pull request's origin from the database, keep the threads a repo member wrote, screen every comment for injection, count this source's rounds, and create the work branch at the pull request's head. output.decision decides. | — | — | 1 node in 1 template: `address-pr-feedback` |
| `mcpCallTool` (backs [`mcp`](./workflow-nodes.md#mcp)) | Call MCP tool | Call one tool on an external MCP server with the resolved inputs as arguments. Prefer the typed node: its fields are checked and it has an inspector form. | `connectionRef` (required), `tool` (required) | — | — |
| `postTicketComment` | Post ticket comment | Post one comment to the run's tracker ticket through the configured issue tracker. Output: `posted`, and a `reason` when it did not post. A run with no ticket, a platform-generated ticket id, no tracker configured, a body that is not text, a comment the tracker refuses, or a step that times out or loses its worker returns `posted: false` without failing the run; after a timeout the comment may or may not have been posted. On the GitHub tracker the ticket id names its own repository, so the step posts only when that repository is one the run targets, on the host the tracker writes to, or one an operator listed in `github.trackerIssueRepositories`; otherwise it returns `posted: false`. Credential-shaped text is masked, and on GitHub and Linear @mentions and images are neutralised. | `body` (required), `heading` | — | — |
| `publishOutcome` | Publish outcome | Evaluate the autonomy policy for an external-facing action and decide whether to auto-publish or require approval. | `action` | — | 8 nodes in 8 templates: `create-issue`, `create-issue-from-brief`, `issue-to-confluence-page`, `notion-content-brand-review`, `notion-content-draft`, `product-prd-draft`, `send-slack-update`, `zendesk-ticket-reply` |
| `readSource` | Read source | Read a source object from the target connection (page, ticket, record, issue). | — | — | 5 nodes in 5 templates: `issue-to-confluence-page`, `notion-content-brand-review`, `notion-content-draft`, `product-prd-draft`, `zendesk-ticket-reply` |
| `resolveCiWaitConfig` | Resolve CI wait config | Read the CI wait strategy (webhook signal vs. active polling) from the workflow defaults. Returns { mode, intervalSec, graceSec, deadlineSec } for a downstream cond + poll step. | — | — | 3 nodes in 3 templates: `ci-triage-and-fix`, `ticket-to-merge`, `ticket-to-merge-qodo` |
| `resolveWorkspace` | Resolve workspace | Materialise the workspace context (git repo, Notion page, Zendesk ticket, etc.) for a run. | `workspaceProvider` | — | 5 nodes in 5 templates: `issue-to-confluence-page`, `notion-content-brand-review`, `notion-content-draft`, `product-prd-draft`, `zendesk-ticket-reply` |
| `retrieveKnowledge` | Retrieve knowledge | Retrieve authorized governed knowledge as untrusted evidence. | `limit`, `query` (required) | — | — |
| `runTool` | Run connection tool | Run a named tool on a connection (e.g. fetchTicket, postMessage, createIssue). | — | — | — |
| `submitPrdWorkRequests` | Submit PRD work requests | Submit each approved story as a separate implementation work request, starting a RunnableWorkflow per story. Returns { workRequestIds }. | — | — | 1 node in 1 template: `prd-decomposition` |
| `updateDomainState` | Update domain state | Update the workflow row's currentStatus column. | `status` (required) | — | 63 nodes in 22 templates: `address-pr-feedback`, `agent-reviewed-pr`, `approve-before-pr`, `ci-triage-and-fix`, `code-and-ci`, `consensus-review`, `db-migration-dry-run`, `dependency-update`, `external-approval-gate`, `four-eyes`, `fully-supervised`, `hotfix`, `human-code-review`, `model-catalog-refresh`, `parallel-fan-out`, `prd-decomposition`, `scope-clarification`, `security-triage`, `staged-deploy-signals`, `ticket-to-merge`, `ticket-to-merge-qodo`, `tiered-escalation` |
| `writeOutcome` | Write outcome | Write a validated outcome to the target connection (page, ticket, record, issue tracker, Slack). | — | — | 13 nodes in 8 templates: `create-issue`, `create-issue-from-brief`, `issue-to-confluence-page`, `notion-content-brand-review`, `notion-content-draft`, `product-prd-draft`, `send-slack-update`, `zendesk-ticket-reply` |

### Shell steps

| Step | Label | Description | Config fields | Agent role | Built-in templates |
|---|---|---|---|---|---|
| `runContainerStep` (backs [`containerStep`](./workflow-nodes.md#containerstep)) | Run container step | Run a container-contract coded step: an ephemeral image with the inputs as JSON env, output parsed from stdout. Prefer the typed node: its fields are checked and it has an inspector form. | `command`, `cpus`, `image` (required), `memory`, `network`, `timeoutMs`, `transport` | — | — |

## Built-in templates

What each built-in template does (the first sentence of its description) and the node types
it is made of, with how many nodes of each.

| Template | Description | Nodes | Node types |
|---|---|---|---|
| `address-pr-feedback` | Address review feedback on a pull request the platform (or an agent run) opened — and, where an admin allows it, on another open pull request after an explicit… | 59 | `cond` ×16, `set` ×9, `step` ×28, `terminate` ×6 |
| `agent-reviewed-pr` | Implement the change, have the review agents check it (up to 3 attempts), open a pull request, then wait for CI. | 32 | `cond` ×4, `set` ×9, `signal` ×1, `step` ×14, `terminate` ×4 |
| `approve-before-pr` | Implement, run tests, then require explicit human approval before the pull request is opened. | 20 | `cond` ×2, `humanApproval` ×1, `set` ×4, `signal` ×1, `step` ×8, `terminate` ×4 |
| `ci-triage-and-fix` | Diagnose a failed GitHub Actions run from its logs and classify it (regression, test bug, configuration, dependency, flaky, infrastructure). | 63 | `cond` ×15, `set` ×14, `signal` ×1, `step` ×25, `terminate` ×8 |
| `code-and-ci` | Fully automated: implement the change, run lint, type checks and tests, open a pull request, then fix CI failures from the logs and push, up to 3 times. | 23 | `cond` ×2, `set` ×5, `signal` ×1, `step` ×12, `terminate` ×3 |
| `consensus-review` | Implement the change, open the pull request and wait for CI (a failing CI is fixed by the agent: 2 fix attempts, and a third failure fails the run). | 41 | `cond` ×7, `fanOut` ×1, `set` ×11, `signal` ×1, `step` ×15, `terminate` ×6 |
| `create-issue` | Create a Linear or Jira issue from a title and description. | 7 | `cond` ×1, `humanApproval` ×1, `step` ×3, `terminate` ×2 |
| `create-issue-from-brief` | Draft a Linear or Jira issue from a brief and create it after policy/approval gating. | 8 | `agent` ×1, `cond` ×1, `humanApproval` ×1, `step` ×3, `terminate` ×2 |
| `db-migration-dry-run` | Implement the migration code, run it as a dry run in a throwaway container to preview the SQL, then require a person to review the plan and approve it before… | 13 | `humanApproval` ×1, `set` ×3, `shell` ×1, `step` ×5, `terminate` ×3 |
| `dependency-update` | Implement the dependency update, run the full test suite, open a pull request, then fix CI failures from the logs and push, up to 3 times. | 21 | `cond` ×2, `set` ×5, `signal` ×1, `step` ×10, `terminate` ×3 |
| `external-approval-gate` | Implement, have the review agents check it, open a pull request and wait for CI. | 34 | `cond` ×5, `set` ×9, `signal` ×2, `step` ×12, `terminate` ×6 |
| `four-eyes` | Implement, run the agent review loop, open the PR and wait for CI (a failing CI is fixed by the agent: 2 fix attempts, and a third failure fails the run), then… | 48 | `cond` ×7, `humanApproval` ×2, `set` ×15, `signal` ×1, `step` ×17, `terminate` ×6 |
| `fully-supervised` | The most hands-on workflow: collect requirements up front, implement, show the diff for review, let the reviewer decide whether to apply their notes, then… | 20 | `cond` ×1, `humanApproval` ×1, `humanDecision` ×1, `humanInput` ×1, `humanReview` ×1, `set` ×7, `step` ×5, `terminate` ×3 |
| `hotfix` | The fastest path from ticket to open pull request. | 10 | `set` ×2, `step` ×7, `terminate` ×1 |
| `human-code-review` | Implement, run lint and type checks, then show the diff to a human reviewer before the pull request is opened. | 15 | `humanDecision` ×1, `humanReview` ×1, `set` ×4, `step` ×8, `terminate` ×1 |
| `issue-to-confluence-page` | Read a Jira or Linear issue, draft a Confluence page with the content writer, and create that page — or rewrite the one the request names — after… | 10 | `agent` ×1, `cond` ×1, `humanApproval` ×1, `step` ×5, `terminate` ×2 |
| `model-catalog-refresh` | Keep the built-in model catalog current: list each provider's live models, read the official pricing pages, update the catalog with a cited source for every… | 27 | `cond` ×6, `set` ×7, `step` ×9, `terminate` ×5 |
| `notion-content-brand-review` | Read a Notion page, draft an update, review it for brand voice and clarity, and append the result to a target Notion page. | 10 | `agent` ×2, `cond` ×1, `humanApproval` ×1, `step` ×4, `terminate` ×2 |
| `notion-content-draft` | Read a Notion source page, draft a short update with the content writer, and append it to a target Notion page. | 9 | `agent` ×1, `cond` ×1, `humanApproval` ×1, `step` ×4, `terminate` ×2 |
| `parallel-fan-out` | Validate the context, then split the work into three branches that run at the same time (feature, tests and documentation). | 22 | `cond` ×3, `fanOut` ×1, `set` ×7, `step` ×7, `terminate` ×4 |
| `prd-decomposition` | Analyse a PRD for engineering readiness, collect PM feedback, decompose it into epics and stories, get Engineering sign-off, then create tracker tickets and… | 17 | `humanReview` ×2, `set` ×5, `step` ×8, `terminate` ×2 |
| `product-prd-draft` | Analyze a product brief and draft a focused PRD with acceptance criteria, then append it to a Notion page. | 11 | `agent` ×2, `cond` ×2, `humanApproval` ×1, `step` ×4, `terminate` ×2 |
| `scope-clarification` | Ask a person for more context before the agent starts implementing. | 18 | `cond` ×2, `humanInput` ×1, `set` ×6, `step` ×7, `terminate` ×2 |
| `security-triage` | Implement, run a vulnerability scan, then ask a person how to proceed. | 13 | `humanDecision` ×1, `set` ×3, `step` ×7, `terminate` ×2 |
| `send-slack-update` | Send a Slack message to a channel. | 7 | `cond` ×1, `humanApproval` ×1, `step` ×3, `terminate` ×2 |
| `staged-deploy-signals` | Implement, have the review agents check it (up to 3 attempts), open a pull request and wait for CI. | 38 | `cond` ×6, `set` ×9, `signal` ×3, `step` ×12, `terminate` ×8 |
| `ticket-to-merge` (default) | Implement a ticket in an isolated sandbox until the tests pass, run the security, domain-logic, and performance reviewers, open a pull request, fix CI failures… | 46 | `cond` ×6, `set` ×12, `signal` ×2, `step` ×20, `terminate` ×6 |
| `ticket-to-merge-qodo` | ticket-to-merge, with a Qodo review of the final commit once CI is green: a review with an open action_required finding asks a person to continue or stop, and… | 51 | `cond` ×7, `humanDecision` ×1, `set` ×12, `signal` ×2, `step` ×21, `terminate` ×8 |
| `tiered-escalation` | After implementation, a person rates the change's risk (low, medium or high). | 13 | `humanApproval` ×2, `humanDecision` ×1, `set` ×2, `step` ×5, `terminate` ×3 |
| `zendesk-ticket-reply` | Fetch a Zendesk ticket, draft a response with the support responder, and post it back. | 10 | `agent` ×1, `cond` ×1, `humanApproval` ×1, `step` ×5, `terminate` ×2 |

## Limitations

- It lists what exists, not how it behaves: fields, edges, output and failure handling for each
  node type are in [workflow-nodes.md](./workflow-nodes.md), and a step does what its executor
  in the worker does, which this page does not describe beyond the registry description.
- Config fields are what the editor’s form offers, not a full contract: an executor can read
  keys its registry entry does not declare, and several accept a field from `inputs` instead.
- Template usage covers the built-in templates only. Teams’ own templates, bundle-installed
  templates and the system templates that own internal steps are not counted, so a step with no
  built-in usage may still be in use.
- The agent role is the cost estimator’s hint, not a binding: an `agent` node runs whichever
  library agent it references, and a step may resolve a different agent at run time.
