/**
 * The model-role(s) each runnable step resolves at execution time. The table
 * lives in `@auto-swe/shared/lib/deploymentAgents` so the gateway's readiness
 * check and the worker's boot gate read one definition; see it for the rules.
 */
export { STEP_REQUIRED_AGENTS } from '@auto-swe/shared/lib/deploymentAgents';
