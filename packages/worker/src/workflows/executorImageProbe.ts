import { proxyActivities } from '@temporalio/workflow';
import type {
  ExecutorImageProbeResult,
  ProbeExecutorImageInput,
} from '../activities/probeExecutorImage.js';

/**
 * ExecutorImageProbeWorkflow — check a candidate executor image against the
 * workspace image contract by actually starting it as a workspace. Started BY
 * NAME by the gateway (admin-only route), which awaits the result.
 *
 * No retries: a pull or start failure is already reported as a failed check,
 * and a retry would re-pull a broken image. The timeout is generous because
 * image pulls are slow.
 *
 * V8-isolate rule: only `import type` from external packages / activities;
 * runtime imports come from `@temporalio/workflow` and the activity proxy.
 */
const { probeExecutorImage } = proxyActivities<{
  probeExecutorImage(input: ProbeExecutorImageInput): Promise<ExecutorImageProbeResult>;
}>({
  retry: { maximumAttempts: 1 },
  startToCloseTimeout: '10 minutes',
});

export async function ExecutorImageProbeWorkflow(
  input: ProbeExecutorImageInput
): Promise<ExecutorImageProbeResult> {
  return probeExecutorImage(input);
}
