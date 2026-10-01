'use client';

import Link from 'next/link';
import { useState } from 'react';
import { DailyCostChart } from '@/components/charts/DailyCostChart';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { LoadingState } from '@/components/ui/LoadingState';
import { PageHeader } from '@/components/ui/PageHeader';
import { Stat } from '@/components/ui/Stat';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { Table, Td, THead, Th, TRow } from '@/components/ui/Table';
import { type UsageBucket, usePlatformUsage } from '@/hooks/useAdmin';
import { formatCost, formatDuration, formatPercent, formatTokens } from '@/lib/utils';

const WINDOWS = [7, 30, 90] as const;

function errorRate(b: UsageBucket): number | null {
  return b.calls > 0 ? b.errors / b.calls : null;
}

/** One breakdown table: a label column plus the same usage columns every time. */
function BreakdownTable({
  title,
  labelHeader,
  rows,
}: {
  title: string;
  labelHeader: string;
  rows: (UsageBucket & { label: string })[];
}) {
  return (
    <Card className="p-0 overflow-hidden">
      <CardHeader className="px-4 pt-4">
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <Table>
        <THead className="bg-ink-800">
          <Th variant="plain">{labelHeader}</Th>
          <Th align="right" variant="plain">
            Calls
          </Th>
          <Th align="right" variant="plain">
            Tokens in / out
          </Th>
          <Th align="right" variant="plain">
            Avg latency
          </Th>
          <Th align="right" variant="plain">
            Error rate
          </Th>
          <Th align="right" variant="plain">
            Cost
          </Th>
        </THead>
        <tbody>
          {rows.length === 0 && (
            <TRow>
              <Td className="px-4 py-6 text-center text-xs text-paper-500" colSpan={6}>
                No LLM calls in this window.
              </Td>
            </TRow>
          )}
          {rows.map((r) => (
            <TRow key={r.label}>
              <Td className="px-4 py-2 font-mono text-xs text-paper-300">{r.label}</Td>
              <Td align="right" className="px-4 py-2 font-mono text-xs text-paper-400">
                {r.calls.toLocaleString()}
              </Td>
              <Td align="right" className="px-4 py-2 font-mono text-xs text-paper-400">
                {formatTokens(r.inputTokens)} / {formatTokens(r.outputTokens)}
              </Td>
              <Td align="right" className="px-4 py-2 font-mono text-xs text-paper-400">
                {formatDuration(r.avgDurationMs === null ? null : Math.round(r.avgDurationMs))}
              </Td>
              <Td
                align="right"
                className={`px-4 py-2 font-mono text-xs ${r.errors > 0 ? 'text-brick-400' : 'text-paper-400'}`}
              >
                {formatPercent(errorRate(r))}
              </Td>
              <Td align="right" className="px-4 py-2 font-mono text-xs text-paper-200">
                {formatCost(r.costUsd)}
              </Td>
            </TRow>
          ))}
        </tbody>
      </Table>
    </Card>
  );
}

export default function UsagePage() {
  const [windowDays, setWindowDays] = useState<number>(30);
  const { data, isLoading } = usePlatformUsage(windowDays);

  return (
    <div className="space-y-6">
      <PageHeader
        actions={
          <div className="flex gap-1 bg-ink-800 rounded-md p-1">
            {WINDOWS.map((days) => (
              <button
                className={`px-3 py-1 text-sm rounded transition-colors ${
                  windowDays === days
                    ? 'bg-ink-600 text-paper-100'
                    : 'text-paper-400 hover:text-paper-200'
                }`}
                key={days}
                onClick={() => setWindowDays(days)}
                type="button"
              >
                {days}d
              </button>
            ))}
          </div>
        }
        subtitle="Every LLM and embedding call across the platform, including workflows that keep no run record. Days are UTC."
        title="LLM Usage"
      />

      {isLoading || !data ? (
        <LoadingState />
      ) : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-6">
            <Stat label="Spend" tone="ember" value={formatCost(data.totals.costUsd)} />
            <Stat label="LLM calls" value={data.totals.calls.toLocaleString()} />
            <Stat
              label="Error rate"
              tone={data.totals.errors > 0 ? 'brick' : 'default'}
              value={formatPercent(errorRate(data.totals))}
            />
            <Stat label="Without a run" value={formatCost(data.unattributed.costUsd)} />
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Spend per day</CardTitle>
            </CardHeader>
            <DailyCostChart data={data.daily} />
          </Card>

          <BreakdownTable
            labelHeader="Model"
            rows={data.byModel.map((r) => ({ ...r, label: r.model ?? '(unresolved)' }))}
            title="By model"
          />
          <BreakdownTable
            labelHeader="Agent"
            rows={data.byAgent.map((r) => ({ ...r, label: r.agentKey }))}
            title="By agent"
          />
          <BreakdownTable
            labelHeader="Activity"
            rows={data.byActivity.map((r) => ({ ...r, label: r.nodeId }))}
            title="By activity"
          />

          <Card className="p-0 overflow-hidden">
            <CardHeader className="px-4 pt-4">
              <CardTitle>Costliest runs — spend in this window</CardTitle>
            </CardHeader>
            <Table>
              <THead className="bg-ink-800">
                <Th variant="plain">Run</Th>
                <Th variant="plain">Template</Th>
                <Th variant="plain">Status</Th>
                <Th align="right" variant="plain">
                  Tokens in / out
                </Th>
                <Th align="right" variant="plain">
                  Cost
                </Th>
              </THead>
              <tbody>
                {data.topRuns.length === 0 && (
                  <TRow>
                    <Td className="px-4 py-6 text-center text-xs text-paper-500" colSpan={5}>
                      No priced runs in this window.
                    </Td>
                  </TRow>
                )}
                {data.topRuns.map((r) => (
                  <TRow hover key={r.runId}>
                    <Td className="px-4 py-2">
                      <Link className="text-ember-400 hover:underline" href={`/runs/${r.runId}`}>
                        {r.externalTicketId ?? r.runId.slice(0, 8)}
                      </Link>
                    </Td>
                    <Td className="px-4 py-2 text-paper-400">{r.templateName}</Td>
                    <Td className="px-4 py-2">
                      <StatusBadge status={r.status} />
                    </Td>
                    <Td align="right" className="px-4 py-2 font-mono text-xs text-paper-400">
                      {formatTokens(r.inputTokens)} / {formatTokens(r.outputTokens)}
                    </Td>
                    <Td align="right" className="px-4 py-2 font-mono text-xs text-paper-200">
                      {formatCost(r.costUsd)}
                    </Td>
                  </TRow>
                ))}
              </tbody>
            </Table>
          </Card>
        </>
      )}
    </div>
  );
}
