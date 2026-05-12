'use client';

import Link from 'next/link';
import { use } from 'react';
import { Card } from '@/components/ui/Card';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { useTemplateRuns, useWorkflowTemplate } from '@/hooks/useWorkflows';
import { formatDate, formatDuration, formatRelativeTime } from '@/lib/utils';

interface PageProps {
  params: Promise<{ id: string }>;
}

function runDuration(start: string, end: string | null): string {
  if (!end) return 'running';
  return formatDuration(new Date(end).getTime() - new Date(start).getTime());
}

export default function TemplateRunsPage({ params }: PageProps) {
  const { id } = use(params);
  const { data: template } = useWorkflowTemplate(id);
  const { data, isLoading } = useTemplateRuns(id);

  if (isLoading)
    return <div className="text-center py-12 text-[var(--muted-foreground)]">Loading…</div>;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Link className="text-[var(--primary)] hover:underline text-sm" href={`/templates/${id}`}>
          &larr; {template?.name ?? 'Template'}
        </Link>
        <h2 className="text-2xl font-bold">Run history</h2>
        <span className="text-sm text-[var(--muted-foreground)]">{data?.total ?? 0} total</span>
      </div>

      <Card className="p-0 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[var(--border)] bg-[var(--muted)]">
              <th className="text-left px-4 py-3 font-medium">Started</th>
              <th className="text-left px-4 py-3 font-medium">Status</th>
              <th className="text-left px-4 py-3 font-medium">Template version</th>
              <th className="text-left px-4 py-3 font-medium">Work request</th>
              <th className="text-right px-4 py-3 font-medium">Duration</th>
            </tr>
          </thead>
          <tbody>
            {(data?.data ?? []).map((r) => (
              <tr
                className="border-b border-[var(--border)] hover:bg-[var(--muted)] transition-colors"
                key={r.id}
              >
                <td className="px-4 py-3">
                  <Link className="text-[var(--primary)] hover:underline" href={`/runs/${r.id}`}>
                    {formatDate(r.startedAt)}
                  </Link>
                  <div className="text-xs text-[var(--muted-foreground)]">
                    {formatRelativeTime(r.startedAt)}
                  </div>
                </td>
                <td className="px-4 py-3">
                  <StatusBadge status={r.status} />
                </td>
                <td className="px-4 py-3 font-mono text-xs">v{r.templateVersion}</td>
                <td className="px-4 py-3 text-xs">
                  {r.workRequest ? (
                    <>
                      <div className="font-mono">{r.workRequest.externalTicketId}</div>
                      <div className="text-[var(--muted-foreground)] truncate max-w-md">
                        {r.workRequest.description}
                      </div>
                    </>
                  ) : (
                    <span className="text-[var(--muted-foreground)]">—</span>
                  )}
                </td>
                <td className="px-4 py-3 text-right text-xs">
                  {runDuration(r.startedAt, r.endedAt)}
                </td>
              </tr>
            ))}
            {(data?.data ?? []).length === 0 && (
              <tr>
                <td className="px-4 py-8 text-center text-[var(--muted-foreground)]" colSpan={5}>
                  No runs yet
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
