import type {
  OnboardingPrInput,
  OnboardingPrResult,
} from '@auto-swe/shared/lib/onboardingPrWorkflow';
import { proxyActivities } from '@temporalio/workflow';
import type * as activitiesType from '../activities/index.js';

/**
 * OnboardingPrWorkflow — opens (or updates) the one pull request that adds a repository's
 * `.auto-swe/` configuration files. The gateway starts it under `onboardingPrWorkflowId`, so the
 * same request joins the same run. One activity; policy refusals are non-retryable failures, so
 * the retries only cover transient git and network errors. It never merges anything.
 *
 * The function name is the wire contract: it must equal `ONBOARDING_PR_WORKFLOW_TYPE`
 * (`onboardingPrWorkflow`), which a test pins.
 *
 * V8-isolate rule: only `import type` from external packages / activities; runtime imports come
 * from `@temporalio/workflow` and the activity proxy.
 */
const { openOnboardingPr } = proxyActivities<Pick<typeof activitiesType, 'openOnboardingPr'>>({
  retry: {
    backoffCoefficient: 2,
    initialInterval: '10s',
    maximumAttempts: 3,
    maximumInterval: '1m',
  },
  startToCloseTimeout: '10m',
});

export async function onboardingPrWorkflow(input: OnboardingPrInput): Promise<OnboardingPrResult> {
  return await openOnboardingPr(input);
}
