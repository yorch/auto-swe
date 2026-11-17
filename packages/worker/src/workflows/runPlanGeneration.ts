import { proxyActivities } from '@temporalio/workflow';
import type {
  GenerateRunPlanSpecInput,
  GenerateRunPlanSpecResult,
} from '../activities/generateRunPlanSpec.js';
import type * as activitiesType from '../activities/index.js';
import { RETRY_SINGLE_ATTEMPT, T_10M } from './proxyOptions.js';

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
    retry: RETRY_SINGLE_ATTEMPT,
    // Three rounds of the author model, each bounded by the model's own timeout.
    startToCloseTimeout: T_10M,
  }
);

export async function RunPlanGenerationWorkflow(
  input: GenerateRunPlanSpecInput
): Promise<GenerateRunPlanSpecResult> {
  return generateRunPlanSpec(input);
}
