import { proxyActivities } from '@temporalio/workflow';
import type { discoverModels as discoverModelsType } from '../activities/discoverModels.js';
import { RETRY_SCHEDULED, T_10M } from './proxyOptions.js';

const { discoverModels } = proxyActivities<{
  discoverModels: typeof discoverModelsType;
}>({
  retry: RETRY_SCHEDULED,
  startToCloseTimeout: T_10M,
});

export type ScheduledModelDiscoveryResult = Awaited<ReturnType<typeof discoverModelsType>>;

/**
 * Ask each configured provider which models it lists, on the cadence set by
 * `models.discoveryInterval`. One activity: the provider calls run in parallel
 * inside it and each already survives its own failure.
 */
export async function ScheduledModelDiscoveryWorkflow(): Promise<ScheduledModelDiscoveryResult> {
  return discoverModels();
}
