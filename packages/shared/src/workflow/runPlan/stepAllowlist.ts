/**
 * The steps and node types a generated run plan may use.
 *
 * A generated plan is a deterministic skeleton plus a free middle. The middle is composed from this
 * catalog and nothing else. Every step in the registry is classified here exactly once, in one of
 * three classes, and `stepAllowlist.test.ts` fails when a registered step is in none of them or in
 * two, so adding a step forces an explicit decision about whether a generated plan may use it:
 *
 * - **free**: no external effect beyond the run's own record and bounded reads. Usable in either
 *   plan mode.
 * - **skeleton**: operates on the run's repository checkout, branch or pull request. Usable only in
 *   a `delivering` plan, and every use is held to the skeleton policy's configuration allowlist
 *   (`skeletonPolicy.ts`), not just to this list.
 * - **denied**: never usable in a generated plan. Each entry carries the reason, so a refusal can
 *   say why and a reviewer can see the decision.
 *
 * Pure and I/O-free. The classification is by step name; node types that run authored or external
 * code (`shell`, `containerStep`, `mcp`) are denied in {@link RUN_PLAN_DENIED_NODE_TYPES}.
 */

import type { Node } from '../spec.js';

/** The two plan shapes: an implementer plan that opens a pull request, or a library-agent plan. */
export type SkeletonMode = 'delivering' | 'output-only';

/** Steps with no external effect: reads, planning, parsing and the run's own status. */
export const RUN_PLAN_FREE_STEPS: ReadonlySet<string> = new Set([
  'analyzePrd',
  'decomposePrd',
  'gatherTicketContext',
  'parseAgentOutput',
  'planDecomposition',
  'retrieveKnowledge',
  'updateDomainState',
  'validateContext',
]);

/**
 * Steps that act on the run's repository, branch or pull request. Delivering plans only; the
 * mandatory nodes and the loops that feed them are here.
 */
export const RUN_PLAN_SKELETON_STEPS: ReadonlySet<string> = new Set([
  'awaitQodoReview',
  'commitToMemory',
  'createOrUpdatePullRequest',
  'executeCIFixImplementation',
  'executeGateFixImplementation',
  'executeImplementation',
  'executeReviewFixImplementation',
  'fetchCILogs',
  'resolveCiWaitConfig',
  'runBuild',
  'runLint',
  'runQualityGates',
  'runReviewNetwork',
  'runTests',
  'runTypecheck',
  'runVulnScan',
  'uiVerify',
  'waitForCiByPolling',
]);

/** Steps a generated plan may never use, each with the reason. */
export const RUN_PLAN_DENIED_STEPS: Readonly<Record<string, string>> = {
  applyRecipe: 'applies a campaign recipe and pushes without the implementation security gate',
  captureLearning: 'writes shared memory that later runs recall',
  checkPriceListNotes: 'belongs to the model-catalog refresh template',
  createTrackerItems: 'creates items in the issue tracker (external write)',
  executePrFeedbackImplementation:
    'automation-only: re-runs the implementer on pull request feedback and pushes',
  finishCiFixPush: 'automation-only: deletes a branch after a CI-fix push',
  finishPrFeedbackPush: 'automation-only: deletes a branch after a feedback push',
  gatherPrFeedback: 'automation-only: reads a pull request feedback round',
  listProviderModels: 'reads provider model lists through platform credentials',
  loadChangeForReview: 'belongs to the code-review template (runs gates on a foreign checkout)',
  mcpCallTool: 'calls an MCP tool (external effect); the typed mcp node is denied as well',
  mergeBranches: 'merges and pushes branches',
  planChannelTask: 'channel-assistant composite runs only',
  postTicketComment: 'posts a comment to the tracker (external write)',
  publishOutcome: 'records an autonomy decision for external writes, which plans may not make',
  publishReviewResult: 'posts a review comment on a pull request',
  pushCiFixToPullRequest: 'automation-only: pushes onto an existing pull request branch',
  pushPrFeedbackToPullRequest: 'automation-only: pushes onto an existing pull request branch',
  readSource: 'reads from a target connection outside the run repository',
  repoOnboardingPr: 'opens a configuration pull request (repository setup template only)',
  repoOnboardingTrial: 'repository setup template only',
  reportCiTriage: 'automation-only: posts a CI triage comment',
  resolveMergeConflict: 'resolves conflicts and pushes a merge commit',
  resolveWorkspace: 'selects a workspace provider outside the run repository',
  respondToPrFeedback: 'automation-only: posts replies on a pull request',
  runAgentNode:
    'step spelling of an agent node; use the typed agent node so the launchable-agent lint applies',
  runAgentPrFeedbackTask: 'automation-only: pushes a follow-up to an agent run pull request',
  runAgentTask: 'internal to the Agent Run system template',
  runChannelSubtasks: 'channel-assistant composite runs only',
  runContainerStep: 'runs an authored image and command in a container',
  runEvalNode: 'step spelling of an eval node; use the typed eval node',
  runPerfBench: 'has no default command: it runs an authored command',
  runTool: 'runs a connection tool, which may write outside the platform',
  submitPrdWorkRequests: 'starts new runs',
  triageCiFailure: 'automation-only: reads a failed CI run by id',
  verifyCiFix: 'automation-only: runs a reproduction command from a triage result',
  writeOutcome: 'writes an outcome to a connection (external write)',
};

/** Node types a generated plan may never contain: they run authored code or call out. */
export const RUN_PLAN_DENIED_NODE_TYPES: Readonly<Record<string, string>> = {
  containerStep: 'runs an authored container',
  mcp: 'calls an MCP tool, which the run treats as a mutation',
  shell: 'runs an authored shell command in a container',
};

export type RunPlanStepClass = 'free' | 'skeleton' | 'denied' | 'unclassified';

/** The class of a step name. A name in no list is `unclassified`, which no plan may use. */
export function classifyRunPlanStep(name: string): RunPlanStepClass {
  if (Object.hasOwn(RUN_PLAN_DENIED_STEPS, name)) {
    return 'denied';
  }
  if (RUN_PLAN_FREE_STEPS.has(name)) {
    return 'free';
  }
  if (RUN_PLAN_SKELETON_STEPS.has(name)) {
    return 'skeleton';
  }
  return 'unclassified';
}

/** Whether a step may appear in a plan of this mode. */
export function isRunPlanStepAllowed(name: string, mode: SkeletonMode): boolean {
  const cls = classifyRunPlanStep(name);
  return cls === 'free' || (cls === 'skeleton' && mode === 'delivering');
}

/** Why a step is refused in a plan of this mode, or `undefined` when it is allowed. */
export function runPlanStepRefusal(name: string, mode: SkeletonMode): string | undefined {
  const cls = classifyRunPlanStep(name);
  if (cls === 'free') {
    return undefined;
  }
  if (cls === 'skeleton') {
    return mode === 'delivering'
      ? undefined
      : `step '${name}' acts on a repository and is only usable in a delivering plan`;
  }
  if (cls === 'denied') {
    return `step '${name}' is not allowed in a generated plan: ${RUN_PLAN_DENIED_STEPS[name]}`;
  }
  return `step '${name}' is not on the generated-plan allowlist`;
}

/** Why a node's type is refused in any generated plan, or `undefined`. */
export function runPlanNodeTypeRefusal(node: Node): string | undefined {
  return Object.hasOwn(RUN_PLAN_DENIED_NODE_TYPES, node.type)
    ? `a '${node.type}' node ${RUN_PLAN_DENIED_NODE_TYPES[node.type]}`
    : undefined;
}
