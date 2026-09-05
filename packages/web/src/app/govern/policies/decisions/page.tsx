'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { LoadingState } from '@/components/ui/LoadingState';
import { PageHeader } from '@/components/ui/PageHeader';
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

  const { data, isLoading } = useAutonomyDecisions({ ...filters, limit: LIMIT, offset });

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
      <PageHeader chapter="§ Govern" title="Autonomy Decisions" />

      <form
        className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3"
        onSubmit={applyFilters}
      >
        <Input
          onChange={(e) => setForm((f) => ({ ...f, policyName: e.target.value }))}
          placeholder="Policy name"
          value={form.policyName}
        />
        <Input
          onChange={(e) => setForm((f) => ({ ...f, riskClass: e.target.value }))}
          placeholder="Risk class"
          value={form.riskClass}
        />
        <Input
          onChange={(e) => setForm((f) => ({ ...f, event: e.target.value }))}
          placeholder="Event"
          value={form.event}
        />
        <Input
          onChange={(e) => setForm((f) => ({ ...f, actorId: e.target.value }))}
          placeholder="Actor ID (UUID)"
          value={form.actorId}
        />
        <Input
          onChange={(e) => setForm((f) => ({ ...f, runId: e.target.value }))}
          placeholder="Run ID (UUID)"
          value={form.runId}
        />
        <div className="flex gap-2">
          <Button type="submit" variant="primary">
            Filter
          </Button>
          <Button onClick={clearFilters} type="button" variant="ghost">
            Clear
          </Button>
        </div>
      </form>

      {isLoading && <LoadingState message="loading decisions…" />}

      {!isLoading && (
        <div className="border border-ink-600 rounded-lg overflow-hidden">
          <table className="w-full text-left text-sm">
            <thead className="bg-ink-700 text-paper-400">
              <tr>
                <th className="px-4 py-2 font-medium">Created</th>
                <th className="px-4 py-2 font-medium">Event</th>
                <th className="px-4 py-2 font-medium">Policy</th>
                <th className="px-4 py-2 font-medium">Risk class</th>
                <th className="px-4 py-2 font-medium">Actor</th>
                <th className="px-4 py-2 font-medium">Run</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-600">
              {data?.data.map((row) => (
                <tr className="hover:bg-ink-700/30" key={row.id}>
                  <td className="px-4 py-2 text-paper-300">{formatDate(row.createdAt)}</td>
                  <td className="px-4 py-2 text-paper-300">{row.event}</td>
                  <td className="px-4 py-2 text-paper-400">{row.policyName ?? '—'}</td>
                  <td className="px-4 py-2 text-paper-400">{row.riskClass ?? '—'}</td>
                  <td className="px-4 py-2 font-mono text-xs text-paper-500">
                    {row.actorId ?? 'system'}
                  </td>
                  <td className="px-4 py-2 font-mono text-xs text-paper-500">{row.runId}</td>
                </tr>
              ))}
              {(!data || data.data.length === 0) && (
                <tr>
                  <td className="px-4 py-8 text-center text-paper-400" colSpan={6}>
                    No autonomy decisions found.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

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
