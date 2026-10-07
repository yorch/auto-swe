'use client';

import { KNOWN_RISK_CLASSES } from '@auto-swe/shared/lib/autonomyPolicy';
import Link from 'next/link';
import { BackLink } from '@/components/govern/BackLink';
import { RelativeTime } from '@/components/govern/RelativeTime';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Combobox } from '@/components/ui/Combobox';
import { EmptyState } from '@/components/ui/EmptyState';
import { Input } from '@/components/ui/Input';
import { SkeletonRows } from '@/components/ui/LoadingState';
import { PageHeader } from '@/components/ui/PageHeader';
import { Pagination } from '@/components/ui/Pagination';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { Select } from '@/components/ui/Select';
import { Table, TableStatusRow, Td, THead, Th, TRow } from '@/components/ui/Table';
import { useAutonomyDecisions, useAutonomyPolicies } from '@/hooks/useAutonomyPolicies';
import { parseOffset, useUrlFilters } from '@/hooks/useUrlFilters';
import { useUsers } from '@/hooks/useUsers';
import { eventLabel, KNOWN_AUTONOMY_EVENTS, riskClassLabel } from '@/lib/autonomyEvents';

const LIMIT = 50;

/** Approvals read as go, rejections as stop; anything else stays neutral. */
const EVENT_TONE: Record<string, BadgeTone> = {
  approve: 'moss',
  approve_partial: 'amber',
  publish: 'dust',
  reject: 'brick',
};

type Filters = {
  actorId: string;
  event: string;
  policyName: string;
  riskClass: string;
  runId: string;
};

const EMPTY: Filters = { actorId: '', event: '', policyName: '', riskClass: '', runId: '' };

const FILTER_KEYS = ['policyName', 'riskClass', 'event', 'actorId', 'runId'] as const;

export default function AutonomyDecisionsPage() {
  const { params, update } = useUrlFilters();
  // Filters and page live in the URL, so a filtered view can be shared and survives a reload.
  const filters: Filters = {
    actorId: params.get('actorId') ?? '',
    event: params.get('event') ?? '',
    policyName: params.get('policyName') ?? '',
    riskClass: params.get('riskClass') ?? '',
    runId: params.get('runId') ?? '',
  };
  const offset = parseOffset(params.get('offset'));

  const { data, isLoading, isError, isFetching, refetch, error } = useAutonomyDecisions({
    ...filters,
    limit: LIMIT,
    offset,
  });
  const { data: policies } = useAutonomyPolicies();
  const { data: users } = useUsers();
  const emailById = new Map((users ?? []).map((u) => [u.id, u.email]));

  function navigate(next: Partial<Filters> & { offset?: number }) {
    const { offset: nextOffset, ...changed } = next;
    update({ ...changed, offset: nextOffset ? String(nextOffset) : null });
  }

  // A filter change goes back to the first page.
  const setFilter = (key: keyof Filters, value: string) => navigate({ [key]: value, offset: 0 });

  const total = data?.meta.total ?? 0;
  const hasMore = offset + (data?.data.length ?? 0) < total;
  const anyFilter = FILTER_KEYS.some((k) => filters[k]);

  const eventOptions = [
    ...new Set([...KNOWN_AUTONOMY_EVENTS, ...(data?.data ?? []).map((r) => r.event)]),
  ].map((value) => ({ label: eventLabel(value), value }));
  const policyNames = [...new Set((policies ?? []).map((p) => p.name))].sort();

  return (
    <div className="space-y-6">
      <BackLink href="/govern/policies" label="Autonomy policies" />
      <PageHeader
        subtitle="Every automatic or approval-required decision the autonomy policies made, newest first."
        title="Autonomy decisions"
      />

      <Card className="p-4 sm:p-6">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Select
            label="Policy"
            onChange={(v) => setFilter('policyName', v)}
            options={[
              { label: 'All policies', value: '' },
              ...policyNames.map((n) => ({ label: n, value: n })),
            ]}
            value={filters.policyName}
          />
          <Select
            label="Risk class"
            onChange={(v) => setFilter('riskClass', v)}
            options={[
              { label: 'All risk classes', value: '' },
              ...KNOWN_RISK_CLASSES.map((c) => ({ label: c.label, value: c.key })),
            ]}
            value={filters.riskClass}
          />
          <Select
            label="Event"
            onChange={(v) => setFilter('event', v)}
            options={[{ label: 'All events', value: '' }, ...eventOptions]}
            value={filters.event}
          />
          <Combobox
            emptyMessage="No user matches"
            label="Decided by"
            onChange={(v) => setFilter('actorId', v)}
            options={(users ?? []).map((u) => ({ label: u.email, value: u.id }))}
            placeholder="Anyone"
            value={filters.actorId}
          />
          <Input
            className="font-mono"
            hint="Paste a run ID to see only that run's decisions."
            label="Run ID"
            onChange={(e) => setFilter('runId', e.target.value.trim())}
            value={filters.runId}
          />
          <div className="flex items-start justify-end sm:pt-6">
            <Button
              disabled={!anyFilter}
              onClick={() => navigate({ ...EMPTY, offset: 0 })}
              variant="ghost"
            >
              Clear filters
            </Button>
          </div>
        </div>

        <div className="mt-6 border-t border-ink-600 pt-2">
          <QueryBoundary
            error={error}
            isError={isError}
            isFetching={isFetching}
            isLoading={false}
            label="autonomy decisions"
            onRetry={() => void refetch()}
          >
            {isLoading ? (
              <SkeletonRows rows={6} />
            ) : (
              <Table stacked>
                <THead>
                  <Th className="pl-0" variant="plain">
                    Decision
                  </Th>
                  <Th variant="plain">Risk class</Th>
                  <Th variant="plain">Policy</Th>
                  <Th variant="plain">Decided by</Th>
                  <Th variant="plain">Run</Th>
                  <Th className="pr-0" variant="plain">
                    When
                  </Th>
                </THead>
                <tbody>
                  {data?.data.map((row) => (
                    <TRow hover key={row.id}>
                      <Td className="py-3 pr-4" primary>
                        <Badge dot tone={EVENT_TONE[row.event] ?? 'neutral'} variant="outline">
                          {eventLabel(row.event)}
                        </Badge>
                      </Td>
                      <Td className="px-4 py-3 text-[13px] text-paper-200" label="Risk class">
                        {row.riskClass ? (
                          riskClassLabel(row.riskClass)
                        ) : (
                          <span className="text-paper-500">—</span>
                        )}
                      </Td>
                      <Td className="px-4 py-3 text-[13px] text-paper-300" label="Policy">
                        {row.policyName ?? <span className="text-paper-500">—</span>}
                      </Td>
                      <Td className="px-4 py-3 text-[13px] text-paper-300" label="Decided by">
                        {row.actorId ? (
                          (emailById.get(row.actorId) ?? 'Unknown user')
                        ) : (
                          <span className="text-paper-500">System</span>
                        )}
                      </Td>
                      <Td className="px-4 py-3" label="Run">
                        <Link
                          className="font-mono text-xs text-ember-400 hover:underline"
                          href={`/runs/${row.runId}`}
                          title={row.runId}
                        >
                          {row.runId.slice(0, 8)}
                        </Link>
                      </Td>
                      <Td className="py-3 pl-4 text-[13px] text-paper-400" label="When">
                        <RelativeTime value={row.createdAt} />
                      </Td>
                    </TRow>
                  ))}
                  {(!data || data.data.length === 0) && (
                    <TableStatusRow colSpan={6}>
                      {anyFilter ? (
                        <EmptyState
                          action={
                            <Button onClick={() => navigate({ ...EMPTY, offset: 0 })} size="sm">
                              Clear filters
                            </Button>
                          }
                          hint="Try a different policy, risk class or event."
                          icon="search"
                          title="No decisions match these filters"
                        />
                      ) : (
                        <EmptyState
                          hint="Decisions appear here when a run reaches a step an autonomy policy governs."
                          icon="gavel"
                          title="No autonomy decisions yet"
                        />
                      )}
                    </TableStatusRow>
                  )}
                </tbody>
              </Table>
            )}
          </QueryBoundary>
          {total > 0 && (
            <div className="mt-4 border-t border-ink-600 pt-4">
              <Pagination
                hasNext={hasMore}
                hasPrev={offset > 0}
                onNext={() => navigate({ offset: offset + LIMIT })}
                onPrev={() => navigate({ offset: Math.max(0, offset - LIMIT) })}
                rangeEnd={Math.min(offset + LIMIT, total)}
                rangeStart={offset + 1}
                total={total}
              />
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}
