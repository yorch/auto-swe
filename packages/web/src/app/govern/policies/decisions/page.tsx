'use client';

import { KNOWN_RISK_CLASSES } from '@auto-swe/shared/lib/autonomyPolicy';
import Link from 'next/link';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Combobox } from '@/components/ui/Combobox';
import { EmptyState } from '@/components/ui/EmptyState';
import { Input } from '@/components/ui/Input';
import { PageHeader } from '@/components/ui/PageHeader';
import { Pagination } from '@/components/ui/Pagination';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { Select } from '@/components/ui/Select';
import { Table, TableStatusRow, Td, THead, Th, TRow } from '@/components/ui/Table';
import { useAutonomyDecisions, useAutonomyPolicies } from '@/hooks/useAutonomyPolicies';
import { useUrlParams } from '@/hooks/useUrlParams';
import { useUsers } from '@/hooks/useUsers';
import { eventLabel, KNOWN_AUTONOMY_EVENTS, riskClassLabel } from '@/lib/autonomyEvents';
import { formatDate } from '@/lib/utils';

const LIMIT = 50;

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
  const { params, update } = useUrlParams();
  // Filters and page live in the URL, so a filtered view can be shared and survives a reload.
  const filters: Filters = {
    actorId: params.get('actorId') ?? '',
    event: params.get('event') ?? '',
    policyName: params.get('policyName') ?? '',
    riskClass: params.get('riskClass') ?? '',
    runId: params.get('runId') ?? '',
  };
  const offset = Math.max(0, Number(params.get('offset')) || 0);

  const { data, isLoading, isError, error } = useAutonomyDecisions({
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
    <div className="space-y-8">
      <Link className="label-mono hover:text-paper-200" href="/govern/policies">
        ← Autonomy policies
      </Link>
      <PageHeader
        chapter="§ Govern"
        subtitle="Every automatic or approval-required decision the autonomy policies made, newest first."
        title="Autonomy decisions"
      />

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
          hint="Paste a run ID to see only that run's decisions."
          label="Run ID"
          onChange={(e) => setFilter('runId', e.target.value.trim())}
          value={filters.runId}
        />
        <div className="flex items-end">
          <Button
            disabled={!anyFilter}
            onClick={() => navigate({ ...EMPTY, offset: 0 })}
            variant="ghost"
          >
            Clear filters
          </Button>
        </div>
      </div>

      <QueryBoundary
        error={error}
        isError={isError}
        isLoading={isLoading}
        label="autonomy decisions"
        loadingMessage="loading decisions…"
      >
        <Card className="overflow-x-auto p-0" variant="inset">
          <Table className="text-left">
            <THead className="text-paper-400">
              <Th variant="dense">Created</Th>
              <Th variant="dense">Event</Th>
              <Th variant="dense">Policy</Th>
              <Th variant="dense">Risk class</Th>
              <Th variant="dense">Actor</Th>
              <Th variant="dense">Run</Th>
            </THead>
            <tbody>
              {data?.data.map((row) => (
                <TRow hover key={row.id}>
                  <Td className="px-4 py-2 text-paper-300">{formatDate(row.createdAt)}</Td>
                  <Td className="px-4 py-2 text-paper-300">{eventLabel(row.event)}</Td>
                  <Td className="px-4 py-2 text-paper-400">{row.policyName ?? '—'}</Td>
                  <Td className="px-4 py-2 text-paper-400">
                    {row.riskClass ? riskClassLabel(row.riskClass) : '—'}
                  </Td>
                  <Td className="px-4 py-2 text-xs text-paper-400">
                    {row.actorId ? (emailById.get(row.actorId) ?? 'Unknown user') : 'System'}
                  </Td>
                  <Td className="px-4 py-2 font-mono text-xs">
                    <Link
                      className="text-ember-400 hover:underline"
                      href={`/runs/${row.runId}`}
                      title={row.runId}
                    >
                      {row.runId.slice(0, 8)}
                    </Link>
                  </Td>
                </TRow>
              ))}
              {(!data || data.data.length === 0) && (
                <TableStatusRow colSpan={6}>
                  <EmptyState title="No autonomy decisions found." />
                </TableStatusRow>
              )}
            </tbody>
          </Table>
        </Card>
      </QueryBoundary>

      {total > 0 && (
        <Pagination
          hasNext={hasMore}
          hasPrev={offset > 0}
          onNext={() => navigate({ offset: offset + LIMIT })}
          onPrev={() => navigate({ offset: Math.max(0, offset - LIMIT) })}
          rangeEnd={Math.min(offset + LIMIT, total)}
          rangeStart={offset + 1}
          total={total}
        />
      )}
    </div>
  );
}
