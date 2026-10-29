import { proxyActivities } from '@temporalio/workflow';
import type { detectRepoDependencies as detectRepoDependenciesType } from '../activities/detectRepoDependencies.js';
import { RETRY_SCHEDULED, T_2_MINUTES } from './proxyOptions.js';

const { detectRepoDependencies: detectDependencies } = proxyActivities<{
  detectRepoDependencies: typeof detectRepoDependenciesType;
}>({
  retry: RETRY_SCHEDULED,
  startToCloseTimeout: T_2_MINUTES,
});

export interface RepoDependencyScanOneInput {
  repoId: string;
}

/**
 * RepoDependencyScanOneWorkflow — the weekly dependency and stack scan for ONE repository.
 *
 * Started BY NAME by the gateway when a repository is onboarded, so its detected stack (the gate
 * commands, the test command and the executor image all follow it) exists from its first run
 * instead of after the next weekly sweep. Name MUST be `'RepoDependencyScanOneWorkflow'`, task
 * queue `'engineering-workflow'`, single arg `{ repoId: string }`. It runs the same activity the
 * sweep runs, so what it records is what the sweep would record.
 *
 * V8-isolate rule: only `import type` from external packages / activities; runtime imports come
 * from `@temporalio/workflow` and the activity proxy.
 */
export async function RepoDependencyScanOneWorkflow(
  input: RepoDependencyScanOneInput
): Promise<{ edgesUpserted: number; scanned: string[]; suggestions: number }> {
  return detectDependencies({ repoId: input.repoId });
}
