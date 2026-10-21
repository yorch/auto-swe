'use client';

import { useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { Select } from '@/components/ui/Select';
import { Table, Td, THead, Th, TRow } from '@/components/ui/Table';
import {
  type AgentVersionStatsRow,
  useAgentVersionStats,
  VERSION_STATS_WINDOWS,
} from '@/hooks/useAgentLibrary';
import {
  formatCount,
  formatDuration,
  formatPercent,
  formatTokens,
  formatTotalCost,
} from '@/lib/utils';

const WINDOW_OPTIONS = VERSION_STATS_WINDOWS.map((d) => ({
  label: `Last ${d} days`,
  value: String(d),
}));

/**
 * What each version of an agent (and each model it ran on) actually did: calls, errors, tokens,
 * cost and latency, from the Agent row every LLM call resolved. A description of usage, not a
 * comparison: the runs behind two versions differ in more than the version.
 */
export function AgentVersionStats({ agentId }: { agentId: string }) {
  const [days, setDays] = useState<number>(30);
  const { data, error, isError, isFetching, isLoading, refetch } = useAgentVersionStats(
    agentId,
    days
  );
  const hasData = !!data && (data.rows.length > 0 || data.unrecorded.length > 0);

  return (
    <section aria-label="Version stats" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium text-paper-100">Version stats</h3>
        <Select
          appearance="pill"
          aria-label="Window"
          onChange={(v) => setDays(Number(v))}
          options={WINDOW_OPTIONS}
          value={String(days)}
        />
      </div>
      <p className="text-xs text-paper-500">
        Per version and model, across every run that used it; not a controlled comparison — other
        agents, templates and repositories differ between runs. Days are UTC.
      </p>
      <QueryBoundary
        error={error}
        isError={isError}
        isFetching={isFetching}
        isLoading={isLoading}
        label="version stats"
        onRetry={() => void refetch()}
      >
        {data?.groupsTruncated && (
          <Alert variant="warning">
            This window has more version and model groups than one read returns, so some rows are
            missing and the figures are partial
            {data.runsTruncated ? ', and run counts are lower bounds' : ''}. Choose a shorter
            window.
          </Alert>
        )}
        {data && !data.groupsTruncated && data.runsTruncated && (
          <Alert variant="warning">
            Calls, errors, tokens and cost are complete, but this window has more runs than one read
            returns, so the run counts are lower bounds. Choose a shorter window.
          </Alert>
        )}
        {!hasData ? (
          <p className="text-sm text-paper-400">
            No recorded LLM calls for this agent in the last {days} days.
          </p>
        ) : (
          <Table>
            <THead>
              <Th variant="compact">Version</Th>
              <Th variant="compact">Model</Th>
              <Th variant="compact">Calls</Th>
              <Th variant="compact">Runs</Th>
              <Th variant="compact">Errors</Th>
              <Th variant="compact">Tokens in / out</Th>
              <Th variant="compact">Cost</Th>
              <Th variant="compact">Mean latency</Th>
            </THead>
            <tbody>
              {data.rows.map((r) => (
                <StatsRow key={`${r.agentId}|${r.model}`} row={r} />
              ))}
              {data.unrecorded.map((r) => (
                <StatsRow key={`unrecorded|${r.model}`} row={r} />
              ))}
            </tbody>
          </Table>
        )}
        {hasData && data.unrecorded.length > 0 && (
          <p className="text-xs text-paper-500">
            Unrecorded: calls with no recorded agent version (made before versions were recorded, or
            by a step that runs no agent row). They are matched on the agent key alone, so they
            include other scopes of {data.key}.
          </p>
        )}
      </QueryBoundary>
    </section>
  );
}

function StatsRow({ row }: { row: AgentVersionStatsRow }) {
  return (
    <TRow>
      <Td className="py-2 pr-3">
        {row.agentVersion !== null ? (
          <span className="tabular-nums text-paper-100">v{row.agentVersion}</span>
        ) : (
          <Badge tone="muted" variant="text">
            Unrecorded
          </Badge>
        )}
      </Td>
      <Td className="py-2 pr-3 font-mono text-xs text-paper-400">{row.model ?? '—'}</Td>
      <Td className="py-2 pr-3 tabular-nums">{formatCount(row.calls)}</Td>
      <Td className="py-2 pr-3 tabular-nums">{formatCount(row.distinctRuns)}</Td>
      <Td className="py-2 pr-3 tabular-nums">
        {formatCount(row.errors)}
        {row.calls > 0 && (
          <span className="ml-1 text-xs text-paper-500">
            ({formatPercent(row.errors / row.calls)})
          </span>
        )}
      </Td>
      <Td className="py-2 pr-3 tabular-nums text-xs">
        {formatTokens(row.inputTokens)} / {formatTokens(row.outputTokens)}
      </Td>
      <Td className="py-2 pr-3 tabular-nums">{formatTotalCost(row.costUsd)}</Td>
      <Td className="py-2 tabular-nums">{formatDuration(row.avgDurationMs)}</Td>
    </TRow>
  );
}
