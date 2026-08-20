'use client';

import { WORKFLOW_RUN_STATUSES } from '@auto-swe/shared/types/api';
import Link from 'next/link';
import { useState } from 'react';
import { Card } from '@/components/ui/Card';
import { PageHeader } from '@/components/ui/PageHeader';
import { Pagination } from '@/components/ui/Pagination';
import { Select } from '@/components/ui/Select';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { useAllWorkflowRuns } from '@/hooks/useRuns';
import { useWorkflowTemplates } from '@/hooks/useTemplates';
import { formatRelativeTime } from '@/lib/utils';

const PAGE_SIZE = 50;

export default function WorkflowRunsPage() {
  const [status, setStatus] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [includeChannel, setIncludeChannel] = useState(false);
  const [offset, setOffset] = useState(0);
  const { data: templates = [] } = useWorkflowTemplates();
  const { data, isLoading } = useAllWorkflowRuns({
    includeChannel,
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
      <PageHeader chapter={`§ Runs · ${total} total`} title="Workflow runs" />

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
            {WORKFLOW_RUN_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s.replace(/_/g, ' ').toLowerCase()}
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
        <label className="mt-3 flex items-center gap-2 text-sm text-paper-400">
          <input
            checked={includeChannel}
            className="accent-ember-500"
            onChange={(e) => {
              setIncludeChannel(e.target.checked);
              setOffset(0);
            }}
            type="checkbox"
          />
          Show channel runs
        </label>
      </Card>

      <Card className="p-0 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-ink-600 bg-ink-800">
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
              <tr className="border-b border-ink-600 hover:bg-ink-800 transition-colors" key={r.id}>
                <td className="px-4 py-3">
                  <Link
                    className="text-ember-400 hover:underline font-medium"
                    href={`/runs/${r.id}`}
                  >
                    {r.workRequest?.externalTicketId ?? '—'}
                  </Link>
                </td>
                <td className="px-4 py-3 text-paper-400 truncate max-w-md">
                  {r.workRequest?.description ?? '—'}
                </td>
                <td className="px-4 py-3 font-mono text-xs text-paper-400">
                  {r.templateName ?? '—'} v{r.templateVersion}
                </td>
                <td className="px-4 py-3">
                  <StatusBadge status={r.status} />
                </td>
                <td className="px-4 py-3 text-paper-400">{formatRelativeTime(r.startedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <Pagination
        hasNext={hasNext}
        hasPrev={hasPrev}
        onNext={() => setOffset((o) => o + PAGE_SIZE)}
        onPrev={() => setOffset((o) => Math.max(0, o - PAGE_SIZE))}
        rangeEnd={Math.min(offset + PAGE_SIZE, total)}
        rangeStart={total === 0 ? 0 : offset + 1}
        total={total}
      />
    </div>
  );
}
