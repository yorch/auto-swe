import { prisma } from '../db.js';
import type { WorkflowSpec } from '../workflow/index.js';
import { runUnscoped } from './tenantGuard.js';

/**
 * The model-role(s) each runnable step resolves at execution time.
 *
 * `requiredAgentKeysForDeployment` (lib/config/deploymentAgents.ts) maps the
 * step nodes of every installed template through this to compute the boot gate,
 * so a missing entry here means an agent a runnable template needs is not
 * checked at boot and the run fails mid-flight instead — exactly what
 * `assertConfigReady` exists to prevent. `stepRequiredAgents.coverage.test.ts`
 * checks the keys against the executors registered in `runnableSteps.ts`.
 *
 * This is the import-safe companion to the step registry in
 * `workflows/runnableSteps.ts`: `assertConfigReady` runs at Node boot and must not
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
 *     so they need both `implementer` and `securityReview`. Each fix loop runs
 *     as its own persona (`ciFixer` / `reviewFixer` / `gateFixer`), which
 *     inherits the `implementer` model — so it needs the persona row and the
 *     parent its model resolves through.
 *   - `resolveMergeConflict` runs the `mergeConflictResolver` persona (model
 *     from `implementer`) and scans a resolved merge with `securityReview`.
 *   - `runReviewNetwork`'s three sub-reviewers each resolve their own persona
 *     row and bind the `reviewer` model through it.
 *   - `planDecomposition` runs the `decomposer` persona on the `planner` model.
 *   - `planChannelTask` + `runChannelSubtasks` (general-route decomposition) both
 *     run the channel's `channelAssistant` model (planner/subtask/synthesis calls).
 *
 * Agent keys are free-form strings — agents are seed data, not an enum — so this
 * is typed to match. Narrowing it to `ModelBackedAgentKey`, the pricing/UI
 * convenience set, silently kept seeded agents like `evalJudge` out of the gate.
 */
/**
 * `null` marks a step whose agent comes from the spec, not from this map.
 *
 * `runAgentNode` binds whatever `agentRef` a template node names, so no static
 * entry could exist for it — `requiredAgentKeysForDeployment` documents
 * agentRef-reached agents as deliberately outside the boot gate (they are
 * checked when the template is saved, and resolved per node at run time).
 * Saying so here rather than in a second set beside this one keeps the answer
 * where a reader is already looking, and makes "declared *and* exempt"
 * unrepresentable instead of something a test has to forbid.
 *
 * `null` rather than a string sentinel because a sentinel string is still
 * iterable: `for (const key of declared)` would quietly add `'d'`, `'y'`, `'n'`
 * … to the boot gate, and every consumer would need a guard to prevent it.
 */
export const STEP_REQUIRED_AGENTS: Record<string, readonly string[] | null> = {
  commitToMemory: ['commitToMemory'],
  executeCIFixImplementation: ['ciFixer', 'implementer', 'securityReview'],
  executeGateFixImplementation: ['gateFixer', 'implementer', 'securityReview'],
  executeImplementation: ['implementer', 'securityReview'],
  executeReviewFixImplementation: ['reviewFixer', 'implementer', 'securityReview'],
  planChannelTask: ['channelAssistant'],
  planDecomposition: ['decomposer', 'planner'],
  resolveMergeConflict: ['mergeConflictResolver', 'implementer', 'securityReview'],
  runAgentNode: null,
  // The agent comes from the launch payload, but the post-diff gate is fixed.
  runAgentTask: ['securityReview'],
  runChannelSubtasks: ['channelAssistant'],
  runEvalNode: ['evalJudge'],
  runReviewNetwork: ['securityReviewer', 'domainLogicReviewer', 'performanceReviewer', 'reviewer'],
  // The `ciTriager` persona, on the `planner` model it inherits.
  triageCiFailure: ['ciTriager', 'planner'],
  validateContext: ['validateContext'],
};

/**
 * The agent keys *this deployment* actually needs at boot.
 *
 * `requiredAgentKeys()` returns the union over the whole step catalog, which is
 * the SWE library. That made every deployment configure `implementer`,
 * `reviewer`, `planner`, `securityReview`, `validateContext`, `commitToMemory`
 * and `channelAssistant` — with credentials — before the poller would start,
 * including a deployment that runs no software-engineering workflow at all.
 *
 * The set is derived from the specs that can actually execute instead: the
 * active (and experiment) versions of every ACTIVE template, plus
 * `channelAssistant` when the deployment has Slack channels. A step nobody has
 * installed cannot run, so demanding its model is demanding configuration for
 * work that will never happen.
 *
 * What this deliberately does **not** change: agents reached through a
 * template's `agentRef` stay non-fatal here (checked at template save, resolved
 * per node at run time), and a template activated *after* boot is not
 * retroactively gated — that node fails at run time with `ConfigMissingError`,
 * the same as any other late config change.
 */

/** Step names reachable from the installed, runnable template versions. */
/** The tables the deployment's agent set is read from; the gateway passes its own client. */
type DeploymentClient = Pick<
  typeof prisma,
  'slackChannel' | 'workflowTemplate' | 'workflowTemplateVersion'
>;

export async function installedStepNames(client: DeploymentClient = prisma): Promise<Set<string>> {
  const templates = await runUnscoped(
    'the boot gate covers the whole deployment: any tenant installed template can run on this worker',
    ['WorkflowTemplate'],
    () =>
      client.workflowTemplate.findMany({
        select: { activeVersion: true, experimentVersion: true, id: true },
        where: { status: 'ACTIVE' },
      })
  );

  // Both arms of an A/B split can run, so both count as installed.
  const wanted = templates.flatMap((t) =>
    [t.activeVersion, t.experimentVersion]
      .filter((v): v is number => v !== null)
      .map((version) => ({ templateId: t.id, version }))
  );
  if (wanted.length === 0) {
    return new Set();
  }

  const versions = await client.workflowTemplateVersion.findMany({
    select: { spec: true },
    where: { OR: wanted },
  });

  const steps = new Set<string>();
  for (const { spec } of versions) {
    // The real spec type, not a local shape: this is the sole input to the boot
    // gate, so if the `step` discriminant is ever renamed this must stop
    // compiling. A structural stand-in would keep compiling, quietly return no
    // steps, and boot the worker with no LLM-config check at all.
    const nodes = (spec as WorkflowSpec | null)?.nodes;
    if (!nodes) {
      continue;
    }
    for (const node of Object.values(nodes)) {
      if (node?.type === 'step') {
        steps.add(node.step);
      } else if (node?.type === 'eval') {
        // The interpreter dispatches an `eval` node through the `runEvalNode`
        // step, whose judge scorer binds `evalJudge` — the gate must see it.
        steps.add('runEvalNode');
      }
    }
  }
  return steps;
}

/** Empty when nothing runnable is installed — boot then has no agent gate. */
export async function deploymentAgentRequirements(client: DeploymentClient = prisma): Promise<{
  keys: string[];
  steps: Set<string>;
}> {
  // Independent reads on the worker's pre-poller boot path.
  const [steps, channelCount] = await Promise.all([
    installedStepNames(client),
    runUnscoped(
      'a channel in any tenant means this worker can serve channel turns',
      ['SlackChannel'],
      () => client.slackChannel.count()
    ),
  ]);
  const keys = new Set<string>();
  for (const step of steps) {
    // Absent (resolves no model) and null (agent comes from the spec) are both
    // "nothing to gate on here"; a dynamic step's agent is checked at template
    // save instead.
    const declared = STEP_REQUIRED_AGENTS[step];
    if (!declared) {
      continue;
    }
    for (const key of declared) {
      keys.add(key);
    }
  }

  // Channel turns do not go through a step node — `ChannelAssistantWorkflow`
  // calls `runAgent` directly, and the seeded channel template is a one-node
  // trace container. So walking specs cannot see this requirement; the presence
  // of a channel is what implies it.
  if (channelCount > 0) {
    keys.add('channelAssistant');
  }

  return { keys: [...keys], steps };
}
