import { proxyActivities } from '@temporalio/workflow';
import type * as activitiesType from '../activities/index.js';
import type { RouteRunPlanInput, RouteRunPlanResult } from '../activities/routeRunPlan.js';
import { T_2M } from './proxyOptions.js';

/**
 * RunPlanRouteWorkflow — rank the templates a requester may launch for a stated goal.
 *
 * Kept separate from {@link RunPlanGenerationWorkflow}: routing is one cheap call the dashboard
 * makes while the person is still typing, generation is a slower job the person chooses to start,
 * and neither's failure should hide the other. A couple of retries cover a transient provider blip;
 * a router failure leaves the user with "generate new".
 *
 * V8-isolate rule: only `import type` from external packages / activities;
 * runtime imports come from `@temporalio/workflow` and the activity proxy.
 */
const { routeRunPlan } = proxyActivities<Pick<typeof activitiesType, 'routeRunPlan'>>({
  retry: { maximumAttempts: 2 },
  startToCloseTimeout: T_2M,
});

export async function RunPlanRouteWorkflow(input: RouteRunPlanInput): Promise<RouteRunPlanResult> {
  return routeRunPlan(input);
}
