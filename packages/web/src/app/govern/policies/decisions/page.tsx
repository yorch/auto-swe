'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Input } from '@/components/ui/Input';
import { PageHeader } from '@/components/ui/PageHeader';
import { Pagination } from '@/components/ui/Pagination';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { Table, TableStatusRow, Td, THead, Th, TRow } from '@/components/ui/Table';
import { useAutonomyDecisions } from '@/hooks/useAutonomyPolicies';
import { formatDate } from '@/lib/utils';

const LIMIT = 50;

export default function AutonomyDecisionsPage() {
  const [form, setForm] = useState({
    actorId: '',
    event: '',
    policyName: '',
    riskClass: '',
    runId: '',
  });
  const [filters, setFilters] = useState(form);
  const [offset, setOffset] = useState(0);

  const { data, isLoading, isError, isFetching, refetch, error } = useAutonomyDecisions({
    ...filters,
    limit: LIMIT,
    offset,
  });

  function applyFilters(e: React.FormEvent) {
    e.preventDefault();
    setFilters(form);
    setOffset(0);
  }

  function clearFilters() {
    const empty = { actorId: '', event: '', policyName: '', riskClass: '', runId: '' };
    setForm(empty);
    setFilters(empty);
    setOffset(0);
  }

  const total = data?.meta.total ?? 0;
  const hasMore = offset + (data?.data.length ?? 0) < total;

  return (
    <div className="space-y-8">
      <Link className="label-mono hover:text-paper-200" href="/govern/policies">
        ← Autonomy policies
      </Link>
      <PageHeader
        chapter="§ Govern"
        subtitle="Every auto-run or approval-required decision the autonomy policies made, newest first."
        title="Autonomy decisions"
      />

      <form
        className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3"
        onSubmit={applyFilters}
      >
        <Input
          aria-label="Filter by policy name"
          onChange={(e) => setForm((f) => ({ ...f, policyName: e.target.value }))}
          placeholder="Policy name"
          value={form.policyName}
        />
        <Input
          aria-label="Filter by risk class"
          onChange={(e) => setForm((f) => ({ ...f, riskClass: e.target.value }))}
          placeholder="Risk class"
          value={form.riskClass}
        />
        <Input
          aria-label="Filter by event"
          onChange={(e) => setForm((f) => ({ ...f, event: e.target.value }))}
          placeholder="Event"
          value={form.event}
        />
        <Input
          aria-label="Filter by actor ID"
          onChange={(e) => setForm((f) => ({ ...f, actorId: e.target.value }))}
          placeholder="Actor ID (UUID)"
          value={form.actorId}
        />
        <Input
          aria-label="Filter by run ID"
          onChange={(e) => setForm((f) => ({ ...f, runId: e.target.value }))}
          placeholder="Run ID (UUID)"
          value={form.runId}
        />
        <div className="flex items-end gap-2">
          <Button type="submit" variant="primary">
            Filter
          </Button>
          <Button onClick={clearFilters} type="button" variant="ghost">
            Clear
          </Button>
        </div>
      </form>

      <QueryBoundary
        error={error}
        isError={isError}
        isFetching={isFetching}
        isLoading={isLoading}
        label="autonomy decisions"
        loadingMessage="loading decisions…"
        onRetry={() => void refetch()}
      >
        <Card className="overflow-hidden p-0" variant="inset">
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
                  <Td className="px-4 py-2 text-paper-300">{row.event}</Td>
                  <Td className="px-4 py-2 text-paper-400">{row.policyName ?? '—'}</Td>
                  <Td className="px-4 py-2 text-paper-400">{row.riskClass ?? '—'}</Td>
                  <Td className="px-4 py-2 font-mono text-xs text-paper-500">
                    {row.actorId ?? 'system'}
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
          onNext={() => setOffset((o) => o + LIMIT)}
          onPrev={() => setOffset((o) => Math.max(0, o - LIMIT))}
          rangeEnd={Math.min(offset + LIMIT, total)}
          rangeStart={offset + 1}
          total={total}
        />
      )}
    </div>
  );
}
