import { proxyActivities } from '@temporalio/workflow';
import type { deliverCallbacks as deliverCallbacksType } from '../activities/deliverCallbacks.js';
import type { pruneCallbackDeliveries as pruneCallbackDeliveriesType } from '../activities/pruneCallbackDeliveries.js';
import { RETRY_SCHEDULED, T_10M } from './proxyOptions.js';

const { deliverCallbacks, pruneCallbackDeliveries } = proxyActivities<{
  deliverCallbacks: typeof deliverCallbacksType;
  pruneCallbackDeliveries: typeof pruneCallbackDeliveriesType;
}>({
  retry: RETRY_SCHEDULED,
  startToCloseTimeout: T_10M,
});

export type ScheduledCallbackDeliveryResult = Awaited<ReturnType<typeof deliverCallbacksType>>;
export type ScheduledCallbackDeliveryPruneResult = Awaited<
  ReturnType<typeof pruneCallbackDeliveriesType>
>;

/**
 * Send the run callbacks that are due, on the cadence set by
 * `CALLBACK_DELIVERY_ENABLED` and `CALLBACK_DELIVERY_CRON`. The outbox rows are
 * written by activities, never here: workflow code replays.
 */
export async function ScheduledCallbackDeliveryWorkflow(): Promise<ScheduledCallbackDeliveryResult> {
  return deliverCallbacks();
}

/**
 * Delete delivered and dead callback deliveries past their retention, on the
 * cadence set by `CALLBACK_DELIVERY_PRUNE_ENABLED` and `CALLBACK_DELIVERY_PRUNE_CRON`.
 */
export async function ScheduledCallbackDeliveryPruneWorkflow(): Promise<ScheduledCallbackDeliveryPruneResult> {
  return pruneCallbackDeliveries();
}
