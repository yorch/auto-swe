import type { ApprovalLatencySummary } from '@auto-swe/shared/types/api';
import { Alert } from '@/components/ui/Alert';
import { Card } from '@/components/ui/Card';
import { Stat } from '@/components/ui/Stat';
import { Table, Td, THead, Th, TRow } from '@/components/ui/Table';
import { formatDuration } from '@/lib/utils';

/**
 * How long people took to answer the human steps (approvals, decisions, inputs, reviews)
 * requested in the window. Only answered steps have a wait; the others are counted apart.
 */
export function ApprovalLatencyCard({ latency }: { latency: ApprovalLatencySummary }) {
  const total = latency.resolved.count + latency.timedOut + latency.cancelled + latency.pending;

  return (
    <Card className="p-5 sm:p-6">
      <h2 className="mb-1 text-lg font-semibold tracking-tight text-paper-50">Approval latency</h2>
      <p className="mb-4 text-sm text-paper-500">
        Time from a human step being requested to a person answering it.
      </p>
      {latency.isTruncated && (
        <Alert className="mb-4" variant="warning">
          Results capped at the 10,000 most recent steps. The figures cover only those.
        </Alert>
      )}
      {total === 0 ? (
        <p className="text-sm text-paper-400">No human steps were requested in this window.</p>
      ) : (
        <div className="space-y-6">
          <div className="grid grid-cols-1 gap-x-4 gap-y-8 sm:grid-cols-2 lg:grid-cols-4">
            <Stat
              hint={`Over ${latency.resolved.count} answered`}
              label="Wait, median"
              value={formatDuration(latency.resolved.p50Ms)}
            />
            <Stat
              hint="The slowest 1 in 20 waited at least this long"
              label="Wait, 95th percentile"
              value={formatDuration(latency.resolved.p95Ms)}
            />
            <Stat
              hint="Nobody answered before the deadline"
              label="Timed out"
              tone={latency.timedOut > 0 ? 'warning' : 'default'}
              value={latency.timedOut}
            />
            <Stat
              hint="The run ended before anyone answered"
              label="Cancelled"
              value={latency.cancelled}
            />
          </div>
          <p className="text-xs text-paper-500">
            Timed-out and cancelled steps are not in the wait figures.
            {latency.pending > 0 &&
              ` ${latency.pending} still waiting ${latency.pending === 1 ? 'is' : 'are'} left out too, so the waits read shorter than they will turn out to be.`}
          </p>

          {latency.perTemplate.length > 0 && (
            <div className="-mx-4">
              <Table className="max-sm:px-4" stacked>
                <THead>
                  <Th className="px-4" variant="compact">
                    Template
                  </Th>
                  <Th align="right" className="px-4" variant="compact">
                    Answered
                  </Th>
                  <Th align="right" className="px-4" variant="compact">
                    Median
                  </Th>
                  <Th align="right" className="px-4" variant="compact">
                    95th percentile
                  </Th>
                  <Th align="right" className="px-4" variant="compact">
                    Timed out
                  </Th>
                  <Th align="right" className="px-4" variant="compact">
                    Cancelled
                  </Th>
                  <Th align="right" className="px-4" variant="compact">
                    Waiting
                  </Th>
                </THead>
                <tbody>
                  {latency.perTemplate.map((t) => (
                    <TRow key={t.templateId}>
                      <Td className="px-4 py-2.5 font-medium text-paper-100" primary>
                        {t.templateName}
                      </Td>
                      <Td className="px-4 py-2 text-right tabular-nums" label="Answered">
                        {t.resolved.count}
                      </Td>
                      <Td className="px-4 py-2 text-right tabular-nums" label="Median">
                        {formatDuration(t.resolved.p50Ms)}
                      </Td>
                      <Td className="px-4 py-2 text-right tabular-nums" label="95th percentile">
                        {formatDuration(t.resolved.p95Ms)}
                      </Td>
                      <Td className="px-4 py-2 text-right tabular-nums" label="Timed out">
                        {t.timedOut}
                      </Td>
                      <Td className="px-4 py-2 text-right tabular-nums" label="Cancelled">
                        {t.cancelled}
                      </Td>
                      <Td className="px-4 py-2 text-right tabular-nums" label="Waiting">
                        {t.pending}
                      </Td>
                    </TRow>
                  ))}
                </tbody>
              </Table>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
