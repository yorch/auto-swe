/**
 * The agents each step a generated plan may use resolves when it runs.
 *
 * A run plan pins the agent versions it was approved against, and a canonical core is made of
 * `step` nodes, not `agent` nodes: the implementer, the review network, the three fix paths, the
 * lesson writer and the post-diff security gate are all reached through a step. Without this table
 * those agents would sit outside the pin, and an edit to the implementer's prompt after approval
 * would change what the approved plan does without the approval noticing.
 *
 * An entry lists every agent KEY the step resolves, parents included: a persona that inherits its
 * model (`inheritsModelFrom`) is listed with the row it inherits from, because a change to either
 * changes the call. An empty list is a decision ("this step resolves no agent"), not an omission.
 *
 * `runPlanStepAgents.test.ts` fails when a step a plan may use (free or skeleton class) has no
 * entry, when an entry is not a superset of the deployment's `STEP_REQUIRED_AGENTS`, when an entry
 * omits the parent of a persona it names, and when an activity names an agent literal this table
 * lacks. Pure and I/O-free.
 */

export const RUN_PLAN_STEP_AGENTS: Readonly<Record<string, readonly string[]>> = {
  // Free steps.
  analyzePrd: ['prdAnalyst', 'planner'],

  // Skeleton steps.
  awaitQodoReview: [],
  commitToMemory: ['commitToMemory'],
  // The pull request title is picked by the `prTitler` agent when the title type is on auto.
  createOrUpdatePullRequest: ['prTitler'],
  decomposePrd: ['prdDecomposer', 'planner'],
  executeCIFixImplementation: ['ciFixer', 'implementer', 'securityReview'],
  executeGateFixImplementation: ['gateFixer', 'implementer', 'securityReview'],
  // The implementer session, then the post-diff security gate (`scanDiffForSecurityIssues`).
  executeImplementation: ['implementer', 'securityReview'],
  executeReviewFixImplementation: ['reviewFixer', 'implementer', 'securityReview'],
  fetchCILogs: [],
  gatherTicketContext: ['ticketContextGatherer', 'planner'],
  parseAgentOutput: [],
  planDecomposition: ['decomposer', 'planner'],
  resolveCiWaitConfig: [],
  retrieveKnowledge: [],
  runBuild: [],
  runLint: [],
  runQualityGates: [],
  runReviewNetwork: ['securityReviewer', 'domainLogicReviewer', 'performanceReviewer', 'reviewer'],
  runTests: [],
  runTypecheck: [],
  runVulnScan: [],
  uiVerify: [],
  validateContext: ['validateContext'],
  waitForCiByPolling: [],
};

/** The agent keys a step resolves; empty for an unknown step (the policy refuses those anyway). */
export function runPlanStepAgentKeys(step: string): readonly string[] {
  return Object.hasOwn(RUN_PLAN_STEP_AGENTS, step) ? (RUN_PLAN_STEP_AGENTS[step] ?? []) : [];
}
