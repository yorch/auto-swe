import { proxyActivities } from '@temporalio/workflow';
import type {
  ExplainWorkflowSpecInput,
  ExplainWorkflowSpecResult,
} from '../activities/explainWorkflowSpec.js';
import type * as activitiesType from '../activities/index.js';

/**
 * WorkflowExplainWorkflow — generate a plain-language explanation of a
 * WorkflowSpec. Started BY NAME by the gateway, which awaits the result (a
 * single fast LLM call — request/response). A couple of retries cover transient
 * provider blips.
 *
 * V8-isolate rule: only `import type` from external packages / activities;
 * runtime imports come from `@temporalio/workflow` and the activity proxy.
 */
const { explainWorkflowSpec } = proxyActivities<Pick<typeof activitiesType, 'explainWorkflowSpec'>>(
  {
    retry: { maximumAttempts: 2 },
    startToCloseTimeout: '2m',
  }
);

export async function WorkflowExplainWorkflow(
  input: ExplainWorkflowSpecInput
): Promise<ExplainWorkflowSpecResult> {
  return explainWorkflowSpec(input);
}
