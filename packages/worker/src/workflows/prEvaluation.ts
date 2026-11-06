import type { PrEvaluationInput } from '@auto-swe/shared/lib/prEvaluationWorkflow';
import { proxyActivities, sleep } from '@temporalio/workflow';
import type { EvaluatePullRequestResult } from '../activities/evaluatePullRequest.js';
import type * as activitiesType from '../activities/index.js';

/**
 * PrEvaluationWorkflow — evaluates one pull request at its current head. The gateway starts it
 * under `prEvaluationWorkflowId`, so a redelivered webhook is a no-op start. One activity, retried
 * a few times on a thrown error; the activity itself is idempotent per head.
 *
 * The function name is the wire contract: it must equal `PR_EVALUATION_WORKFLOW_TYPE`
 * (`prEvaluationWorkflow`), which a test pins.
 *
 * V8-isolate rule: only `import type` from external packages / activities; runtime imports come
 * from `@temporalio/workflow` and the activity proxy.
 */
const { evaluatePullRequest, reviewRunStatusForEvaluation } = proxyActivities<
  Pick<typeof activitiesType, 'evaluatePullRequest' | 'reviewRunStatusForEvaluation'>
>({
  retry: {
    backoffCoefficient: 2,
    initialInterval: '5s',
    maximumAttempts: 4,
    maximumInterval: '1m',
  },
  startToCloseTimeout: '3m',
});

export async function prEvaluationWorkflow(
  input: PrEvaluationInput
): Promise<EvaluatePullRequestResult> {
  if (input.trigger === 'review_run' && input.reviewRunId) {
    for (let attempt = 0; ; attempt += 1) {
      const status = await reviewRunStatusForEvaluation(input.reviewRunId);
      if (status === 'SUCCESS') {
        break;
      }
      if (status !== 'RUNNING' || attempt === 60) {
        return {
          outcome: 'skipped',
          reason: 'Review run did not finish successfully within five minutes',
        };
      }
      await sleep('5s');
    }
  }
  return await evaluatePullRequest(input);
}
