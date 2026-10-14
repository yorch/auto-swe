'use client';

import { CallbackDeliveriesTable } from '@/components/teams/TeamCallbackEndpointsSection';
import { useRunCallbackDeliveries } from '@/hooks/useCallbackEndpoints';

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
    <details className="rounded border border-ink-700 px-4 py-3 text-sm">
      <summary className="cursor-pointer text-paper-300">
        Callback
        {data.target && (
          <span className="ml-2 font-mono text-xs text-paper-500">{data.target}</span>
        )}
        <span className="ml-2 text-xs text-paper-500">
          {data.deliveries.length} {data.deliveries.length === 1 ? 'delivery' : 'deliveries'}
          {dead > 0 && `, ${dead} dead`}
        </span>
      </summary>
      <div className="mt-3">
        <CallbackDeliveriesTable rows={data.deliveries} />
      </div>
    </details>
  );
}
