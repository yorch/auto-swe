import { proxyActivities } from '@temporalio/workflow';
import type { inferRepoDependencies as inferRepoDependenciesType } from '../activities/inferRepoDependencies.js';
import { RETRY_SCHEDULED, T_5_MINUTES } from './proxyOptions.js';

const { inferRepoDependencies: infer } = proxyActivities<{
  inferRepoDependencies: typeof inferRepoDependenciesType;
}>({
  retry: RETRY_SCHEDULED,
  startToCloseTimeout: T_5_MINUTES,
});

export interface InferRepoDependenciesWorkflowInput {
  repoId: string;
}

/**
 * One-shot LLM inference of likely dependency edges for a single repo.
 *
 * Deliberately NOT part of the scheduled detector sweep: inference costs a model
 * call per repo, while the manifest/git-signal detectors are free. An operator
 * asks for it per repo, and what comes back lands as `proposed` (or is
 * auto-promoted above the configured confidence threshold) rather than going
 * straight into agent context.
 */
export async function InferRepoDependenciesWorkflow(
  input: InferRepoDependenciesWorkflowInput
): Promise<{ autoPromoted: number; proposed: number }> {
  return await infer({ repoId: input.repoId });
}
