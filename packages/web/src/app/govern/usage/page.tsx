'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { DailyCostChart } from '@/components/charts/DailyCostChart';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { PageHeader } from '@/components/ui/PageHeader';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Select, type SelectOption } from '@/components/ui/Select';
import { Stat } from '@/components/ui/Stat';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { Table, TableStatusRow, Td, THead, Th, TRow } from '@/components/ui/Table';
import {
  type UsageBucket,
  type UsageScope,
  usePlatformUsage,
  useUsageScopes,
} from '@/hooks/useAdmin';
import { formatCost, formatCount, formatDuration, formatPercent, formatTokens } from '@/lib/utils';

const WINDOW_OPTIONS = [7, 30, 90].map((days) => ({ label: `${days}d`, value: String(days) }));

/** `''` is platform-wide; `team:<id>` and `org:<id>` name a tenant. */
function scopeOf(value: string): UsageScope {
  const [kind, id] = value.split(':');
  return kind === 'team' ? { teamId: id } : kind === 'org' ? { orgId: id } : {};
}

/**
 * The scopes the caller may read, as the gateway reports them. `null` until
 * they are known.
 */
function useScopeOptions(): SelectOption[] | null {
  const scopes = useUsageScopes();
  return useMemo(() => {
    if (!scopes.data) {
      return null;
    }
    return [
      ...(scopes.data.platform ? [{ label: 'Whole platform', value: '' }] : []),
      ...scopes.data.teams.map((t) => ({ label: `Team: ${t.name}`, value: `team:${t.id}` })),
      ...scopes.data.orgs.map((o) => ({ label: `Organization: ${o.name}`, value: `org:${o.id}` })),
    ];
  }, [scopes.data]);
}

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
            <TableStatusRow colSpan={6}>
              <EmptyState title="No LLM calls in this window." />
            </TableStatusRow>
          )}
          {rows.map((r) => (
            <TRow key={r.label}>
              <Td className="px-4 py-2 font-mono text-xs text-paper-300">{r.label}</Td>
              <Td align="right" className="px-4 py-2 font-mono text-xs text-paper-400">
                {formatCount(r.calls)}
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
  const scopeOptions = useScopeOptions();
  const [chosenScope, setChosenScope] = useState<string | null>(null);
  // Until the caller picks one, the first scope they may read: the whole
  // platform for an ADMIN, their first team (or organization) otherwise.
  const scopeValue = chosenScope ?? scopeOptions?.[0]?.value ?? null;
  const { data, error, isError, isFetching, refetch, isLoading } = usePlatformUsage(
    windowDays,
    scopeOf(scopeValue ?? ''),
    scopeValue !== null
  );

  return (
    <div className="space-y-8">
      <PageHeader
        actions={
          <div className="flex items-center gap-3">
            {scopeOptions && scopeOptions.length > 0 && (
              <Select
                appearance="pill"
                aria-label="Scope"
                onChange={setChosenScope}
                options={scopeOptions}
                value={scopeValue ?? ''}
              />
            )}
            <SegmentedControl
              ariaLabel="Time window"
              onChange={(v) => setWindowDays(Number(v))}
              options={WINDOW_OPTIONS}
              value={String(windowDays)}
            />
          </div>
        }
        chapter="§ Govern"
        subtitle="Every LLM and embedding call, including workflows that keep no run record, attributed to the team and organization whose spend it is. Days are UTC."
        title="LLM usage"
      />

      {scopeOptions?.length === 0 && (
        <EmptyState title="You lead no team or organization, so there is no usage you can see." />
      )}

      {/* A failed request has no data and is not loading: show the error, not a spinner. */}
      <QueryBoundary
        error={error}
        isError={isError}
        isFetching={isFetching}
        isLoading={isLoading}
        label="LLM usage"
        onRetry={() => void refetch()}
      >
        {data && (
          <>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-6">
              <Stat label="Spend" tone="ember" value={formatCost(data.totals.costUsd)} />
              <Stat label="LLM calls" value={formatCount(data.totals.calls)} />
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
              labelHeader="Team"
              rows={data.byTeam.map((r) => ({
                ...r,
                label: r.teamId ? (r.teamName ?? r.teamId) : '(no team)',
              }))}
              title="By team"
            />
            <BreakdownTable
              labelHeader="Organization"
              rows={data.byOrg.map((r) => ({
                ...r,
                label: r.orgId ? (r.orgName ?? r.orgId) : '(no organization)',
              }))}
              title="By organization"
            />
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
                    <TableStatusRow colSpan={5}>
                      <EmptyState title="No priced runs in this window." />
                    </TableStatusRow>
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
      </QueryBoundary>
    </div>
  );
}
