/**
 * Names and workflow ids of the launch-time generation workflows. The gateway starts them BY NAME
 * (it cannot import the worker's workflow code), so the strings live here, where both sides and the
 * naming table in AGENTS.md can be checked against one definition.
 */

/** Generates a run plan's spec (`generateRunPlanSpec`). Request/response. */
export const RUN_PLAN_GENERATION_WORKFLOW = 'RunPlanGenerationWorkflow';

/** Ranks the templates a requester may launch for a goal (`routeRunPlan`). Request/response. */
export const RUN_PLAN_ROUTE_WORKFLOW = 'RunPlanRouteWorkflow';

/** `runplan-<key>`: one generation. `key` is a caller-unique token (a UUID or a short hex digest). */
export function runPlanGenerationWorkflowId(key: string): string {
  return `runplan-${key}`;
}

/** `runplan-route-<key>`: one routing call. */
export function runPlanRouteWorkflowId(key: string): string {
  return `runplan-route-${key}`;
}
