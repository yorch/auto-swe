import { proxyActivities } from '@temporalio/workflow';
import type {
  GenerateRunPlanSpecInput,
  GenerateRunPlanSpecResult,
} from '../activities/generateRunPlanSpec.js';
import type * as activitiesType from '../activities/index.js';
import { RETRY_SINGLE_ATTEMPT, T_2M, T_15M } from './proxyOptions.js';

/**
 * RunPlanGenerationWorkflow — generate a run plan's spec from the requester's intent.
 *
 * Started BY NAME by the gateway (`RUN_PLAN_GENERATION_WORKFLOW`), which awaits the result. Like
 * WorkflowAuthorWorkflow it only calls one activity; the activity owns the generate → policy →
 * repair loop, so a workflow-level retry would re-burn LLM tokens and is capped at one attempt.
 * Nothing about the run depends on this workflow's history: the result is recorded as an activity
 * result and the approved plan's spec is what the run pins, so a change here is not replay-affecting
 * for any run.
 *
 * V8-isolate rule: only `import type` from external packages / activities;
 * runtime imports come from `@temporalio/workflow` and the activity proxy.
 */
const { generateRunPlanSpec } = proxyActivities<Pick<typeof activitiesType, 'generateRunPlanSpec'>>(
  {
    // Every model call pumps heartbeats (`runAgent`), so a stuck worker is noticed in two minutes
    // instead of when the whole timeout runs out; a cancellation reaches the activity the same way.
    heartbeatTimeout: T_2M,
    retry: RETRY_SINGLE_ATTEMPT,
    // At most five rounds (`runPlans.generationMaxAttempts`) of the author model.
    startToCloseTimeout: T_15M,
  }
);

export async function RunPlanGenerationWorkflow(
  input: GenerateRunPlanSpecInput
): Promise<GenerateRunPlanSpecResult> {
  return generateRunPlanSpec(input);
}
