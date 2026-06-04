'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Card } from '@/components/ui/Card';
import { Select } from '@/components/ui/Select';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { useAllWorkflowRuns, useWorkflowTemplates } from '@/hooks/useWorkflows';
import { formatRelativeTime } from '@/lib/utils';

const STATUS_OPTIONS = ['RUNNING', 'SUCCESS', 'FAILED', 'TIMED_OUT', 'SKIPPED', 'CANCELLED'];
const PAGE_SIZE = 50;

export default function WorkflowRunsPage() {
  const [status, setStatus] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [offset, setOffset] = useState(0);
  const { data: templates = [] } = useWorkflowTemplates();
  const { data, isLoading } = useAllWorkflowRuns({
    limit: PAGE_SIZE,
    offset,
    status: status || undefined,
    templateId: templateId || undefined,
  });

  const runs = data?.data ?? [];
  const total = data?.meta.total ?? 0;
  const hasPrev = offset > 0;
  const hasNext = offset + PAGE_SIZE < total;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-2xl font-bold">Workflow runs</h2>
        <span className="text-sm text-[var(--muted-foreground)]">{total} total</span>
      </div>

      <Card variant="inset">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <Select
            id="status"
            label="Status"
            onChange={(e) => {
              setStatus(e.target.value);
              setOffset(0);
            }}
            value={status}
          >
            <option value="">All statuses</option>
            {STATUS_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </Select>
          <Select
            id="template"
            label="Template"
            onChange={(e) => {
              setTemplateId(e.target.value);
              setOffset(0);
            }}
            value={templateId}
          >
            <option value="">All templates</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
        </div>
      </Card>

      <Card className="p-0 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[var(--border)] bg-[var(--muted)]">
              <th className="text-left px-4 py-3 font-medium">Ticket</th>
              <th className="text-left px-4 py-3 font-medium">Description</th>
              <th className="text-left px-4 py-3 font-medium">Template</th>
              <th className="text-left px-4 py-3 font-medium">Status</th>
              <th className="text-left px-4 py-3 font-medium">Started</th>
            </tr>
          </thead>
          <tbody>
            {isLoading && (
              <tr>
                <td className="px-4 py-6 text-center text-xs text-paper-500" colSpan={5}>
                  Loading…
                </td>
              </tr>
            )}
            {!isLoading && runs.length === 0 && (
              <tr>
                <td className="px-4 py-6 text-center text-xs text-paper-500" colSpan={5}>
                  No runs match these filters.
                </td>
              </tr>
            )}
            {runs.map((r) => (
              <tr
                className="border-b border-[var(--border)] hover:bg-[var(--muted)] transition-colors"
                key={r.id}
              >
                <td className="px-4 py-3">
                  <Link
                    className="text-[var(--primary)] hover:underline font-medium"
                    href={`/runs/${r.id}`}
                  >
                    {r.workRequest?.externalTicketId ?? '—'}
                  </Link>
                </td>
                <td className="px-4 py-3 text-[var(--muted-foreground)] truncate max-w-md">
                  {r.workRequest?.description ?? '—'}
                </td>
                <td className="px-4 py-3 font-mono text-xs text-[var(--muted-foreground)]">
                  v{r.templateVersion}
                </td>
                <td className="px-4 py-3">
                  <StatusBadge status={r.status} />
                </td>
                <td className="px-4 py-3 text-[var(--muted-foreground)]">
                  {formatRelativeTime(r.startedAt)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <div className="flex items-center justify-between">
        <span className="font-mono text-[10px] uppercase tracking-wider text-paper-500">
          {offset + 1}–{Math.min(offset + PAGE_SIZE, total)} of {total}
        </span>
        <div className="flex gap-2">
          <button
            className="rounded-sm border border-ink-500 px-3 py-1 font-mono text-[10px] uppercase tracking-wider text-paper-200 hover:border-ember-400 disabled:cursor-not-allowed disabled:opacity-40"
            disabled={!hasPrev}
            onClick={() => setOffset((o) => Math.max(0, o - PAGE_SIZE))}
            type="button"
          >
            ← Prev
          </button>
          <button
            className="rounded-sm border border-ink-500 px-3 py-1 font-mono text-[10px] uppercase tracking-wider text-paper-200 hover:border-ember-400 disabled:cursor-not-allowed disabled:opacity-40"
            disabled={!hasNext}
            onClick={() => setOffset((o) => o + PAGE_SIZE)}
            type="button"
          >
            Next →
          </button>
        </div>
      </div>
    </div>
  );
}
