'use client';

import Link from 'next/link';
import { use } from 'react';
import { Card } from '@/components/ui/Card';
import { PageHeader } from '@/components/ui/PageHeader';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { useTemplateRuns, useWorkflowTemplate } from '@/hooks/useWorkflows';
import { formatDate, formatDuration, formatRelativeTime } from '@/lib/utils';

interface PageProps {
  params: Promise<{ id: string }>;
}

function runDuration(start: string, end: string | null): string {
  if (!end) {
    return 'running';
  }
  return formatDuration(new Date(end).getTime() - new Date(start).getTime());
}

export default function TemplateRunsPage({ params }: PageProps) {
  const { id } = use(params);
  const { data: template } = useWorkflowTemplate(id);
  const { data, isLoading } = useTemplateRuns(id);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20 font-mono text-[11px] uppercase tracking-[0.18em] text-paper-500">
        <span className="pulse-dot mr-3 inline-block h-1.5 w-1.5 rounded-full bg-ember-400" />
        loading runs…
      </div>
    );
  }

  const rows = data?.data ?? [];

  return (
    <div className="space-y-10">
      <div className="fade-up">
        <Link
          className="inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-paper-500 transition-colors hover:text-ember-400"
          href={`/templates/${id}`}
        >
          <span>←</span> {template?.name ?? 'template'}
        </Link>
        <div className="mt-4">
          <PageHeader
            chapter={`§ Runs · ${data?.total ?? 0} total`}
            subtitle="Every execution of this template, newest first. Click a row to drill into a specific run."
            title="Run history."
          />
        </div>
      </div>

      <Card className="fade-up stagger-1 overflow-hidden p-0" variant="inset">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-ink-600">
              <Th>Started</Th>
              <Th>Status</Th>
              <Th>Template ver.</Th>
              <Th>Work request</Th>
              <Th align="right">Duration</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                className="border-b border-ink-600 transition-colors hover:bg-ink-700/40"
                key={r.id}
              >
                <td className="px-4 py-3">
                  <Link className="text-paper-100 hover:text-ember-400" href={`/runs/${r.id}`}>
                    {formatDate(r.startedAt)}
                  </Link>
                  <div className="font-mono text-[11px] text-paper-500">
                    {formatRelativeTime(r.startedAt)}
                  </div>
                </td>
                <td className="px-4 py-3">
                  <StatusBadge status={r.status} />
                </td>
                <td className="px-4 py-3 font-mono text-xs text-paper-300">v{r.templateVersion}</td>
                <td className="px-4 py-3 text-xs">
                  {r.workRequest ? (
                    <>
                      <div className="font-mono text-paper-100">
                        {r.workRequest.externalTicketId}
                      </div>
                      <div className="max-w-md truncate text-paper-500">
                        {r.workRequest.description}
                      </div>
                    </>
                  ) : (
                    <span className="font-mono text-[11px] uppercase tracking-wider text-paper-500">
                      —
                    </span>
                  )}
                </td>
                <td className="tabular px-4 py-3 text-right font-mono text-xs text-paper-300">
                  {runDuration(r.startedAt, r.endedAt)}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td
                  className="px-4 py-12 text-center font-mono text-[11px] uppercase tracking-[0.18em] text-paper-500"
                  colSpan={5}
                >
                  no runs yet — submit a work request to trigger one
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

function Th({ children, align = 'left' }: { children: React.ReactNode; align?: 'left' | 'right' }) {
  return (
    <th
      className={`px-4 py-3 font-mono text-[10px] font-medium uppercase tracking-[0.18em] text-paper-500 ${
        align === 'right' ? 'text-right' : 'text-left'
      }`}
    >
      {children}
    </th>
  );
}
