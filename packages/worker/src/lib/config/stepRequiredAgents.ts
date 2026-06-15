import type { ModelBackedAgentKey } from './types.js';

/**
 * The model-role(s) each runnable step resolves at execution time — the data
 * `assertConfigReady` uses to compute *what the worker actually needs* instead
 * of a hardcoded list.
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
 */
export const STEP_REQUIRED_AGENTS: Record<string, readonly ModelBackedAgentKey[]> = {
  commitToMemory: ['commitToMemory'],
  executeCIFixImplementation: ['implementer', 'securityReview'],
  executeGateFixImplementation: ['implementer', 'securityReview'],
  executeImplementation: ['implementer', 'securityReview'],
  executeReviewFixImplementation: ['implementer', 'securityReview'],
  planDecomposition: ['planner'],
  resolveMergeConflict: ['implementer'],
  runReviewNetwork: ['reviewer'],
  validateContext: ['validateContext'],
};

/**
 * The deduplicated set of agent (model) roles required by *some* registered
 * step. `assertConfigReady` requires a GLOBAL `ModelRoleConfig` + resolvable
 * credential for each of these. Roles no registered step needs are ignored.
 *
 * Forward note (degrade-don't-crash): this is the static, executor-declared
 * hard-fail set. When P1/P2 let templates reference arbitrary `agentRef`s,
 * those template-referenced agents must be validated as a *separate, non-fatal*
 * surface — a bad template edit should fail that template, not block worker boot.
 */
export function requiredAgentRoles(): ModelBackedAgentKey[] {
  return [...new Set(Object.values(STEP_REQUIRED_AGENTS).flat())];
}
