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
 *   - `planChannelTask` + `runChannelSubtasks` (general-route decomposition) both
 *     run the channel's `channelAssistant` model (planner/subtask/synthesis calls).
 *
 * Worked example: a template whose steps are `executeImplementation` →
 * `runReviewNetwork` → `runLint` → `createOrUpdatePullRequest`. `requiredAgentKeys()`
 * returns `['implementer', 'securityReview', 'reviewer']` (the last two steps resolve
 * no model). At boot, `assertConfigReady` calls `resolveAgent` for each; if the GLOBAL
 * `reviewer` Agent has a `modelSpec` but no `ProviderCredential` for its provider, boot
 * throws `ConfigMissingError` naming `reviewer` and the worker never starts polling —
 * instead of failing the review step mid-run.
 */
export const STEP_REQUIRED_AGENTS: Record<string, readonly ModelBackedAgentKey[]> = {
  commitToMemory: ['commitToMemory'],
  executeCIFixImplementation: ['implementer', 'securityReview'],
  executeGateFixImplementation: ['implementer', 'securityReview'],
  executeImplementation: ['implementer', 'securityReview'],
  executeReviewFixImplementation: ['implementer', 'securityReview'],
  planChannelTask: ['channelAssistant'],
  planDecomposition: ['planner'],
  resolveMergeConflict: ['implementer'],
  runChannelSubtasks: ['channelAssistant'],
  runReviewNetwork: ['reviewer'],
  validateContext: ['validateContext'],
};

/**
 * The deduplicated set of model-backed agent keys required by *some* registered
 * step. `assertConfigReady` requires a GLOBAL `Agent` (with a `modelSpec`) +
 * resolvable credential for each of these. Keys no registered step needs are ignored.
 *
 * Degrade-don't-crash: this is the static, executor-declared hard-fail set.
 * Templates that reference arbitrary `agentRef`s / `mcp` `connectionRef`s (P1/P2)
 * are NOT validated here — they're checked on a *separate, non-fatal* surface at
 * template save (`gateway/lib/specRefValidation.ts`, returns warnings) and finally
 * resolved at run time per node (`resolveAgent` throws `ConfigMissingError` for
 * that node only). A bad template edit fails that template/node, never worker boot.
 */
export function requiredAgentKeys(): ModelBackedAgentKey[] {
  return [...new Set(Object.values(STEP_REQUIRED_AGENTS).flat())];
}
