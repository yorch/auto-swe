/**
 * The model-role(s) each runnable step resolves at execution time.
 *
 * `requiredAgentKeysForDeployment` (lib/config/deploymentAgents.ts) maps the
 * step nodes of every installed template through this to compute the boot gate,
 * so a missing entry here means an agent a runnable template needs is not
 * checked at boot and the run fails mid-flight instead — exactly what
 * `assertConfigReady` exists to prevent. `stepRequiredAgents.coverage.test.ts`
 * checks the keys against the executors registered in `runnable.ts`.
 *
 * This is the import-safe companion to the step registry in
 * `workflows/runnable.ts`: `assertConfigReady` runs at Node boot and must not
 * import a workflow-isolate module (which pulls in `@temporalio/workflow`), so
 * the required-agent metadata lives here as plain data. **Keep this in sync
 * with `STEP_EXECUTORS`** — when a new step resolves a model via
 * `getModelSpec`/`recordLlmUsage`, add its role(s) here.
 *
 * Steps absent from this map resolve no model (pure shell / state / GitHub
 * steps such as `runLint`, `mergeBranches`, `createOrUpdatePullRequest`).
 *
 * Attribution notes (verified against the activities):
 *   - `executeImplementation` and the three fix loops run an implementer
 *     session AND a post-diff security scan (`scanDiffForSecurityIssues`),
 *     so they need both `implementer` and `securityReview`.
 *   - `runReviewNetwork`'s three sub-reviewers all bind the `reviewer` model.
 *   - `planDecomposition` binds `planner`.
 *   - `planChannelTask` + `runChannelSubtasks` (general-route decomposition) both
 *     run the channel's `channelAssistant` model (planner/subtask/synthesis calls).
 *
 * Agent keys are free-form strings — agents are seed data, not an enum — so this
 * is typed to match. Narrowing it to `ModelBackedAgentKey`, the pricing/UI
 * convenience set, silently kept seeded agents like `evalJudge` out of the gate.
 */
/**
 * A step whose agent comes from the spec, not from this map.
 *
 * `runAgentNode` binds whatever `agentRef` a template node names, so no static
 * entry could exist for it — `requiredAgentKeysForDeployment` documents
 * agentRef-reached agents as deliberately outside the boot gate (they are
 * checked when the template is saved, and resolved per node at run time).
 * Saying so here rather than in a second set beside this one keeps the answer
 * where a reader is already looking, and makes "declared *and* exempt"
 * unrepresentable instead of something a test has to forbid.
 */
export const DYNAMIC_AGENT = 'dynamic';

export const STEP_REQUIRED_AGENTS: Record<string, readonly string[] | typeof DYNAMIC_AGENT> = {
  commitToMemory: ['commitToMemory'],
  executeCIFixImplementation: ['implementer', 'securityReview'],
  executeGateFixImplementation: ['implementer', 'securityReview'],
  executeImplementation: ['implementer', 'securityReview'],
  executeReviewFixImplementation: ['implementer', 'securityReview'],
  planChannelTask: ['channelAssistant'],
  planDecomposition: ['planner'],
  resolveMergeConflict: ['implementer'],
  runAgentNode: DYNAMIC_AGENT,
  runChannelSubtasks: ['channelAssistant'],
  runEvalNode: ['evalJudge'],
  runReviewNetwork: ['reviewer'],
  validateContext: ['validateContext'],
};
