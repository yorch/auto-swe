import { proxyActivities } from '@temporalio/workflow';
import type {
  GenerateWorkflowSpecInput,
  GenerateWorkflowSpecResult,
} from '../activities/generateWorkflowSpec.js';
import type * as activitiesType from '../activities/index.js';

/**
 * WorkflowAuthorWorkflow — generate a {@link WorkflowSpec} from a natural-language
 * description.
 *
 * Started BY NAME by the gateway, which then awaits the result (this is an
 * interactive, request/response workflow, not a long-running one). The single
 * `generateWorkflowSpec` activity runs the workflowAuthor agent's
 * generate→validate→repair loop internally, so a workflow-level retry would just
 * re-burn LLM tokens — we cap it at one attempt and let the activity's own loop
 * handle invalid output.
 *
 * V8-isolate rule: only `import type` from external packages / activities;
 * runtime imports come from `@temporalio/workflow` and the activity proxy.
 */
const { generateWorkflowSpec } = proxyActivities<
  Pick<typeof activitiesType, 'generateWorkflowSpec'>
>({
  retry: { maximumAttempts: 1 },
  startToCloseTimeout: '5m',
});

export async function WorkflowAuthorWorkflow(
  input: GenerateWorkflowSpecInput
): Promise<GenerateWorkflowSpecResult> {
  return generateWorkflowSpec(input);
}
