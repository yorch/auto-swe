'use client';

import { CallbackDeliveriesTable } from '@/components/teams/TeamCallbackEndpointsSection';
import { useRunCallbackDeliveries } from '@/hooks/useCallbackEndpoints';
import { RunPanel } from './RunPanel';

/**
 * Where this run reports its outcome (docs/run-callbacks.md) and what came of
 * each delivery. Renders nothing for a run launched without a callback.
 */
export function RunCallbackDeliveries({ runId }: { runId: string }) {
  const { data } = useRunCallbackDeliveries(runId);
  if (!data || (!data.target && data.deliveries.length === 0)) {
    return null;
  }
  const dead = data.deliveries.filter((d) => d.status === 'DEAD').length;
  return (
    <RunPanel
      meta={
        <>
          {data.target && <span className="mr-2 font-mono">{data.target}</span>}
          {data.deliveries.length} {data.deliveries.length === 1 ? 'delivery' : 'deliveries'}
          {dead > 0 && `, ${dead} dead`}
        </>
      }
      title="Callback"
    >
      <div className="mt-3">
        <CallbackDeliveriesTable rows={data.deliveries} />
      </div>
    </RunPanel>
  );
}
