'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { PageHeader } from '@/components/ui/PageHeader';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { Table, Td, THead, Th, TRow } from '@/components/ui/Table';
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

  const { data, isLoading, isError, error } = useAutonomyDecisions({
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
    <div className="space-y-6">
      <PageHeader chapter="§ Govern" title="Autonomy decisions" />

      <form
        className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3"
        onSubmit={applyFilters}
      >
        <Input
          id="decision-policy"
          label="Policy name"
          onChange={(e) => setForm((f) => ({ ...f, policyName: e.target.value }))}
          placeholder="Policy name"
          value={form.policyName}
        />
        <Input
          id="decision-risk"
          label="Risk class"
          onChange={(e) => setForm((f) => ({ ...f, riskClass: e.target.value }))}
          placeholder="Risk class"
          value={form.riskClass}
        />
        <Input
          id="decision-event"
          label="Event"
          onChange={(e) => setForm((f) => ({ ...f, event: e.target.value }))}
          placeholder="Event"
          value={form.event}
        />
        <Input
          id="decision-actor"
          label="Actor ID"
          onChange={(e) => setForm((f) => ({ ...f, actorId: e.target.value }))}
          placeholder="Actor ID (UUID)"
          value={form.actorId}
        />
        <Input
          id="decision-run"
          label="Run ID"
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
        isLoading={isLoading}
        label="autonomy decisions"
        loadingMessage="loading decisions…"
      >
        <Card className="overflow-hidden p-0" variant="inset">
          <Table>
            <THead>
              <Th>Created</Th>
              <Th>Event</Th>
              <Th>Policy</Th>
              <Th>Risk class</Th>
              <Th>Actor</Th>
              <Th>Run</Th>
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
                  <Td className="px-4 py-2 font-mono text-xs text-paper-500">{row.runId}</Td>
                </TRow>
              ))}
              {(!data || data.data.length === 0) && (
                <TRow>
                  <Td className="px-4 py-8 text-center text-paper-400" colSpan={6}>
                    No autonomy decisions found.
                  </Td>
                </TRow>
              )}
            </tbody>
          </Table>
        </Card>
      </QueryBoundary>

      <div className="flex items-center justify-between text-xs text-paper-400">
        <span>
          {total === 0
            ? 'No results'
            : `${offset + 1}–${Math.min(offset + LIMIT, total)} of ${total}`}
        </span>
        <div className="flex gap-2">
          <Button
            disabled={offset === 0}
            onClick={() => setOffset((o) => Math.max(0, o - LIMIT))}
            size="sm"
            variant="ghost"
          >
            Previous
          </Button>
          <Button
            disabled={!hasMore}
            onClick={() => setOffset((o) => o + LIMIT)}
            size="sm"
            variant="ghost"
          >
            Next
          </Button>
        </div>
      </div>
    </div>
  );
}
